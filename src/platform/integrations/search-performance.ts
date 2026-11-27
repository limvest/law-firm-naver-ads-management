import type { Db } from '@/lib/db/client'
import {
  normalizeSearchProvider,
  SEARCH_URL_STATUSES,
  type SearchIntegrationProvider,
  type SearchProvider,
  type SearchUrlStatusInput,
} from '@/domains/search/intelligence'
import {
  upsertSearchIntegration,
  upsertSearchQueryStat,
  upsertSearchUrlStatus,
  type SearchIntegrationUpsertResult,
  type SearchQueryStatUpsertResult,
  type SearchUrlStatusUpsertResult,
} from '@/domains/search/repository'

/** The only snapshot schema currently accepted by the importer. */
export const SEARCH_PERFORMANCE_SNAPSHOT_VERSION = 1 as const

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const URL_STATUS_VALUES = new Set<string>([
  ...SEARCH_URL_STATUSES,
  'not_indexed',
  'pending',
])

export type SearchPerformanceProvider = SearchProvider

export type SearchPerformanceIndexSnapshot = {
  readonly url: string
  readonly publicationId?: string
  readonly status: SearchUrlStatusInput
  readonly reason?: string
  readonly error?: string
  readonly errorCode?: string
  readonly submittedAt?: string
  readonly discoveredAt?: string
  readonly indexedAt?: string
  readonly checkedAt: string
  readonly raw?: Record<string, unknown>
}

export type SearchPerformanceUrlMetric = {
  readonly url: string
  readonly publicationId?: string
  readonly day: string
  readonly impressions: number
  readonly clicks: number
  readonly ctr?: number
  readonly position?: number
  readonly raw?: Record<string, unknown>
}

export type SearchPerformanceQueryMetric = {
  readonly query: string
  readonly url?: string
  readonly publicationId?: string
  readonly day: string
  readonly impressions: number
  readonly clicks: number
  readonly ctr?: number
  readonly position?: number
  readonly raw?: Record<string, unknown>
}

/**
 * Provider-neutral JSON contract.
 *
 * `provider` accepts the short names (`naver`, `google`) as well as the
 * canonical repository values.  `indexSnapshots`, `urlMetrics`, and
 * `queryMetrics` may be empty or omitted when a provider export contains only
 * one kind of report.  Every metric row still carries a top-level `day` by
 * default; a row-level day is accepted only when it matches that day.
 */
export type SearchPerformanceSnapshot = {
  readonly version: typeof SEARCH_PERFORMANCE_SNAPSHOT_VERSION
  readonly provider: SearchIntegrationProvider
  readonly firmId: number
  readonly siteUrl: string
  readonly day: string
  readonly capturedAt: string
  readonly indexSnapshots: readonly SearchPerformanceIndexSnapshot[]
  readonly urlMetrics: readonly SearchPerformanceUrlMetric[]
  readonly queryMetrics: readonly SearchPerformanceQueryMetric[]
}

export type SearchPerformanceSnapshotInput = Record<string, unknown>

export class SearchPerformanceSnapshotError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'SearchPerformanceSnapshotError'
    this.path = path
  }
}

export type SearchPerformanceImportResult = {
  readonly provider: SearchIntegrationProvider
  readonly firmId: number
  readonly siteUrl: string
  readonly day: string
  readonly integrationId: string
  readonly integrationInserted: boolean
  readonly indexSnapshots: SearchPerformanceImportCounts
  readonly urlMetrics: SearchPerformanceImportCounts
  readonly queryMetrics: SearchPerformanceImportCounts
  readonly urls: SearchPerformanceImportCounts
  readonly queries: SearchPerformanceImportCounts
}

export type SearchPerformanceImportCounts = {
  readonly received: number
  readonly inserted: number
  readonly updated: number
}

export type SearchPerformanceRepository = {
  readonly upsertSearchIntegration: typeof upsertSearchIntegration
  readonly upsertSearchUrlStatus: typeof upsertSearchUrlStatus
  readonly upsertSearchQueryStat: typeof upsertSearchQueryStat
}

export type SearchPerformanceImportOptions = {
  readonly repository?: Partial<SearchPerformanceRepository>
}

const defaultRepository: SearchPerformanceRepository = {
  upsertSearchIntegration,
  upsertSearchUrlStatus,
  upsertSearchQueryStat,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(path: string, message: string): never {
  throw new SearchPerformanceSnapshotError(path, message)
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, 'must be a JSON object')
  return value
}

function assertKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'unknown field')
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(path, 'must be a non-empty string')
  }
  return value.trim()
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requiredString(value, path)
}

function optionalObject(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  return assertRecord(value, path)
}

function requiredPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(path, 'must be a positive safe integer')
  }
  return value
}

function requiredCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(path, 'must be a non-negative safe integer')
  }
  return value
}

function optionalMetricNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalid(path, 'must be a finite non-negative number')
  }
  return value
}

function optionalCtr(value: unknown, path: string): number | undefined {
  const ctr = optionalMetricNumber(value, path)
  if (ctr !== undefined && ctr > 1) invalid(path, 'must be between 0 and 1')
  return ctr
}

function validateCountPair(
  impressions: number,
  clicks: number,
  path: string,
): void {
  if (clicks > impressions) invalid(`${path}.clicks`, 'cannot exceed impressions')
}

function validDay(value: string, path: string): string {
  const match = DAY_PATTERN.exec(value)
  if (!match) invalid(path, 'must use YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    invalid(path, 'must be a real calendar day')
  }
  return value
}

function timestamp(value: unknown, path: string): string {
  const raw = requiredString(value, path)
  // Requiring an explicit zone prevents a machine-local timezone from
  // changing the observed day when the same JSON is replayed elsewhere.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    invalid(path, 'must include a timezone offset')
  }
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) invalid(path, 'must be a valid timestamp')
  return date.toISOString()
}

function dayEnd(day: string): string {
  return `${day}T23:59:59.999Z`
}

function absoluteHttpUrl(value: unknown, path: string): string {
  const raw = requiredString(value, path)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    invalid(path, 'must be an absolute HTTP(S) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    invalid(path, 'must be an absolute HTTP(S) URL')
  }
  if (parsed.username || parsed.password) {
    invalid(path, 'must not contain URL credentials')
  }
  return raw
}

function provider(value: unknown, path: string): SearchIntegrationProvider {
  if (
    value !== 'naver'
    && value !== 'google'
    && value !== 'naver_search_advisor'
    && value !== 'google_search_console'
  ) {
    invalid(path, 'must be naver, google, naver_search_advisor, or google_search_console')
  }
  return normalizeSearchProvider(value)
}

function status(value: unknown, path: string): SearchUrlStatusInput {
  const raw = requiredString(value, path)
  if (!URL_STATUS_VALUES.has(raw)) {
    invalid(path, `unsupported URL status: ${raw}`)
  }
  return raw as SearchUrlStatusInput
}

function rowDay(value: unknown, snapshotDay: string, path: string): string {
  if (value === undefined || value === null) return snapshotDay
  const day = validDay(requiredString(value, path), path)
  if (day !== snapshotDay) invalid(path, `must match snapshot day ${snapshotDay}`)
  return day
}

function arrayValue(
  value: unknown,
  path: string,
): readonly unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) invalid(path, 'must be an array')
  return value
}

function aliasedArray(
  value: Record<string, unknown>,
  primary: string,
  alias: string,
  path: string,
): readonly unknown[] {
  if (value[primary] !== undefined && value[alias] !== undefined) {
    invalid(path, `use only one of ${primary} and ${alias}`)
  }
  return arrayValue(value[primary] ?? value[alias], path)
}

function aliasedString(
  value: Record<string, unknown>,
  primary: string,
  alias: string,
  path: string,
): string | undefined {
  if (value[primary] !== undefined && value[alias] !== undefined) {
    invalid(path, `use only one of ${primary} and ${alias}`)
  }
  return optionalString(value[primary] ?? value[alias], path)
}

function metricPosition(
  value: Record<string, unknown>,
  path: string,
): number | undefined {
  if (value.position !== undefined && value.averagePosition !== undefined) {
    invalid(path, 'use only one of position and averagePosition')
  }
  return optionalMetricNumber(value.position ?? value.averagePosition, `${path}.position`)
}

function metricUrl(
  value: Record<string, unknown>,
  path: string,
): string | undefined {
  if (value.url !== undefined && value.pageUrl !== undefined) {
    invalid(path, 'use only one of url and pageUrl')
  }
  const raw = value.url ?? value.pageUrl
  return raw === undefined || raw === null
    ? undefined
    : absoluteHttpUrl(raw, `${path}.url`)
}

function normalizeIndexSnapshot(
  value: unknown,
  index: number,
  capturedAt: string,
): SearchPerformanceIndexSnapshot {
  const path = `indexSnapshots[${index}]`
  const row = assertRecord(value, path)
  assertKnownKeys(row, [
    'url',
    'publicationId',
    'status',
    'state',
    'reason',
    'error',
    'errorCode',
    'submittedAt',
    'discoveredAt',
    'indexedAt',
    'checkedAt',
    'raw',
  ], path)
  if (row.status !== undefined && row.state !== undefined) {
    invalid(path, 'use only one of status and state')
  }
  const statusValue = row.status ?? row.state
  if (statusValue === undefined || statusValue === null) {
    invalid(`${path}.status`, 'is required')
  }
  const submittedAt = row.submittedAt === undefined || row.submittedAt === null
    ? undefined
    : timestamp(row.submittedAt, `${path}.submittedAt`)
  const discoveredAt = row.discoveredAt === undefined || row.discoveredAt === null
    ? undefined
    : timestamp(row.discoveredAt, `${path}.discoveredAt`)
  const indexedAt = row.indexedAt === undefined || row.indexedAt === null
    ? undefined
    : timestamp(row.indexedAt, `${path}.indexedAt`)
  const checkedAt = row.checkedAt === undefined || row.checkedAt === null
    ? capturedAt
    : timestamp(row.checkedAt, `${path}.checkedAt`)
  return {
    url: absoluteHttpUrl(row.url, `${path}.url`),
    publicationId: optionalString(row.publicationId, `${path}.publicationId`),
    status: status(statusValue, `${path}.status`),
    reason: optionalString(row.reason, `${path}.reason`),
    error: optionalString(row.error, `${path}.error`),
    errorCode: optionalString(row.errorCode, `${path}.errorCode`),
    submittedAt,
    discoveredAt,
    indexedAt,
    checkedAt,
    raw: optionalObject(row.raw, `${path}.raw`),
  }
}

function normalizeUrlMetric(
  value: unknown,
  index: number,
  snapshotDay: string,
): SearchPerformanceUrlMetric {
  const path = `urlMetrics[${index}]`
  const row = assertRecord(value, path)
  assertKnownKeys(row, [
    'url',
    'pageUrl',
    'publicationId',
    'day',
    'impressions',
    'clicks',
    'ctr',
    'position',
    'averagePosition',
    'raw',
  ], path)
  const impressions = requiredCount(row.impressions, `${path}.impressions`)
  const clicks = requiredCount(row.clicks, `${path}.clicks`)
  validateCountPair(impressions, clicks, path)
  return {
    url: absoluteHttpUrl(row.url ?? row.pageUrl, `${path}.url`),
    publicationId: optionalString(row.publicationId, `${path}.publicationId`),
    day: rowDay(row.day, snapshotDay, `${path}.day`),
    impressions,
    clicks,
    ctr: optionalCtr(row.ctr, `${path}.ctr`),
    position: metricPosition(row, path),
    raw: optionalObject(row.raw, `${path}.raw`),
  }
}

function normalizeQueryMetric(
  value: unknown,
  index: number,
  snapshotDay: string,
): SearchPerformanceQueryMetric {
  const path = `queryMetrics[${index}]`
  const row = assertRecord(value, path)
  assertKnownKeys(row, [
    'query',
    'searchQuery',
    'url',
    'pageUrl',
    'publicationId',
    'day',
    'impressions',
    'clicks',
    'ctr',
    'position',
    'averagePosition',
    'raw',
  ], path)
  if (row.query !== undefined && row.searchQuery !== undefined) {
    invalid(path, 'use only one of query and searchQuery')
  }
  const query = requiredString(row.query ?? row.searchQuery, `${path}.query`)
  const impressions = requiredCount(row.impressions, `${path}.impressions`)
  const clicks = requiredCount(row.clicks, `${path}.clicks`)
  validateCountPair(impressions, clicks, path)
  return {
    query,
    url: metricUrl(row, path),
    publicationId: optionalString(row.publicationId, `${path}.publicationId`),
    day: rowDay(row.day, snapshotDay, `${path}.day`),
    impressions,
    clicks,
    ctr: optionalCtr(row.ctr, `${path}.ctr`),
    position: metricPosition(row, path),
    raw: optionalObject(row.raw, `${path}.raw`),
  }
}

function duplicateKey(
  seen: Set<string>,
  key: string,
  path: string,
): void {
  if (seen.has(key)) invalid(path, 'duplicates another row in this snapshot')
  seen.add(key)
}

function validateSnapshotRows(snapshot: SearchPerformanceSnapshot): void {
  const indexUrls = new Set<string>()
  for (let index = 0; index < snapshot.indexSnapshots.length; index += 1) {
    duplicateKey(indexUrls, snapshot.indexSnapshots[index].url, `indexSnapshots[${index}].url`)
  }

  const metricUrls = new Set<string>()
  for (let index = 0; index < snapshot.urlMetrics.length; index += 1) {
    duplicateKey(metricUrls, snapshot.urlMetrics[index].url, `urlMetrics[${index}].url`)
  }

  const queryKeys = new Set<string>()
  for (let index = 0; index < snapshot.queryMetrics.length; index += 1) {
    const row = snapshot.queryMetrics[index]
    const scope = row.publicationId ?? row.url ?? ''
    duplicateKey(queryKeys, `${scope}\u0000${row.query}\u0000${row.day}`, `queryMetrics[${index}]`)
  }
}

/** Parse and validate a JSON-decoded provider snapshot before any DB writes. */
export function parseSearchPerformanceSnapshot(
  value: unknown,
): SearchPerformanceSnapshot {
  const input = assertRecord(value, 'snapshot')
  assertKnownKeys(input, [
    'version',
    'provider',
    'firmId',
    'siteUrl',
    'day',
    'capturedAt',
    'observedAt',
    'indexSnapshots',
    'index',
    'urlMetrics',
    'urls',
    'queryMetrics',
    'queries',
  ], 'snapshot')
  if (input.version !== undefined && input.version !== SEARCH_PERFORMANCE_SNAPSHOT_VERSION) {
    invalid('snapshot.version', `must be ${SEARCH_PERFORMANCE_SNAPSHOT_VERSION}`)
  }
  const snapshotDay = validDay(requiredString(input.day, 'snapshot.day'), 'snapshot.day')
  const capturedAtInput = aliasedString(input, 'capturedAt', 'observedAt', 'snapshot.capturedAt')
  const capturedAt = capturedAtInput === undefined
    ? dayEnd(snapshotDay)
    : timestamp(capturedAtInput, 'snapshot.capturedAt')
  const result: SearchPerformanceSnapshot = {
    version: SEARCH_PERFORMANCE_SNAPSHOT_VERSION,
    provider: provider(input.provider, 'snapshot.provider'),
    firmId: requiredPositiveInteger(input.firmId, 'snapshot.firmId'),
    siteUrl: absoluteHttpUrl(input.siteUrl, 'snapshot.siteUrl'),
    day: snapshotDay,
    capturedAt,
    indexSnapshots: aliasedArray(input, 'indexSnapshots', 'index', 'snapshot.indexSnapshots')
      .map((row, index) => normalizeIndexSnapshot(row, index, capturedAt)),
    urlMetrics: aliasedArray(input, 'urlMetrics', 'urls', 'snapshot.urlMetrics')
      .map((row, index) => normalizeUrlMetric(row, index, snapshotDay)),
    queryMetrics: aliasedArray(input, 'queryMetrics', 'queries', 'snapshot.queryMetrics')
      .map((row, index) => normalizeQueryMetric(row, index, snapshotDay)),
  }
  validateSnapshotRows(result)
  return result
}

type UrlImportRow = {
  readonly url: string
  publicationId?: string
  status: SearchUrlStatusInput
  reason?: string
  error?: string
  errorCode?: string
  submittedAt?: string
  discoveredAt?: string
  indexedAt?: string
  checkedAt: string
  raw: Record<string, unknown>
  readonly fromIndex: boolean
  readonly fromUrlMetric: boolean
}

function rawEnvelope(
  snapshot: SearchPerformanceSnapshot,
  kind: 'index' | 'url_metric',
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider: snapshot.provider,
    firmId: snapshot.firmId,
    siteUrl: snapshot.siteUrl,
    day: snapshot.day,
    capturedAt: snapshot.capturedAt,
    kind,
    payload,
  }
}

function indexRaw(
  snapshot: SearchPerformanceSnapshot,
  row: SearchPerformanceIndexSnapshot,
): Record<string, unknown> {
  return rawEnvelope(snapshot, 'index', {
    url: row.url,
    publicationId: row.publicationId ?? null,
    status: row.status,
    reason: row.reason ?? null,
    error: row.error ?? null,
    errorCode: row.errorCode ?? null,
    submittedAt: row.submittedAt ?? null,
    discoveredAt: row.discoveredAt ?? null,
    indexedAt: row.indexedAt ?? null,
    checkedAt: row.checkedAt,
    ...(row.raw ? { providerPayload: row.raw } : {}),
  })
}

function metricRaw(
  snapshot: SearchPerformanceSnapshot,
  row: SearchPerformanceUrlMetric,
): Record<string, unknown> {
  return rawEnvelope(snapshot, 'url_metric', {
    url: row.url,
    publicationId: row.publicationId ?? null,
    day: row.day,
    impressions: row.impressions,
    clicks: row.clicks,
    ctr: row.ctr ?? null,
    position: row.position ?? null,
    ...(row.raw ? { providerPayload: row.raw } : {}),
  })
}

function mergeRaw(
  existing: Record<string, unknown>,
  addition: Record<string, unknown>,
): Record<string, unknown> {
  const existingPayload = existing.payload
  const additionPayload = addition.payload
  const merged: Record<string, unknown> = {
    ...existing,
    urlMetric: addition,
  }
  if (typeof existingPayload === 'object' && existingPayload !== null && !Array.isArray(existingPayload)) {
    merged.payload = { ...(existingPayload as Record<string, unknown>) }
  }
  if (typeof additionPayload === 'object' && additionPayload !== null && !Array.isArray(additionPayload)) {
    merged.urlMetricPayload = { ...(additionPayload as Record<string, unknown>) }
  }
  return merged
}

function buildUrlRows(snapshot: SearchPerformanceSnapshot): UrlImportRow[] {
  const rows = new Map<string, UrlImportRow>()
  for (const index of snapshot.indexSnapshots) {
    rows.set(index.url, {
      url: index.url,
      publicationId: index.publicationId,
      status: index.status,
      reason: index.reason,
      error: index.error,
      errorCode: index.errorCode,
      submittedAt: index.submittedAt,
      discoveredAt: index.discoveredAt,
      indexedAt: index.indexedAt,
      checkedAt: index.checkedAt,
      raw: indexRaw(snapshot, index),
      fromIndex: true,
      fromUrlMetric: false,
    })
  }
  for (const metric of snapshot.urlMetrics) {
    const existing = rows.get(metric.url)
    if (!existing) {
      rows.set(metric.url, {
        url: metric.url,
        publicationId: metric.publicationId,
        status: 'unknown',
        checkedAt: snapshot.capturedAt,
        raw: metricRaw(snapshot, metric),
        fromIndex: false,
        fromUrlMetric: true,
      })
      continue
    }
    if (
      existing.publicationId !== undefined
      && metric.publicationId !== undefined
      && existing.publicationId !== metric.publicationId
    ) {
      throw new SearchPerformanceSnapshotError(
        `urlMetrics[${snapshot.urlMetrics.indexOf(metric)}].publicationId`,
        'does not match the index snapshot publicationId for this URL',
      )
    }
    rows.set(metric.url, {
      ...existing,
      publicationId: existing.publicationId ?? metric.publicationId,
      raw: mergeRaw(existing.raw, metricRaw(snapshot, metric)),
      fromUrlMetric: true,
    })
  }
  return [...rows.values()]
}

function counts(received: number, inserted: number): SearchPerformanceImportCounts {
  return { received, inserted, updated: received - inserted }
}

function integrationId(result: SearchIntegrationUpsertResult): string {
  const id = result.integration?.id ?? result.row?.id
  if (!id) throw new Error('search integration upsert returned no integration id')
  return id
}

/**
 * Import one validated snapshot into the target repository.  This function
 * performs no HTTP/API work; all writes are delegated to the existing scoped
 * repository upserts, so replaying a snapshot updates the same rows.
 */
export async function importSearchPerformanceSnapshot(
  db: Db,
  input: unknown,
  options: SearchPerformanceImportOptions = {},
): Promise<SearchPerformanceImportResult> {
  const snapshot = parseSearchPerformanceSnapshot(input)
  const repository: SearchPerformanceRepository = {
    ...defaultRepository,
    ...(options.repository ?? {}),
  }
  const integration = await repository.upsertSearchIntegration(db, {
    firmId: snapshot.firmId,
    provider: snapshot.provider,
    siteUrl: snapshot.siteUrl,
    status: 'connected',
    lastSyncedAt: snapshot.capturedAt,
  })
  const integrationKey = integrationId(integration)
  const urlRows = buildUrlRows(snapshot)
  const urlResults: Array<{ row: UrlImportRow; result: SearchUrlStatusUpsertResult }> = []
  for (const row of urlRows) {
    const result = await repository.upsertSearchUrlStatus(db, {
      firmId: snapshot.firmId,
      integrationId: integrationKey,
      provider: snapshot.provider,
      publicationId: row.publicationId,
      url: row.url,
      status: row.status,
      reason: row.reason,
      error: row.error,
      errorCode: row.errorCode,
      submittedAt: row.submittedAt,
      discoveredAt: row.discoveredAt,
      indexedAt: row.indexedAt,
      checkedAt: row.checkedAt,
      raw: row.raw,
    })
    urlResults.push({ row, result })
  }

  const queryResults: SearchQueryStatUpsertResult[] = []
  for (const metric of snapshot.queryMetrics) {
    queryResults.push(await repository.upsertSearchQueryStat(db, {
      firmId: snapshot.firmId,
      integrationId: integrationKey,
      provider: snapshot.provider,
      publicationId: metric.publicationId,
      url: metric.url,
      query: metric.query,
      day: metric.day,
      impressions: metric.impressions,
      clicks: metric.clicks,
      ctr: metric.ctr,
      position: metric.position,
    }))
  }

  const indexReceived = snapshot.indexSnapshots.length
  const metricReceived = snapshot.urlMetrics.length
  const indexUrls = new Set(snapshot.indexSnapshots.map((row) => row.url))
  const metricUrls = new Set(snapshot.urlMetrics.map((row) => row.url))
  const indexInserted = urlResults.filter(({ row, result }) => row.fromIndex && indexUrls.has(row.url) && result.inserted).length
  const metricInserted = urlResults.filter(({ row, result }) => row.fromUrlMetric && metricUrls.has(row.url) && result.inserted).length
  const urlInserted = urlResults.filter(({ result }) => result.inserted).length
  const queryInserted = queryResults.filter((result) => result.inserted).length
  return {
    provider: snapshot.provider,
    firmId: snapshot.firmId,
    siteUrl: snapshot.siteUrl,
    day: snapshot.day,
    integrationId: integrationKey,
    integrationInserted: integration.inserted,
    indexSnapshots: counts(indexReceived, indexInserted),
    urlMetrics: counts(metricReceived, metricInserted),
    queryMetrics: counts(snapshot.queryMetrics.length, queryInserted),
    urls: counts(urlRows.length, urlInserted),
    queries: counts(snapshot.queryMetrics.length, queryInserted),
  }
}

// Stable aliases make the integration boundary easy to discover for workers.
export const importSearchPerformance = importSearchPerformanceSnapshot
export const importSearchSnapshot = importSearchPerformanceSnapshot
export const parseSearchPerformance = parseSearchPerformanceSnapshot
