import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  intelligenceSources,
  keywords,
  observations,
  sourceItems,
  sourceRuns,
} from '@/lib/db/schema'
import { reconcileAutoDiscoveredSourceFamilies } from '@/domains/intelligence/source-family-reconcile'
import { parseSourceFamilyCliArgs } from '../../scripts/agent/reconcile-source-families'

async function seedRows() {
  const db = await createTestDb()
  const [autoSource] = await db.insert(intelligenceSources).values({
    sourceKey: 'operator:auto-competitorb',
    name: '자동발견 · competitor-b-office.co.example.com',
    sourceType: 'sitemap',
    sourceFamily: 'legacy-family',
    baseUrl: 'https://www.competitor-b-office.co.example.com/sitemap.xml',
    // enabled is deliberately true: the repair must not change it.
    enabled: true,
    config: {
      type: 'sitemap',
      url: 'https://www.competitor-b-office.co.example.com/sitemap.xml',
      autoDiscovered: true,
      status: 'ready',
      parserSpec: { adapter: 'sitemap-xml', sampleItemCount: 3 },
      sourceFamily: 'legacy-family',
      operatorNote: 'retain this metadata',
    },
  }).returning()
  const [ordinarySource] = await db.insert(intelligenceSources).values({
    sourceKey: 'operator:ordinary-competitorb',
    name: '검토 완료 소스',
    sourceType: 'sitemap',
    sourceFamily: 'ordinary-family',
    baseUrl: 'https://www.competitor-b-office.co.example.com/sitemap.xml',
    enabled: true,
    config: { type: 'sitemap', parserSpec: { adapter: 'sitemap-xml' } },
  }).returning()
  const [keyword] = await db.insert(keywords).values({
    name: '자동발견 보존 사건',
    normalizedName: '자동발견보존사건',
    slug: 'source-family-reconcile-case',
    scamType: 'other',
    status: 'published',
  }).returning()
  const [run] = await db.insert(sourceRuns).values({
    sourceId: autoSource.id,
    status: 'succeeded',
    itemsSeen: 1,
    itemsAccepted: 1,
  }).returning()
  await db.insert(sourceItems).values({
    sourceId: autoSource.id,
    sourceRunId: run.id,
    firstSeenRunId: run.id,
    lastSeenRunId: run.id,
    sourceItemKey: 'item-1',
    sourceUrl: 'https://www.competitor-b-office.co.example.com/case/1',
    fingerprint: 'fingerprint-1',
    title: '보존 제목',
    payload: { source: 'preserve' },
    status: 'observed',
  })
  await db.insert(observations).values({
    keywordId: keyword.id,
    sourceUrl: 'https://www.competitor-b-office.co.example.com/case/1',
    sourceType: 'report',
    sourceFamily: 'legacy-family',
    title: '보존 관측',
    origin: '자동발견 보존 소스',
  })
  return { db, autoSource, ordinarySource, keyword }
}

describe('자동발견 sourceFamily 정본화 CLI 도메인', () => {
  it('기본 dry-run은 후보만 보고하고 어떤 행도 변경하지 않는다', async () => {
    const { db, autoSource, ordinarySource } = await seedRows()
    const beforeSources = await db.select().from(intelligenceSources)
    const result = await reconcileAutoDiscoveredSourceFamilies(db, { batchSize: 1 })

    expect(result.mode).toBe('dry-run')
    expect(result.candidates).toBe(1)
    expect(result.wouldUpdate).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.verification).toMatchObject({
      allPreserved: true,
      enabled: true,
      status: true,
      parserSpec: true,
      sourceItems: true,
      keywords: true,
      observations: true,
      databaseCanonical: false,
    })
    expect(await db.select().from(intelligenceSources)).toEqual(beforeSources)
    expect((await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, ordinarySource.id)))[0].sourceFamily)
      .toBe('ordinary-family')
    expect((await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, autoSource.id)))[0].sourceFamily)
      .toBe('legacy-family')
  })

  it('이중 opt-in apply는 두 family 필드만 바꾸고 재실행은 멱등이다', async () => {
    const { db, autoSource, ordinarySource } = await seedRows()
    const beforeItems = await db.select().from(sourceItems)
    const beforeKeywords = await db.select().from(keywords)
    const beforeObservations = await db.select().from(observations)
    const before = (await db.select().from(intelligenceSources))
      .map((row) => ({ id: row.id, enabled: row.enabled, config: row.config, family: row.sourceFamily }))

    const result = await reconcileAutoDiscoveredSourceFamilies(db, {
      mode: 'apply',
      confirm: true,
      batchSize: 1,
    })
    expect(result).toMatchObject({ mode: 'apply', candidates: 1, updated: 1 })
    expect(result.verification).toMatchObject({
      allPreserved: true,
      enabled: true,
      status: true,
      parserSpec: true,
      sourceItems: true,
      keywords: true,
      observations: true,
      databaseCanonical: true,
    })

    const [afterAuto] = await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, autoSource.id))
    expect(afterAuto).toMatchObject({ sourceFamily: 'competitorb-law', enabled: true })
    expect(afterAuto.config).toMatchObject({
      type: 'sitemap',
      autoDiscovered: true,
      status: 'ready',
      parserSpec: { adapter: 'sitemap-xml', sampleItemCount: 3 },
      sourceFamily: 'competitorb-law',
      operatorNote: 'retain this metadata',
    })
    const ordinaryAfter = (await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, ordinarySource.id)))[0]
    expect(ordinaryAfter.sourceFamily).toBe('ordinary-family')
    expect(ordinaryAfter.config).toEqual({ type: 'sitemap', parserSpec: { adapter: 'sitemap-xml' } })
    expect(await db.select().from(sourceItems)).toEqual(beforeItems)
    expect(await db.select().from(keywords)).toEqual(beforeKeywords)
    expect(await db.select().from(observations)).toEqual(beforeObservations)

    const second = await reconcileAutoDiscoveredSourceFamilies(db, {
      mode: 'apply',
      confirmApply: true,
      batchSize: 1,
    })
    expect(second).toMatchObject({ candidates: 0, wouldUpdate: 0, updated: 0, unchanged: 1 })
    expect((await db.select().from(intelligenceSources))
      .map((row) => ({ id: row.id, enabled: row.enabled, config: row.config, family: row.sourceFamily })))
      .toEqual(expect.arrayContaining(before.map((row) => row.id === autoSource.id
        ? { ...row, config: { ...(row.config as Record<string, unknown>), sourceFamily: 'competitorb-law' }, family: 'competitorb-law' }
        : row)))
  })

  it('apply에는 두 번째 확인이 없으면 실패하고 CLI 인자도 같은 게이트를 사용한다', () => {
    expect(() => parseSourceFamilyCliArgs(['--apply'])).toThrow(/both --apply and --confirm-source-family/)
    expect(() => parseSourceFamilyCliArgs(['--confirm-source-family'])).toThrow(/both --apply and --confirm-source-family/)
    expect(parseSourceFamilyCliArgs([])).toMatchObject({ mode: 'dry-run', apply: false, confirm: false })
    expect(parseSourceFamilyCliArgs(['--apply', '--confirm-source-family', '--batch-size', '25']))
      .toMatchObject({ mode: 'apply', apply: true, confirm: true, batchSize: 25 })
  })
})
