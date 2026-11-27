import { createHash } from 'node:crypto'
import { asc, gt, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  intelligenceSources,
  keywords,
  observations,
  sourceItems,
} from '@/lib/db/schema'
import {
  isAutoDiscoveredSource,
  sourceFamilyForCollector,
} from './source-family'

/**
 * A source-family repair is intentionally small in scope.  The collector
 * registry owns the source-family rule; this module only reconciles the two
 * denormalized copies in intelligence_sources.  In particular, it never
 * enables a source and never touches a collected document or a keyword.
 */
export const DEFAULT_SOURCE_FAMILY_BATCH_SIZE = 500
const MAX_SOURCE_FAMILY_BATCH_SIZE = 5_000

type JsonObject = Record<string, unknown>

export type SourceFamilyReconcileMode = 'dry-run' | 'apply'

export type SourceFamilyReconcileOptions = {
  /** Defaults to dry-run. */
  mode?: SourceFamilyReconcileMode
  /** Convenience alias for callers that do not use mode. */
  apply?: boolean
  /** The second, independent apply acknowledgement. */
  confirm?: boolean
  /** Alias used by a few operators in scripts. */
  confirmApply?: boolean
  batchSize?: number
}

export type SourceFamilyChange = {
  sourceId: string
  sourceKey: string
  currentSourceFamily: string | null
  nextSourceFamily: string
  currentConfigSourceFamily: unknown
  nextConfigSourceFamily: string
}

type SourceFamilyCandidate = SourceFamilyChange & {
  /** Snapshot used only by the transactional writer; not part of the report contract. */
  currentConfig: unknown
}

export type SourceFamilyInvariantChecks = {
  enabled: boolean
  status: boolean
  parserSpec: boolean
  sourceItems: boolean
  keywords: boolean
  observations: boolean
  /** True only when every named invariant above is true. */
  allPreserved: boolean
}

export type SourceFamilyReconcileVerification = SourceFamilyInvariantChecks & {
  /** The proposed family was deterministic for every candidate. */
  projectedCanonical: boolean
  /** The persisted rows are canonical after an apply.  Dry-run is false when work remains. */
  databaseCanonical: boolean
}

export type SourceFamilyReconcileResult = {
  mode: SourceFamilyReconcileMode
  batchSize: number
  batches: number
  scanned: number
  autoDiscovered: number
  candidates: number
  wouldUpdate: number
  updated: number
  unchanged: number
  withoutCanonicalFamily: number
  changes: SourceFamilyChange[]
  verification: SourceFamilyReconcileVerification
}

type SourceRow = typeof intelligenceSources.$inferSelect

/** The subset of a config used to decide whether a row is an auto-discovery row. */
function sourceFamilyInput(row: SourceRow): Record<string, unknown> {
  const config = isRecord(row.config) ? row.config : {}
  return {
    ...config,
    name: row.name,
    type: config.type ?? row.sourceType,
    sourceType: row.sourceType,
    sourceUrl: row.baseUrl,
    baseUrl: row.baseUrl,
    sourceFamily: config.sourceFamily ?? row.sourceFamily,
    config: row.config,
  }
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function configSourceFamily(value: unknown): unknown {
  return isRecord(value) ? value.sourceFamily : undefined
}

function normalizedBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SOURCE_FAMILY_BATCH_SIZE
  if (!Number.isInteger(value) || value < 1 || value > MAX_SOURCE_FAMILY_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer between 1 and ${MAX_SOURCE_FAMILY_BATCH_SIZE}`)
  }
  return value
}

function requestedApply(options: SourceFamilyReconcileOptions): boolean {
  return options.mode === 'apply' || options.apply === true
}

function confirmedApply(options: SourceFamilyReconcileOptions): boolean {
  return options.confirm === true || options.confirmApply === true
}

function modeFor(options: SourceFamilyReconcileOptions): SourceFamilyReconcileMode {
  if (options.mode === 'dry-run' && options.apply === true) {
    throw new Error('mode dry-run cannot be combined with apply=true')
  }
  if (options.mode === 'apply' && options.apply === false) {
    throw new Error('mode apply cannot be combined with apply=false')
  }
  const apply = requestedApply(options)
  if (apply && !confirmedApply(options)) {
    throw new Error('source-family apply requires both --apply and --confirm-source-family')
  }
  if (!apply && options.mode === 'apply') {
    throw new Error('source-family apply requires an explicit confirmation')
  }
  return apply ? 'apply' : 'dry-run'
}

function stableJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(stableJson)
  if (!isRecord(value)) return value
  const output: JsonObject = {}
  for (const key of Object.keys(value).sort()) {
    const normalized = stableJson(value[key])
    if (normalized !== undefined) output[key] = normalized
  }
  return output
}

function stableJsonString(value: unknown): string {
  return JSON.stringify(stableJson(value))
}

function digestRows(rows: readonly unknown[], key?: (row: unknown) => string): string {
  const digest = createHash('sha256')
  const ordered = [...rows].sort((left, right) => {
    if (key) return key(left).localeCompare(key(right), 'en-US')
    return stableJsonString(left).localeCompare(stableJsonString(right), 'en-US')
  })
  for (const row of ordered) digest.update(stableJsonString(row)).update('\n')
  return digest.digest('hex')
}

/**
 * Remove the one permitted nested mutation from a config.  Empty objects and
 * null are equivalent here: the apply may have to create `{ sourceFamily }`
 * when an old row had no config at all.
 */
function configWithoutSourceFamily(value: unknown): unknown {
  if (!isRecord(value)) return null
  const output = { ...value }
  delete output.sourceFamily
  return Object.keys(output).length ? output : null
}

function sourceWithoutAllowedFamily(row: SourceRow, allowedIds: ReadonlySet<string>): unknown {
  if (!allowedIds.has(row.id)) return row
  const { sourceFamily: _sourceFamily, config, ...rest } = row
  return {
    ...rest,
    config: configWithoutSourceFamily(config),
  }
}

type InvariantSnapshot = {
  sourceRows: SourceRow[]
  sourceRowsDigest: string
  enabledDigest: string
  statusDigest: string
  parserSpecDigest: string
  sourceItemsDigest: string
  keywordsDigest: string
  observationsDigest: string
}

/**
 * Capture all data that this repair is forbidden to mutate.  The full row
 * digests make this stronger than count-only checks: a changed status,
 * parserSpec, payload, title, keyword, or observation is detected even when
 * the row count stays the same.
 */
async function captureInvariantSnapshot(
  db: Db,
  allowedFamilySourceIds: ReadonlySet<string>,
): Promise<InvariantSnapshot> {
  const [sourceRows, itemRows, keywordRows, observationRows] = await Promise.all([
    db.select().from(intelligenceSources),
    db.select().from(sourceItems),
    db.select().from(keywords),
    db.select().from(observations),
  ])

  return {
    sourceRows,
    sourceRowsDigest: digestRows(sourceRows.map((row) => sourceWithoutAllowedFamily(row, allowedFamilySourceIds))),
    enabledDigest: digestRows(sourceRows.map((row) => ({
      id: row.id,
      enabled: row.enabled,
      configEnabled: configValue(row.config, 'enabled'),
    })), (row) => String((row as { id: string }).id)),
    statusDigest: digestRows([
      ...sourceRows.map((row) => ({
        kind: 'source', id: row.id,
        status: configValue(row.config, 'status'),
        onboardingStatus: configValue(row.config, 'onboardingStatus'),
      })),
      ...itemRows.map((row) => ({ kind: 'source_item', id: row.id, status: row.status })),
      ...keywordRows.map((row) => ({ kind: 'keyword', id: row.id, status: row.status })),
    ], (row) => {
      const value = row as { kind: string; id: string }
      return `${value.kind}:${value.id}`
    }),
    parserSpecDigest: digestRows(sourceRows.map((row) => ({
      id: row.id,
      parserSpec: configValue(row.config, 'parserSpec'),
    })), (row) => String((row as { id: string }).id)),
    sourceItemsDigest: digestRows(itemRows, (row) => String((row as { id: string }).id)),
    keywordsDigest: digestRows(keywordRows, (row) => String((row as { id: string }).id)),
    observationsDigest: digestRows(observationRows, (row) => String((row as { id: string }).id)),
  }
}

function configValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function compareInvariantSnapshots(
  before: InvariantSnapshot,
  after: InvariantSnapshot,
): SourceFamilyInvariantChecks {
  const checks = {
    enabled: before.enabledDigest === after.enabledDigest,
    status: before.statusDigest === after.statusDigest,
    parserSpec: before.parserSpecDigest === after.parserSpecDigest,
    sourceItems: before.sourceItemsDigest === after.sourceItemsDigest,
    keywords: before.keywordsDigest === after.keywordsDigest,
    observations: before.observationsDigest === after.observationsDigest,
  }
  return { ...checks, allPreserved: Object.values(checks).every(Boolean) }
}

type CandidateScan = {
  candidates: SourceFamilyCandidate[]
  scanned: number
  autoDiscovered: number
  unchanged: number
  withoutCanonicalFamily: number
  batches: number
}

/**
 * Read in keyset batches so a large operational source table is never loaded
 * into memory in one query.  UUID ordering is stable for this point-in-time
 * scan and no source row is modified by discovery itself.
 */
async function collectCandidates(db: Db, batchSize: number): Promise<CandidateScan> {
  const candidates: SourceFamilyCandidate[] = []
  let cursor: string | null = null
  let scanned = 0
  let autoDiscovered = 0
  let unchanged = 0
  let withoutCanonicalFamily = 0
  let batches = 0

  while (true) {
    const rows: SourceRow[] = cursor
      ? await db.select().from(intelligenceSources)
        .where(gt(intelligenceSources.id, cursor))
        .orderBy(asc(intelligenceSources.id))
        .limit(batchSize)
      : await db.select().from(intelligenceSources)
        .orderBy(asc(intelligenceSources.id))
        .limit(batchSize)
    if (!rows.length) break
    batches += 1
    scanned += rows.length
    cursor = rows.at(-1)!.id

    for (const row of rows) {
      if (!isAutoDiscoveredSource(sourceFamilyInput(row))) continue
      autoDiscovered += 1
      const canonical = sourceFamilyForCollector(sourceFamilyInput(row))
      if (!canonical) {
        withoutCanonicalFamily += 1
        continue
      }
      const currentConfigSourceFamily = configSourceFamily(row.config)
      if (row.sourceFamily === canonical && currentConfigSourceFamily === canonical) {
        unchanged += 1
        continue
      }
      candidates.push({
        sourceId: row.id,
        sourceKey: row.sourceKey,
        currentSourceFamily: row.sourceFamily,
        nextSourceFamily: canonical,
        currentConfigSourceFamily,
        nextConfigSourceFamily: canonical,
        currentConfig: row.config,
      })
    }
  }

  return { candidates, scanned, autoDiscovered, unchanged, withoutCanonicalFamily, batches }
}

function configWithSourceFamily(value: unknown, family: string): JsonObject {
  return {
    ...(isRecord(value) ? value : {}),
    sourceFamily: family,
  }
}

async function applyCandidates(db: Db, candidates: readonly SourceFamilyCandidate[], batchSize: number): Promise<number> {
  let updated = 0
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize)
    if (!batch.length) continue
    // One parameterized UPDATE per batch keeps a 20k-row repair bounded by
    // roughly 20–40 round trips instead of one round trip per source.  The
    // current-family predicate makes a concurrent repair harmless: an already
    // canonical row is simply not counted as our update and is verified below.
    const values = batch.map((candidate) => sql`(
      ${candidate.sourceId}::uuid,
      ${candidate.currentSourceFamily},
      ${candidate.nextSourceFamily},
      ${JSON.stringify(configWithSourceFamily(candidate.currentConfig, candidate.nextConfigSourceFamily))}::jsonb
    )`)
    const outcome = await db.execute(sql`
      UPDATE ${intelligenceSources} AS target
      SET source_family = incoming.next_source_family,
          config = incoming.next_config
      FROM (VALUES ${sql.join(values, sql`, `)}) AS incoming(id, current_source_family, next_source_family, next_config)
      WHERE target.id = incoming.id
        AND target.source_family IS NOT DISTINCT FROM incoming.current_source_family
    `) as unknown as { rowCount?: number; length?: number }
    updated += typeof outcome.rowCount === 'number'
      ? outcome.rowCount
      : typeof outcome.length === 'number' ? outcome.length : batch.length
  }
  return updated
}

function databaseCanonical(rows: readonly SourceRow[]): boolean {
  return rows.every((row) => {
    if (!isAutoDiscoveredSource(sourceFamilyInput(row))) return true
    const canonical = sourceFamilyForCollector(sourceFamilyInput(row))
    return !canonical || (row.sourceFamily === canonical && configSourceFamily(row.config) === canonical)
  })
}

function projectedCanonical(candidates: readonly SourceFamilyChange[]): boolean {
  return candidates.every((candidate) => candidate.nextSourceFamily === candidate.nextConfigSourceFamily)
}

function publicChanges(candidates: readonly SourceFamilyCandidate[]): SourceFamilyChange[] {
  return candidates.map(({ currentConfig: _currentConfig, ...change }) => change)
}

async function runReconcile(
  db: Db,
  mode: SourceFamilyReconcileMode,
  batchSize: number,
): Promise<SourceFamilyReconcileResult> {
  if (mode === 'dry-run') {
    const scan = await collectCandidates(db, batchSize)
    const allowedIds = new Set(scan.candidates.map((candidate) => candidate.sourceId))
    const before = await captureInvariantSnapshot(db, allowedIds)
    const after = await captureInvariantSnapshot(db, allowedIds)
    const immutable = compareInvariantSnapshots(before, after)
    return {
      mode,
      batchSize,
      batches: scan.batches,
      scanned: scan.scanned,
      autoDiscovered: scan.autoDiscovered,
      candidates: scan.candidates.length,
      wouldUpdate: scan.candidates.length,
      updated: 0,
      unchanged: scan.unchanged,
      withoutCanonicalFamily: scan.withoutCanonicalFamily,
      changes: publicChanges(scan.candidates),
      verification: {
        ...immutable,
        projectedCanonical: projectedCanonical(scan.candidates),
        databaseCanonical: databaseCanonical(before.sourceRows),
      },
    }
  }

  // One transaction covers all batches.  Batching bounds each query/update
  // set while the transaction makes the allow-list and invariant snapshots
  // share one consistent database view.
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const scan = await collectCandidates(transactionalDb, batchSize)
    const allowedIds = new Set(scan.candidates.map((candidate) => candidate.sourceId))
    const before = await captureInvariantSnapshot(transactionalDb, allowedIds)
    const updated = await applyCandidates(transactionalDb, scan.candidates, batchSize)
    const after = await captureInvariantSnapshot(transactionalDb, allowedIds)
    const immutable = compareInvariantSnapshots(before, after)
    if (!immutable.allPreserved) {
      throw new Error(`source-family invariant violation: ${JSON.stringify(immutable)}`)
    }
    const canonical = databaseCanonical(after.sourceRows)
    if (!canonical) throw new Error('source-family apply did not produce canonical rows')
    return {
      mode,
      batchSize,
      batches: scan.batches,
      scanned: scan.scanned,
      autoDiscovered: scan.autoDiscovered,
      candidates: scan.candidates.length,
      wouldUpdate: scan.candidates.length,
      updated,
      unchanged: scan.unchanged,
      withoutCanonicalFamily: scan.withoutCanonicalFamily,
      changes: publicChanges(scan.candidates),
      verification: {
        ...immutable,
        projectedCanonical: projectedCanonical(scan.candidates),
        databaseCanonical: canonical,
      },
    }
  })
}

/**
 * Reconcile canonical families for automatic-discovery rows.
 *
 * `apply: true` without `confirm: true` is rejected deliberately.  Callers
 * should normally use the CLI, whose two flags are `--apply` and
 * `--confirm-source-family`.
 */
export async function reconcileAutoDiscoveredSourceFamilies(
  db: Db,
  options: SourceFamilyReconcileOptions = {},
): Promise<SourceFamilyReconcileResult> {
  const mode = modeFor(options)
  return runReconcile(db, mode, normalizedBatchSize(options.batchSize))
}
