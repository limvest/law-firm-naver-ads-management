import {
  and,
  eq,
  inArray,
  isNull,
  or,
} from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  contentAssets,
  publications,
  searchIntegrations,
  searchQueryStats,
  searchUrlStatuses,
} from '@/lib/db/schema'
import {
  aggregateSearchQueryStats,
  calculateIndexLatency,
  inspectUrlIndexState,
  normalizeSearchProvider,
  normalizeSearchQueryDailyStat,
  recommendContentRefreshes,
  type ContentRefreshRecommendation,
  type SearchIntegrationProvider,
  type SearchPerformanceSnapshot,
  type SearchProvider,
  type SearchProviderName,
  type SearchQueryAggregate,
  type SearchQueryDailyStat,
  type SearchTimestamp,
  type SearchUrlIndexObservation,
  type SearchUrlStatusInput,
} from './intelligence'

type SearchIntegrationRow = typeof searchIntegrations.$inferSelect
type SearchUrlStatusRow = typeof searchUrlStatuses.$inferSelect
type SearchQueryStatRow = typeof searchQueryStats.$inferSelect
type PublicationRow = typeof publications.$inferSelect
type ContentAssetRow = typeof contentAssets.$inferSelect

export class SearchPersistenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchPersistenceError'
  }
}

export type SearchIntegrationUpsertInput = {
  firmId: number
  provider: SearchProvider
  siteUrl: string
  status?: string
  config?: Record<string, unknown> | null
  lastSyncedAt?: SearchTimestamp | null
  lastError?: string | null
  updatedAt?: SearchTimestamp | null
}

export type SearchIntegrationUpsertResult = {
  integration: SearchIntegrationRow
  row: SearchIntegrationRow
  inserted: boolean
}

export type SearchUrlStatusUpsertInput = Omit<
  SearchUrlIndexObservation,
  'provider' | 'publicationId'
> & {
  firmId: number
  integrationId: string
  provider?: SearchProvider
  publicationId?: string | null
  observation?: SearchUrlIndexObservation
  raw?: Record<string, unknown> | null
}

export type SearchUrlStatusUpsertResult = {
  urlStatus: SearchUrlStatusRow
  observation: SearchUrlStatusRow
  row: SearchUrlStatusRow
  inserted: boolean
}

export type SearchQueryStatUpsertInput = {
  firmId: number
  integrationId: string
  provider?: SearchProvider
  publicationId?: string | null
  url?: string | null
  pageUrl?: string | null
  query?: string
  searchQuery?: string
  day?: string
  date?: string
  impressions?: number
  clicks?: number
  ctr?: number | null
  position?: number | null
  averagePosition?: number | null
  positionBasisPoints?: number | null
  stat?: SearchQueryDailyStat
}

export type SearchQueryStatUpsertResult = {
  queryStat: SearchQueryStatRow
  stat: SearchQueryStatRow
  row: SearchQueryStatRow
  inserted: boolean
}

export type SearchQueryStatsBatchInput = {
  firmId: number
  integrationId: string
  provider?: SearchProvider
  stats: readonly (SearchQueryStatUpsertInput | SearchQueryDailyStat)[]
}

export type SearchExcludedUrl = {
  provider: SearchIntegrationProvider
  providerName: SearchProviderName
  publicationId: string
  url: string
  status: 'excluded'
  reason: string | null
  checkedAt: Date | null
}

export type SearchProviderIntegrationSummary = {
  provider: SearchIntegrationProvider
  providerName: SearchProviderName
  integrationId: string | null
  siteUrl: string | null
  integrationStatus: string | null
  integrationIds: string[]
  integrations: Array<{
    id: string
    siteUrl: string
    status: string
    lastSyncedAt: Date | null
    lastError: string | null
  }>
  totalUrls: number
  indexableUrls: number
  observedUrls: number
  indexedUrls: number
  indexRate: number | null
  averageIndexLatencyDays: number | null
  medianIndexLatencyDays: number | null
  averageIndexLatency: number | null
  medianIndexLatency: number | null
  impressions: number | null
  clicks: number | null
  ctr: number | null
  weightedPosition: number | null
  weightedAvgPosition: number | null
  weightedAveragePosition: number | null
  averagePosition: number | null
  queryStats: SearchQueryAggregate[]
  excludedUrls: SearchExcludedUrl[]
  excludedUrlCount: number
  refreshRecommendations: ContentRefreshRecommendation[]
  actionableRefreshRecommendations: ContentRefreshRecommendation[]
}

export type SearchDashboardSummaryOptions = {
  /** Inclusive YYYY-MM-DD bounds for the current query-stat window. */
  since?: string | Date
  until?: string | Date
  /** Optional comparison window used by refresh recommendations. */
  previousSince?: string | Date
  previousUntil?: string | Date
  /** Required by the pure recommendation rules for stale-evidence decisions. */
  asOf?: SearchTimestamp | null
  staleAfterDays?: number
  declineThreshold?: number
}

export type SearchDashboardSummary = {
  firmId: number
  providers: SearchProviderIntegrationSummary[]
  providerSummaries: SearchProviderIntegrationSummary[]
  byProvider: Partial<Record<SearchIntegrationProvider, SearchProviderIntegrationSummary>>
  providerMetrics: Partial<Record<SearchIntegrationProvider, SearchProviderIntegrationSummary>>
  indexableUrls: number
  totalUrls: number
  indexRate: number | null
  indexRateByProvider: Partial<Record<SearchIntegrationProvider, number | null>>
  impressions: number | null
  clicks: number | null
  ctr: number | null
  weightedPosition: number | null
  weightedAveragePosition: number | null
  averagePosition: number | null
  excludedUrls: SearchExcludedUrl[]
  refreshRecommendations: ContentRefreshRecommendation[]
  actionableRefreshRecommendations: ContentRefreshRecommendation[]
}

function firmIdValue(value: number | { id: number }): number {
  const id = typeof value === 'number' ? value : value.id
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new SearchPersistenceError('firm id must be a positive integer')
  }
  return id
}

function requiredText(value: string | null | undefined, field: string): string {
  const normalized = value?.trim() ?? ''
  if (!normalized) throw new SearchPersistenceError(`${field} must not be blank`)
  return normalized
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function timestampDate(
  value: SearchTimestamp | null | undefined,
  field: string,
): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new SearchPersistenceError(`${field} must be a valid timestamp`)
  }
  return date
}

function dayValue(value: string | Date | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new SearchPersistenceError(`${field} must be a valid date`)
    return value.toISOString().slice(0, 10)
  }
  const day = value.trim()
  if (!day) throw new SearchPersistenceError(`${field} must not be blank`)
  return day
}

function optionalDate(value: Date | null | undefined): Date | null {
  return value ? new Date(value.getTime()) : null
}

function providerFromStoredValue(value: string): SearchIntegrationProvider {
  try {
    return normalizeSearchProvider(value as SearchProvider)
  } catch {
    throw new SearchPersistenceError(`unsupported search provider: ${value}`)
  }
}

function requestedProvider(
  value: SearchProvider | undefined,
  fallback: SearchIntegrationProvider,
): SearchIntegrationProvider {
  if (value === undefined) return fallback
  const normalized = normalizeSearchProvider(value)
  if (normalized !== fallback) {
    throw new SearchPersistenceError(
      `search provider does not match integration provider ${fallback}`,
    )
  }
  return normalized
}

async function integrationForFirm(
  db: Db,
  firmId: number,
  integrationId: string,
): Promise<{ row: SearchIntegrationRow; provider: SearchIntegrationProvider }> {
  const [row] = await db.select().from(searchIntegrations).where(and(
    eq(searchIntegrations.id, requiredText(integrationId, 'integrationId')),
    eq(searchIntegrations.firmId, firmId),
  )).limit(1)
  if (!row) throw new SearchPersistenceError('search integration not found in firm scope')
  return { row, provider: providerFromStoredValue(row.provider) }
}

async function publicationForFirm(
  db: Db,
  firmId: number,
  publicationId: string | null | undefined,
  url: string | null | undefined,
): Promise<PublicationRow | null> {
  const id = optionalText(publicationId)
  if (id) {
    const [row] = await db.select().from(publications).where(and(
      eq(publications.id, id),
      eq(publications.firmId, firmId),
    )).limit(1)
    if (!row) throw new SearchPersistenceError('publication not found in firm scope')
    return row
  }
  const normalizedUrl = optionalText(url)
  if (!normalizedUrl) return null
  const rows = await db.select().from(publications).where(and(
    eq(publications.firmId, firmId),
    or(eq(publications.url, normalizedUrl), eq(publications.canonicalUrl, normalizedUrl)),
  ))
  return rows[0] ?? null
}

/** Persist one provider connection without crossing firm boundaries. */
export async function upsertSearchIntegration(
  db: Db,
  input: SearchIntegrationUpsertInput,
): Promise<SearchIntegrationUpsertResult> {
  const firmId = firmIdValue(input.firmId)
  const provider = normalizeSearchProvider(input.provider)
  const siteUrl = requiredText(input.siteUrl, 'siteUrl')
  const lastSyncedAt = timestampDate(input.lastSyncedAt, 'lastSyncedAt')
  const updatedAt = timestampDate(input.updatedAt, 'updatedAt')
  const [before] = await db.select().from(searchIntegrations).where(and(
    eq(searchIntegrations.firmId, firmId),
    eq(searchIntegrations.provider, provider),
    eq(searchIntegrations.siteUrl, siteUrl),
  )).limit(1)

  const values: typeof searchIntegrations.$inferInsert = {
    firmId,
    provider,
    siteUrl,
    ...(input.status === undefined ? {} : { status: requiredText(input.status, 'status') }),
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt }),
    ...(input.lastError === undefined ? {} : { lastError: optionalText(input.lastError) }),
    ...(updatedAt === null ? {} : { updatedAt }),
  }
  const update: Partial<typeof searchIntegrations.$inferInsert> = {
    ...(input.status === undefined ? {} : { status: requiredText(input.status, 'status') }),
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt }),
    ...(input.lastError === undefined ? {} : { lastError: optionalText(input.lastError) }),
    // Drizzle rejects an empty conflict update set. Preserve the existing
    // timestamp for a metadata-only replay, and only use the clock for the
    // rare concurrent insert race.
    updatedAt: updatedAt ?? before?.updatedAt ?? new Date(),
  }
  const [row] = await db.insert(searchIntegrations).values(values)
    .onConflictDoUpdate({
      target: [searchIntegrations.firmId, searchIntegrations.provider, searchIntegrations.siteUrl],
      set: update,
    })
    .returning()
  if (!row) throw new SearchPersistenceError('search integration upsert returned no row')
  return { integration: row, row, inserted: !before }
}

/** Persist one provider URL inspection, deriving status only from provider evidence. */
export async function upsertSearchUrlStatus(
  db: Db,
  input: SearchUrlStatusUpsertInput,
): Promise<SearchUrlStatusUpsertResult> {
  const firmId = firmIdValue(input.firmId)
  const integration = await integrationForFirm(db, firmId, input.integrationId)
  const observationInput = {
    ...(input.observation ?? {}),
    ...input,
  } as SearchUrlIndexObservation & { raw?: Record<string, unknown> | null }
  const provider = requestedProvider(
    input.provider ?? input.observation?.provider,
    integration.provider,
  )
  const publication = await publicationForFirm(
    db,
    firmId,
    input.publicationId ?? input.observation?.publicationId,
    input.url ?? input.observation?.url,
  )
  const publicationId = publication?.id ?? optionalText(input.publicationId ?? input.observation?.publicationId)
  if (!publicationId) {
    throw new SearchPersistenceError('publicationId or a firm-owned URL is required')
  }
  if (!publication) {
    throw new SearchPersistenceError('publication not found in firm scope')
  }
  const inspection = inspectUrlIndexState({
    ...observationInput,
    provider,
    publicationId,
    url: publication.url,
  })
  const submittedAt = timestampDate(observationInput.submittedAt, 'submittedAt')
  const discoveredAt = timestampDate(observationInput.discoveredAt, 'discoveredAt')
  const indexedAt = timestampDate(observationInput.indexedAt, 'indexedAt')
  const checkedAt = timestampDate(
    observationInput.checkedAt ?? observationInput.observedAt,
    'checkedAt',
  ) ?? new Date()
  const raw = input.raw === undefined ? null : input.raw

  const [before] = await db.select().from(searchUrlStatuses).where(and(
    eq(searchUrlStatuses.integrationId, integration.row.id),
    eq(searchUrlStatuses.publicationId, publication.id),
  )).limit(1)
  const [row] = await db.insert(searchUrlStatuses).values({
    integrationId: integration.row.id,
    publicationId: publication.id,
    status: inspection.status,
    reason: inspection.reason,
    submittedAt,
    discoveredAt,
    indexedAt,
    checkedAt,
    raw,
  }).onConflictDoUpdate({
    target: [searchUrlStatuses.integrationId, searchUrlStatuses.publicationId],
    set: {
      status: inspection.status,
      reason: inspection.reason,
      submittedAt,
      discoveredAt,
      indexedAt,
      checkedAt,
      raw,
    },
  }).returning()
  if (!row) throw new SearchPersistenceError('search URL status upsert returned no row')
  return { urlStatus: row, observation: row, row, inserted: !before }
}

function queryCount(value: number | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SearchPersistenceError(`${field} must be a finite non-negative integer`)
  }
  return value
}

function queryInputWithDefaults(
  input: SearchQueryStatUpsertInput,
  provider: SearchIntegrationProvider,
): SearchQueryDailyStat {
  const merged = {
    ...(input.stat ?? {}),
    ...input,
  }
  return {
    provider: requestedProvider(
      input.provider ?? input.stat?.provider,
      provider,
    ),
    query: merged.query,
    searchQuery: merged.searchQuery,
    day: merged.day,
    date: merged.date,
    publicationId: merged.publicationId ?? input.stat?.publicationId,
    url: merged.url,
    pageUrl: merged.pageUrl,
    impressions: queryCount(merged.impressions, 'impressions'),
    clicks: queryCount(merged.clicks, 'clicks'),
    ctr: merged.ctr,
    position: merged.position,
    averagePosition: merged.averagePosition,
    positionBasisPoints: merged.positionBasisPoints,
  }
}

/** Persist one provider/day/query row; replaying the same key updates one row. */
export async function upsertSearchQueryStat(
  db: Db,
  input: SearchQueryStatUpsertInput,
): Promise<SearchQueryStatUpsertResult> {
  const firmId = firmIdValue(input.firmId)
  const integration = await integrationForFirm(db, firmId, input.integrationId)
  const statInput = queryInputWithDefaults(input, integration.provider)
  const normalized = normalizeSearchQueryDailyStat(statInput)
  const day = requiredText(normalized.day, 'day')
  const publication = await publicationForFirm(
    db,
    firmId,
    input.publicationId ?? input.stat?.publicationId,
    normalized.url,
  )
  const publicationId = publication?.id
    ?? optionalText(input.publicationId ?? input.stat?.publicationId)
    ?? null
  if (publicationId && !publication) {
    throw new SearchPersistenceError('publication not found in firm scope')
  }
  const positionBasisPoints = normalized.positionBasisPoints === null
    ? null
    : Math.round(normalized.positionBasisPoints)
  const key = [
    eq(searchQueryStats.integrationId, integration.row.id),
    eq(searchQueryStats.day, day),
    eq(searchQueryStats.query, normalized.query),
    publicationId === null
      ? isNull(searchQueryStats.publicationId)
      : eq(searchQueryStats.publicationId, publicationId),
  ]
  const [before] = await db.select().from(searchQueryStats).where(and(...key)).limit(1)
  const values: typeof searchQueryStats.$inferInsert = {
    integrationId: integration.row.id,
    publicationId,
    day,
    query: normalized.query,
    impressions: normalized.impressions,
    clicks: normalized.clicks,
    positionBasisPoints,
  }
  let row: SearchQueryStatRow | undefined
  if (before) {
    ;[row] = await db.update(searchQueryStats).set({
      impressions: values.impressions,
      clicks: values.clicks,
      positionBasisPoints: values.positionBasisPoints,
    }).where(eq(searchQueryStats.id, before.id)).returning()
  } else {
    ;[row] = await db.insert(searchQueryStats).values(values).returning()
  }
  if (!row) throw new SearchPersistenceError('search query stat upsert returned no row')
  return { queryStat: row, stat: row, row, inserted: !before }
}

/** Persist a deterministic sequence of daily query rows for one firm/integration. */
export async function upsertSearchQueryStats(
  db: Db,
  input: SearchQueryStatsBatchInput,
): Promise<SearchQueryStatUpsertResult[]> {
  const rows: SearchQueryStatUpsertResult[] = []
  for (const stat of input.stats) {
    const candidate = stat as SearchQueryStatUpsertInput
    rows.push(await upsertSearchQueryStat(db, {
      ...candidate,
      firmId: input.firmId,
      integrationId: input.integrationId,
      provider: input.provider ?? candidate.provider,
    }))
  }
  return rows
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function dateMs(value: Date | null | undefined): number {
  return value && Number.isFinite(value.getTime()) ? value.getTime() : 0
}

function latestStatus(
  rows: readonly SearchUrlStatusRow[],
): SearchUrlStatusRow | null {
  let latest: SearchUrlStatusRow | null = null
  for (const row of rows) {
    if (!latest
      || dateMs(row.checkedAt) > dateMs(latest.checkedAt)
      || (dateMs(row.checkedAt) === dateMs(latest.checkedAt) && row.id > latest.id)) {
      latest = row
    }
  }
  return latest
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function average(values: readonly number[]): number | null {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function snapshotForRows(
  rows: readonly SearchQueryStatRow[],
  publicationId: string,
  publicationById: ReadonlyMap<string, PublicationRow>,
): SearchPerformanceSnapshot | null {
  const matching = rows.filter((row) => row.publicationId === publicationId)
  if (!matching.length) return null
  let impressions = 0
  let clicks = 0
  let weightedPosition = 0
  let positionImpressions = 0
  for (const row of matching) {
    impressions += row.impressions
    clicks += row.clicks
    if (row.positionBasisPoints !== null && row.impressions > 0) {
      weightedPosition += (row.positionBasisPoints / 100) * row.impressions
      positionImpressions += row.impressions
    }
  }
  const position = positionImpressions === 0 ? null : weightedPosition / positionImpressions
  // The map lookup is an intentional scope assertion for callers and keeps
  // this helper from accidentally recommending a row without a firm URL.
  if (!publicationById.has(publicationId)) return null
  return {
    impressions,
    clicks,
    ctr: impressions === 0 ? 0 : clicks / impressions,
    position,
    averagePosition: position,
    weightedAvgPosition: position,
    weightedAveragePosition: position,
  }
}

function rangeRows(
  rows: readonly SearchQueryStatRow[],
  since: string | null,
  until: string | null,
): SearchQueryStatRow[] {
  return rows.filter((row) => (
    (!since || row.day >= since) && (!until || row.day <= until)
  ))
}

function previousRange(
  since: string | null,
  until: string | null,
): { since: string; until: string } | null {
  if (!since || !until) return null
  const start = new Date(`${since}T00:00:00.000Z`)
  const end = new Date(`${until}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  const previousEnd = new Date(start.getTime() - 86_400_000)
  const previousStart = new Date(previousEnd.getTime() - (span - 1) * 86_400_000)
  return {
    since: previousStart.toISOString().slice(0, 10),
    until: previousEnd.toISOString().slice(0, 10),
  }
}

function providerMetrics(
  rows: readonly SearchQueryStatRow[],
): {
  impressions: number | null
  clicks: number | null
  ctr: number | null
  weightedPosition: number | null
} {
  if (!rows.length) return { impressions: null, clicks: null, ctr: null, weightedPosition: null }
  let impressions = 0
  let clicks = 0
  let positionTotal = 0
  let positionImpressions = 0
  for (const row of rows) {
    impressions += row.impressions
    clicks += row.clicks
    if (row.positionBasisPoints !== null && row.impressions > 0) {
      positionTotal += (row.positionBasisPoints / 100) * row.impressions
      positionImpressions += row.impressions
    }
  }
  return {
    impressions,
    clicks,
    ctr: impressions === 0 ? 0 : clicks / impressions,
    weightedPosition: positionImpressions === 0 ? null : positionTotal / positionImpressions,
  }
}

function sortProviderSummaries(
  rows: SearchProviderIntegrationSummary[],
): SearchProviderIntegrationSummary[] {
  return rows.sort((left, right) => compareText(left.provider, right.provider))
}

/**
 * Build the firm dashboard view from persisted observations only.  SEO pages
 * with an explicit index policy are the denominator; ad landing/noindex URLs
 * never inflate the customer's index rate.
 */
export async function getSearchDashboardSummary(
  db: Db,
  firm: number | { id: number },
  options: SearchDashboardSummaryOptions = {},
): Promise<SearchDashboardSummary> {
  const firmId = firmIdValue(firm)
  const since = dayValue(options.since, 'since')
  const until = dayValue(options.until, 'until')
  const previousSince = dayValue(options.previousSince, 'previousSince')
  const previousUntil = dayValue(options.previousUntil, 'previousUntil')
  const derivedPrevious = previousSince || previousUntil
    ? null
    : previousRange(since, until)
  const currentPreviousSince = previousSince ?? derivedPrevious?.since ?? null
  const currentPreviousUntil = previousUntil ?? derivedPrevious?.until ?? null
  const asOf = timestampDate(options.asOf, 'asOf')

  const [integrationRows, publicationRows, assetRows] = await Promise.all([
    db.select().from(searchIntegrations).where(eq(searchIntegrations.firmId, firmId)),
    db.select().from(publications).where(eq(publications.firmId, firmId)),
    db.select().from(contentAssets).where(eq(contentAssets.firmId, firmId)),
  ])
  const assetById = new Map(assetRows.map((row) => [row.id, row]))
  const publicationById = new Map(publicationRows.map((row) => [row.id, row]))
  const indexablePublications = publicationRows
    .filter((publication) => {
      const asset = assetById.get(publication.contentAssetId)
      return asset?.assetType === 'seo_page' && publication.indexPolicy === 'index'
    })
    .sort((left, right) => compareText(left.url, right.url) || compareText(left.id, right.id))
  const indexableIds = new Set(indexablePublications.map((row) => row.id))
  const integrationIds = integrationRows.map((row) => row.id)
  const [statusRows, queryRows] = integrationIds.length === 0
    ? [[], []] as const
    : await Promise.all([
      db.select().from(searchUrlStatuses).where(inArray(searchUrlStatuses.integrationId, integrationIds)),
      db.select().from(searchQueryStats).where(inArray(searchQueryStats.integrationId, integrationIds)),
    ])
  const integrationById = new Map(integrationRows.map((row) => [row.id, row]))
  const providers = new Map<SearchIntegrationProvider, {
    integrations: SearchIntegrationRow[]
    statuses: SearchUrlStatusRow[]
    queryRows: SearchQueryStatRow[]
  }>()
  for (const row of integrationRows) {
    const provider = providerFromStoredValue(row.provider)
    const bucket = providers.get(provider) ?? { integrations: [], statuses: [], queryRows: [] }
    bucket.integrations.push(row)
    providers.set(provider, bucket)
  }
  for (const row of statusRows) {
    const integration = integrationById.get(row.integrationId)
    if (!integration || !indexableIds.has(row.publicationId)) continue
    const provider = providerFromStoredValue(integration.provider)
    providers.get(provider)?.statuses.push(row)
  }
  for (const row of queryRows) {
    const integration = integrationById.get(row.integrationId)
    if (!integration) continue
    if (row.publicationId !== null && !indexableIds.has(row.publicationId)) continue
    const provider = providerFromStoredValue(integration.provider)
    providers.get(provider)?.queryRows.push(row)
  }

  const summaries: SearchProviderIntegrationSummary[] = []
  for (const [provider, bucket] of providers.entries()) {
    const integrations = [...bucket.integrations].sort((left, right) => (
      compareText(left.siteUrl, right.siteUrl) || compareText(left.id, right.id)
    ))
    const primary = integrations[0]
    const statusByPublication = new Map<string, SearchUrlStatusRow>()
    for (const publication of indexablePublications) {
      const latest = latestStatus(bucket.statuses.filter((row) => row.publicationId === publication.id))
      if (latest) statusByPublication.set(publication.id, latest)
    }
    const indexedUrls = indexablePublications.filter((publication) => (
      statusByPublication.get(publication.id)?.status === 'indexed'
    )).length
    const observedUrls = statusByPublication.size
    const latencyDays: number[] = []
    for (const publication of indexablePublications) {
      const status = statusByPublication.get(publication.id)
      if (!status || status.status !== 'indexed') continue
      const latency = calculateIndexLatency({
        publishedAt: publication.publishedAt,
        submittedAt: status.submittedAt,
        discoveredAt: status.discoveredAt,
        indexedAt: status.indexedAt,
        status: status.status,
      })
      if (latency.status === 'calculated' && latency.days !== null) latencyDays.push(latency.days)
    }

    const currentRows = rangeRows(bucket.queryRows, since, until)
    const previousRows = rangeRows(bucket.queryRows, currentPreviousSince, currentPreviousUntil)
    const normalizedCurrent = currentRows.map((row) => normalizeSearchQueryDailyStat({
      provider,
      query: row.query,
      day: row.day,
      publicationId: row.publicationId,
      url: row.publicationId ? publicationById.get(row.publicationId)?.url ?? null : null,
      impressions: row.impressions,
      clicks: row.clicks,
      positionBasisPoints: row.positionBasisPoints,
    }))
    const queryStats = aggregateSearchQueryStats(normalizedCurrent)
    const metrics = providerMetrics(currentRows)
    const excludedUrls: SearchExcludedUrl[] = indexablePublications
      .map((publication) => ({ publication, status: statusByPublication.get(publication.id) }))
      .filter((item): item is { publication: PublicationRow; status: SearchUrlStatusRow } => (
        item.status?.status === 'excluded'
      ))
      .map(({ publication, status }) => ({
        provider,
        providerName: (provider === 'google_search_console' ? 'google' : 'naver') as SearchProviderName,
        publicationId: publication.id,
        url: publication.url,
        status: 'excluded' as const,
        reason: status.reason,
        checkedAt: optionalDate(status.checkedAt),
      }))
      .sort((left, right) => compareText(left.url, right.url) || compareText(left.publicationId, right.publicationId))

    const recommendationInputs = indexablePublications.map((publication) => {
      const status = statusByPublication.get(publication.id)
      return {
        url: publication.url,
        provider,
        asOf,
        staleAfterDays: options.staleAfterDays,
        declineThreshold: options.declineThreshold,
        evidence: status ? { capturedAt: status.checkedAt } : null,
        current: snapshotForRows(currentRows, publication.id, publicationById),
        previous: snapshotForRows(previousRows, publication.id, publicationById),
        index: status
          ? { status: status.status as SearchUrlStatusInput, reason: status.reason }
          : { status: 'unknown' as const },
      }
    })
    const refreshRecommendations = recommendContentRefreshes(recommendationInputs)
    const actionableRefreshRecommendations = refreshRecommendations.filter((row) => (
      row.recommendation !== 'monitor'
    ))
    const providerSummary: SearchProviderIntegrationSummary = {
      provider,
      providerName: provider === 'google_search_console' ? 'google' : 'naver',
      integrationId: primary?.id ?? null,
      siteUrl: primary?.siteUrl ?? null,
      integrationStatus: primary?.status ?? null,
      integrationIds: integrations.map((row) => row.id),
      integrations: integrations.map((row) => ({
        id: row.id,
        siteUrl: row.siteUrl,
        status: row.status,
        lastSyncedAt: optionalDate(row.lastSyncedAt),
        lastError: row.lastError,
      })),
      totalUrls: indexablePublications.length,
      indexableUrls: indexablePublications.length,
      observedUrls,
      indexedUrls,
      indexRate: indexablePublications.length === 0 ? null : indexedUrls / indexablePublications.length,
      averageIndexLatencyDays: average(latencyDays),
      medianIndexLatencyDays: median(latencyDays),
      averageIndexLatency: average(latencyDays),
      medianIndexLatency: median(latencyDays),
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      ctr: metrics.ctr,
      weightedPosition: metrics.weightedPosition,
      weightedAvgPosition: metrics.weightedPosition,
      weightedAveragePosition: metrics.weightedPosition,
      averagePosition: metrics.weightedPosition,
      queryStats,
      excludedUrls,
      excludedUrlCount: excludedUrls.length,
      refreshRecommendations,
      actionableRefreshRecommendations,
    }
    summaries.push(providerSummary)
  }
  sortProviderSummaries(summaries)

  const byProvider: Partial<Record<SearchIntegrationProvider, SearchProviderIntegrationSummary>> = {}
  for (const summary of summaries) byProvider[summary.provider] = summary
  const excludedUrls = summaries.flatMap((summary) => summary.excludedUrls)
    .sort((left, right) => compareText(left.provider, right.provider)
      || compareText(left.url, right.url)
      || compareText(left.publicationId, right.publicationId))
  const refreshRecommendations = summaries.flatMap((summary) => summary.refreshRecommendations)
    .sort((left, right) => (
      (left.priority === right.priority ? 0 : left.priority === 'high' ? -1 : right.priority === 'high' ? 1 : left.priority === 'medium' ? -1 : 1)
      || compareText(left.provider ?? '', right.provider ?? '')
      || compareText(left.url ?? '', right.url ?? '')
    ))
  const actionableRefreshRecommendations = refreshRecommendations.filter((row) => (
    row.recommendation !== 'monitor'
  ))
  const singleProvider = summaries.length === 1 ? summaries[0] : null
  return {
    firmId,
    providers: summaries,
    providerSummaries: summaries,
    byProvider,
    providerMetrics: byProvider,
    indexableUrls: indexablePublications.length,
    totalUrls: indexablePublications.length,
    indexRate: singleProvider?.indexRate ?? null,
    indexRateByProvider: Object.fromEntries(summaries.map((row) => [row.provider, row.indexRate])),
    impressions: singleProvider?.impressions ?? null,
    clicks: singleProvider?.clicks ?? null,
    ctr: singleProvider?.ctr ?? null,
    weightedPosition: singleProvider?.weightedPosition ?? null,
    weightedAveragePosition: singleProvider?.weightedAveragePosition ?? null,
    averagePosition: singleProvider?.averagePosition ?? null,
    excludedUrls,
    refreshRecommendations,
    actionableRefreshRecommendations,
  }
}

// Names used by callers in the domain and by dashboard adapters.
export const upsertProviderIntegration = upsertSearchIntegration
export const upsertSearchProviderIntegration = upsertSearchIntegration
export const upsertUrlIndexStatus = upsertSearchUrlStatus
export const upsertSearchUrlIndexObservation = upsertSearchUrlStatus
export const recordSearchUrlStatus = upsertSearchUrlStatus
export const upsertDailyQueryStat = upsertSearchQueryStat
export const recordSearchQueryStat = upsertSearchQueryStat
export const customerSearchSummaryForFirm = getSearchDashboardSummary
export const searchDashboardSummaryForFirm = getSearchDashboardSummary
export const searchSummaryForFirm = getSearchDashboardSummary
