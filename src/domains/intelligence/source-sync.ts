import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { intelligenceSources, sourceItemChanges, sourceItems, sourceRuns } from '@/lib/db/schema'
import { isAutoDiscoveredSource, sourceFamilyForCollector } from './source-family'

type JsonObject = Record<string, unknown>
export type SourceTimestamp = Date | string | number
export type SourceRunStatus = 'running' | 'succeeded' | 'warning' | 'failed' | 'skipped'

/** The legacy source identity is intentionally separate from a target UUID. */
export type LegacySourceDefinitionInput = {
  sourceKey?: string | null
  legacySourceId?: string | number | null
  id?: string | number | null
  name?: string | null
  sourceType?: string | null
  type?: string | null
  sourceFamily?: string | null
  baseUrl?: string | null
  url?: string | null
  enabled?: boolean
  cadenceMinutes?: number | null
  config?: JsonObject | null
}

export type LegacySourceItemInput = {
  sourceItemKey?: string | number | null
  itemKey?: string | number | null
  legacyItemId?: string | number | null
  id?: string | number | null
  sourceUrl?: string | null
  url?: string | null
  link?: string | null
  title?: string | null
  fingerprint?: string | null
  payload?: JsonObject | null
  /** Unmodified legacy row or collector response, retained under payload.raw. */
  raw?: JsonObject | null
  /** Source URL/collector metadata retained under payload.provenance. */
  provenance?: JsonObject | null
  rawProvenance?: JsonObject | null
  observedAt?: SourceTimestamp | null
  parserVersion?: string | null
}

export type LegacySourceRunDetails = {
  runKey?: string | null
  trigger?: string | null
  attempted?: boolean
  collectorMethod?: string | null
  legacyRunId?: string | number | null
  runId?: string | number | null
  idempotencyKey?: string | null
  status?: SourceRunStatus
  checkpointBefore?: JsonObject | null
  checkpointAfter?: JsonObject | null
  itemsSeen?: number
  itemsAccepted?: number
  latencyMs?: number | null
  error?: string | Error | null
  startedAt?: SourceTimestamp | null
  finishedAt?: SourceTimestamp | null
}

/**
 * A flat form is convenient for a small script, while `source`/`run` lets a
 * later collector pass registry and execution records without reshaping them.
 */
export type LegacySourceRunInput = LegacySourceRunDetails & LegacySourceDefinitionInput & {
  source?: LegacySourceDefinitionInput
  run?: LegacySourceRunDetails
  sourceId?: string | number | null
  sourceConfig?: JsonObject | null
  items?: readonly LegacySourceItemInput[]
  harvestedItems?: readonly LegacySourceItemInput[]
}

export type LegacySourceSyncOptions = {
  /** Omit the persisted item read when the caller only needs run-level counts. */
  mode?: 'full' | 'summary'
}

export type LegacySourceSyncResult = {
  source: typeof intelligenceSources.$inferSelect
  run: typeof sourceRuns.$inferSelect
  items: Array<typeof sourceItems.$inferSelect>
  sourceKey: string
  runKey: string
  sourceInserted: boolean
  runInserted: boolean
  itemsInserted: number
  itemsUpdated: number
  itemsUnchanged: number
  changeEventIds: string[]
  itemsSeen: number
  itemsAccepted: number
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(stableJson)
  if (!isRecord(value)) return value

  const result: JsonObject = {}
  for (const key of Object.keys(value).sort()) {
    const normalized = stableJson(value[key])
    if (normalized !== undefined) result[key] = normalized
  }
  return result
}

function stableJsonString(value: unknown): string {
  return JSON.stringify(stableJson(value))
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).normalize('NFKC').trim()
  return normalized || null
}

function stableToken(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/\s+/g, '-')
}

/**
 * Return the target source key for a legacy source. Explicit target keys are
 * respected; registry IDs are namespaced so future target sources cannot
 * accidentally collide with a legacy collector.
 */
export function stableSourceKey(input: Pick<LegacySourceDefinitionInput, 'sourceKey' | 'legacySourceId' | 'id'>): string {
  const explicit = nonEmpty(input.sourceKey)
  if (explicit) return stableToken(explicit)

  const legacyId = nonEmpty(input.legacySourceId ?? input.id)
  if (!legacyId) throw new TypeError('a sourceKey or legacy source id is required')
  return `legacy:${stableToken(legacyId)}`
}

export const legacySourceKey = stableSourceKey

function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16)
  // RFC 4122 version 5/variant bits over a SHA-256-derived identity.
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function parseTimestamp(value: SourceTimestamp, label: string): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError(`${label} must be a valid date`)
    return new Date(value.getTime())
  }

  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,}$/.test(value.trim()))) {
    const numeric = typeof value === 'number' ? value : Number(value)
    const milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric
    const date = new Date(milliseconds)
    if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`)
    return date
  }

  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`)
  return date
}

function optionalTimestamp(value: SourceTimestamp | null | undefined, label: string): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return parseTimestamp(value, label)
}

function optionalString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  return nonEmpty(value)
}

function errorMessage(value: string | Error | null | undefined): string | null {
  if (value == null) return null
  if (value instanceof Error) return value.message || value.name
  const message = value.trim()
  return message || null
}

function nonNegativeInteger(value: number | null | undefined, label: string): number | null | undefined {
  if (value === undefined || value === null) return value
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative number`)
  return Math.round(value)
}

function sourceField<T>(source: LegacySourceDefinitionInput, input: LegacySourceRunInput, key: keyof LegacySourceDefinitionInput): T | undefined {
  if (source[key] !== undefined) return source[key] as T
  return input[key] as T | undefined
}

function normalizePayload(item: LegacySourceItemInput): JsonObject | null {
  const payload: JsonObject = isRecord(item.payload) ? { ...item.payload } : {}
  if (item.raw !== undefined) payload.raw = stableJson(item.raw)
  const provenance = item.provenance !== undefined ? item.provenance : item.rawProvenance
  if (provenance !== undefined) payload.provenance = stableJson(provenance)
  if (!Object.keys(payload).length) return null
  return stableJson(payload) as JsonObject
}

function itemString(item: LegacySourceItemInput, ...keys: Array<keyof LegacySourceItemInput>): string | null {
  for (const key of keys) {
    const value = nonEmpty(item[key])
    if (value) return value
  }
  return null
}

function normalizeItem(sourceKey: string, item: LegacySourceItemInput): {
  sourceItemKey: string
  sourceUrl: string | null
  title: string | null
  fingerprint: string
  payload: JsonObject | null
  observedAt: Date | null
  parserVersion: string
} {
  const sourceUrl = itemString(item, 'sourceUrl', 'url', 'link')
  const title = itemString(item, 'title')
  const payload = normalizePayload(item)
  const sourceItemKey = itemString(item, 'sourceItemKey', 'itemKey', 'legacyItemId', 'id')
    ?? `item:${createHash('sha256').update(stableJsonString({ sourceUrl, title, payload })).digest('hex')}`
  // provenance에는 실행일·라인 번호가 들어가므로 내용 동일성 해시에 포함하지 않는다.
  // 같은 문서를 다음 날 다시 확인해도 의미 있는 원문 필드가 같으면 unchanged여야 한다.
  const fingerprintPayload = isRecord(item.payload)
    ? item.payload
    : isRecord(item.raw)
      ? item.raw
      : null
  const fingerprint = itemString(item, 'fingerprint')
    ?? createHash('sha256').update(stableJsonString({ sourceKey, sourceItemKey, sourceUrl, title, payload: fingerprintPayload })).digest('hex')
  const observedAt = item.observedAt === undefined || item.observedAt === null
    ? null
    : parseTimestamp(item.observedAt, 'item observedAt')

  const parserVersion = nonEmpty(item.parserVersion) ?? 'collector-v1'
  return { sourceItemKey, sourceUrl, title, fingerprint, payload, observedAt, parserVersion }
}

function sourceMetadata(input: LegacySourceRunInput, source: LegacySourceDefinitionInput, sourceKey: string): {
  name: string
  sourceType: string
  sourceFamily: string | null
  baseUrl: string | null
  enabled: boolean
  cadenceMinutes: number | null
  config: JsonObject | null
} {
  const name = nonEmpty(sourceField<string | null>(source, input, 'name')) ?? sourceKey
  const sourceType = nonEmpty(sourceField<string | null>(source, input, 'sourceType'))
    ?? nonEmpty(sourceField<string | null>(source, input, 'type'))
    ?? 'legacy'
  const explicitSourceFamily = optionalString(sourceField<string | null>(source, input, 'sourceFamily')) ?? null
  const baseUrl = optionalString(sourceField<string | null>(source, input, 'baseUrl'))
    ?? optionalString(sourceField<string | null>(source, input, 'url'))
    ?? null
  const cadenceMinutes = sourceField<number | null>(source, input, 'cadenceMinutes') ?? null
  const config = source.config !== undefined
    ? source.config
    : input.sourceConfig !== undefined
      ? input.sourceConfig
      : input.config ?? null
  const autoBlocked = isAutoDiscoveredSource({
    ...source,
    name,
    sourceFamily: explicitSourceFamily,
    sourceUrl: baseUrl,
    baseUrl,
    config,
  })
  const sourceFamily = sourceFamilyForCollector({
    ...source,
    sourceFamily: explicitSourceFamily,
    sourceUrl: baseUrl,
    baseUrl,
    config,
  }) ?? null
  const enabled = autoBlocked ? false : sourceField<boolean | undefined>(source, input, 'enabled') ?? true
  const persistedConfig = config === null
    ? (autoBlocked ? { enabled: false, autoDiscovered: true, collectionBlocked: 'auto-discovery' } : null)
    : autoBlocked
      ? {
          ...(stableJson(config) as JsonObject),
          enabled: false,
          autoDiscovered: true,
          collectionBlocked: 'auto-discovery',
        }
      : stableJson(config) as JsonObject

  return {
    name,
    sourceType,
    sourceFamily,
    baseUrl,
    enabled,
    cadenceMinutes: nonNegativeInteger(cadenceMinutes, 'cadenceMinutes') ?? null,
    config: persistedConfig,
  }
}

function explicitRunKey(run: LegacySourceRunDetails, input: LegacySourceRunInput): string | null {
  return nonEmpty(run.runKey)
    ?? nonEmpty(run.legacyRunId)
    ?? nonEmpty(run.runId)
    ?? nonEmpty(run.idempotencyKey)
    ?? nonEmpty(input.idempotencyKey)
}

function normalizedRunDetails(input: LegacySourceRunInput): {
  run: LegacySourceRunDetails
  items: readonly LegacySourceItemInput[]
} {
  const run = input.run ?? input
  const items = input.items ?? input.harvestedItems ?? []
  return { run, items }
}

function inferredCollectorMethod(metadata: ReturnType<typeof sourceMetadata>): string {
  const config = metadata.config ?? {}
  const type = nonEmpty(config.type) ?? metadata.sourceType
  if (type === 'google_news_rss') return 'google-news-rss-search'
  if (type === 'naver_cafe') return config.search ? 'naver-cafe-public-api+keyword-search' : 'naver-cafe-public-api'
  if (type === 'naver_blog') return 'naver-blog-public-post-list+detail'
  if (type === 'sitemap') {
    if (config.fetchPageBodyFacts) return 'sitemap+html-body-facts'
    if (config.fetchPageMetadata) return 'sitemap+html-metadata'
    return 'sitemap-url-metadata'
  }
  if (type === 'rss') return config.fetchPageBodyFacts ? 'rss+html-body-facts' : 'rss-feed'
  if (type === 'webpage') return config.parserSpec ? 'webpage-list-parser' : 'webpage-html'
  if (metadata.sourceType === 'search-discovery') return 'naver-public-html-search'
  return nonEmpty(type) ?? 'unknown'
}

/**
 * Record one legacy collector execution and its raw harvested signals.
 *
 * The source and run identities are deterministic. Source items use the stable
 * `(source_id, source_item_key)` business identity, so a later run updates the
 * same document instead of appending another copy. Insert/update detection and
 * its outbox event are committed with the document in one transaction.
 */
export async function syncLegacySourceRun(
  db: Db,
  input: LegacySourceRunInput,
  options: LegacySourceSyncOptions = {},
): Promise<LegacySourceSyncResult> {
  const sourceInput = input.source ?? input
  const sourceKey = stableSourceKey({
    sourceKey: sourceInput.sourceKey ?? input.sourceKey,
    legacySourceId: sourceInput.legacySourceId ?? input.legacySourceId ?? input.sourceId,
    id: sourceInput.id,
  })
  const metadata = sourceMetadata(input, sourceInput, sourceKey)
  const { run, items } = normalizedRunDetails(input)
  const autoBlocked = isAutoDiscoveredSource({
    ...sourceInput,
    name: metadata.name,
    sourceFamily: metadata.sourceFamily,
    sourceUrl: metadata.baseUrl,
    baseUrl: metadata.baseUrl,
    config: metadata.config,
  })
  // Keep the run/checkpoint auditable, but never persist harvested items from
  // an automatic discovery lane.  The incremental ingest gate applies the
  // same rule to any already-existing outbox rows.
  const normalizedItems = autoBlocked
    ? []
    : [...new Map(items.map((item) => {
        const normalized = normalizeItem(sourceKey, item)
        return [normalized.sourceItemKey, normalized] as const
      })).values()]
  const acceptedItems = normalizedItems
  const runError = errorMessage(run.error)
  const status = run.status ?? (runError ? 'failed' : 'succeeded')
  const startedAt = run.startedAt === undefined || run.startedAt === null
    ? new Date()
    : parseTimestamp(run.startedAt, 'run startedAt')
  const finishedAtInput = optionalTimestamp(run.finishedAt, 'run finishedAt')
  const finishedAt = finishedAtInput === undefined
    ? status === 'running' ? null : new Date()
    : finishedAtInput
  if (finishedAt && finishedAt.getTime() < startedAt.getTime()) {
    throw new TypeError('run finishedAt must not precede startedAt')
  }

  const runKey = stableToken(explicitRunKey(run, input) ?? createHash('sha256').update(stableJsonString({
    sourceKey,
    status,
    items: normalizedItems.map((item) => item.sourceItemKey),
    startedAt: run.startedAt ?? null,
    checkpointBefore: run.checkpointBefore ?? null,
    checkpointAfter: run.checkpointAfter ?? null,
  })).digest('hex'))
  const trigger = nonEmpty(run.trigger) ?? nonEmpty(input.trigger) ?? 'unknown'
  const attempted = run.attempted ?? input.attempted ?? status !== 'skipped'
  const collectorMethod = nonEmpty(run.collectorMethod) ?? nonEmpty(input.collectorMethod)
    ?? inferredCollectorMethod(metadata)
  const itemsSeen = nonNegativeInteger(run.itemsSeen, 'itemsSeen') ?? items.length
  const itemsAccepted = autoBlocked
    ? 0
    : nonNegativeInteger(run.itemsAccepted, 'itemsAccepted') ?? normalizedItems.length
  const latencyMs = nonNegativeInteger(
    run.latencyMs ?? (finishedAt ? finishedAt.getTime() - startedAt.getTime() : null),
    'latencyMs',
  ) ?? null

  return db.transaction(async (tx) => {
    const sourceId = stableUuid(`lawfirm-ads:legacy-source:v1:${sourceKey}`)
    const existingSource = (await tx.select().from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, sourceKey)).limit(1))[0]
    await tx.insert(intelligenceSources).values({
      id: sourceId,
      sourceKey,
      name: metadata.name,
      sourceType: metadata.sourceType,
      sourceFamily: metadata.sourceFamily,
      baseUrl: metadata.baseUrl,
      enabled: metadata.enabled,
      cadenceMinutes: metadata.cadenceMinutes,
      config: metadata.config,
    }).onConflictDoNothing({ target: intelligenceSources.sourceKey })
    const source = (await tx.select().from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, sourceKey)).limit(1))[0]
    if (!source) throw new Error(`source ${sourceKey} was not persisted`)

    await tx.update(intelligenceSources).set({
      name: metadata.name,
      sourceType: metadata.sourceType,
      sourceFamily: metadata.sourceFamily,
      baseUrl: metadata.baseUrl,
      enabled: metadata.enabled,
      cadenceMinutes: metadata.cadenceMinutes,
      config: metadata.config,
      updatedAt: new Date(),
    }).where(eq(intelligenceSources.id, source.id))
    const refreshedSource = (await tx.select().from(intelligenceSources)
      .where(eq(intelligenceSources.id, source.id)).limit(1))[0]
    if (!refreshedSource) throw new Error(`source ${sourceKey} disappeared during sync`)

    const runId = stableUuid(`lawfirm-ads:legacy-source-run:v1:${sourceKey}:${runKey}`)
    const existingRun = (await tx.select().from(sourceRuns)
      .where(eq(sourceRuns.id, runId)).limit(1))[0]
    await tx.insert(sourceRuns).values({
      id: runId,
      sourceId: refreshedSource.id,
      runKey,
      trigger,
      attempted,
      sourceKey,
      sourceName: metadata.name,
      sourceType: metadata.sourceType,
      sourceFamily: metadata.sourceFamily,
      sourceUrl: metadata.baseUrl,
      collectorMethod,
      collectorConfig: metadata.config ?? {},
      status,
      checkpointBefore: run.checkpointBefore === undefined ? null : stableJson(run.checkpointBefore) as JsonObject | null,
      checkpointAfter: run.checkpointAfter === undefined ? null : stableJson(run.checkpointAfter) as JsonObject | null,
      itemsSeen,
      itemsAccepted,
      latencyMs,
      error: runError,
      startedAt,
      finishedAt,
    }).onConflictDoNothing({ target: sourceRuns.id })
    await tx.update(sourceRuns).set({
      sourceId: refreshedSource.id,
      runKey,
      trigger,
      attempted,
      sourceKey,
      sourceName: metadata.name,
      sourceType: metadata.sourceType,
      sourceFamily: metadata.sourceFamily,
      sourceUrl: metadata.baseUrl,
      collectorMethod,
      collectorConfig: metadata.config ?? {},
      status,
      checkpointBefore: run.checkpointBefore === undefined ? null : stableJson(run.checkpointBefore) as JsonObject | null,
      checkpointAfter: run.checkpointAfter === undefined ? null : stableJson(run.checkpointAfter) as JsonObject | null,
      itemsSeen,
      itemsAccepted,
      latencyMs,
      error: runError,
      startedAt,
      finishedAt,
    }).where(eq(sourceRuns.id, runId))
    const persistedRun = (await tx.select().from(sourceRuns).where(eq(sourceRuns.id, runId)).limit(1))[0]
    if (!persistedRun) throw new Error(`run ${runKey} was not persisted`)

    let itemsInserted = 0
    let itemsUpdated = 0
    let itemsUnchanged = 0
    const seenAt = finishedAt ?? startedAt
    const itemRows = acceptedItems.map((item) => ({
      sourceId: refreshedSource.id,
      sourceRunId: persistedRun.id,
      firstSeenRunId: persistedRun.id,
      lastSeenRunId: persistedRun.id,
      sourceItemKey: item.sourceItemKey,
      sourceUrl: item.sourceUrl,
      fingerprint: item.fingerprint,
      title: item.title,
      payload: item.payload,
      status: 'observed',
      observedAt: item.observedAt ?? seenAt,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      isCurrent: true,
      parserVersion: item.parserVersion,
    }))
    const existingItems = itemRows.length
      ? await tx.select().from(sourceItems).where(and(
          eq(sourceItems.sourceId, refreshedSource.id),
          inArray(sourceItems.sourceItemKey, itemRows.map((item) => item.sourceItemKey)),
        ))
      : []
    const existingByKey = new Map(existingItems.map((item) => [item.sourceItemKey, item]))
    const persistedByKey = new Map<string, typeof sourceItems.$inferSelect>()
    for (let offset = 0; offset < itemRows.length; offset += 500) {
      const persisted = await tx.insert(sourceItems).values(itemRows.slice(offset, offset + 500))
        .onConflictDoUpdate({
          target: [sourceItems.sourceId, sourceItems.sourceItemKey],
          set: {
            sourceRunId: sql`excluded.source_run_id`,
            lastSeenRunId: sql`excluded.last_seen_run_id`,
            sourceUrl: sql`excluded.source_url`,
            fingerprint: sql`excluded.fingerprint`,
            title: sql`excluded.title`,
            payload: sql`excluded.payload`,
            observedAt: sql`excluded.observed_at`,
            lastSeenAt: sql`excluded.last_seen_at`,
            isCurrent: true,
            parserVersion: sql`excluded.parser_version`,
          },
        })
        .returning()
      for (const item of persisted) persistedByKey.set(item.sourceItemKey, item)
    }

    const changeRows: Array<typeof sourceItemChanges.$inferInsert> = []
    for (const item of acceptedItems) {
      const previous = existingByKey.get(item.sourceItemKey)
      const persisted = persistedByKey.get(item.sourceItemKey)
      if (!persisted) throw new Error(`source item ${item.sourceItemKey} was not persisted`)
      if (!previous) {
        itemsInserted += 1
        changeRows.push({
          sourceRunId: persistedRun.id,
          sourceItemId: persisted.id,
          changeType: 'inserted',
          previousFingerprint: null,
          nextFingerprint: item.fingerprint,
        })
      } else if (previous.fingerprint !== item.fingerprint || previous.parserVersion !== item.parserVersion) {
        itemsUpdated += 1
        changeRows.push({
          sourceRunId: persistedRun.id,
          sourceItemId: persisted.id,
          changeType: 'updated',
          previousFingerprint: previous.fingerprint,
          nextFingerprint: item.fingerprint,
        })
      } else {
        itemsUnchanged += 1
      }
    }
    const changeEventIds: string[] = []
    for (let offset = 0; offset < changeRows.length; offset += 500) {
      const inserted = await tx.insert(sourceItemChanges).values(changeRows.slice(offset, offset + 500))
        .onConflictDoNothing({
          target: [sourceItemChanges.sourceRunId, sourceItemChanges.sourceItemId, sourceItemChanges.nextFingerprint],
        })
        .returning({ id: sourceItemChanges.id })
      changeEventIds.push(...inserted.map((row) => row.id))
    }

    const persistedItems: Array<typeof sourceItems.$inferSelect> = options.mode === 'summary'
      ? []
      : [...persistedByKey.values()]
    return {
      source: refreshedSource,
      run: persistedRun,
      items: persistedItems,
      sourceKey,
      runKey,
      sourceInserted: !existingSource,
      runInserted: !existingRun,
      itemsInserted,
      itemsUpdated,
      itemsUnchanged,
      changeEventIds,
      itemsSeen,
      itemsAccepted,
    }
  })
}

export const recordLegacySourceRun = syncLegacySourceRun
export const syncLegacyCollectorRun = syncLegacySourceRun
