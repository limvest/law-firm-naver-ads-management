import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  keywordSearchCoverageAttempts,
  keywordSearchCoverageBatches,
  keywordSearchCoverageRuns,
  keywords,
  observations,
  type KeywordSearchCoverageBatchStatus,
  type KeywordSearchCoverageRunStatus,
} from '@/lib/db/schema'

/**
 * The coverage ledger deliberately has no search client dependency.  A worker
 * may search however it is authorised to search, then record only the outcome
 * of each seed here.  This keeps the ledger useful for dry-runs and prevents
 * a progress check from accidentally activating a source or writing a
 * keyword.
 */

export const DEFAULT_KEYWORD_SEARCH_COVERAGE_KEY = 'naver-public-search'
export const DEFAULT_KEYWORD_SEARCH_ELIGIBILITY_VERSION = 'observed-nonblocked-v1'

export type KeywordSearchSeedOutcome = {
  seedId: string
  status: 'succeeded' | 'failed'
  retryable?: boolean
  error?: string | null
}

export type KeywordSearchCoverageRunInput = {
  /** Logical lane, e.g. naver-public-search. */
  coverageKey?: string
  /** Stable identity for one complete coverage cycle. */
  runKey?: string
  eligibilityVersion?: string
  /** Test/replay override. Production callers should let the DB snapshot IDs. */
  eligibleSeedIds?: readonly string[]
  cursorHint?: Record<string, unknown> | null
  now?: Date
}

export type KeywordSearchCoverageBatch = {
  id: string
  runId: string
  batchKey: string
  batchNumber: number
  status: KeywordSearchCoverageBatchStatus
  seedIds: string[]
  attemptedSeedIds: string[]
  succeededSeedIds: string[]
  failedSeedIds: string[]
  retriedSeedIds: string[]
  retryableSeedIds: string[]
  pendingSeedIds: string[]
  attemptCount: number
  processedCount: number
  remainingCount: number
  lastError: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type KeywordSearchCoverageSummary = {
  id: string
  coverageKey: string
  runKey: string
  status: KeywordSearchCoverageRunStatus
  eligibilityVersion: string
  totalEligible: number
  attemptedCount: number
  processedCount: number
  succeededCount: number
  failedCount: number
  pendingRetryCount: number
  retriedCount: number
  retryCount: number
  remainingCount: number
  coveragePercent: number
  batchesTotal: number
  batchesCompleted: number
  batchesPending: number
  cursorHint: Record<string, unknown> | null
  startedAt: Date
  finishedAt: Date | null
  updatedAt: Date
  createdAt: Date
}

export type KeywordSearchCoverageReport = KeywordSearchCoverageSummary & {
  batches: KeywordSearchCoverageBatch[]
}

type RunRow = typeof keywordSearchCoverageRuns.$inferSelect
type BatchRow = typeof keywordSearchCoverageBatches.$inferSelect
type AttemptRow = typeof keywordSearchCoverageAttempts.$inferSelect

const MAX_BATCH_SIZE = 5_000

function clean(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(clean).filter(Boolean))]
}

function jsonStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => typeof item === 'string'))
    : []
}

function boundedBatchSize(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || !value || value < 1) return 100
  return Math.min(value, MAX_BATCH_SIZE)
}

function dateValue(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function stableBatchKey(runId: string, seedIds: readonly string[]): string {
  const digest = createHash('sha256')
    .update(`${runId}\u0000${[...seedIds].join(',')}`)
    .digest('hex')
    .slice(0, 24)
  return `batch:${digest}`
}

function stableAttemptKey(
  batchId: string,
  outcomes: readonly KeywordSearchSeedOutcome[],
  error: string | null | undefined,
): string {
  const stable = [...outcomes]
    .map((outcome) => ({
      seedId: clean(outcome.seedId), status: outcome.status,
      retryable: outcome.retryable === true, error: clean(outcome.error),
    }))
    .sort((left, right) => left.seedId.localeCompare(right.seedId))
  const digest = createHash('sha256')
    .update(`${batchId}\u0000${JSON.stringify({ stable, error: clean(error) })}`)
    .digest('hex')
    .slice(0, 32)
  return `attempt:${digest}`
}

function asBatch(row: BatchRow): KeywordSearchCoverageBatch {
  return {
    id: row.id,
    runId: row.runId,
    batchKey: row.batchKey,
    batchNumber: row.batchNumber,
    status: row.status,
    seedIds: jsonStrings(row.seedIds),
    attemptedSeedIds: jsonStrings(row.attemptedSeedIds),
    succeededSeedIds: jsonStrings(row.succeededSeedIds),
    failedSeedIds: jsonStrings(row.failedSeedIds),
    retriedSeedIds: jsonStrings(row.retriedSeedIds),
    retryableSeedIds: jsonStrings(row.retryableSeedIds),
    pendingSeedIds: jsonStrings(row.pendingSeedIds),
    attemptCount: Number(row.attemptCount ?? 0),
    processedCount: Number(row.processedCount ?? 0),
    remainingCount: Number(row.remainingCount ?? 0),
    lastError: row.lastError ?? null,
    startedAt: dateValue(row.startedAt),
    finishedAt: dateValue(row.finishedAt),
    createdAt: dateValue(row.createdAt) ?? new Date(0),
    updatedAt: dateValue(row.updatedAt) ?? new Date(0),
  }
}

/**
 * Eligible means the same conservative set used by source discovery: a
 * non-blocked keyword with at least one observation.  IDs are ordered by the
 * same `(created_at,id)` tie-break as the existing cursor, but this snapshot
 * remains the progress source of truth after the cursor wraps.
 */
export async function selectEligibleKeywordIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: keywords.id })
    .from(keywords)
    .where(and(
      ne(keywords.status, 'blocked'),
      sql`exists (select 1 from ${observations} o where o.keyword_id = ${keywords.id})`,
    ))
    .orderBy(asc(keywords.createdAt), asc(keywords.id))
  return rows.map((row) => row.id)
}

/** Create (or return) one immutable eligible snapshot. */
export async function ensureKeywordSearchCoverageRun(
  db: Db,
  input: KeywordSearchCoverageRunInput = {},
): Promise<RunRow> {
  const coverageKey = clean(input.coverageKey) || DEFAULT_KEYWORD_SEARCH_COVERAGE_KEY
  // A caller that omits runKey gets one stable "current" cycle, which is
  // useful for a scheduled worker and still makes repeated starts idempotent.
  const runKey = clean(input.runKey) || 'current'
  const [existing] = await db.select().from(keywordSearchCoverageRuns)
    .where(and(
      eq(keywordSearchCoverageRuns.coverageKey, coverageKey),
      eq(keywordSearchCoverageRuns.runKey, runKey),
    ))
    .limit(1)
  if (existing) return existing

  const eligibleSeedIds = input.eligibleSeedIds === undefined
    ? await selectEligibleKeywordIds(db)
    : unique(input.eligibleSeedIds)
  const now = input.now ?? new Date()
  const [inserted] = await db.insert(keywordSearchCoverageRuns).values({
    coverageKey,
    runKey,
    status: 'running',
    eligibilityVersion: clean(input.eligibilityVersion) || DEFAULT_KEYWORD_SEARCH_ELIGIBILITY_VERSION,
    eligibleSeedIds,
    totalEligible: eligibleSeedIds.length,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    pendingRetryCount: 0,
    retryCount: 0,
    remainingCount: eligibleSeedIds.length,
    cursorHint: input.cursorHint ?? null,
    startedAt: now,
    updatedAt: now,
    createdAt: now,
  }).onConflictDoNothing({
    target: [keywordSearchCoverageRuns.coverageKey, keywordSearchCoverageRuns.runKey],
  }).returning()
  if (inserted) return inserted

  // A competing worker won the insert.  Returning its immutable snapshot is
  // important: never replace it with a second dynamic eligible count.
  const [raced] = await db.select().from(keywordSearchCoverageRuns)
    .where(and(
      eq(keywordSearchCoverageRuns.coverageKey, coverageKey),
      eq(keywordSearchCoverageRuns.runKey, runKey),
    )).limit(1)
  if (!raced) throw new Error('keyword search coverage run was not created')
  return raced
}

/** Alias used by callers that prefer create-or-get terminology. */
export const createKeywordSearchCoverageRun = ensureKeywordSearchCoverageRun

async function getRun(db: Db, runId: string): Promise<RunRow> {
  const [run] = await db.select().from(keywordSearchCoverageRuns)
    .where(eq(keywordSearchCoverageRuns.id, runId)).limit(1)
  if (!run) throw new Error(`keyword search coverage run not found: ${runId}`)
  return run
}

/**
 * Claim the next unassigned slice from the immutable snapshot. Existing
 * warning batches (failed/retryable seeds) are returned first. The deterministic
 * key means two workers racing for the same slice converge on one batch row.
 */
export async function claimKeywordSearchBatch(
  db: Db,
  input: { runId: string; batchSize?: number; batchKey?: string; now?: Date },
): Promise<KeywordSearchCoverageBatch | null> {
  const run = await getRun(db, input.runId)
  const batchSize = boundedBatchSize(input.batchSize)
  const rows = await db.select().from(keywordSearchCoverageBatches)
    .where(eq(keywordSearchCoverageBatches.runId, run.id))
    .orderBy(asc(keywordSearchCoverageBatches.batchNumber), asc(keywordSearchCoverageBatches.id))
  const retry = rows.find((row) => {
    const attempted = jsonStrings(row.attemptedSeedIds)
    const pending = jsonStrings(row.pendingSeedIds)
    // A partial worker result can leave untouched seeds in the same batch;
    // resume those IDs instead of assigning them to a second batch.
    return attempted.length > 0 && pending.length > 0
  })
  if (retry) {
    const now = input.now ?? new Date()
    const [claimed] = await db.update(keywordSearchCoverageBatches).set({
      status: 'running',
      startedAt: retry.startedAt ?? now,
      updatedAt: now,
    }).where(eq(keywordSearchCoverageBatches.id, retry.id)).returning()
    return asBatch(claimed ?? retry)
  }

  const assigned = new Set(rows.flatMap((row) => jsonStrings(row.seedIds)))
  const eligible = jsonStrings(run.eligibleSeedIds)
  const next = eligible.filter((seedId) => !assigned.has(seedId)).slice(0, batchSize)
  if (!next.length) return null

  const batchKey = clean(input.batchKey) || stableBatchKey(run.id, next)
  const nextNumber = rows.reduce((max, row) => Math.max(max, Number(row.batchNumber) || 0), 0) + 1
  const now = input.now ?? new Date()
  const [inserted] = await db.insert(keywordSearchCoverageBatches).values({
    runId: run.id,
    batchKey,
    batchNumber: nextNumber,
    status: 'running',
    seedIds: next,
    pendingSeedIds: next,
    remainingCount: run.remainingCount,
    startedAt: now,
    updatedAt: now,
    createdAt: now,
  }).onConflictDoNothing({
    target: [keywordSearchCoverageBatches.runId, keywordSearchCoverageBatches.batchKey],
  }).returning()
  if (inserted) return asBatch(inserted)

  const [raced] = await db.select().from(keywordSearchCoverageBatches)
    .where(and(
      eq(keywordSearchCoverageBatches.runId, run.id),
      eq(keywordSearchCoverageBatches.batchKey, batchKey),
    )).limit(1)
  return raced ? asBatch(raced) : null
}

/** Alias for worker code that calls this operation reserve/lease. */
export const reserveKeywordSearchBatch = claimKeywordSearchBatch

function normalizeOutcomes(input: {
  seedIds?: readonly string[]
  outcomes?: readonly KeywordSearchSeedOutcome[]
  succeededSeedIds?: readonly string[]
  failedSeedIds?: readonly string[]
  retryableSeedIds?: readonly string[]
}): KeywordSearchSeedOutcome[] {
  const byId = new Map<string, KeywordSearchSeedOutcome>()
  for (const outcome of input.outcomes ?? []) {
    const seedId = clean(outcome.seedId)
    if (!seedId) continue
    if (byId.has(seedId)) throw new Error(`duplicate seed outcome: ${seedId}`)
    byId.set(seedId, {
      seedId,
      status: outcome.status,
      retryable: outcome.retryable === true,
      error: clean(outcome.error) || null,
    })
  }
  const retryable = new Set(unique(input.retryableSeedIds ?? []))
  for (const seedId of unique(input.succeededSeedIds ?? [])) {
    if (byId.has(seedId)) throw new Error(`duplicate seed outcome: ${seedId}`)
    byId.set(seedId, { seedId, status: 'succeeded', retryable: false, error: null })
  }
  for (const seedId of unique(input.failedSeedIds ?? [])) {
    if (byId.has(seedId)) throw new Error(`duplicate seed outcome: ${seedId}`)
    byId.set(seedId, { seedId, status: 'failed', retryable: retryable.has(seedId), error: null })
  }
  // seedIds without a status are intentionally not made into fake failures;
  // a worker may record a partial result and complete the same batch later.
  return [...byId.values()]
}

type SeedState = 'unprocessed' | 'pending' | 'succeeded' | 'failed'

function attemptOrdering(left: AttemptRow, right: AttemptRow): number {
  const numberOrder = Number(left.attemptNumber) - Number(right.attemptNumber)
  if (numberOrder) return numberOrder
  const leftDate = dateValue(left.createdAt)?.getTime() ?? 0
  const rightDate = dateValue(right.createdAt)?.getTime() ?? 0
  return leftDate - rightDate || left.id.localeCompare(right.id)
}

function reconcileBatchState(
  batch: BatchRow,
  attempts: readonly AttemptRow[],
): {
  status: KeywordSearchCoverageBatchStatus
  attemptedSeedIds: string[]
  succeededSeedIds: string[]
  failedSeedIds: string[]
  retriedSeedIds: string[]
  retryableSeedIds: string[]
  pendingSeedIds: string[]
  attemptCount: number
  processedCount: number
  lastError: string | null
  finishedAt: Date | null
} {
  const seedIds = jsonStrings(batch.seedIds)
  const allowed = new Set(seedIds)
  const states = new Map(seedIds.map((seedId) => [seedId, 'unprocessed' as SeedState]))
  const attemptCounts = new Map<string, number>()
  const attempted = new Set<string>()
  const retried = new Set<string>()
  const ordered = [...attempts].sort(attemptOrdering)
  for (const attempt of ordered) {
    const attemptSeedIds = jsonStrings(attempt.seedIds).filter((seedId) => allowed.has(seedId))
    const successful = new Set(jsonStrings(attempt.succeededSeedIds))
    const failed = new Set(jsonStrings(attempt.failedSeedIds))
    const retryable = new Set(jsonStrings(attempt.retryableSeedIds))
    for (const seedId of attemptSeedIds) {
      attempted.add(seedId)
      const count = (attemptCounts.get(seedId) ?? 0) + 1
      attemptCounts.set(seedId, count)
      if (count > 1) retried.add(seedId)
      if (successful.has(seedId)) states.set(seedId, 'succeeded')
      else if (failed.has(seedId)) states.set(seedId, retryable.has(seedId) ? 'pending' : 'failed')
    }
  }
  const succeededSeedIds = seedIds.filter((seedId) => states.get(seedId) === 'succeeded')
  const failedSeedIds = seedIds.filter((seedId) => states.get(seedId) === 'failed')
  const retryableSeedIds = seedIds.filter((seedId) => states.get(seedId) === 'pending')
  const pendingSeedIds = seedIds.filter((seedId) => states.get(seedId) === 'pending' || states.get(seedId) === 'unprocessed')
  const processedCount = succeededSeedIds.length + failedSeedIds.length
  const status: KeywordSearchCoverageBatchStatus = attempts.length === 0
    ? 'pending'
    : pendingSeedIds.length
      ? 'warning'
      : failedSeedIds.length
        ? 'failed'
        : 'succeeded'
  const lastError = [...ordered].reverse().find((attempt) => clean(attempt.error))?.error ?? null
  return {
    status,
    attemptedSeedIds: seedIds.filter((seedId) => attempted.has(seedId)),
    succeededSeedIds,
    failedSeedIds,
    retriedSeedIds: seedIds.filter((seedId) => retried.has(seedId)),
    retryableSeedIds,
    pendingSeedIds,
    attemptCount: attempts.length,
    processedCount,
    lastError,
    finishedAt: pendingSeedIds.length ? null : dateValue(ordered.at(-1)?.finishedAt) ?? new Date(),
  }
}

type GlobalState = 'unprocessed' | 'pending' | 'failed' | 'succeeded'

function deriveRunState(
  run: RunRow,
  batches: readonly BatchRow[],
  attempts: readonly AttemptRow[],
): {
  status: KeywordSearchCoverageRunStatus
  attemptedCount: number
  processedCount: number
  succeededCount: number
  failedCount: number
  pendingRetryCount: number
  retriedCount: number
  retryCount: number
  remainingCount: number
  batchesCompleted: number
  batchesPending: number
} {
  const eligible = new Set(jsonStrings(run.eligibleSeedIds))
  const state = new Map<string, GlobalState>([...eligible].map((id) => [id, 'unprocessed']))
  const attempted = new Set<string>()
  const retried = new Set<string>()
  const retryable = new Set<string>()
  const rank: Record<GlobalState, number> = { unprocessed: 0, pending: 1, failed: 2, succeeded: 3 }
  const apply = (seedId: string, next: GlobalState) => {
    if (!eligible.has(seedId)) return
    const current = state.get(seedId) ?? 'unprocessed'
    // A successful observation always wins over a stale duplicate failure
    // from another worker. This is what makes overlap harmless on retries.
    if (rank[next] >= rank[current]) state.set(seedId, next)
  }
  for (const batch of batches) {
    for (const seedId of jsonStrings(batch.attemptedSeedIds)) attempted.add(seedId)
    for (const seedId of jsonStrings(batch.retriedSeedIds)) retried.add(seedId)
    for (const seedId of jsonStrings(batch.succeededSeedIds)) apply(seedId, 'succeeded')
    for (const seedId of jsonStrings(batch.failedSeedIds)) apply(seedId, 'failed')
    for (const seedId of jsonStrings(batch.pendingSeedIds)) apply(seedId, 'pending')
    for (const seedId of jsonStrings(batch.retryableSeedIds)) retryable.add(seedId)
  }
  const succeededCount = [...state.values()].filter((value) => value === 'succeeded').length
  const failedCount = [...state.values()].filter((value) => value === 'failed').length
  const pendingRetryCount = [...state.entries()].filter(([id, value]) => value === 'pending' && retryable.has(id)).length
  const processedCount = succeededCount + failedCount
  const remainingCount = Math.max(0, eligible.size - processedCount)
  const batchesCompleted = batches.filter((batch) => batch.status === 'succeeded' || batch.status === 'failed').length
  const batchesPending = Math.max(0, batches.length - batchesCompleted)
  const retryCount = attempts.reduce((sum, attempt) => {
    if (Number(attempt.attemptNumber) <= 1) return sum
    return sum + jsonStrings(attempt.seedIds).filter((seedId) => eligible.has(seedId)).length
  }, 0)
  const status: KeywordSearchCoverageRunStatus = remainingCount === 0 && pendingRetryCount === 0
    ? failedCount ? 'warning' : 'completed'
    : (failedCount > 0 || pendingRetryCount > 0) ? 'warning' : 'running'
  return {
    status,
    attemptedCount: [...attempted].filter((id) => eligible.has(id)).length,
    processedCount,
    succeededCount,
    failedCount,
    pendingRetryCount,
    retriedCount: [...retried].filter((id) => eligible.has(id)).length,
    retryCount,
    remainingCount,
    batchesCompleted,
    batchesPending,
  }
}

async function readAllForRun(db: Db, runId: string): Promise<{
  run: RunRow
  batches: BatchRow[]
  attempts: AttemptRow[]
}> {
  const run = await getRun(db, runId)
  const batches = await db.select().from(keywordSearchCoverageBatches)
    .where(eq(keywordSearchCoverageBatches.runId, runId))
    .orderBy(asc(keywordSearchCoverageBatches.batchNumber), asc(keywordSearchCoverageBatches.id))
  const batchIds = batches.map((batch) => batch.id)
  if (!batchIds.length) return { run, batches, attempts: [] }
  const attempts = await db.select().from(keywordSearchCoverageAttempts)
    .where(inArray(keywordSearchCoverageAttempts.batchId, batchIds))
    .orderBy(asc(keywordSearchCoverageAttempts.createdAt), asc(keywordSearchCoverageAttempts.id))
  return { run, batches, attempts }
}

function summaryFrom(
  run: RunRow,
  batches: readonly BatchRow[],
  attempts: readonly AttemptRow[],
): KeywordSearchCoverageSummary {
  const derived = deriveRunState(run, batches, attempts)
  const totalEligible = Number(run.totalEligible ?? jsonStrings(run.eligibleSeedIds).length)
  const coveragePercent = totalEligible > 0
    ? Number(((derived.processedCount / totalEligible) * 100).toFixed(2))
    : 100
  return {
    id: run.id,
    coverageKey: run.coverageKey,
    runKey: run.runKey,
    status: derived.status,
    eligibilityVersion: run.eligibilityVersion,
    totalEligible,
    attemptedCount: derived.attemptedCount,
    processedCount: derived.processedCount,
    succeededCount: derived.succeededCount,
    failedCount: derived.failedCount,
    pendingRetryCount: derived.pendingRetryCount,
    retriedCount: derived.retriedCount,
    retryCount: derived.retryCount,
    remainingCount: derived.remainingCount,
    coveragePercent,
    batchesTotal: batches.length,
    batchesCompleted: derived.batchesCompleted,
    batchesPending: derived.batchesPending,
    cursorHint: run.cursorHint ?? null,
    startedAt: dateValue(run.startedAt) ?? new Date(0),
    finishedAt: dateValue(run.finishedAt),
    updatedAt: dateValue(run.updatedAt) ?? new Date(0),
    createdAt: dateValue(run.createdAt) ?? new Date(0),
  }
}

/**
 * Record one batch attempt. Reusing attemptKey is a no-op, while a retry gets
 * a new attempt row and is folded into the same batch without double-counting
 * processed seeds.
 */
export async function recordKeywordSearchBatch(
  db: Db,
  input: {
    batchId: string
    attemptKey?: string
    seedIds?: readonly string[]
    outcomes?: readonly KeywordSearchSeedOutcome[]
    succeededSeedIds?: readonly string[]
    failedSeedIds?: readonly string[]
    retryableSeedIds?: readonly string[]
    error?: string | null
    startedAt?: Date
    finishedAt?: Date | null
    now?: Date
  },
): Promise<KeywordSearchCoverageReport> {
  const [batch] = await db.select().from(keywordSearchCoverageBatches)
    .where(eq(keywordSearchCoverageBatches.id, input.batchId)).limit(1)
  if (!batch) throw new Error(`keyword search coverage batch not found: ${input.batchId}`)
  const run = await getRun(db, batch.runId)
  const allowed = new Set(jsonStrings(batch.seedIds))
  const outcomes = normalizeOutcomes(input)
  const suppliedSeedIds = unique([
    ...jsonStrings(input.seedIds),
    ...outcomes.map((outcome) => outcome.seedId),
  ])
  for (const seedId of suppliedSeedIds) {
    if (!allowed.has(seedId)) throw new Error(`seed is not assigned to batch: ${seedId}`)
  }
  if (!suppliedSeedIds.length) throw new Error('batch attempt must contain at least one seed')
  const failedSeedIds = outcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.seedId)
  const succeededSeedIds = outcomes.filter((outcome) => outcome.status === 'succeeded').map((outcome) => outcome.seedId)
  const retryableSeedIds = outcomes.filter((outcome) => outcome.status === 'failed' && outcome.retryable).map((outcome) => outcome.seedId)
  const now = input.now ?? new Date()
  const attemptKey = clean(input.attemptKey) || stableAttemptKey(batch.id, outcomes, input.error)
  const attempts = await db.select().from(keywordSearchCoverageAttempts)
    .where(eq(keywordSearchCoverageAttempts.batchId, batch.id))
    .orderBy(desc(keywordSearchCoverageAttempts.attemptNumber), desc(keywordSearchCoverageAttempts.createdAt))
  const attemptNumber = (attempts[0] ? Number(attempts[0].attemptNumber) : 0) + 1
  const inserted = await db.insert(keywordSearchCoverageAttempts).values({
    batchId: batch.id,
    attemptKey,
    attemptNumber,
    seedIds: suppliedSeedIds,
    succeededSeedIds,
    failedSeedIds,
    retryableSeedIds,
    processedCount: succeededSeedIds.length + failedSeedIds.filter((seedId) => !retryableSeedIds.includes(seedId)).length,
    error: (clean(input.error) || outcomes.find((outcome) => clean(outcome.error))?.error) ?? null,
    startedAt: input.startedAt ?? now,
    finishedAt: input.finishedAt === undefined ? now : input.finishedAt,
    createdAt: now,
  }).onConflictDoNothing({
    target: [keywordSearchCoverageAttempts.batchId, keywordSearchCoverageAttempts.attemptKey],
  }).returning({ id: keywordSearchCoverageAttempts.id })

  // Preserve the idempotency contract even when the same payload is sent by a
  // restarted worker. No second attempt row means no second retry increment.
  if (!inserted.length) {
    const state = await readAllForRun(db, run.id)
    return {
      ...summaryFrom(state.run, state.batches, state.attempts),
      batches: state.batches.map(asBatch),
    }
  }

  const allAttempts = await db.select().from(keywordSearchCoverageAttempts)
    .where(eq(keywordSearchCoverageAttempts.batchId, batch.id))
    .orderBy(asc(keywordSearchCoverageAttempts.attemptNumber), asc(keywordSearchCoverageAttempts.createdAt), asc(keywordSearchCoverageAttempts.id))
  const nextState = reconcileBatchState(batch, allAttempts)
  const batchUpdatedAt = input.now ?? new Date()
  await db.update(keywordSearchCoverageBatches).set({
    status: nextState.status,
    attemptedSeedIds: nextState.attemptedSeedIds,
    succeededSeedIds: nextState.succeededSeedIds,
    failedSeedIds: nextState.failedSeedIds,
    retriedSeedIds: nextState.retriedSeedIds,
    retryableSeedIds: nextState.retryableSeedIds,
    pendingSeedIds: nextState.pendingSeedIds,
    attemptCount: nextState.attemptCount,
    processedCount: nextState.processedCount,
    lastError: nextState.lastError,
    startedAt: batch.startedAt ?? input.startedAt ?? now,
    finishedAt: nextState.finishedAt,
    updatedAt: batchUpdatedAt,
  }).where(eq(keywordSearchCoverageBatches.id, batch.id))

  const state = await readAllForRun(db, run.id)
  const derived = deriveRunState(state.run, state.batches, state.attempts)
  const runUpdated = await db.update(keywordSearchCoverageRuns).set({
    status: derived.status,
    processedCount: derived.processedCount,
    succeededCount: derived.succeededCount,
    failedCount: derived.failedCount,
    pendingRetryCount: derived.pendingRetryCount,
    retryCount: derived.retryCount,
    remainingCount: derived.remainingCount,
    finishedAt: derived.status === 'completed' || (derived.remainingCount === 0 && derived.pendingRetryCount === 0)
      ? (state.run.finishedAt ?? batchUpdatedAt)
      : null,
    updatedAt: batchUpdatedAt,
  }).where(eq(keywordSearchCoverageRuns.id, state.run.id)).returning()
  const finalRun = runUpdated[0] ?? state.run

  // Keep a batch-local snapshot of global remaining for operator/report tables.
  await db.update(keywordSearchCoverageBatches).set({ remainingCount: derived.remainingCount })
    .where(eq(keywordSearchCoverageBatches.id, batch.id))
  const final = await readAllForRun(db, finalRun.id)
  return {
    ...summaryFrom(final.run, final.batches, final.attempts),
    batches: final.batches.map(asBatch),
  }
}

/** Convenience for callers that have a batch key rather than its UUID. */
export async function recordKeywordSearchBatchByKey(
  db: Db,
  input: Omit<Parameters<typeof recordKeywordSearchBatch>[1], 'batchId'> & {
    runId: string
    batchKey: string
    batchNumber?: number
    seedIds: readonly string[]
  },
): Promise<KeywordSearchCoverageReport> {
  const run = await getRun(db, input.runId)
  const [existing] = await db.select().from(keywordSearchCoverageBatches)
    .where(and(
      eq(keywordSearchCoverageBatches.runId, run.id),
      eq(keywordSearchCoverageBatches.batchKey, clean(input.batchKey)),
    )).limit(1)
  const batch = existing ?? (await db.insert(keywordSearchCoverageBatches).values({
    runId: run.id,
    batchKey: clean(input.batchKey),
    batchNumber: input.batchNumber ?? 1,
    status: 'running',
    seedIds: unique(input.seedIds),
    pendingSeedIds: unique(input.seedIds),
    remainingCount: run.remainingCount,
    startedAt: input.startedAt ?? input.now ?? new Date(),
    updatedAt: input.now ?? new Date(),
    createdAt: input.now ?? new Date(),
  }).onConflictDoNothing({
    target: [keywordSearchCoverageBatches.runId, keywordSearchCoverageBatches.batchKey],
  }).returning())[0]
  if (!batch) throw new Error('keyword search coverage batch was not created')
  return recordKeywordSearchBatch(db, { ...input, batchId: batch.id })
}

async function findRun(
  db: Db,
  input: { runId?: string; coverageKey?: string; runKey?: string },
): Promise<RunRow | null> {
  if (input.runId) {
    const [run] = await db.select().from(keywordSearchCoverageRuns)
      .where(eq(keywordSearchCoverageRuns.id, input.runId)).limit(1)
    return run ?? null
  }
  const coverageKey = clean(input.coverageKey) || DEFAULT_KEYWORD_SEARCH_COVERAGE_KEY
  const rows = await db.select().from(keywordSearchCoverageRuns)
    .where(and(
      eq(keywordSearchCoverageRuns.coverageKey, coverageKey),
      input.runKey ? eq(keywordSearchCoverageRuns.runKey, clean(input.runKey)) : undefined,
    ))
    .orderBy(desc(keywordSearchCoverageRuns.createdAt), desc(keywordSearchCoverageRuns.id))
    .limit(1)
  return rows[0] ?? null
}

/** Read exact coverage from ledger rows; cursorHint is returned only as context. */
export async function readKeywordSearchCoverage(
  db: Db,
  input: { runId?: string; coverageKey?: string; runKey?: string } = {},
): Promise<KeywordSearchCoverageReport | null> {
  const run = await findRun(db, input)
  if (!run) return null
  const state = await readAllForRun(db, run.id)
  return {
    ...summaryFrom(state.run, state.batches, state.attempts),
    batches: state.batches.map(asBatch),
  }
}

export const getKeywordSearchCoverage = readKeywordSearchCoverage

export async function listKeywordSearchCoverageRuns(
  db: Db,
  input: { coverageKey?: string; limit?: number } = {},
): Promise<KeywordSearchCoverageSummary[]> {
  const coverageKey = clean(input.coverageKey) || DEFAULT_KEYWORD_SEARCH_COVERAGE_KEY
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 20), 100))
  const rows = await db.select().from(keywordSearchCoverageRuns)
    .where(eq(keywordSearchCoverageRuns.coverageKey, coverageKey))
    .orderBy(desc(keywordSearchCoverageRuns.createdAt), desc(keywordSearchCoverageRuns.id))
    .limit(limit)
  const output: KeywordSearchCoverageSummary[] = []
  for (const row of rows) {
    const state = await readAllForRun(db, row.id)
    output.push(summaryFrom(state.run, state.batches, state.attempts))
  }
  return output
}

export const listKeywordSearchCoverage = listKeywordSearchCoverageRuns
