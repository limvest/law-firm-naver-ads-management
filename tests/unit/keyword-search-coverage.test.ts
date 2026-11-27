import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  keywordSearchCoverageBatches,
  keywordSearchCoverageRuns,
  keywords,
  observations,
} from '@/lib/db/schema'
import {
  claimKeywordSearchBatch,
  ensureKeywordSearchCoverageRun,
  readKeywordSearchCoverage,
  recordKeywordSearchBatch,
} from '@/domains/intelligence/keyword-search-coverage'

const id = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`

describe('keyword search coverage ledger', () => {
  it('snapshots eligible IDs and never treats the cursor as coverage', async () => {
    const db = await createTestDb()
    const rows = await db.insert(keywords).values([
      ...Array.from({ length: 5 }, (_, index) => ({
        id: id(index + 1), name: `Case ${index + 1}`, normalizedName: `case${index + 1}`,
        slug: `case-${index + 1}`, scamType: 'other', status: 'published' as const,
      })),
      { id: id(99), name: 'Blocked', normalizedName: 'blocked', slug: 'blocked', scamType: 'other', status: 'blocked' as const },
    ]).returning()
    await db.insert(observations).values(rows.filter((row) => row.status !== 'blocked').map((row, index) => ({
      keywordId: row.id, sourceUrl: `https://evidence.example/${index}`, sourceType: 'report', title: row.name,
    })))

    const run = await ensureKeywordSearchCoverageRun(db, {
      coverageKey: 'naver-public-search', runKey: 'cycle-1',
      cursorHint: { keywordId: id(5) },
    })
    expect(run.totalEligible).toBe(5)
    expect(run.remainingCount).toBe(5)
    expect(run.eligibleSeedIds).toHaveLength(5)
    expect(run.eligibleSeedIds).not.toContain(id(99))
    await db.update(keywordSearchCoverageRuns).set({ cursorHint: { keywordId: id(1) } })
      .where(eq(keywordSearchCoverageRuns.id, run.id))
    const view = await readKeywordSearchCoverage(db, { runId: run.id })
    expect(view).toMatchObject({ totalEligible: 5, processedCount: 0, remainingCount: 5 })
  })

  it('records success/failure/retry exactly once and computes global remaining', async () => {
    const db = await createTestDb()
    const run = await ensureKeywordSearchCoverageRun(db, {
      runKey: 'cycle-2', eligibleSeedIds: [id(1), id(2), id(3), id(4), id(5)],
    })
    const batch = await claimKeywordSearchBatch(db, { runId: run.id, batchSize: 2 })
    expect(batch?.seedIds).toEqual([id(1), id(2)])
    if (!batch) throw new Error('batch was not claimed')

    const first = await recordKeywordSearchBatch(db, {
      batchId: batch.id,
      attemptKey: 'attempt-1',
      outcomes: [
        { seedId: id(1), status: 'succeeded' },
        { seedId: id(2), status: 'failed', retryable: true, error: 'temporary' },
      ],
    })
    expect(first).toMatchObject({
      totalEligible: 5, attemptedCount: 2, processedCount: 1,
      succeededCount: 1, failedCount: 0, pendingRetryCount: 1,
      retryCount: 0, remainingCount: 4,
    })
    expect(first.batches[0]).toMatchObject({
      succeededSeedIds: [id(1)], retryableSeedIds: [id(2)], pendingSeedIds: [id(2)],
      processedCount: 1, attemptCount: 1,
    })

    const duplicate = await recordKeywordSearchBatch(db, {
      batchId: batch.id,
      attemptKey: 'attempt-1',
      outcomes: [
        { seedId: id(1), status: 'succeeded' },
        { seedId: id(2), status: 'failed', retryable: true, error: 'temporary' },
      ],
    })
    expect(duplicate).toMatchObject({ processedCount: 1, remainingCount: 4, retryCount: 0 })

    const retried = await recordKeywordSearchBatch(db, {
      batchId: batch.id,
      attemptKey: 'attempt-2',
      outcomes: [{ seedId: id(2), status: 'succeeded' }],
    })
    expect(retried).toMatchObject({
      attemptedCount: 2, processedCount: 2, succeededCount: 2,
      failedCount: 0, pendingRetryCount: 0, retriedCount: 1,
      retryCount: 1, remainingCount: 3,
    })
    expect(retried.batches[0]).toMatchObject({
      succeededSeedIds: [id(1), id(2)], failedSeedIds: [], retriedSeedIds: [id(2)],
      pendingSeedIds: [], attemptCount: 2, processedCount: 2,
    })

    const next = await claimKeywordSearchBatch(db, { runId: run.id, batchSize: 2 })
    expect(next?.seedIds).toEqual([id(3), id(4)])
    if (!next) throw new Error('second batch was not claimed')
    const finished = await recordKeywordSearchBatch(db, {
      batchId: next.id,
      outcomes: [
        { seedId: id(3), status: 'succeeded' },
        { seedId: id(4), status: 'failed', retryable: false, error: 'permanent' },
      ],
    })
    expect(finished).toMatchObject({
      attemptedCount: 4, processedCount: 4, succeededCount: 3,
      failedCount: 1, remainingCount: 1, status: 'warning',
    })
    expect(finished.batches.find((item) => item.id === next.id)).toMatchObject({
      status: 'failed', failedSeedIds: [id(4)], retryableSeedIds: [], processedCount: 2,
    })

    const rawBatches = await db.select().from(keywordSearchCoverageBatches)
    expect(rawBatches).toHaveLength(2)
    expect(rawBatches.reduce((sum, item) => sum + item.processedCount, 0)).toBe(4)
  })

  it('keeps a terminal failure visible and does not count unassigned IDs as processed', async () => {
    const db = await createTestDb()
    const run = await ensureKeywordSearchCoverageRun(db, {
      runKey: 'cycle-3', eligibleSeedIds: [id(1), id(2)],
    })
    const batch = await claimKeywordSearchBatch(db, { runId: run.id, batchSize: 1 })
    if (!batch) throw new Error('batch was not claimed')
    const report = await recordKeywordSearchBatch(db, {
      batchId: batch.id,
      outcomes: [{ seedId: id(1), status: 'failed', retryable: false, error: 'permanent' }],
    })
    expect(report).toMatchObject({
      status: 'warning', totalEligible: 2, attemptedCount: 1,
      processedCount: 1, failedCount: 1, remainingCount: 1,
    })
    expect(report.batches[0]).toMatchObject({ status: 'failed', failedSeedIds: [id(1)] })
  })
})
