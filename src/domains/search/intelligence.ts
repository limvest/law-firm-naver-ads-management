/**
 * Pure contracts for Search Intelligence.
 *
 * Search integrations are deliberately represented as observations.  An HTTP
 * response tells us that a URL was reachable; it does not tell us that a
 * search provider indexed it.  Only an explicit provider status (or an
 * indexed timestamp returned by that provider) can produce `indexed` here.
 *
 * This module has no database, network, or clock dependency.  Workers can
 * normalize provider payloads, persist the returned values, and make the same
 * decision again from the same inputs.
 */

export const SEARCH_PROVIDERS = [
  'naver_search_advisor',
  'google_search_console',
] as const

export type SearchIntegrationProvider = (typeof SEARCH_PROVIDERS)[number]
export type SearchProviderName = 'naver' | 'google'

/**
 * Short names are accepted at the pure boundary, while the canonical values
 * match `search_integrations.provider`.
 */
export type SearchProvider = SearchIntegrationProvider | SearchProviderName
export type SearchProviderInput = SearchProvider

export const NAVER_PROVIDER: SearchIntegrationProvider = 'naver_search_advisor'
export const GOOGLE_PROVIDER: SearchIntegrationProvider = 'google_search_console'
export const NAVER_SEARCH_ADVISOR = NAVER_PROVIDER
export const GOOGLE_SEARCH_CONSOLE = GOOGLE_PROVIDER

const PROVIDER_NAMES: Readonly<Record<SearchIntegrationProvider, SearchProviderName>> = {
  naver_search_advisor: 'naver',
  google_search_console: 'google',
}

export function isSearchProvider(value: unknown): value is SearchProvider {
  return value === 'naver'
    || value === 'google'
    || value === 'naver_search_advisor'
    || value === 'google_search_console'
}

export function normalizeSearchProvider(
  provider: SearchProvider,
): SearchIntegrationProvider {
  switch (provider) {
    case 'naver':
    case 'naver_search_advisor':
      return NAVER_PROVIDER
    case 'google':
    case 'google_search_console':
      return GOOGLE_PROVIDER
    default:
      throw new TypeError(`unsupported search provider: ${String(provider)}`)
  }
}

export function getSearchProviderName(
  provider: SearchProvider,
): SearchProviderName {
  return PROVIDER_NAMES[normalizeSearchProvider(provider)]
}

export const canonicalizeSearchProvider = normalizeSearchProvider

export const SEARCH_URL_STATUSES = [
  'unknown',
  'discovered',
  'crawled',
  'indexed',
  'excluded',
  'error',
] as const

export type SearchUrlStatus = (typeof SEARCH_URL_STATUSES)[number]
export type UrlIndexState = SearchUrlStatus
export type SearchUrlState = SearchUrlStatus

/** Provider adapters may use these two descriptive values before persistence. */
export type SearchUrlStatusInput = SearchUrlStatus | 'not_indexed' | 'pending'

export const URL_INDEX_STATES = SEARCH_URL_STATUSES
export const SEARCH_URL_STATES = SEARCH_URL_STATUSES

export function isSearchUrlStatus(value: unknown): value is SearchUrlStatus {
  return typeof value === 'string'
    && (SEARCH_URL_STATUSES as readonly string[]).includes(value)
}

function normalizeUrlStatus(value: unknown): SearchUrlStatus | null {
  if (isSearchUrlStatus(value)) return value
  if (value === 'not_indexed' || value === 'pending') return 'unknown'
  return null
}

export type SearchTimestamp = string | number | Date

function timestampMs(value: SearchTimestamp | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function timestampIso(value: SearchTimestamp | null | undefined): string | null {
  const time = timestampMs(value)
  return time === null ? null : new Date(time).toISOString()
}

function finiteHttpStatus(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A provider URL inspection.  `status` is authoritative when present.  The
 * HTTP fields are retained as transport evidence only and are never used to
 * turn `unknown` into `indexed`.
 */
export interface SearchUrlIndexObservation {
  readonly provider: SearchProvider
  readonly url?: string | null
  readonly publicationId?: string | null
  readonly status?: SearchUrlStatusInput | null
  readonly state?: SearchUrlStatusInput | null
  readonly providerStatus?: SearchUrlStatusInput | null
  readonly inspectionStatus?: SearchUrlStatusInput | null
  readonly verdict?: SearchUrlStatusInput | null
  readonly reason?: string | null
  readonly exclusionReason?: string | null
  readonly error?: string | null
  readonly errorCode?: string | null
  readonly httpStatus?: number | null
  readonly submittedAt?: SearchTimestamp | null
  readonly discoveredAt?: SearchTimestamp | null
  readonly indexedAt?: SearchTimestamp | null
  readonly checkedAt?: SearchTimestamp | null
  readonly observedAt?: SearchTimestamp | null
}

export type SearchUrlStatusObservation = SearchUrlIndexObservation
export type UrlIndexObservation = SearchUrlIndexObservation

export type UrlIndexEvidenceSource =
  | 'provider_status'
  | 'provider_verdict'
  | 'indexed_at'
  | 'none'

export interface UrlIndexStateResult {
  readonly provider: SearchIntegrationProvider
  readonly providerName: SearchProviderName
  readonly url: string | null
  readonly publicationId: string | null
  readonly status: SearchUrlStatus
  readonly state: SearchUrlStatus
  readonly indexed: boolean
  readonly isIndexed: boolean
  readonly explicit: boolean
  readonly evidence: UrlIndexEvidenceSource
  readonly reason: string | null
  readonly httpStatus: number | null
  readonly checkedAt: string | null
}

type ExplicitStateCandidate = {
  readonly value: SearchUrlStatusInput | null | undefined
  readonly source: Exclude<UrlIndexEvidenceSource, 'indexed_at' | 'none'>
}

function explicitUrlState(
  observation: SearchUrlIndexObservation,
): { status: SearchUrlStatus; source: ExplicitStateCandidate['source'] } | null {
  const candidates: readonly ExplicitStateCandidate[] = [
    { value: observation.status, source: 'provider_status' },
    { value: observation.state, source: 'provider_status' },
    { value: observation.providerStatus, source: 'provider_status' },
    { value: observation.inspectionStatus, source: 'provider_status' },
    { value: observation.verdict, source: 'provider_verdict' },
  ]

  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === null) continue
    // An invalid provider value fails closed as unknown.  In particular, it
    // must not fall through to a transport status or an unrelated field.
    return {
      status: normalizeUrlStatus(candidate.value) ?? 'unknown',
      source: candidate.source,
    }
  }
  return null
}

/**
 * Derive a URL state from explicit provider evidence.
 *
 * A `200`/`2xx` HTTP response with no provider state is intentionally
 * `unknown`, not `indexed`.  This is the guard that keeps publication health
 * checks separate from search-index observations.
 */
export function deriveUrlIndexState(
  observation: SearchUrlIndexObservation,
): SearchUrlStatus {
  const explicit = explicitUrlState(observation)
  if (explicit) return explicit.status
  if (timestampMs(observation.indexedAt) !== null) return 'indexed'
  return 'unknown'
}

export const getUrlIndexState = deriveUrlIndexState
export const resolveUrlIndexState = deriveUrlIndexState
export const deriveSearchUrlState = deriveUrlIndexState

export function inspectUrlIndexState(
  observation: SearchUrlIndexObservation,
): UrlIndexStateResult {
  const explicit = explicitUrlState(observation)
  const indexedAtPresent = timestampMs(observation.indexedAt) !== null
  const status = explicit?.status ?? (indexedAtPresent ? 'indexed' : 'unknown')
  const evidence: UrlIndexEvidenceSource = explicit?.source
    ?? (indexedAtPresent ? 'indexed_at' : 'none')
  const reason = observation.reason?.trim()
    || observation.exclusionReason?.trim()
    || observation.error?.trim()
    || observation.errorCode?.trim()
    || null

  return {
    provider: normalizeSearchProvider(observation.provider),
    providerName: getSearchProviderName(observation.provider),
    url: observation.url?.trim() || null,
    publicationId: observation.publicationId?.trim() || null,
    status,
    state: status,
    indexed: status === 'indexed',
    isIndexed: status === 'indexed',
    explicit: evidence !== 'none',
    evidence,
    reason,
    httpStatus: finiteHttpStatus(observation.httpStatus),
    checkedAt: timestampIso(observation.checkedAt ?? observation.observedAt),
  }
}

export const evaluateUrlIndexState = inspectUrlIndexState
export const normalizeUrlIndexState = inspectUrlIndexState

export function isUrlIndexed(
  observation: SearchUrlIndexObservation | SearchUrlStatusInput,
): boolean {
  if (typeof observation === 'string') {
    return normalizeUrlStatus(observation) === 'indexed'
  }
  return deriveUrlIndexState(observation) === 'indexed'
}

export const isSearchUrlIndexed = isUrlIndexed

export interface SearchQueryDailyStat {
  readonly provider: SearchProvider
  readonly query?: string
  readonly searchQuery?: string
  readonly day?: string
  readonly date?: string
  readonly publicationId?: string | null
  readonly url?: string | null
  readonly pageUrl?: string | null
  readonly impressions: number
  readonly clicks: number
  /** Provider CTR is accepted as input but aggregation always recomputes it. */
  readonly ctr?: number | null
  readonly position?: number | null
  readonly averagePosition?: number | null
  readonly positionBasisPoints?: number | null
}

export type SearchQueryStat = SearchQueryDailyStat
export type QueryDailyStat = SearchQueryDailyStat

export interface NormalizedSearchQueryDailyStat {
  readonly provider: SearchIntegrationProvider
  readonly providerName: SearchProviderName
  readonly query: string
  readonly day: string
  readonly publicationId: string | null
  readonly url: string | null
  readonly impressions: number
  readonly clicks: number
  readonly ctr: number
  readonly position: number | null
  readonly positionBasisPoints: number | null
}

function nonNegativeMetric(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`)
  }
  return value
}

function optionalPosition(
  row: SearchQueryDailyStat,
): number | null {
  const candidates = [
    row.position,
    row.averagePosition,
    row.positionBasisPoints === null || row.positionBasisPoints === undefined
      ? null
      : row.positionBasisPoints / 100,
  ]
  for (const value of candidates) {
    if (value === null || value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return null
    }
    return value
  }
  return null
}

/** Convert either provider's daily row into one provider-neutral pure shape. */
export function normalizeSearchQueryDailyStat(
  row: SearchQueryDailyStat,
): NormalizedSearchQueryDailyStat {
  const query = (row.query ?? row.searchQuery ?? '').trim()
  if (!query) throw new TypeError('search query must not be blank')

  const day = (row.day ?? row.date ?? '').trim()
  const impressions = nonNegativeMetric(row.impressions, 'impressions')
  const clicks = nonNegativeMetric(row.clicks, 'clicks')
  const position = optionalPosition(row)

  return {
    provider: normalizeSearchProvider(row.provider),
    providerName: getSearchProviderName(row.provider),
    query,
    day,
    publicationId: row.publicationId?.trim() || null,
    url: (row.url ?? row.pageUrl)?.trim() || null,
    impressions,
    clicks,
    ctr: impressions === 0 ? 0 : clicks / impressions,
    position,
    positionBasisPoints: position === null ? null : position * 100,
  }
}

export const normalizeQueryDailyStat = normalizeSearchQueryDailyStat

export interface SearchQueryAggregate {
  readonly provider: SearchIntegrationProvider
  readonly providerName: SearchProviderName
  readonly query: string
  readonly publicationId: string | null
  readonly url: string | null
  readonly impressions: number
  readonly clicks: number
  readonly ctr: number
  readonly weightedAvgPosition: number | null
  /** Verbose aliases make the contract readable to dashboard consumers. */
  readonly weightedAveragePosition: number | null
  readonly averagePosition: number | null
  readonly clickThroughRate: number
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function aggregateNormalizedRows(
  rows: readonly NormalizedSearchQueryDailyStat[],
): SearchQueryAggregate {
  if (rows.length === 0) throw new TypeError('cannot aggregate an empty search-stat set')

  const first = rows[0]
  for (const row of rows) {
    if (row.provider !== first.provider) {
      throw new MixedSearchProviderError(
        'search statistics from Naver and Google must be aggregated separately',
      )
    }
    if (row.query !== first.query) {
      throw new TypeError(
        'aggregateQueryStats accepts one query; use aggregateSearchQueryStats for groups',
      )
    }
    if (row.publicationId !== first.publicationId || row.url !== first.url) {
      throw new TypeError(
        'aggregateQueryStats accepts one publication URL; group rows before aggregating',
      )
    }
  }

  let impressions = 0
  let clicks = 0
  let positionWeight = 0
  let positionImpressions = 0
  for (const row of rows) {
    impressions += row.impressions
    clicks += row.clicks
    if (row.position !== null && row.impressions > 0) {
      positionWeight += row.position * row.impressions
      positionImpressions += row.impressions
    }
  }

  const ctr = impressions === 0 ? 0 : clicks / impressions
  const weightedAvgPosition = positionImpressions === 0
    ? null
    : positionWeight / positionImpressions

  return {
    provider: first.provider,
    providerName: first.providerName,
    query: first.query,
    publicationId: first.publicationId,
    url: first.url,
    impressions,
    clicks,
    ctr,
    weightedAvgPosition,
    weightedAveragePosition: weightedAvgPosition,
    averagePosition: weightedAvgPosition,
    clickThroughRate: ctr,
  }
}

export class MixedSearchProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MixedSearchProviderError'
  }
}

/** Aggregate daily rows for one query, publication, and provider. */
export function aggregateQueryStats(
  rows: readonly SearchQueryDailyStat[],
): SearchQueryAggregate {
  return aggregateNormalizedRows(rows.map(normalizeSearchQueryDailyStat))
}

export const aggregateSearchQueryStatsForQuery = aggregateQueryStats
export const aggregateDailyQueryStats = aggregateQueryStats

function aggregateKey(row: NormalizedSearchQueryDailyStat): string {
  return [row.provider, row.publicationId ?? '', row.url ?? '', row.query].join('\u0000')
}

/**
 * Group and aggregate arbitrary rows without ever combining Naver and Google.
 * Output order is provider, publication, URL, then query using code-point
 * comparisons rather than locale-sensitive ordering.
 */
export function aggregateSearchQueryStats(
  rows: readonly SearchQueryDailyStat[],
): SearchQueryAggregate[] {
  const normalized = rows.map(normalizeSearchQueryDailyStat)
  const groups = new Map<string, NormalizedSearchQueryDailyStat[]>()
  for (const row of normalized) {
    const key = aggregateKey(row)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  return [...groups.values()]
    .map(aggregateNormalizedRows)
    .sort((left, right) => (
      compareStrings(left.provider, right.provider)
      || compareStrings(left.publicationId ?? '', right.publicationId ?? '')
      || compareStrings(left.url ?? '', right.url ?? '')
      || compareStrings(left.query, right.query)
    ))
}

export const aggregateSearchStats = aggregateSearchQueryStats
export const aggregateQueryDailyStats = aggregateSearchQueryStats

export interface IndexLatencyInput {
  readonly publishedAt?: SearchTimestamp | null
  readonly submittedAt?: SearchTimestamp | null
  readonly discoveredAt?: SearchTimestamp | null
  readonly startAt?: SearchTimestamp | null
  readonly indexedAt?: SearchTimestamp | null
  readonly status?: SearchUrlStatusInput | null
  readonly indexState?: SearchUrlStatusInput | null
  readonly httpStatus?: number | null
}

export type IndexLatencyStatus = 'calculated' | 'pending' | 'invalid'

export interface IndexLatencyResult {
  readonly status: IndexLatencyStatus
  readonly startAt: string | null
  readonly indexedAt: string | null
  readonly source: 'startAt' | 'publishedAt' | 'submittedAt' | 'discoveredAt' | null
  readonly latencyMs: number | null
  readonly latencyHours: number | null
  readonly latencyDays: number | null
  readonly milliseconds: number | null
  readonly hours: number | null
  readonly days: number | null
}

function latencyFromInput(input: IndexLatencyInput): IndexLatencyResult {
  const starts: readonly [IndexLatencyResult['source'], SearchTimestamp | null | undefined][] = [
    ['startAt', input.startAt],
    ['publishedAt', input.publishedAt],
    ['submittedAt', input.submittedAt],
    ['discoveredAt', input.discoveredAt],
  ]
  let source: IndexLatencyResult['source'] = null
  let startMs: number | null = null
  for (const [candidateSource, candidate] of starts) {
    if (candidate === null || candidate === undefined) continue
    source = candidateSource
    startMs = timestampMs(candidate)
    break
  }

  const indexedMs = timestampMs(input.indexedAt)
  const startAt = startMs === null ? null : new Date(startMs).toISOString()
  const indexedAt = indexedMs === null ? null : new Date(indexedMs).toISOString()

  let status: IndexLatencyStatus = 'pending'
  let latencyMs: number | null = null
  if (
    (source !== null && startMs === null)
    || (input.indexedAt !== undefined && input.indexedAt !== null && indexedMs === null)
  ) {
    status = 'invalid'
  } else if (startMs !== null && indexedMs !== null) {
    latencyMs = indexedMs - startMs
    status = latencyMs < 0 ? 'invalid' : 'calculated'
    if (latencyMs < 0) latencyMs = null
  }

  const latencyHours = latencyMs === null ? null : latencyMs / 3_600_000
  const latencyDays = latencyMs === null ? null : latencyMs / 86_400_000
  return {
    status,
    startAt,
    indexedAt,
    source,
    latencyMs,
    latencyHours,
    latencyDays,
    milliseconds: latencyMs,
    hours: latencyHours,
    days: latencyDays,
  }
}

export function calculateIndexLatency(input: IndexLatencyInput): IndexLatencyResult
export function calculateIndexLatency(
  startAt: SearchTimestamp | null | undefined,
  indexedAt: SearchTimestamp | null | undefined,
): number | null
export function calculateIndexLatency(
  inputOrStart: IndexLatencyInput | SearchTimestamp | null | undefined,
  indexedAt?: SearchTimestamp | null,
): IndexLatencyResult | number | null {
  if (
    inputOrStart !== null
    && typeof inputOrStart === 'object'
    && !(inputOrStart instanceof Date)
  ) {
    return latencyFromInput(inputOrStart)
  }

  const result = latencyFromInput({
    startAt: inputOrStart as SearchTimestamp | null | undefined,
    indexedAt,
  })
  return result.latencyDays
}

export function calculateIndexLatencyDays(input: IndexLatencyInput): number | null
export function calculateIndexLatencyDays(
  startAt: SearchTimestamp | null | undefined,
  indexedAt: SearchTimestamp | null | undefined,
): number | null
export function calculateIndexLatencyDays(
  inputOrStart: IndexLatencyInput | SearchTimestamp | null | undefined,
  indexedAt?: SearchTimestamp | null,
): number | null {
  const result = inputOrStart !== null
    && typeof inputOrStart === 'object'
    && !(inputOrStart instanceof Date)
    ? latencyFromInput(inputOrStart).latencyDays
    : latencyFromInput({
      startAt: inputOrStart as SearchTimestamp | null | undefined,
      indexedAt,
    }).latencyDays
  return result
}

export const getIndexLatency = latencyFromInput
export const getIndexLatencyDays = calculateIndexLatencyDays
export const indexLatencyDays = calculateIndexLatencyDays

export interface SearchPerformanceSnapshot {
  readonly impressions?: number | null
  readonly clicks?: number | null
  readonly ctr?: number | null
  readonly position?: number | null
  readonly averagePosition?: number | null
  readonly weightedAvgPosition?: number | null
  readonly weightedAveragePosition?: number | null
}

export type ContentPerformanceSnapshot = SearchPerformanceSnapshot

export interface RefreshEvidenceSignal {
  readonly capturedAt?: SearchTimestamp | null
  readonly observedAt?: SearchTimestamp | null
  readonly ageDays?: number | null
  readonly stale?: boolean
  readonly staleAfterDays?: number
}

export interface RefreshIndexSignal {
  readonly status?: SearchUrlStatusInput | null
  readonly state?: SearchUrlStatusInput | null
  readonly reason?: string | null
  readonly error?: string | null
  readonly errorCode?: string | null
}

export interface ContentRefreshInput {
  readonly url?: string | null
  readonly provider?: SearchProvider
  readonly asOf?: SearchTimestamp | null
  readonly evidence?: RefreshEvidenceSignal | null
  readonly evidenceCapturedAt?: SearchTimestamp | null
  readonly evidenceAgeDays?: number | null
  readonly evidenceStale?: boolean
  readonly staleEvidence?: boolean
  readonly staleAfterDays?: number
  readonly current?: SearchPerformanceSnapshot | null
  readonly previous?: SearchPerformanceSnapshot | null
  readonly currentStats?: SearchPerformanceSnapshot | null
  readonly previousStats?: SearchPerformanceSnapshot | null
  readonly currentPerformance?: SearchPerformanceSnapshot | null
  readonly previousPerformance?: SearchPerformanceSnapshot | null
  readonly content?: {
    readonly current?: SearchPerformanceSnapshot | null
    readonly previous?: SearchPerformanceSnapshot | null
    readonly declining?: boolean
    readonly decline?: boolean
    readonly declineThreshold?: number
  } | null
  readonly contentDecline?: boolean
  readonly declineThreshold?: number
  readonly index?: RefreshIndexSignal | null
  readonly indexStatus?: SearchUrlStatusInput | null
  readonly indexState?: SearchUrlStatusInput | null
  readonly indexError?: string | boolean | null
}

export const DEFAULT_REFRESH_THRESHOLDS = Object.freeze({
  evidenceStaleAfterDays: 30,
  contentDeclineRate: 0.2,
})

export const CONTENT_REFRESH_REASONS = [
  'stale_evidence',
  'content_decline',
  'index_error',
] as const

export type ContentRefreshReason = (typeof CONTENT_REFRESH_REASONS)[number]
export type RefreshRecommendationReason = ContentRefreshReason
export type RefreshRecommendationAction = 'refresh' | 'investigate_index' | 'monitor'
export type ContentRefreshAction = RefreshRecommendationAction
export type RefreshRecommendationPriority = 'high' | 'medium' | 'low'

export interface ContentRefreshRecommendation {
  readonly url: string | null
  readonly provider: SearchIntegrationProvider | null
  readonly recommendation: RefreshRecommendationAction
  readonly action: RefreshRecommendationAction
  readonly shouldRefresh: boolean
  readonly priority: RefreshRecommendationPriority
  readonly reasons: readonly ContentRefreshReason[]
  readonly reasonCodes: readonly ContentRefreshReason[]
  readonly staleEvidence: boolean
  readonly contentDecline: boolean
  readonly contentDeclineMetrics: readonly ('impressions' | 'clicks' | 'ctr' | 'position')[]
  readonly indexError: boolean
  readonly blockedByIndexError: boolean
}

function finiteNonNegativeOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function thresholdOrDefault(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1
    ? value
    : fallback
}

function evidenceAgeDays(input: ContentRefreshInput): number | null {
  const explicitAge = input.evidenceAgeDays ?? input.evidence?.ageDays
  const numericAge = finiteNonNegativeOrNull(explicitAge)
  if (numericAge !== null) return numericAge

  const observedAt = input.evidenceCapturedAt
    ?? input.evidence?.capturedAt
    ?? input.evidence?.observedAt
  const asOfMs = timestampMs(input.asOf)
  const observedMs = timestampMs(observedAt)
  if (asOfMs === null || observedMs === null || asOfMs < observedMs) return null
  return Math.floor((asOfMs - observedMs) / 86_400_000)
}

function snapshotMetric(
  snapshot: SearchPerformanceSnapshot | null | undefined,
  metric: 'impressions' | 'clicks' | 'ctr' | 'position',
): number | null {
  if (!snapshot) return null
  if (metric === 'position') {
    return finiteNonNegativeOrNull(
      snapshot.weightedAveragePosition
      ?? snapshot.weightedAvgPosition
      ?? snapshot.averagePosition
      ?? snapshot.position,
    )
  }
  return finiteNonNegativeOrNull(snapshot[metric])
}

function contentDeclineMetrics(
  previous: SearchPerformanceSnapshot | null | undefined,
  current: SearchPerformanceSnapshot | null | undefined,
  threshold: number,
): Array<'impressions' | 'clicks' | 'ctr' | 'position'> {
  const declined: Array<'impressions' | 'clicks' | 'ctr' | 'position'> = []
  for (const metric of ['impressions', 'clicks', 'ctr', 'position'] as const) {
    const before = snapshotMetric(previous, metric)
    const after = snapshotMetric(current, metric)
    if (before === null || after === null || before <= 0) continue
    const isDecline = metric === 'position'
      ? after >= before * (1 + threshold)
      : after <= before * (1 - threshold)
    if (isDecline) declined.push(metric)
  }
  return declined
}

function indexErrorPresent(input: ContentRefreshInput): boolean {
  const index = input.index
  const status = normalizeUrlStatus(
    index?.status
    ?? index?.state
    ?? input.indexStatus
    ?? input.indexState,
  )
  const explicitError = input.indexError
  return status === 'error'
    || status === 'excluded'
    || (typeof explicitError === 'boolean' && explicitError)
    || (typeof explicitError === 'string' && explicitError.trim().length > 0)
    || Boolean(index?.error?.trim())
    || Boolean(index?.errorCode?.trim())
}

/**
 * Produce a deterministic recommendation for one URL.  All date-based
 * decisions require an explicit `asOf`; callers can also provide an already
 * calculated evidence age.  This keeps repeated runs stable and testable.
 */
export function recommendContentRefresh(
  input: ContentRefreshInput,
): ContentRefreshRecommendation {
  const evidenceThreshold = finiteNonNegativeOrNull(
    input.staleAfterDays ?? input.evidence?.staleAfterDays,
  ) ?? DEFAULT_REFRESH_THRESHOLDS.evidenceStaleAfterDays
  const age = evidenceAgeDays(input)
  const staleEvidence = input.staleEvidence === true
    || input.evidenceStale === true
    || input.evidence?.stale === true
    || (age !== null && age >= evidenceThreshold)

  const current = input.currentPerformance
    ?? input.currentStats
    ?? input.current
    ?? input.content?.current
    ?? null
  const previous = input.previousPerformance
    ?? input.previousStats
    ?? input.previous
    ?? input.content?.previous
    ?? null
  const declineThreshold = thresholdOrDefault(
    input.declineThreshold ?? input.content?.declineThreshold,
    DEFAULT_REFRESH_THRESHOLDS.contentDeclineRate,
  )
  const declinedMetrics = contentDeclineMetrics(previous, current, declineThreshold)
  const contentDecline = input.contentDecline === true
    || input.content?.declining === true
    || input.content?.decline === true
    || declinedMetrics.length > 0
  const hasIndexError = indexErrorPresent(input)

  const reasons: ContentRefreshReason[] = []
  if (staleEvidence) reasons.push('stale_evidence')
  if (contentDecline) reasons.push('content_decline')
  if (hasIndexError) reasons.push('index_error')

  const recommendation: RefreshRecommendationAction = hasIndexError
    ? 'investigate_index'
    : reasons.length > 0
      ? 'refresh'
      : 'monitor'
  const priority: RefreshRecommendationPriority = hasIndexError
    || (staleEvidence && contentDecline)
    ? 'high'
    : reasons.length > 0
      ? 'medium'
      : 'low'
  const provider = input.provider === undefined || input.provider === null
    ? null
    : normalizeSearchProvider(input.provider)
  const reasonCodes = [...reasons] as readonly ContentRefreshReason[]

  return {
    url: input.url?.trim() || null,
    provider,
    recommendation,
    action: recommendation,
    shouldRefresh: recommendation === 'refresh',
    priority,
    reasons: reasonCodes,
    reasonCodes,
    staleEvidence,
    contentDecline,
    contentDeclineMetrics: declinedMetrics,
    indexError: hasIndexError,
    blockedByIndexError: hasIndexError,
  }
}

export const getContentRefreshRecommendation = recommendContentRefresh
export const determineRefreshRecommendation = recommendContentRefresh
export const recommendRefresh = recommendContentRefresh

const PRIORITY_RANK: Readonly<Record<RefreshRecommendationPriority, number>> = {
  high: 0,
  medium: 1,
  low: 2,
}

/** Sort recommendations deterministically for an operator queue. */
export function recommendContentRefreshes(
  inputs: readonly ContentRefreshInput[],
): ContentRefreshRecommendation[] {
  return inputs
    .map(recommendContentRefresh)
    .sort((left, right) => (
      PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
      || compareStrings(left.url ?? '', right.url ?? '')
      || compareStrings(left.provider ?? '', right.provider ?? '')
    ))
}

export const getContentRefreshRecommendations = recommendContentRefreshes
