import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  caseApprovals,
  intelligenceSources,
  sourceItemChanges,
  sourceItems,
  sourceRuns,
} from '@/lib/db/schema'
import { syncLegacySourceRun } from '@/domains/intelligence/source-sync'

const STARTED_AT = new Date('2026-08-10T00:00:00.000Z')
const FINISHED_AT = new Date('2026-08-10T00:00:02.000Z')

function sourceRunInput(sourceId = 'cafe-a', runKey = 'run-2026-08-10') {
  return {
    source: {
      id: sourceId,
      name: `Legacy ${sourceId}`,
      type: 'community',
      sourceFamily: 'legacy-cafe',
      url: `https://${sourceId}.example/feed`,
    },
    run: {
      runKey,
      status: 'succeeded' as const,
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
    },
    items: [
      {
        sourceItemKey: 'article-1',
        sourceUrl: `https://${sourceId}.example/article-1`,
        title: 'Observed title',
        raw: { source: sourceId, articleId: 1, query: '검색/alpha' },
        provenance: { collector: 'legacy-harvest', sourceId },
      },
      {
        sourceItemKey: 'article-2',
        sourceUrl: `https://${sourceId}.example/article-2`,
        title: 'Second observed title',
        payload: { sourceType: 'report' },
        raw: { source: sourceId, articleId: 2 },
      },
    ],
  }
}

describe('legacy collector → target intelligence source bridge', () => {
  it('records a source, successful run, counts, timestamps, and raw observed items', async () => {
    const db = await createTestDb()
    const result = await syncLegacySourceRun(db, sourceRunInput())

    expect(result.sourceKey).toBe('legacy:cafe-a')
    expect(result.run.status).toBe('succeeded')
    expect(result.run.runKey).toBe('run-2026-08-10')
    expect(result.run.trigger).toBe('unknown')
    expect(result.run.attempted).toBe(true)
    expect(result.run.sourceKey).toBe('legacy:cafe-a')
    expect(result.run.sourceName).toBe('Legacy cafe-a')
    expect(result.run.sourceUrl).toBe('https://cafe-a.example/feed')
    expect(result.run.collectorMethod).toBe('community')
    expect(result.run.itemsSeen).toBe(2)
    expect(result.run.itemsAccepted).toBe(2)
    expect(result.run.startedAt).toEqual(STARTED_AT)
    expect(result.run.finishedAt).toEqual(FINISHED_AT)
    expect(result.items).toHaveLength(2)
    expect(result.items.map((item) => item.status)).toEqual(['observed', 'observed'])
    expect(result.items[0].payload).toMatchObject({
      raw: { source: 'cafe-a', articleId: 1, query: '검색/alpha' },
      provenance: { collector: 'legacy-harvest', sourceId: 'cafe-a' },
    })
    expect(result.items.every((item) => item.caseEntityId === null)).toBe(true)
    expect(await db.select().from(caseApprovals)).toHaveLength(0)
  })

  it('supports summary mode without loading persisted items into the result while keeping DB truth', async () => {
    const db = await createTestDb()
    const result = await syncLegacySourceRun(db, sourceRunInput(), { mode: 'summary' })

    expect(result.items).toEqual([])
    expect(result.itemsInserted).toBe(2)
    expect(result.itemsSeen).toBe(2)
    expect(result.itemsAccepted).toBe(2)
    expect(await db.select().from(sourceItems)).toHaveLength(2)
    expect(await db.select().from(sourceItemChanges)).toHaveLength(2)
  })

  it('is idempotent for a rerun of the same source run', async () => {
    const db = await createTestDb()
    const input = sourceRunInput()
    const first = await syncLegacySourceRun(db, input)
    const second = await syncLegacySourceRun(db, input)

    expect(first.source.id).toBe(second.source.id)
    expect(first.run.id).toBe(second.run.id)
    expect(first.sourceInserted).toBe(true)
    expect(first.runInserted).toBe(true)
    expect(first.itemsInserted).toBe(2)
    expect(second.sourceInserted).toBe(false)
    expect(second.runInserted).toBe(false)
    expect(second.itemsInserted).toBe(0)
    expect(second.itemsUpdated).toBe(0)
    expect(second.itemsUnchanged).toBe(2)
    expect(await db.select().from(intelligenceSources)).toHaveLength(1)
    expect(await db.select().from(sourceRuns)).toHaveLength(1)
    expect(await db.select().from(sourceItems)).toHaveLength(2)
  })

  it('keeps one source document across different runs and emits a change only for a new fingerprint', async () => {
    const db = await createTestDb()
    const first = await syncLegacySourceRun(db, sourceRunInput('source-a', 'run-one'))
    const secondInput = sourceRunInput('source-a', 'run-two')
    secondInput.items[0].title = 'Updated title'
    const second = await syncLegacySourceRun(db, secondInput)

    expect(first.itemsInserted).toBe(2)
    expect(second.itemsInserted).toBe(0)
    expect(second.itemsUpdated).toBe(1)
    expect(second.itemsUnchanged).toBe(1)
    expect(await db.select().from(sourceItems)).toHaveLength(2)
    expect(await db.select().from(sourceItemChanges)).toHaveLength(3)
  })

  it('records a failed collector run with an error and completion timestamp', async () => {
    const db = await createTestDb()
    const result = await syncLegacySourceRun(db, {
      source: { id: 'failed-feed', name: 'Failed feed', sourceType: 'rss' },
      run: {
        runKey: 'run-failed',
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        error: 'upstream returned 503',
      },
    })

    expect(result.run.status).toBe('failed')
    expect(result.run.error).toBe('upstream returned 503')
    expect(result.run.finishedAt).toEqual(FINISHED_AT)
    expect(result.run.itemsSeen).toBe(0)
    expect(result.run.itemsAccepted).toBe(0)
    expect(result.items).toHaveLength(0)
  })

  it('records cadence skips in the same run ledger with a source snapshot', async () => {
    const db = await createTestDb()
    const result = await syncLegacySourceRun(db, {
      source: {
        id: 'daily-sitemap', name: 'Daily sitemap', type: 'sitemap', sourceType: 'report',
        sourceFamily: 'daily-law', url: 'https://daily.example/sitemap.xml',
        config: { type: 'sitemap', fetchPageMetadata: true, recrawlDays: 1 },
      },
      run: {
        runKey: 'daily:2026-08-10', trigger: 'daily', attempted: false, status: 'skipped',
        startedAt: STARTED_AT, finishedAt: FINISHED_AT,
      },
    })

    expect(result.run).toMatchObject({
      runKey: 'daily:2026-08-10', trigger: 'daily', attempted: false, status: 'skipped',
      sourceName: 'Daily sitemap', sourceType: 'report', sourceFamily: 'daily-law',
      sourceUrl: 'https://daily.example/sitemap.xml', collectorMethod: 'sitemap+html-metadata',
      itemsSeen: 0, itemsAccepted: 0,
    })
    expect(result.run.collectorConfig).toMatchObject({ type: 'sitemap', recrawlDays: 1 })
  })

  it('isolates identical run and item keys across different sources', async () => {
    const db = await createTestDb()
    const first = await syncLegacySourceRun(db, sourceRunInput('source-a', 'same-run'))
    const second = await syncLegacySourceRun(db, sourceRunInput('source-b', 'same-run'))

    expect(first.sourceKey).not.toBe(second.sourceKey)
    expect(first.source.id).not.toBe(second.source.id)
    expect(first.run.id).not.toBe(second.run.id)
    expect(first.items[0].id).not.toBe(second.items[0].id)
    expect(await db.select().from(intelligenceSources)).toHaveLength(2)
    expect(await db.select().from(sourceRuns)).toHaveLength(2)
    expect(await db.select().from(sourceItems)).toHaveLength(4)
    expect(await db.select().from(sourceItems).where(eq(sourceItems.sourceRunId, first.run.id))).toHaveLength(2)
    expect(await db.select().from(sourceItems).where(eq(sourceItems.sourceRunId, second.run.id))).toHaveLength(2)
  })
})
