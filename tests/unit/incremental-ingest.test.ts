import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { ingestPendingSourceChanges, normalizeKeywordName, stableKeywordSlug } from '@/domains/intelligence/incremental-ingest'
import { syncLegacySourceRun } from '@/domains/intelligence/source-sync'
import { caseEntities, intelligenceSources, keywords, observations, sourceItemChanges, sourceItems } from '@/lib/db/schema'

describe('incremental source truth', () => {
  it('자동발견 소스는 수집 원장에 남겨도 source item·키워드·관측으로 승격하지 않는다', async () => {
    const db = await createTestDb()
    const synced = await syncLegacySourceRun(db, {
      source: {
        id: 'auto-discovered-law',
        name: '자동발견 · new-law.example',
        sourceType: 'sitemap',
        url: 'https://new-law.example/sitemap.xml',
        config: {
          competitorKeywordSource: true,
          discovery: { method: 'naver-web-search' },
        },
      },
      run: { runKey: 'auto-discovery-run', status: 'succeeded' },
      items: [{
        sourceItemKey: 'https://new-law.example/cases/alpha',
        sourceUrl: 'https://new-law.example/cases/alpha',
        title: 'Alpha Exchange',
      }],
    })

    expect(synced).toMatchObject({ itemsSeen: 1, itemsAccepted: 0, itemsInserted: 0, changeEventIds: [] })
    expect(synced.source.enabled).toBe(false)
    expect(await db.select().from(sourceItems)).toHaveLength(0)
    expect(await ingestPendingSourceChanges(db)).toMatchObject({ changes: 0, blockedChanges: 0, keywordsInserted: 0 })
    expect(await db.select().from(keywords)).toHaveLength(0)
    expect(await db.select().from(observations)).toHaveLength(0)
  })

  it('legacy auto-discovery outbox rows are consumed as rejected without materialization', async () => {
    const db = await createTestDb()
    const synced = await syncLegacySourceRun(db, {
      source: {
        id: 'legacy-auto-law', name: 'Legacy auto source', sourceType: 'sitemap',
        url: 'https://legacy-auto.example/sitemap.xml', config: { competitorKeywordSource: true },
      },
      run: { runKey: 'legacy-auto-run', status: 'succeeded' },
      items: [{ sourceItemKey: 'item-1', sourceUrl: 'https://legacy-auto.example/case/1', title: 'Legacy Fraud' }],
    })
    await db.update(sourceItems).set({ status: 'observed' })
    const source = (await db.select().from(intelligenceSources)).find((row) => row.id === synced.source.id)
    if (!source) throw new Error('test source missing')
    await db.update(intelligenceSources).set({
      name: '자동발견 · legacy-auto.example',
      config: { competitorKeywordSource: true, discovery: { method: 'naver-web-search' } },
    }).where(eq(intelligenceSources.id, source.id))

    const result = await ingestPendingSourceChanges(db)
    expect(result).toMatchObject({ changes: 1, blockedChanges: 1, keywordsInserted: 0, observationsInserted: 0 })
    expect((await db.select().from(sourceItemChanges))[0]).toMatchObject({ status: 'processed', keywordIds: [], caseEntityIds: [] })
    expect((await db.select().from(sourceItems))[0]).toMatchObject({ status: 'rejected', caseEntityId: null })
    expect(await db.select().from(keywords)).toHaveLength(0)
    expect(await db.select().from(observations)).toHaveLength(0)
  })

  it('서로 다른 사이트맵의 동일 사건명을 하나의 키워드와 두 관측로 병합한다', async () => {
    const db = await createTestDb()
    for (const [suffix, title] of [['a', 'MOCKQIB'], ['b', 'mockqib']] as const) {
      await syncLegacySourceRun(db, {
        source: {
          id: `competitor-sitemap-${suffix}`,
          name: `경쟁사 ${suffix.toUpperCase()} 사이트맵`,
          sourceType: 'sitemap',
          sourceFamily: `competitor-${suffix}`,
          config: { competitorKeywordSource: true },
        },
        run: { runKey: `duplicate-${suffix}`, status: 'succeeded' },
        items: [{
          sourceItemKey: `https://${suffix}.example/case/mockqib`,
          sourceUrl: `https://${suffix}.example/case/mockqib`,
          title,
          raw: { query: `사이트맵/경쟁사 ${suffix}`, sourceType: 'report' },
        }],
      })
    }

    const result = await ingestPendingSourceChanges(db)
    expect(result).toMatchObject({ changes: 2, keywordsInserted: 1, observationsInserted: 2 })
    expect(await db.select().from(keywords)).toHaveLength(1)
    expect((await db.select().from(keywords))[0]).toMatchObject({ normalizedName: 'mockqib' })
    expect(await db.select().from(observations)).toHaveLength(2)
  })

  it('materializes only a new source document and a replay produces no new work', async () => {
    const db = await createTestDb()
    const input = {
      source: {
        id: 'competitor-sitemap-a',
        name: '경쟁사 A 사이트맵',
        sourceType: 'sitemap',
        sourceFamily: 'competitor-a',
        config: { competitorKeywordSource: true },
      },
      run: { runKey: 'daily-one', status: 'succeeded' as const },
      items: [{
        sourceItemKey: 'https://example.com/case/alpha',
        sourceUrl: 'https://example.com/case/alpha',
        title: 'Alpha Exchange',
        raw: { query: '사이트맵/경쟁사 A', sourceType: 'report' },
      }],
    }
    const firstSync = await syncLegacySourceRun(db, input)
    const first = await ingestPendingSourceChanges(db)

    expect(firstSync).toMatchObject({ itemsInserted: 1, itemsUpdated: 0, itemsUnchanged: 0 })
    expect(first).toMatchObject({ changes: 1, keywordsInserted: 1, observationsInserted: 1, keywordsChanged: 1 })
    const [keyword] = await db.select().from(keywords)
    expect(keyword).toMatchObject({
      normalizedName: normalizeKeywordName('Alpha Exchange'),
      slug: stableKeywordSlug('Alpha Exchange'),
      status: 'published',
      managedBy: 'competitor-sitemap',
      autoPublished: true,
    })
    expect(await db.select().from(observations)).toHaveLength(1)
    expect(await db.select().from(caseEntities)).toHaveLength(1)
    expect((await db.select().from(sourceItems))[0]).toMatchObject({ status: 'linked' })

    await db.update(sourceItemChanges).set({ status: 'processed' }).where(eq(sourceItemChanges.id, first.changeEventIds[0]))
    const replaySync = await syncLegacySourceRun(db, { ...input, run: { ...input.run, runKey: 'daily-two' } })
    const replay = await ingestPendingSourceChanges(db)
    expect(replaySync).toMatchObject({ itemsInserted: 0, itemsUpdated: 0, itemsUnchanged: 1 })
    expect(replay).toMatchObject({ changes: 0, keywordsInserted: 0, observationsInserted: 0 })
    expect(await db.select().from(sourceItems)).toHaveLength(1)
    expect(await db.select().from(sourceItemChanges)).toHaveLength(1)
  })
})
