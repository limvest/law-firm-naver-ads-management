import { eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  caseEntities,
  contentAssets,
  publications,
  searchIntegrations,
  searchQueryStats,
  searchUrlStatuses,
} from '@/lib/db/schema'
import {
  getSearchProviderName,
  inspectUrlIndexState,
  normalizeSearchProvider,
  normalizeSearchQueryDailyStat,
  recommendContentRefresh,
  type ContentRefreshRecommendation,
  type SearchIntegrationProvider,
  type SearchPerformanceSnapshot,
  type SearchProviderName,
  type SearchProvider,
  type SearchTimestamp,
  type SearchUrlStatusInput,
} from './intelligence'

type SearchIntegrationRow = typeof searchIntegrations.$inferSelect
type SearchUrlStatusRow = typeof searchUrlStatuses.$inferSelect
type SearchQueryStatRow = typeof searchQueryStats.$inferSelect
type PublicationRow = typeof publications.$inferSelect
type ContentAssetRow = typeof contentAssets.$inferSelect
type CaseEntityRow = typeof caseEntities.$inferSelect

export class SearchDetailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchDetailError'
  }
}

export type SearchDetailOptions = {
  /** Inclusive YYYY-MM-DD bounds. Omitted bounds include persisted rows only. */
  since?: string | Date
  until?: string | Date
  /** Optional comparison window for refresh recommendations. */
  previousSince?: string | Date
  previousUntil?: string | Date
  /** Date used for stale-evidence decisions; omitted means no age is inferred. */
  asOf?: SearchTimestamp | null
  staleAfterDays?: number
  declineThreshold?: number
}

export type SearchDetailPeriod = {
  since: string | null
  until: string | null
}

export type SearchDetailMetrics = {
  impressions: number | null
  clicks: number | null
  ctr: number | null
  averagePosition: number | null
  weightedAveragePosition: number | null
}

export type SearchDetailIntegration = {
  id: string
  firmId: number
  provider: SearchIntegrationProvider
  providerName: SearchProviderName
  siteUrl: string
  status: string
  lastSyncedAt: string | null
  lastError: string | null
  totalUrls: number
  indexableUrls: number
  observedUrls: number
  indexedUrls: number
  indexRate: number | null
  checkedAt: string | null
  metrics: SearchDetailMetrics
}

export type SearchDetailIndexStatus = {
  firmId: number
  integrationId: string
  provider: SearchIntegrationProvider
  providerName: SearchProviderName
  publicationId: string
  url: string
  canonicalUrl: string
  caseEntityId: string
  caseName: string | null
  contentAssetId: string
  contentVersion: number
  latestContentVersion: number | null
  status: string
  state: string
  indexed: boolean
  isIndexed: boolean
  observed: boolean
  exclusionReason: string | null
  reason: string | null
  checkedAt: string | null
  submittedAt: string | null
  discoveredAt: string | null
  indexedAt: string | null
}

export type SearchDetailPublication = {
  firmId: number
  publicationId: string
  id: string
  url: string
  canonicalUrl: string
  caseEntityId: string
  caseName: string | null
  contentAssetId: string
  assetId: string
  assetType: string
  assetStatus: string
  contentVersion: number
  assetVersion: number
  latestContentVersion: number | null
  latestAssetVersion: number | null
  templateVersion: string
  contentUpdatedAt: string | null
  publishedAt: string | null
  publicationStatus: string
  indexPolicy: string
  deployedVersion: string | null
  lastVerifiedAt: string | null
  checkedAt: string | null
  lastCheckedAt: string | null
  indexStatuses: SearchDetailIndexStatus[]
}

export type SearchDetailQueryMetric = {
  /** Null for the standalone pure aggregator; database views always set it. */
  firmId: number | null
  integrationId: string
  provider: SearchIntegrationProvider
  providerName: SearchProviderName
  publicationId: string | null
  url: string | null
  canonicalUrl: string | null
  caseEntityId: string | null
  caseName: string | null
  query: string
  period: SearchDetailPeriod
  since: string | null
  until: string | null
  impressions: number
  clicks: number
  ctr: number
  averagePosition: number | null
  weightedAveragePosition: number | null
  clickThroughRate: number
}

export type SearchDetailRefreshRecommendation = ContentRefreshRecommendation & {
  firmId: number
  integrationId: string
  publicationId: string
  caseEntityId: string
  caseName: string | null
  contentAssetId: string
  contentVersion: number
  latestContentVersion: number | null
  checkedAt: string | null
}

export type SearchDetailProvider = {
  provider: SearchIntegrationProvider
  providerName: SearchProviderName
  integrations: SearchDetailIntegration[]
  integrationIds: string[]
  totalUrls: number
  indexableUrls: number
  observedUrls: number
  indexedUrls: number
  indexRate: number | null
  checkedAt: string | null
  metrics: SearchDetailMetrics
}

export type SearchDetail = {
  firmId: number
  period: SearchDetailPeriod
  observedPeriod: SearchDetailPeriod
  integrations: SearchDetailIntegration[]
  providers: SearchDetailProvider[]
  providerSummaries: SearchDetailProvider[]
  publications: SearchDetailPublication[]
  indexStatuses: SearchDetailIndexStatus[]
  indexRows: SearchDetailIndexStatus[]
  queryMetrics: SearchDetailQueryMetric[]
  queryStats: SearchDetailQueryMetric[]
  queries: SearchDetailQueryMetric[]
  refreshRecommendations: SearchDetailRefreshRecommendation[]
  recommendations: SearchDetailRefreshRecommendation[]
  actionableRefreshRecommendations: SearchDetailRefreshRecommendation[]
  metrics: SearchDetailMetrics
  totals: SearchDetailMetrics
  latestCheckedAt: string | null
  empty: boolean
}

export type SearchDetailQueryStatInput = {
  integrationId: string
  provider: SearchProvider
  publicationId?: string | null
  url?: string | null
  canonicalUrl?: string | null
  caseEntityId?: string | null
  caseName?: string | null
  query?: string
  searchQuery?: string
  day?: string
  date?: string
  impressions: number
  clicks: number
  position?: number | null
  averagePosition?: number | null
  positionBasisPoints?: number | null
}

type NormalizedDetailQueryRow = ReturnType<typeof normalizeSearchQueryDailyStat> & {
  integrationId: string
  canonicalUrl: string | null
  caseEntityId: string | null
  caseName: string | null
}

const EMPTY_METRICS: SearchDetailMetrics = Object.freeze({
  impressions: null,
  clicks: null,
  ctr: null,
  averagePosition: null,
  weightedAveragePosition: null,
})

function emptyMetrics(): SearchDetailMetrics {
  return { ...EMPTY_METRICS }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function positiveFirmId(value: number | { id: number }): number {
  const id = typeof value === 'number' ? value : value.id
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new SearchDetailError('firm id must be a positive integer')
  }
  return id
}

function dateMs(value: Date | null | undefined): number {
  if (!value) return 0
  const time = value.getTime()
  return Number.isFinite(time) ? time : 0
}

function isoDate(value: Date | null | undefined): string | null {
  if (!value || !Number.isFinite(value.getTime())) return null
  return value.toISOString()
}

function toDate(value: SearchTimestamp | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const candidate = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isFinite(candidate.getTime()) ? candidate : null
}

function dayValue(value: string | Date | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new SearchDetailError(`${field} must be a valid date`)
    return value.toISOString().slice(0, 10)
  }
  const raw = value.trim()
  if (!raw) throw new SearchDetailError(`${field} must not be blank`)
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : toDate(raw)?.toISOString().slice(0, 10) ?? null
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new SearchDetailError(`${field} must be a valid date`)
  }
  return day
}

function latestDate(values: readonly (Date | null | undefined)[]): string | null {
  let latest: Date | null = null
  for (const value of values) {
    if (!value || !Number.isFinite(value.getTime())) continue
    if (!latest || value.getTime() > latest.getTime()) latest = value
  }
  return isoDate(latest)
}

function latestStatus(rows: readonly SearchUrlStatusRow[]): SearchUrlStatusRow | null {
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

function statusKey(integrationId: string, publicationId: string): string {
  return `${integrationId}\u0000${publicationId}`
}

function assetKey(caseEntityId: string, assetType: string): string {
  return `${caseEntityId}\u0000${assetType}`
}

function currentAsset(
  asset: ContentAssetRow,
  other: ContentAssetRow,
): boolean {
  if (asset.contentVersion !== other.contentVersion) {
    return asset.contentVersion > other.contentVersion
  }
  return dateMs(asset.updatedAt) > dateMs(other.updatedAt)
}

function latestAssets(rows: readonly ContentAssetRow[]): Map<string, ContentAssetRow> {
  const result = new Map<string, ContentAssetRow>()
  for (const row of rows) {
    const key = assetKey(row.caseEntityId, row.assetType)
    const previous = result.get(key)
    if (!previous || currentAsset(row, previous)) result.set(key, row)
  }
  return result
}

function normalizeDetailQueryRow(
  row: SearchDetailQueryStatInput,
): NormalizedDetailQueryRow {
  const normalized = normalizeSearchQueryDailyStat({
    provider: row.provider,
    query: row.query,
    searchQuery: row.searchQuery,
    day: row.day,
    date: row.date,
    publicationId: row.publicationId,
    url: row.url,
    impressions: row.impressions,
    clicks: row.clicks,
    position: row.position,
    averagePosition: row.averagePosition,
    positionBasisPoints: row.positionBasisPoints,
  })
  return {
    ...normalized,
    integrationId: row.integrationId,
    canonicalUrl: row.canonicalUrl?.trim() || null,
    caseEntityId: row.caseEntityId?.trim() || null,
    caseName: row.caseName?.trim() || null,
  }
}

function queryGroupKey(row: NormalizedDetailQueryRow): string {
  return [
    row.integrationId,
    row.provider,
    // Publication IDs are the join key. A URL is only a display fallback for
    // provider-wide rows that intentionally have no publication ID.
    row.publicationId ?? `url:${row.url ?? ''}`,
    row.query,
  ].join('\u0000')
}

function aggregateNormalizedDetailRows(
  rows: readonly NormalizedDetailQueryRow[],
): SearchDetailQueryMetric {
  const first = rows[0]
  if (!first) throw new SearchDetailError('cannot aggregate an empty search query group')

  let impressions = 0
  let clicks = 0
  let positionTotal = 0
  let positionImpressions = 0
  let since: string | null = null
  let until: string | null = null
  for (const row of rows) {
    impressions += row.impressions
    clicks += row.clicks
    if (row.position !== null && row.impressions > 0) {
      positionTotal += row.position * row.impressions
      positionImpressions += row.impressions
    }
    if (row.day && (!since || row.day < since)) since = row.day
    if (row.day && (!until || row.day > until)) until = row.day
  }
  const averagePosition = positionImpressions === 0
    ? null
    : positionTotal / positionImpressions
  const ctr = impressions === 0 ? 0 : clicks / impressions

  return {
    firmId: null,
    integrationId: first.integrationId,
    provider: first.provider,
    providerName: first.providerName,
    publicationId: first.publicationId,
    url: first.url,
    canonicalUrl: first.canonicalUrl,
    caseEntityId: first.caseEntityId,
    caseName: first.caseName,
    query: first.query,
    period: { since, until },
    since,
    until,
    impressions,
    clicks,
    ctr,
    averagePosition,
    weightedAveragePosition: averagePosition,
    clickThroughRate: ctr,
  }
}

/** Aggregate real daily rows by integration, publication and search term. */
export function aggregateSearchDetailQueries(
  rows: readonly SearchDetailQueryStatInput[],
): SearchDetailQueryMetric[] {
  const groups = new Map<string, NormalizedDetailQueryRow[]>()
  for (const input of rows) {
    const row = normalizeDetailQueryRow(input)
    const key = queryGroupKey(row)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()]
    .map(aggregateNormalizedDetailRows)
    .sort((left, right) => (
      compareText(left.provider, right.provider)
      || compareText(left.integrationId, right.integrationId)
      || compareText(left.publicationId ?? '', right.publicationId ?? '')
      || compareText(left.query, right.query)
    ))
}

export const aggregateSearchDetailQueryStats = aggregateSearchDetailQueries
export const calculateSearchDetailQueryMetrics = aggregateSearchDetailQueries

function metricsFromRows(rows: readonly SearchDetailQueryStatInput[]): SearchDetailMetrics {
  if (!rows.length) return emptyMetrics()
  let impressions = 0
  let clicks = 0
  let positionTotal = 0
  let positionImpressions = 0
  for (const input of rows) {
    const row = normalizeDetailQueryRow(input)
    impressions += row.impressions
    clicks += row.clicks
    if (row.position !== null && row.impressions > 0) {
      positionTotal += row.position * row.impressions
      positionImpressions += row.impressions
    }
  }
  const averagePosition = positionImpressions === 0
    ? null
    : positionTotal / positionImpressions
  return {
    impressions,
    clicks,
    ctr: impressions === 0 ? 0 : clicks / impressions,
    averagePosition,
    weightedAveragePosition: averagePosition,
  }
}

function periodFromRows(rows: readonly SearchDetailQueryStatInput[]): SearchDetailPeriod {
  let since: string | null = null
  let until: string | null = null
  for (const row of rows) {
    const day = (row.day ?? row.date ?? '').trim()
    if (!day) continue
    if (!since || day < since) since = day
    if (!until || day > until) until = day
  }
  return { since, until }
}

function withinPeriod(
  row: SearchQueryStatRow,
  since: string | null,
  until: string | null,
): boolean {
  return (!since || row.day >= since) && (!until || row.day <= until)
}

function previousPeriod(
  since: string | null,
  until: string | null,
): SearchDetailPeriod {
  if (!since || !until) return { since: null, until: null }
  const start = new Date(`${since}T00:00:00.000Z`)
  const end = new Date(`${until}T00:00:00.000Z`)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
    return { since: null, until: null }
  }
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  const previousEnd = new Date(start.getTime() - 86_400_000)
  const previousStart = new Date(previousEnd.getTime() - (span - 1) * 86_400_000)
  return {
    since: previousStart.toISOString().slice(0, 10),
    until: previousEnd.toISOString().slice(0, 10),
  }
}

function indexStatusFor(
  firmId: number,
  integration: SearchIntegrationRow,
  publication: SearchDetailPublication,
  caseName: string | null,
  latestStatusRow: SearchUrlStatusRow | null,
): SearchDetailIndexStatus {
  const provider = normalizeSearchProvider(integration.provider as SearchProvider)
  const inspection = inspectUrlIndexState({
    provider,
    publicationId: publication.publicationId,
    url: publication.url,
    status: latestStatusRow?.status as SearchUrlStatusInput | undefined,
    reason: latestStatusRow?.reason,
    checkedAt: latestStatusRow?.checkedAt,
  })
  const reason = inspection.reason
  return {
    firmId,
    integrationId: integration.id,
    provider,
    providerName: inspection.providerName,
    publicationId: publication.publicationId,
    url: publication.url,
    canonicalUrl: publication.canonicalUrl,
    caseEntityId: publication.caseEntityId,
    caseName,
    contentAssetId: publication.contentAssetId,
    contentVersion: publication.contentVersion,
    latestContentVersion: publication.latestContentVersion,
    status: inspection.status,
    state: inspection.state,
    indexed: inspection.indexed,
    isIndexed: inspection.isIndexed,
    observed: latestStatusRow !== null,
    exclusionReason: inspection.status === 'excluded' ? reason : null,
    reason,
    checkedAt: isoDate(latestStatusRow?.checkedAt),
    submittedAt: isoDate(latestStatusRow?.submittedAt),
    discoveredAt: isoDate(latestStatusRow?.discoveredAt),
    indexedAt: isoDate(latestStatusRow?.indexedAt),
  }
}

function snapshotForRows(
  rows: readonly SearchDetailQueryStatInput[],
  integrationId: string,
  publicationId: string,
): SearchPerformanceSnapshot | null {
  const matching = rows.filter((row) => (
    row.integrationId === integrationId && row.publicationId === publicationId
  ))
  if (!matching.length) return null
  return metricsFromRows(matching)
}

function toRefreshRecommendation(
  firmId: number,
  publication: SearchDetailPublication,
  status: SearchDetailIndexStatus,
  currentRows: readonly SearchDetailQueryStatInput[],
  previousRows: readonly SearchDetailQueryStatInput[],
  options: SearchDetailOptions,
): SearchDetailRefreshRecommendation {
  const recommendation = recommendContentRefresh({
    url: publication.url,
    provider: status.provider,
    asOf: options.asOf,
    staleAfterDays: options.staleAfterDays,
    declineThreshold: options.declineThreshold,
    evidence: { capturedAt: status.checkedAt },
    current: snapshotForRows(currentRows, status.integrationId, publication.publicationId),
    previous: snapshotForRows(previousRows, status.integrationId, publication.publicationId),
    index: { status: status.status as SearchUrlStatusInput, reason: status.reason },
  })
  return {
    ...recommendation,
    firmId,
    integrationId: status.integrationId,
    publicationId: publication.publicationId,
    caseEntityId: publication.caseEntityId,
    caseName: publication.caseName,
    contentAssetId: publication.contentAssetId,
    contentVersion: publication.contentVersion,
    latestContentVersion: publication.latestContentVersion,
    checkedAt: status.checkedAt,
  }
}

function providerMetrics(
  rows: readonly SearchDetailQueryStatInput[],
): SearchDetailMetrics {
  return metricsFromRows(rows)
}

function emptyDetail(firmId: number, period: SearchDetailPeriod = { since: null, until: null }): SearchDetail {
  const integrations: SearchDetailIntegration[] = []
  const providers: SearchDetailProvider[] = []
  const publications: SearchDetailPublication[] = []
  const indexStatuses: SearchDetailIndexStatus[] = []
  const queryMetrics: SearchDetailQueryMetric[] = []
  const refreshRecommendations: SearchDetailRefreshRecommendation[] = []
  return {
    firmId,
    period,
    observedPeriod: { since: null, until: null },
    integrations,
    providers,
    providerSummaries: providers,
    publications,
    indexStatuses,
    indexRows: indexStatuses,
    queryMetrics,
    queryStats: queryMetrics,
    queries: queryMetrics,
    refreshRecommendations,
    recommendations: refreshRecommendations,
    actionableRefreshRecommendations: refreshRecommendations,
    metrics: emptyMetrics(),
    totals: emptyMetrics(),
    latestCheckedAt: null,
    empty: true,
  }
}

/**
 * Read the customer-facing search intelligence detail in firm scope.
 *
 * The query order is deliberate: firm-owned integrations, assets and
 * publications establish the allowed canonical ID sets first; status/query
 * rows are then joined through those sets. URLs are display fields only and
 * never participate in a cross-tenant join.
 */
export async function getSearchDetailForFirm(
  db: Db,
  firm: number | { id: number },
  options: SearchDetailOptions = {},
): Promise<SearchDetail> {
  const firmId = positiveFirmId(firm)
  const since = dayValue(options.since, 'since')
  const until = dayValue(options.until, 'until')
  const previousSince = dayValue(options.previousSince, 'previousSince')
  const previousUntil = dayValue(options.previousUntil, 'previousUntil')
  const derivedPrevious = previousSince || previousUntil
    ? { since: previousSince, until: previousUntil }
    : previousPeriod(since, until)
  const currentPrevious: SearchDetailPeriod = {
    since: previousSince ?? derivedPrevious.since,
    until: previousUntil ?? derivedPrevious.until,
  }

  const [integrationRows, assetRows, publicationRows] = await Promise.all([
    db.select().from(searchIntegrations).where(eq(searchIntegrations.firmId, firmId)),
    db.select().from(contentAssets).where(eq(contentAssets.firmId, firmId)),
    db.select().from(publications).where(eq(publications.firmId, firmId)),
  ])
  const firmAssets = new Map(assetRows.map((row) => [row.id, row]))
  const allFirmAssets = [...firmAssets.values()]
  const latestByAssetKey = latestAssets(allFirmAssets)
  const publicationCandidates = publicationRows
    .map((publication) => ({ publication, asset: firmAssets.get(publication.contentAssetId) }))
    .filter((item): item is { publication: PublicationRow; asset: ContentAssetRow } => (
      item.asset?.assetType === 'seo_page' && item.publication.indexPolicy === 'index'
    ))
    .sort((left, right) => (
      compareText(left.publication.url, right.publication.url)
      || compareText(left.publication.id, right.publication.id)
    ))
  const caseIds = [...new Set(publicationCandidates.map((item) => item.asset.caseEntityId))]
  const caseRows = caseIds.length
    ? await db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds))
    : []
  const caseById = new Map(caseRows.map((row) => [row.id, row]))
  const publicationById = new Map(publicationCandidates.map((item) => [item.publication.id, item.publication]))
  const integrationIds = integrationRows.map((row) => row.id)
  const [statusRows, queryRows] = integrationIds.length
    ? await Promise.all([
      db.select().from(searchUrlStatuses).where(inArray(searchUrlStatuses.integrationId, integrationIds)),
      db.select().from(searchQueryStats).where(inArray(searchQueryStats.integrationId, integrationIds)),
    ])
    : [[], []] as const
  const integrationById = new Map(integrationRows.map((row) => [row.id, row]))

  const statusByKey = new Map<string, SearchUrlStatusRow>()
  for (const row of statusRows) {
    // Both checks are required. The integration ID is firm scoped above, but
    // a malformed relation must not make another firm's publication visible.
    if (!integrationById.has(row.integrationId) || !publicationById.has(row.publicationId)) continue
    const key = statusKey(row.integrationId, row.publicationId)
    const previous = statusByKey.get(key)
    if (!previous || latestStatus([previous, row]) === row) statusByKey.set(key, row)
  }

  const sourceQueryRows: SearchDetailQueryStatInput[] = []
  for (const row of queryRows) {
    const integration = integrationById.get(row.integrationId)
    if (!integration) continue
    if (row.publicationId !== null && !publicationById.has(row.publicationId)) continue
    const publication = row.publicationId ? publicationById.get(row.publicationId) : undefined
    const caseRow = publication
      ? caseById.get(firmAssets.get(publication.contentAssetId)?.caseEntityId ?? '')
      : undefined
    try {
      sourceQueryRows.push({
        integrationId: integration.id,
        provider: normalizeSearchProvider(integration.provider as SearchProvider),
        publicationId: row.publicationId,
        url: publication?.url ?? null,
        canonicalUrl: publication?.canonicalUrl ?? null,
        caseEntityId: caseRow?.id ?? null,
        caseName: caseRow?.canonicalName ?? null,
        query: row.query,
        day: row.day,
        impressions: row.impressions,
        clicks: row.clicks,
        positionBasisPoints: row.positionBasisPoints,
      })
    } catch {
      // A malformed provider row is not customer evidence. Skip it and keep
      // the rest of the firm detail renderable.
    }
  }

  const currentSourceRows = sourceQueryRows.filter((row) => (
    withinPeriod(
      { day: row.day } as SearchQueryStatRow,
      since,
      until,
    )
  ))
  const previousSourceRows = sourceQueryRows.filter((row) => (
    withinPeriod(
      { day: row.day } as SearchQueryStatRow,
      currentPrevious.since,
      currentPrevious.until,
    )
  ))
  const observedPeriod = periodFromRows(currentSourceRows)
  const period: SearchDetailPeriod = {
    since: since ?? observedPeriod.since,
    until: until ?? observedPeriod.until,
  }

  const publicationViews: SearchDetailPublication[] = publicationCandidates.map(({ publication, asset }) => {
    const caseRow = caseById.get(asset.caseEntityId)
    const latest = latestByAssetKey.get(assetKey(asset.caseEntityId, asset.assetType))
    const statusViews = integrationRows
      .map((integration) => indexStatusFor(
        firmId,
        integration,
        {
          firmId,
          publicationId: publication.id,
          id: publication.id,
          url: publication.url,
          canonicalUrl: publication.canonicalUrl,
          caseEntityId: asset.caseEntityId,
          caseName: caseRow?.canonicalName ?? null,
          contentAssetId: asset.id,
          assetId: asset.id,
          assetType: asset.assetType,
          assetStatus: asset.status,
          contentVersion: asset.contentVersion,
          assetVersion: asset.contentVersion,
          latestContentVersion: latest?.contentVersion ?? null,
          latestAssetVersion: latest?.contentVersion ?? null,
          templateVersion: asset.templateVersion,
          contentUpdatedAt: isoDate(asset.updatedAt),
          publishedAt: isoDate(publication.publishedAt),
          publicationStatus: publication.status,
          indexPolicy: publication.indexPolicy,
          deployedVersion: publication.deployedVersion,
          lastVerifiedAt: isoDate(publication.lastVerifiedAt),
          checkedAt: null,
          lastCheckedAt: null,
          indexStatuses: [],
        },
        caseRow?.canonicalName ?? null,
        statusByKey.get(statusKey(integration.id, publication.id)) ?? null,
      ))
      .sort((left, right) => (
        compareText(left.provider, right.provider)
        || compareText(left.integrationId, right.integrationId)
      ))
    const checkedAt = latestDate(statusViews.map((status) => (
      status.checkedAt ? new Date(status.checkedAt) : null
    )))
    return {
      firmId,
      publicationId: publication.id,
      id: publication.id,
      url: publication.url,
      canonicalUrl: publication.canonicalUrl,
      caseEntityId: asset.caseEntityId,
      caseName: caseRow?.canonicalName ?? null,
      contentAssetId: asset.id,
      assetId: asset.id,
      assetType: asset.assetType,
      assetStatus: asset.status,
      contentVersion: asset.contentVersion,
      assetVersion: asset.contentVersion,
      latestContentVersion: latest?.contentVersion ?? null,
      latestAssetVersion: latest?.contentVersion ?? null,
      templateVersion: asset.templateVersion,
      contentUpdatedAt: isoDate(asset.updatedAt),
      publishedAt: isoDate(publication.publishedAt),
      publicationStatus: publication.status,
      indexPolicy: publication.indexPolicy,
      deployedVersion: publication.deployedVersion,
      lastVerifiedAt: isoDate(publication.lastVerifiedAt),
      checkedAt,
      lastCheckedAt: checkedAt,
      indexStatuses: statusViews,
    }
  })

  const indexStatuses = publicationViews.flatMap((publication) => publication.indexStatuses)
  const queryInputsForCurrent = currentSourceRows
  const queryMetrics = aggregateSearchDetailQueries(queryInputsForCurrent).map((row) => ({
    ...row,
    firmId,
  }))
  const integrations: SearchDetailIntegration[] = integrationRows
    .map((integration) => {
      const provider = normalizeSearchProvider(integration.provider as SearchProvider)
      const statuses = indexStatuses.filter((status) => status.integrationId === integration.id)
      const integrationRowsForMetrics = queryInputsForCurrent.filter((row) => row.integrationId === integration.id)
      const metricRows = providerMetrics(integrationRowsForMetrics)
      const indexedUrls = statuses.filter((status) => status.indexed).length
      const checkedAt = latestDate(statuses.map((status) => status.checkedAt ? new Date(status.checkedAt) : null))
      return {
        id: integration.id,
        firmId,
        provider,
        providerName: getSearchProviderName(provider),
        siteUrl: integration.siteUrl,
        status: integration.status,
        lastSyncedAt: isoDate(integration.lastSyncedAt),
        lastError: integration.lastError,
        totalUrls: publicationViews.length,
        indexableUrls: publicationViews.length,
        observedUrls: statuses.filter((status) => status.observed).length,
        indexedUrls,
        indexRate: publicationViews.length === 0 ? null : indexedUrls / publicationViews.length,
        checkedAt,
        metrics: metricRows,
      }
    })
    .sort((left, right) => (
      compareText(left.provider, right.provider)
      || compareText(left.siteUrl, right.siteUrl)
      || compareText(left.id, right.id)
    ))

  const providerMap = new Map<SearchIntegrationProvider, SearchDetailIntegration[]>()
  for (const integration of integrations) {
    providerMap.set(integration.provider, [
      ...(providerMap.get(integration.provider) ?? []),
      integration,
    ])
  }
  const providers: SearchDetailProvider[] = [...providerMap.entries()]
    .map(([provider, providerIntegrations]) => {
      const providerIndexableUrls = providerIntegrations.reduce((sum, row) => sum + row.indexableUrls, 0)
      const providerIndexedUrls = providerIntegrations.reduce((sum, row) => sum + row.indexedUrls, 0)
      const providerRows = currentSourceRows.filter((row) => (
        normalizeSearchProvider(row.provider) === provider
      ))
      const checkedAt = latestDate(providerIntegrations.map((row) => row.checkedAt ? new Date(row.checkedAt) : null))
      return {
        provider,
        providerName: getSearchProviderName(provider),
        integrations: providerIntegrations,
        integrationIds: providerIntegrations.map((row) => row.id),
        totalUrls: providerIndexableUrls,
        indexableUrls: providerIndexableUrls,
        observedUrls: providerIntegrations.reduce((sum, row) => sum + row.observedUrls, 0),
        indexedUrls: providerIndexedUrls,
        indexRate: providerIndexableUrls === 0 ? null : providerIndexedUrls / providerIndexableUrls,
        checkedAt,
        metrics: providerMetrics(providerRows),
      }
    })
    .sort((left, right) => compareText(left.provider, right.provider))

  const refreshRecommendations = publicationViews.flatMap((publication) => publication.indexStatuses.map((status) => (
    toRefreshRecommendation(
      firmId,
      publication,
      status,
      currentSourceRows,
      previousSourceRows,
      options,
    )
  ))).sort((left, right) => (
    (left.priority === right.priority ? 0 : left.priority === 'high' ? -1 : right.priority === 'high' ? 1 : left.priority === 'medium' ? -1 : 1)
    || compareText(left.provider ?? '', right.provider ?? '')
    || compareText(left.url ?? '', right.url ?? '')
    || compareText(left.integrationId, right.integrationId)
  ))
  const actionableRefreshRecommendations = refreshRecommendations.filter((row) => row.recommendation !== 'monitor')
  const singleProviderMetrics = providers.length === 1 ? providers[0].metrics : emptyMetrics()
  const latestCheckedAt = latestDate(indexStatuses.map((status) => status.checkedAt ? new Date(status.checkedAt) : null))
  const empty = integrations.length === 0 && publicationViews.length === 0 && queryMetrics.length === 0
  return {
    firmId,
    period,
    observedPeriod,
    integrations,
    providers,
    providerSummaries: providers,
    publications: publicationViews,
    indexStatuses,
    indexRows: indexStatuses,
    queryMetrics,
    queryStats: queryMetrics,
    queries: queryMetrics,
    refreshRecommendations,
    recommendations: refreshRecommendations,
    actionableRefreshRecommendations,
    metrics: singleProviderMetrics,
    totals: singleProviderMetrics,
    latestCheckedAt,
    empty,
  }
}

export const getSearchIntelligenceDetail = getSearchDetailForFirm
export const customerSearchDetailForFirm = getSearchDetailForFirm
export const searchDetailForFirm = getSearchDetailForFirm
export const searchIntelligenceDetailForFirm = getSearchDetailForFirm

export function emptySearchDetail(firm: number | { id: number }): SearchDetail {
  return emptyDetail(positiveFirmId(firm))
}
