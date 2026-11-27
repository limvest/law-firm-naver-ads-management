import { and, eq, gte, inArray, lt, lte } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  adDailyStatsV2,
  adExecutions,
  caseEntities,
  caseOpportunities,
  contentAssets,
  consultations,
  dailyReports,
  events,
  firms,
  leadQualifications,
  leads,
  matterOutcomes,
  publicationChecks,
  publications,
  searchIntegrations,
  searchQueryStats,
  searchUrlStatuses,
  touchpoints,
  visitorSessions,
} from '@/lib/db/schema'
import { calculateQualifiedResponseCoverage } from '@/domains/tenancy/response-coverage'

const DAY_MS = 86_400_000
const DEFAULT_LEAD_SLA_HOURS = 4

type DateValue = Date | string | number
type ReportRow = typeof dailyReports.$inferSelect
type AdExecutionRow = typeof adExecutions.$inferSelect
type AdStatRow = typeof adDailyStatsV2.$inferSelect
type OpportunityRow = typeof caseOpportunities.$inferSelect
type SearchUrlStatusRow = typeof searchUrlStatuses.$inferSelect
type ContentAssetRow = typeof contentAssets.$inferSelect
type CaseEntityRow = typeof caseEntities.$inferSelect

export type ReportPeriod = 'daily' | 'weekly'

export type ReportDateRange = {
  /** Inclusive UTC calendar-day bounds. */
  from: string
  to: string
}

export type ReportRecommendationCode =
  | 'pending_lead_sla'
  | 'spend_without_leads'
  | 'spend_without_qualified_leads'
  | 'traffic_without_leads'
  | 'traffic_pending'
  | 'attribution_gap'
  | 'search_without_clicks'
  | 'search_index_pending'
  | 'new_opportunity'
  | 'improve_opportunity'
  | 'pause_ad'
  | 'improve_ad'
  | 'improve_search'
  | 'outcome_pending'
  | 'no_traffic'

export type ReportRecommendation = {
  code: ReportRecommendationCode
  priority: 'high' | 'medium' | 'low'
  message: string
  kind?: 'opportunity' | 'advertising' | 'search' | 'workflow'
  caseEntityId?: string
  adExecutionId?: string
  reasonCodes?: readonly string[]
}

type ReportMetricValue = number | null | readonly ReportRecommendation[]

export type ReportMetrics = {
  spend: number | null
  impressions: number | null
  adClicks: number | null
  adSpend: number | null
  adCost: number | null
  adImpressions: number | null
  adConversions: number | null
  adCtr: number | null
  adCpc: number | null
  searchImpressions: number | null
  searchClicks: number | null
  searchCtr: number | null
  searchIndexableUrls: number | null
  searchObservedUrls: number | null
  searchIndexedUrls: number | null
  searchIndexRate: number | null
  searchIndexPending: number | null
  searchAveragePosition: number | null
  indexableUrls: number | null
  observedUrls: number | null
  indexedUrls: number | null
  indexRate: number | null
  visits: number | null
  uniqueVisitors: number | null
  pageViews: number | null
  leads: number
  attributedLeads: number
  qualified: number
  attributedQualified: number
  attributedQualifiedLeads: number
  qualifiedAttributionRate: number | null
  consultations: number
  consultationsCompleted: number
  attributedConsultations: number
  attributedConsultationsCompleted: number
  consultationAttributionRate: number | null
  retained: number
  attributedRetained: number
  attributedRetainedMatters: number
  retainedAttributionRate: number | null
  notRetained: number
  notRetainedMatters: number
  closedMatters: number
  outcomePending: number
  attributionRate: number | null
  leadAttributionRate: number | null
  pendingLeads: number
  pendingLeadSla: number
  slaBreached: number
  overdueLeads: number
  unassignedLeads: number
  costPerLead: number | null
  costPerQualified: number | null
  costPerRetained: number | null
  costPerAttributedQualified: number | null
  costPerAttributedRetained: number | null
  newOpportunities: number | null
  newOpportunityCount: number | null
  opportunityPublish: number | null
  opportunityWatch: number | null
  opportunityHold: number | null
  opportunityBlock: number | null
  pauseRecommendations: number | null
  pauseRecommendationCount: number | null
  improvementRecommendations: number | null
  improvementRecommendationCount: number | null
  /** Firm x case pairs that first passed the complete response-readiness gate in this period. */
  wqrc: number
  qualifiedResponseCoverage: number
  recommendationCount: number
  periodDays: number
  recommendations?: readonly ReportRecommendation[]
  [key: string]: ReportMetricValue | undefined
}

export type ReportInput = {
  firmId: number | { id: number }
  period?: ReportPeriod
  day?: DateValue
  date?: DateValue
  weekOf?: DateValue
  from?: DateValue
  since?: DateValue
  to?: DateValue
  until?: DateValue
  asOf?: DateValue
  /** A stable override for the daily_reports.day idempotency key. */
  reportKey?: string
  key?: string
  leadSlaHours?: number
}

export type FirmReport = {
  id: string | null
  firmId: number
  day: string
  period: ReportPeriod
  dateRange: ReportDateRange
  status: 'ready' | 'warning' | 'failed'
  metrics: ReportMetrics
  exceptions: string[]
  recommendations: ReportRecommendation[]
  generatedAt: Date
}

export type DailyReportSnapshotInput = {
  firmId: number | { id: number }
  day: string
  period?: ReportPeriod
  dateRange?: ReportDateRange
  status: 'ready' | 'warning' | 'failed'
  metrics: Record<string, ReportMetricValue>
  exceptions?: readonly string[]
  recommendations?: readonly ReportRecommendation[]
  generatedAt?: DateValue
}

export type UpsertedDailyReport = FirmReport & {
  report: FirmReport
  row: ReportRow
  inserted: boolean
  updated: boolean
  unchanged: boolean
}

export class ReportingValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportingValidationError'
  }
}

export class ReportingScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportingScopeError'
  }
}

type NormalizedRange = {
  period: ReportPeriod
  dateRange: ReportDateRange
  start: Date
  endExclusive: Date
  day: string
  reportKey: string
}

function firmIdValue(value: number | { id: number }): number {
  const id = typeof value === 'number' ? value : value.id
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ReportingValidationError('firm id must be a positive integer')
  }
  return id
}

function dateValue(value: DateValue, field: string): Date {
  const result = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value)
  if (Number.isNaN(result.getTime())) throw new ReportingValidationError(`${field} must be a valid date`)
  return result
}

function dayValue(value: DateValue, field: string): string {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      const parsed = new Date(`${normalized}T00:00:00.000Z`)
      if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized) return normalized
      throw new ReportingValidationError(`${field} must be a valid calendar date`)
    }
  }
  return dateValue(value, field).toISOString().slice(0, 10)
}

function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function nextDay(day: string): string {
  return new Date(dayDate(day).getTime() + DAY_MS).toISOString().slice(0, 10)
}

function previousDays(day: string, days: number): string {
  return new Date(dayDate(day).getTime() - days * DAY_MS).toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.floor((dayDate(to).getTime() - dayDate(from).getTime()) / DAY_MS) + 1
}

function asOfValue(input: ReportInput): DateValue | undefined {
  return input.asOf ?? input.to ?? input.until ?? input.day ?? input.date
}

function normalizeRange(input: ReportInput, forcedPeriod?: ReportPeriod): NormalizedRange {
  const period = forcedPeriod ?? input.period ?? 'daily'
  const explicitFrom = input.from ?? input.since
  const explicitTo = input.to ?? input.until
  let from: string
  let to: string

  if (period === 'daily') {
    const anchor = input.day ?? input.date ?? explicitTo ?? input.asOf ?? new Date()
    const day = dayValue(anchor, 'day')
    from = explicitFrom === undefined ? day : dayValue(explicitFrom, 'from')
    to = explicitTo === undefined ? day : dayValue(explicitTo, 'to')
    if (from !== to) throw new ReportingValidationError('daily reports require one calendar day')
  } else if (explicitFrom !== undefined && explicitTo !== undefined) {
    from = dayValue(explicitFrom, 'from')
    to = dayValue(explicitTo, 'to')
  } else if (input.weekOf !== undefined) {
    const anchor = dayDate(dayValue(input.weekOf, 'weekOf'))
    const mondayOffset = (anchor.getUTCDay() + 6) % 7
    from = new Date(anchor.getTime() - mondayOffset * DAY_MS).toISOString().slice(0, 10)
    to = new Date(anchor.getTime() + (6 - mondayOffset) * DAY_MS).toISOString().slice(0, 10)
  } else if (explicitFrom !== undefined) {
    from = dayValue(explicitFrom, 'from')
    to = nextDay(nextDay(nextDay(nextDay(nextDay(nextDay(from))))))
  } else {
    const anchor = asOfValue(input) ?? new Date()
    to = dayValue(anchor, 'to')
    from = previousDays(to, 6)
  }

  if (from > to) throw new ReportingValidationError('from must not be after to')
  const day = to
  const reportKey = input.reportKey ?? input.key ?? (
    period === 'daily' ? day : `week:${from}:${to}`
  )
  if (!reportKey.trim()) throw new ReportingValidationError('report key must not be blank')
  if (reportKey.length > 255) throw new ReportingValidationError('report key is too long')
  return {
    period,
    dateRange: { from, to },
    start: dayDate(from),
    endExclusive: dayDate(nextDay(to)),
    day,
    reportKey,
  }
}

function normalizeLeadSlaHours(value: number | undefined): number {
  const hours = value ?? DEFAULT_LEAD_SLA_HOURS
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new ReportingValidationError('leadSlaHours must be positive and no greater than 720')
  }
  return hours
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function sum<T>(rows: readonly T[], value: (row: T) => number): number {
  return rows.reduce((total, row) => total + value(row), 0)
}

function isInRange(value: Date, range: NormalizedRange): boolean {
  return value >= range.start && value < range.endExclusive
}

function terminalLeadStatus(status: string): boolean {
  return new Set([
    '수임',
    '종결',
    'retained',
    'matter_retained',
    'matter_not_retained',
    'matter_closed',
    'closed',
    'not_retained',
  ]).has(status)
}

function hasCanonicalAttribution(lead: typeof leads.$inferSelect): boolean {
  return Boolean(
    lead.sessionId
    && lead.caseEntityId
    && lead.contentAssetId
    && lead.publicationId,
  )
}

type RecommendationContext = {
  firmId: number
  range: NormalizedRange
  opportunityRows: readonly OpportunityRow[]
  adExecutionRows: readonly AdExecutionRow[]
  adRows: readonly AdStatRow[]
  searchStatusRows: readonly SearchUrlStatusRow[]
  indexablePublicationIds: ReadonlySet<string>
  caseNames: ReadonlyMap<string, string>
}

type ReportMetricInput = {
  adRows: readonly AdStatRow[]
  searchRows: readonly (typeof searchQueryStats.$inferSelect)[]
  visitCount: number | null
  pageViews: number | null
  searchIndexableUrls: number | null
  searchObservedUrls: number | null
  searchIndexedUrls: number | null
  searchIndexRate: number | null
  searchIndexPending: number | null
  searchAveragePosition: number | null
  allLeads: readonly (typeof leads.$inferSelect)[]
  periodLeads: readonly (typeof leads.$inferSelect)[]
  qualifiedIds: ReadonlySet<string>
  consultationIds: ReadonlySet<string>
  completedConsultationIds: ReadonlySet<string>
  retainedIds: ReadonlySet<string>
  notRetainedIds: ReadonlySet<string>
  closedMatterIds: ReadonlySet<string>
  outcomePendingIds: ReadonlySet<string>
  activeLeads: readonly (typeof leads.$inferSelect)[]
  asOf: Date
  leadSlaHours: number
  periodDays: number
  newOpportunities: number | null
  opportunityPublish: number | null
  opportunityWatch: number | null
  opportunityHold: number | null
  opportunityBlock: number | null
  pauseRecommendations: number | null
  improvementRecommendations: number | null
  wqrc: number
}

function costRatio(spend: number | null, denominator: number): number | null {
  return spend === null ? null : ratio(spend, denominator)
}

function shouldPauseAd(execution: AdExecutionRow): boolean {
  return execution.reviewStatus === 'rejected'
    || execution.status === 'rejected'
    || (!execution.desiredActive && ['submitted', 'pending_review', 'live'].includes(execution.status))
}

function shouldImproveAd(rows: readonly AdStatRow[]): boolean {
  if (!rows.length) return false
  const clicks = sum(rows, (row) => row.clicks)
  const conversions = sum(rows, (row) => row.conversions)
  return clicks >= 10 && conversions === 0
}

function latestSearchStatusRows(rows: readonly SearchUrlStatusRow[]): SearchUrlStatusRow[] {
  const latest = new Map<string, SearchUrlStatusRow>()
  for (const row of rows) {
    const key = `${row.integrationId}:${row.publicationId}`
    const current = latest.get(key)
    if (!current || row.checkedAt.getTime() > current.checkedAt.getTime()
      || (row.checkedAt.getTime() === current.checkedAt.getTime() && row.id > current.id)) {
      latest.set(key, row)
    }
  }
  return [...latest.values()]
}

function reportMetrics(input: ReportMetricInput): ReportMetrics {
  const leadById = new Map(input.allLeads.map((lead) => [lead.id, lead]))
  const attributedLeads = input.periodLeads.filter(hasCanonicalAttribution).length
  const attributedQualified = [...input.qualifiedIds].filter((id) => (
    Boolean(leadById.get(id) && hasCanonicalAttribution(leadById.get(id)!))
  )).length
  const attributedConsultations = [...input.consultationIds].filter((id) => (
    Boolean(leadById.get(id) && hasCanonicalAttribution(leadById.get(id)!))
  )).length
  const attributedConsultationsCompleted = [...input.completedConsultationIds].filter((id) => (
    Boolean(leadById.get(id) && hasCanonicalAttribution(leadById.get(id)!))
  )).length
  const attributedRetained = [...input.retainedIds].filter((id) => (
    Boolean(leadById.get(id) && hasCanonicalAttribution(leadById.get(id)!))
  )).length
  const pendingLeads = input.activeLeads.length
  const effectiveBoundary = new Date(input.asOf.getTime() - input.leadSlaHours * 3_600_000)
  const slaBreached = input.activeLeads.filter((lead) => !lead.lastContactAt && lead.createdAt < effectiveBoundary).length
  const overdueLeads = input.activeLeads.filter((lead) => Boolean(lead.followUpAt && lead.followUpAt < input.asOf)).length
  const unassignedLeads = input.activeLeads.filter((lead) => !lead.assignedLawyer).length
  const hasAdData = input.adRows.length > 0
  const hasSearchData = input.searchRows.length > 0
  const spend = hasAdData ? sum(input.adRows, (row) => row.cost) : null
  const impressions = hasAdData ? sum(input.adRows, (row) => row.impressions) : null
  const adClicks = hasAdData ? sum(input.adRows, (row) => row.clicks) : null
  const adConversions = hasAdData ? sum(input.adRows, (row) => row.conversions) : null
  const searchImpressions = hasSearchData ? sum(input.searchRows, (row) => row.impressions) : null
  const searchClicks = hasSearchData ? sum(input.searchRows, (row) => row.clicks) : null
  const leadsCount = input.periodLeads.length
  const qualified = input.qualifiedIds.size
  const consultationsCount = input.consultationIds.size
  const consultationsCompleted = input.completedConsultationIds.size
  const retained = input.retainedIds.size
  const notRetained = input.notRetainedIds.size
  const closedMatters = input.closedMatterIds.size
  const costPerQualified = costRatio(spend, qualified)
  const costPerRetained = costRatio(spend, retained)

  return {
    spend,
    impressions,
    adClicks,
    adSpend: spend,
    adCost: spend,
    adImpressions: impressions,
    adConversions,
    adCtr: adClicks === null || impressions === null ? null : ratio(adClicks, impressions),
    adCpc: costRatio(spend, adClicks ?? 0),
    searchImpressions,
    searchClicks,
    searchCtr: searchClicks === null || searchImpressions === null ? null : ratio(searchClicks, searchImpressions),
    searchIndexableUrls: input.searchIndexableUrls,
    searchObservedUrls: input.searchObservedUrls,
    searchIndexedUrls: input.searchIndexedUrls,
    searchIndexRate: input.searchIndexRate,
    searchIndexPending: input.searchIndexPending,
    searchAveragePosition: input.searchAveragePosition,
    indexableUrls: input.searchIndexableUrls,
    observedUrls: input.searchObservedUrls,
    indexedUrls: input.searchIndexedUrls,
    indexRate: input.searchIndexRate,
    visits: input.visitCount,
    uniqueVisitors: input.visitCount,
    pageViews: input.pageViews,
    leads: leadsCount,
    attributedLeads,
    qualified,
    attributedQualified,
    attributedQualifiedLeads: attributedQualified,
    qualifiedAttributionRate: ratio(attributedQualified, qualified),
    consultations: consultationsCount,
    consultationsCompleted,
    attributedConsultations,
    attributedConsultationsCompleted,
    consultationAttributionRate: ratio(attributedConsultations, consultationsCount),
    retained,
    attributedRetained,
    attributedRetainedMatters: attributedRetained,
    retainedAttributionRate: ratio(attributedRetained, retained),
    notRetained,
    notRetainedMatters: notRetained,
    closedMatters,
    outcomePending: input.outcomePendingIds.size,
    attributionRate: ratio(attributedQualified, qualified),
    leadAttributionRate: ratio(attributedLeads, leadsCount),
    pendingLeads,
    pendingLeadSla: slaBreached,
    slaBreached,
    overdueLeads,
    unassignedLeads,
    costPerLead: costRatio(spend, leadsCount),
    costPerQualified,
    costPerRetained,
    costPerAttributedQualified: costRatio(spend, attributedQualified),
    costPerAttributedRetained: costRatio(spend, attributedRetained),
    newOpportunities: input.newOpportunities,
    newOpportunityCount: input.newOpportunities,
    opportunityPublish: input.opportunityPublish,
    opportunityWatch: input.opportunityWatch,
    opportunityHold: input.opportunityHold,
    opportunityBlock: input.opportunityBlock,
    pauseRecommendations: input.pauseRecommendations,
    pauseRecommendationCount: input.pauseRecommendations,
    improvementRecommendations: input.improvementRecommendations,
    improvementRecommendationCount: input.improvementRecommendations,
    wqrc: input.wqrc,
    qualifiedResponseCoverage: input.wqrc,
    recommendationCount: 0,
    periodDays: input.periodDays,
  }
}

function recommendationsFor(metrics: ReportMetrics, context?: RecommendationContext): ReportRecommendation[] {
  const recommendations: ReportRecommendation[] = []
  if (metrics.pendingLeadSla > 0) {
    recommendations.push({
      code: 'pending_lead_sla',
      priority: 'high',
      kind: 'workflow',
      message: `${metrics.pendingLeadSla} pending lead(s) have breached the response SLA.`,
    })
  }
  if (metrics.spend !== null && metrics.spend > 0 && metrics.leads === 0) {
    recommendations.push({
      code: 'spend_without_leads',
      priority: 'high',
      kind: 'advertising',
      message: 'Advertising spend was recorded without a lead; inspect landing and tracking paths.',
    })
  } else if (metrics.spend !== null && metrics.spend > 0 && metrics.qualified === 0) {
    recommendations.push({
      code: 'spend_without_qualified_leads',
      priority: 'medium',
      kind: 'advertising',
      message: 'Advertising spend produced leads but no qualified lead; review intake quality and targeting.',
    })
  }
  if (metrics.visits === null && metrics.pageViews === null && metrics.leads === 0) {
    recommendations.push({
      code: 'traffic_pending',
      priority: 'low',
      kind: 'workflow',
      message: 'No traffic rows were captured in this period; visit and page-view metrics are pending.',
    })
  } else if (metrics.visits === 0 && metrics.leads === 0) {
    recommendations.push({
      code: 'no_traffic',
      priority: 'medium',
      kind: 'workflow',
      message: 'No visits or leads were recorded in this period; verify publication and acquisition tracking.',
    })
  } else if (metrics.visits !== null && metrics.visits > 0 && metrics.leads === 0) {
    recommendations.push({
      code: 'traffic_without_leads',
      priority: 'medium',
      kind: 'workflow',
      message: 'Visits were recorded without a lead; review the landing-page call to action and form path.',
    })
  }
  if (metrics.qualified > 0 && metrics.attributionRate === 0) {
    recommendations.push({
      code: 'attribution_gap',
      priority: 'medium',
      kind: 'workflow',
      message: 'Qualified leads have no complete canonical attribution; repair session and publication joins.',
    })
  }
  if (metrics.searchImpressions !== null && metrics.searchImpressions > 0 && metrics.searchClicks === 0) {
    recommendations.push({
      code: 'search_without_clicks',
      priority: 'low',
      kind: 'search',
      message: 'Search impressions produced no clicks; review query coverage, titles, and snippets.',
    })
  }
  if (metrics.searchIndexableUrls !== null && metrics.searchIndexableUrls > 0 && metrics.searchObservedUrls === null) {
    recommendations.push({
      code: 'search_index_pending',
      priority: 'low',
      kind: 'search',
      message: 'Indexable SEO URLs exist but no index observation has been captured for this report.',
    })
  }
  if (metrics.outcomePending > 0) {
    recommendations.push({
      code: 'outcome_pending',
      priority: 'low',
      kind: 'workflow',
      message: `${metrics.outcomePending} consultation lead(s) have no retained/not-retained outcome yet.`,
    })
  }

  if (context) {
    const newOpportunities = context.opportunityRows
      .filter((row) => row.scopeKey === `firm:${context.firmId}`
        && ['publish', 'watch'].includes(row.recommendation)
        && isInRange(row.calculatedAt, context.range))
      .sort((left, right) => right.score - left.score
        || right.calculatedAt.getTime() - left.calculatedAt.getTime()
        || left.id.localeCompare(right.id))
    for (const row of newOpportunities.slice(0, 20)) {
      const caseName = context.caseNames.get(row.caseEntityId) ?? row.caseEntityId
      recommendations.push({
        code: 'new_opportunity',
        priority: row.recommendation === 'publish' ? 'high' : 'medium',
        kind: 'opportunity',
        caseEntityId: row.caseEntityId,
        reasonCodes: row.reasons,
        message: `New ${row.recommendation} opportunity: ${caseName}${row.reasons.length ? ` (${row.reasons.join(', ')})` : ''}.`,
      })
    }
    const actionOpportunityRows = context.opportunityRows
      .filter((row) => row.scopeKey === `firm:${context.firmId}`
        && ['hold', 'block'].includes(row.recommendation)
        && isInRange(row.calculatedAt, context.range))
      .sort((left, right) => right.score - left.score
        || right.calculatedAt.getTime() - left.calculatedAt.getTime()
        || left.id.localeCompare(right.id))
    for (const row of actionOpportunityRows.slice(0, 20)) {
      const caseName = context.caseNames.get(row.caseEntityId) ?? row.caseEntityId
      recommendations.push({
        code: 'improve_opportunity',
        priority: row.recommendation === 'block' ? 'high' : 'medium',
        kind: 'opportunity',
        caseEntityId: row.caseEntityId,
        reasonCodes: row.reasons,
        message: `${row.recommendation === 'block' ? 'Block' : 'Hold'} opportunity ${caseName}${row.reasons.length ? ` (${row.reasons.join(', ')})` : ''}.`,
      })
    }

    const adRowsByExecution = new Map<string, AdStatRow[]>()
    for (const row of context.adRows) {
      const rows = adRowsByExecution.get(row.adExecutionId) ?? []
      rows.push(row)
      adRowsByExecution.set(row.adExecutionId, rows)
    }
    for (const execution of [...context.adExecutionRows].sort((left, right) => left.id.localeCompare(right.id))) {
      const caseName = context.caseNames.get(execution.caseEntityId) ?? execution.caseEntityId
      if (shouldPauseAd(execution)) {
        recommendations.push({
          code: 'pause_ad',
          priority: execution.reviewStatus === 'rejected' || execution.status === 'rejected' ? 'high' : 'medium',
          kind: 'advertising',
          caseEntityId: execution.caseEntityId,
          adExecutionId: execution.id,
          message: `Pause recommendation for ${caseName}; current ad state is ${execution.status}${execution.reviewStatus === 'rejected' ? ` (${execution.reviewReason ?? 'rejected'})` : ''}.`,
        })
      }
      const statRows = adRowsByExecution.get(execution.id) ?? []
      if (shouldImproveAd(statRows)) {
        recommendations.push({
          code: 'improve_ad',
          priority: 'medium',
          kind: 'advertising',
          caseEntityId: execution.caseEntityId,
          adExecutionId: execution.id,
          message: `Improve advertising for ${caseName}; ${sum(statRows, (row) => row.clicks)} clicks produced no recorded conversions.`,
        })
      }
    }

    const latestStatuses = latestSearchStatusRows(context.searchStatusRows)
      .filter((row) => context.indexablePublicationIds.has(row.publicationId))
      .sort((left, right) => left.publicationId.localeCompare(right.publicationId) || left.id.localeCompare(right.id))
    for (const row of latestStatuses.filter((item) => ['excluded', 'error'].includes(item.status)).slice(0, 20)) {
      recommendations.push({
        code: 'improve_search',
        priority: 'medium',
        kind: 'search',
        message: `Improve SEO publication ${row.publicationId}; index status is ${row.status}${row.reason ? ` (${row.reason})` : ''}.`,
      })
    }
  }

  const priority = { high: 0, medium: 1, low: 2 }
  return recommendations.sort((left, right) => (
    priority[left.priority] - priority[right.priority]
      || left.code.localeCompare(right.code)
      || (left.caseEntityId ?? '').localeCompare(right.caseEntityId ?? '')
      || (left.adExecutionId ?? '').localeCompare(right.adExecutionId ?? '')
      || left.message.localeCompare(right.message)
  ))
}

function storedRecommendations(value: unknown): ReportRecommendation[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) throw new ReportingValidationError('metric recommendations must be an array')
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new ReportingValidationError('metric recommendations must contain objects')
    const recommendation = item as Record<string, unknown>
    if (typeof recommendation.code !== 'string'
      || typeof recommendation.priority !== 'string'
      || typeof recommendation.message !== 'string') {
      throw new ReportingValidationError('metric recommendations must include code, priority, and message')
    }
  }
  return value as ReportRecommendation[]
}

function normalizeMetrics(value: Record<string, unknown>): ReportMetrics {
  const normalized: Record<string, ReportMetricValue | undefined> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'recommendations') {
      normalized[key] = storedRecommendations(item) ?? undefined
      continue
    }
    if (item !== null && (typeof item !== 'number' || !Number.isFinite(item))) {
      throw new ReportingValidationError(`metric ${key} must be a finite number or null`)
    }
    normalized[key] = item
  }
  const required: Record<string, number | null> = {
    // These values come from synchronised acquisition sources. A missing key
    // in a legacy row means "not observed", not a measured zero.
    spend: null,
    impressions: null,
    adClicks: null,
    adSpend: null,
    adCost: null,
    adImpressions: null,
    adConversions: null,
    adCtr: null,
    adCpc: null,
    searchImpressions: null,
    searchClicks: null,
    searchCtr: null,
    searchIndexableUrls: null,
    searchObservedUrls: null,
    searchIndexedUrls: null,
    searchIndexRate: null,
    searchIndexPending: null,
    searchAveragePosition: null,
    indexableUrls: null,
    observedUrls: null,
    indexedUrls: null,
    indexRate: null,
    visits: null,
    uniqueVisitors: null,
    pageViews: null,
    leads: 0,
    attributedLeads: 0,
    qualified: 0,
    attributedQualified: 0,
    attributedQualifiedLeads: 0,
    qualifiedAttributionRate: null,
    consultations: 0,
    consultationsCompleted: 0,
    attributedConsultations: 0,
    attributedConsultationsCompleted: 0,
    consultationAttributionRate: null,
    retained: 0,
    attributedRetained: 0,
    attributedRetainedMatters: 0,
    retainedAttributionRate: null,
    notRetained: 0,
    notRetainedMatters: 0,
    closedMatters: 0,
    outcomePending: 0,
    attributionRate: null,
    leadAttributionRate: null,
    pendingLeads: 0,
    pendingLeadSla: 0,
    slaBreached: 0,
    overdueLeads: 0,
    unassignedLeads: 0,
    costPerLead: null,
    costPerQualified: null,
    costPerRetained: null,
    costPerAttributedQualified: null,
    costPerAttributedRetained: null,
    newOpportunities: null,
    newOpportunityCount: null,
    opportunityPublish: null,
    opportunityWatch: null,
    opportunityHold: null,
    opportunityBlock: null,
    pauseRecommendations: null,
    pauseRecommendationCount: null,
    improvementRecommendations: null,
    improvementRecommendationCount: null,
    wqrc: 0,
    qualifiedResponseCoverage: 0,
    recommendationCount: 0,
    periodDays: 1,
  }
  for (const [key, defaultValue] of Object.entries(required)) {
    if (!(key in normalized)) normalized[key] = defaultValue
  }
  return normalized as ReportMetrics
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepEqual(value, right[index]))
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(leftRecord[key], rightRecord[key]))
}

function parseReportKey(day: string, metrics: ReportMetrics): {
  period: ReportPeriod
  dateRange: ReportDateRange
} {
  const weekly = /^week:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(day)
  if (weekly) return {
    period: 'weekly',
    dateRange: { from: weekly[1], to: weekly[2] },
  }
  const to = day.match(/^\d{4}-\d{2}-\d{2}$/) ? day : dayValue(new Date(), 'report day')
  const periodDays = metrics.periodDays ?? 1
  return {
    period: periodDays > 1 ? 'weekly' : 'daily',
    dateRange: {
      from: periodDays > 1 ? previousDays(to, periodDays - 1) : to,
      to,
    },
  }
}

function hydrateReport(row: ReportRow): FirmReport {
  const metrics = normalizeMetrics(row.metrics)
  const parsed = parseReportKey(row.day, metrics)
  const stored = storedRecommendations(metrics.recommendations)
  return {
    id: row.id,
    firmId: row.firmId ?? 0,
    day: row.day,
    period: parsed.period,
    dateRange: parsed.dateRange,
    status: row.status as FirmReport['status'],
    metrics,
    exceptions: [...row.exceptions],
    recommendations: stored ?? recommendationsFor(metrics),
    generatedAt: row.generatedAt,
  }
}

async function assertFirmExists(db: Db, firmId: number): Promise<void> {
  const [firm] = await db.select({ id: firms.id }).from(firms).where(eq(firms.id, firmId)).limit(1)
  if (!firm) throw new ReportingScopeError(`firm ${firmId} was not found`)
}

async function buildReport(db: Db, input: ReportInput, forcedPeriod?: ReportPeriod): Promise<{
  snapshot: Omit<FirmReport, 'id'>
  range: NormalizedRange
}> {
  const firmId = firmIdValue(input.firmId)
  const range = normalizeRange(input, forcedPeriod)
  const leadSlaHours = normalizeLeadSlaHours(input.leadSlaHours)
  await assertFirmExists(db, firmId)

  const [firmLeads, sessions, acquisitionTouches, pageViewEvents, qualificationRows, consultationRows, matterRows, adRows, integrationRows, adExecutionRows, opportunityRows, assetRows, publicationRows] = await Promise.all([
    db.select().from(leads).where(eq(leads.firmId, firmId)),
    db.select().from(visitorSessions).where(and(
      eq(visitorSessions.firmId, firmId),
      lt(visitorSessions.startedAt, range.endExclusive),
      gte(visitorSessions.lastSeenAt, range.start),
    )),
    db.select().from(touchpoints).where(and(
      eq(touchpoints.firmId, firmId),
      gte(touchpoints.occurredAt, range.start),
      lt(touchpoints.occurredAt, range.endExclusive),
    )),
    db.select().from(events).where(and(
      eq(events.firmId, firmId),
      eq(events.type, 'page_view'),
      gte(events.createdAt, range.start),
      lt(events.createdAt, range.endExclusive),
    )),
    db.select().from(leadQualifications).where(eq(leadQualifications.firmId, firmId)),
    db.select().from(consultations).where(eq(consultations.firmId, firmId)),
    db.select().from(matterOutcomes).where(eq(matterOutcomes.firmId, firmId)),
    db.select().from(adDailyStatsV2).where(and(
      eq(adDailyStatsV2.firmId, firmId),
      gte(adDailyStatsV2.day, range.dateRange.from),
      lte(adDailyStatsV2.day, range.dateRange.to),
    )),
    db.select({ id: searchIntegrations.id }).from(searchIntegrations)
      .where(eq(searchIntegrations.firmId, firmId)),
    db.select().from(adExecutions).where(eq(adExecutions.firmId, firmId)),
    db.select().from(caseOpportunities).where(eq(caseOpportunities.firmId, firmId)),
    db.select().from(contentAssets).where(eq(contentAssets.firmId, firmId)),
    db.select().from(publications).where(eq(publications.firmId, firmId)),
  ])
  const [searchRows, searchStatusRows] = integrationRows.length === 0
    ? [[], []] as [typeof searchQueryStats.$inferSelect[], SearchUrlStatusRow[]]
    : await Promise.all([
        db.select().from(searchQueryStats).where(and(
          inArray(searchQueryStats.integrationId, integrationRows.map((row) => row.id)),
          gte(searchQueryStats.day, range.dateRange.from),
          lte(searchQueryStats.day, range.dateRange.to),
        )),
        db.select().from(searchUrlStatuses).where(inArray(
          searchUrlStatuses.integrationId,
          integrationRows.map((row) => row.id),
        )),
      ])
  const publicationCheckRows = publicationRows.length
    ? await db.select().from(publicationChecks).where(inArray(
        publicationChecks.publicationId,
        publicationRows.map((row) => row.id),
      ))
    : []

  // The foreign keys protect normal writes, but the report still scopes every
  // related row explicitly so imported/legacy rows cannot cross a firm.
  const firmExecutionIds = new Set(adExecutionRows.map((row) => row.id))
  const scopedAdRows = adRows.filter((row) => firmExecutionIds.has(row.adExecutionId))
  const firmPublicationIds = new Set(publicationRows.map((row) => row.id))
  const scopedSearchRows = searchRows.filter((row) => (
    row.publicationId === null || firmPublicationIds.has(row.publicationId)
  ))

  const assetById = new Map<string, ContentAssetRow>(assetRows.map((row) => [row.id, row]))
  const indexablePublicationIds = new Set(
    publicationRows
      .filter((row) => row.indexPolicy === 'index' && assetById.get(row.contentAssetId)?.assetType === 'seo_page')
      .map((row) => row.id),
  )
  const statusAtAsOf = latestSearchStatusRows(searchStatusRows.filter((row) => (
    row.checkedAt < range.endExclusive && indexablePublicationIds.has(row.publicationId)
  )))
  const observedPublicationIds = new Set(statusAtAsOf.map((row) => row.publicationId))
  const indexedPublicationIds = new Set(
    statusAtAsOf.filter((row) => row.status === 'indexed').map((row) => row.publicationId),
  )
  const searchIndexableUrls = integrationRows.length ? indexablePublicationIds.size : null
  const searchObservedUrls = statusAtAsOf.length ? observedPublicationIds.size : null
  const searchIndexedUrls = statusAtAsOf.length ? indexedPublicationIds.size : null
  const searchIndexRate = searchIndexableUrls !== null && searchIndexedUrls !== null
    ? ratio(searchIndexedUrls, searchIndexableUrls)
    : null
  const searchIndexPending = searchIndexableUrls !== null && searchObservedUrls !== null
    ? Math.max(0, searchIndexableUrls - searchObservedUrls)
    : null
  const positionRows = scopedSearchRows.filter((row) => row.positionBasisPoints !== null)
  const positionWeight = sum(positionRows, (row) => row.impressions)
  const searchAveragePosition = positionRows.length && positionWeight > 0
    ? sum(positionRows, (row) => (row.positionBasisPoints ?? 0) * row.impressions) / positionWeight / 100
    : null

  const caseIds = [...new Set([
    ...opportunityRows.map((row) => row.caseEntityId),
    ...adExecutionRows.map((row) => row.caseEntityId),
  ])]
  const caseRows = caseIds.length
    ? await db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds))
    : []
  const caseNames = new Map(caseRows.map((row: CaseEntityRow) => [row.id, row.canonicalName]))

  const firmLeadIds = new Set(firmLeads.map((lead) => lead.id))
  const periodLeads = firmLeads.filter((lead) => isInRange(lead.createdAt, range))
  const qualifiedIds = new Set(
    qualificationRows
      .filter((row) => row.status === 'qualified' && firmLeadIds.has(row.leadId) && isInRange(row.decidedAt, range))
      .map((row) => row.leadId),
  )
  const legacyQualifiedStatuses = new Set([
    '검토중',
    '상담예약',
    '상담',
    'qualified',
    'consultation_booked',
    'consultation_completed',
    'matter_retained',
    'retained',
  ])
  for (const lead of periodLeads) {
    if (legacyQualifiedStatuses.has(lead.status)) qualifiedIds.add(lead.id)
  }

  const periodConsultations = consultationRows.filter((row) => (
    firmLeadIds.has(row.leadId) && isInRange(row.createdAt, range)
  ))
  const consultationIds = new Set(periodConsultations.map((row) => row.leadId))
  const completedConsultationIds = new Set(
    periodConsultations.filter((row) => row.status === 'completed').map((row) => row.leadId),
  )
  const legacyConsultationStatuses = new Set(['상담예약', '상담', '수임', 'consultation_booked', 'consultation_completed', 'matter_retained'])
  for (const lead of periodLeads) {
    if (legacyConsultationStatuses.has(lead.status)) consultationIds.add(lead.id)
  }
  const retainedIds = new Set(
    matterRows
      .filter((row) => row.status === 'retained' && firmLeadIds.has(row.leadId) && isInRange(row.decidedAt, range))
      .map((row) => row.leadId),
  )
  for (const lead of periodLeads) if (lead.status === '수임' || lead.status === 'retained' || lead.status === 'matter_retained') retainedIds.add(lead.id)
  const notRetainedIds = new Set(
    matterRows
      .filter((row) => row.status === 'not_retained' && firmLeadIds.has(row.leadId) && isInRange(row.decidedAt, range))
      .map((row) => row.leadId),
  )
  const closedMatterIds = new Set(
    matterRows
      .filter((row) => row.status === 'closed' && firmLeadIds.has(row.leadId) && isInRange(row.decidedAt, range))
      .map((row) => row.leadId),
  )
  const recordedOutcomeIds = new Set(
    matterRows
      .filter((row) => firmLeadIds.has(row.leadId) && row.decidedAt < range.endExclusive)
      .map((row) => row.leadId),
  )
  const outcomePendingIds = new Set(
    [...consultationIds].filter((leadId) => !recordedOutcomeIds.has(leadId)),
  )

  const asOf = range.endExclusive
  const activeLeads = firmLeads.filter((lead) => lead.createdAt < asOf && !terminalLeadStatus(lead.status))
  const visitIds = new Set<string>()
  for (const row of sessions) visitIds.add(`session:${row.id}`)
  for (const row of acquisitionTouches) visitIds.add(`session:${row.sessionId}`)
  for (const row of pageViewEvents) {
    visitIds.add(row.sessionId ? `session:${row.sessionId}` : `event:${row.id}`)
  }
  const pageViewTouchCount = acquisitionTouches.filter((row) => row.touchType === 'page_view').length
  const pageViews = pageViewEvents.length || pageViewTouchCount
    ? pageViewEvents.length + pageViewTouchCount
    : null
  const visitCount = visitIds.size ? visitIds.size : null
  const opportunityPeriodRows = opportunityRows.filter((row) => isInRange(row.calculatedAt, range))
  const opportunityCounts = opportunityRows.length === 0
    ? { newOpportunities: null, publish: null, watch: null, hold: null, block: null }
    : {
        newOpportunities: opportunityPeriodRows.filter((row) => row.scopeKey === `firm:${firmId}`
          && ['publish', 'watch'].includes(row.recommendation)).length,
        publish: opportunityPeriodRows.filter((row) => row.scopeKey === `firm:${firmId}` && row.recommendation === 'publish').length,
        watch: opportunityPeriodRows.filter((row) => row.scopeKey === `firm:${firmId}` && row.recommendation === 'watch').length,
        hold: opportunityPeriodRows.filter((row) => row.scopeKey === `firm:${firmId}` && row.recommendation === 'hold').length,
        block: opportunityPeriodRows.filter((row) => row.scopeKey === `firm:${firmId}` && row.recommendation === 'block').length,
      }
  const adRowsByExecution = new Map<string, AdStatRow[]>()
  for (const row of scopedAdRows) {
    const rows = adRowsByExecution.get(row.adExecutionId) ?? []
    rows.push(row)
    adRowsByExecution.set(row.adExecutionId, rows)
  }
  const pauseRecommendations = adExecutionRows.length
    ? adExecutionRows.filter(shouldPauseAd).length
    : null
  const improvementDataAvailable = scopedAdRows.length > 0
    || scopedSearchRows.length > 0
    || statusAtAsOf.length > 0
    || opportunityPeriodRows.some((row) => row.scopeKey === `firm:${firmId}`
      && ['hold', 'block'].includes(row.recommendation))
  const improvementRecommendations = improvementDataAvailable
    ? adExecutionRows.filter((row) => shouldImproveAd(adRowsByExecution.get(row.id) ?? [])).length
    : null
  const responseCoverage = calculateQualifiedResponseCoverage({
    since: range.start,
    until: range.endExclusive,
    assets: assetRows,
    publications: publicationRows,
    checks: publicationCheckRows,
    adExecutions: adExecutionRows,
  })
  const metrics = reportMetrics({
    adRows: scopedAdRows,
    searchRows: scopedSearchRows,
    visitCount,
    pageViews,
    searchIndexableUrls,
    searchObservedUrls,
    searchIndexedUrls,
    searchIndexRate,
    searchIndexPending,
    searchAveragePosition,
    allLeads: firmLeads,
    periodLeads,
    qualifiedIds,
    consultationIds,
    completedConsultationIds,
    retainedIds,
    notRetainedIds,
    closedMatterIds,
    outcomePendingIds,
    activeLeads,
    asOf,
    leadSlaHours,
    periodDays: daysBetween(range.dateRange.from, range.dateRange.to),
    newOpportunities: opportunityCounts.newOpportunities,
    opportunityPublish: opportunityCounts.publish,
    opportunityWatch: opportunityCounts.watch,
    opportunityHold: opportunityCounts.hold,
    opportunityBlock: opportunityCounts.block,
    pauseRecommendations,
    improvementRecommendations,
    wqrc: responseCoverage.total,
  })
  const recommendationContext: RecommendationContext = {
    firmId,
    range,
    opportunityRows,
    adExecutionRows,
    adRows: scopedAdRows,
    searchStatusRows: statusAtAsOf,
    indexablePublicationIds,
    caseNames,
  }
  const recommendations = recommendationsFor(metrics, recommendationContext)
  metrics.recommendationCount = recommendations.length
  if (metrics.pauseRecommendations !== null) {
    const pauseCount = recommendations.filter((row) => row.code === 'pause_ad').length
    metrics.pauseRecommendations = pauseCount
    metrics.pauseRecommendationCount = pauseCount
  }
  if (metrics.improvementRecommendations !== null) {
    const improvementCount = recommendations.filter((row) => (
      row.code === 'improve_ad'
        || row.code === 'improve_search'
        || row.code === 'improve_opportunity'
        || row.code === 'search_without_clicks'
    )).length
    metrics.improvementRecommendations = improvementCount
    metrics.improvementRecommendationCount = improvementCount
  }
  const exceptions: string[] = []
  if (metrics.pendingLeadSla > 0) exceptions.push(`pending_lead_sla:${metrics.pendingLeadSla}`)
  if (metrics.overdueLeads > 0) exceptions.push(`overdue_follow_up:${metrics.overdueLeads}`)
  if (metrics.unassignedLeads > 0) exceptions.push(`unassigned_lead:${metrics.unassignedLeads}`)
  const generatedAt = new Date()
  const snapshot: Omit<FirmReport, 'id'> = {
    firmId,
    day: range.reportKey,
    period: range.period,
    dateRange: range.dateRange,
    status: exceptions.length ? 'warning' : 'ready',
    metrics,
    exceptions,
    recommendations,
    generatedAt,
  }
  // Keep the set operation above intentionally close to the source reads: a
  // report must never count a related row whose lead belongs to another firm.
  return { snapshot, range }
}

function snapshotFromInput(input: DailyReportSnapshotInput): Omit<FirmReport, 'id'> {
  const firmId = firmIdValue(input.firmId)
  const period = input.period ?? (input.day.startsWith('week:') ? 'weekly' : 'daily')
  const metrics = normalizeMetrics(input.metrics)
  const parsed = parseReportKey(input.day, metrics)
  const dateRange = input.dateRange ?? parsed.dateRange
  const generatedAt = input.generatedAt === undefined ? new Date() : dateValue(input.generatedAt, 'generatedAt')
  const exceptions = [...(input.exceptions ?? [])]
  const recommendations = [...(input.recommendations
    ?? storedRecommendations(metrics.recommendations)
    ?? recommendationsFor(metrics))]
  metrics.recommendationCount = recommendations.length
  return {
    firmId,
    day: input.day,
    period,
    dateRange,
    status: input.status,
    metrics,
    exceptions,
    recommendations,
    generatedAt,
  }
}

async function persistReport(
  db: Db,
  snapshot: Omit<FirmReport, 'id'>,
): Promise<UpsertedDailyReport> {
  await assertFirmExists(db, snapshot.firmId)
  const storedMetrics: ReportMetrics = {
    ...snapshot.metrics,
    recommendations: [...snapshot.recommendations],
    recommendationCount: snapshot.recommendations.length,
  }
  const payload: typeof dailyReports.$inferInsert = {
    firmId: snapshot.firmId,
    day: snapshot.day,
    status: snapshot.status,
    // The JSONB column predates structured recommendations. Keep the DB
    // schema unchanged while allowing this additive snapshot field at runtime.
    metrics: storedMetrics as unknown as typeof dailyReports.$inferInsert.metrics,
    exceptions: snapshot.exceptions,
    generatedAt: snapshot.generatedAt,
  }
  const result = await db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const [existing] = await transactionalDb.select().from(dailyReports).where(and(
      eq(dailyReports.firmId, snapshot.firmId),
      eq(dailyReports.day, snapshot.day),
    )).limit(1)
    const unchanged = Boolean(existing
      && existing.status === payload.status
      && deepEqual(existing.metrics, payload.metrics)
      && deepEqual(existing.exceptions, payload.exceptions))
    if (unchanged && existing) return { row: existing, inserted: false, updated: false, unchanged: true }

    const [row] = await tx.insert(dailyReports).values(payload).onConflictDoUpdate({
      target: [dailyReports.firmId, dailyReports.day],
      set: {
        status: payload.status,
        metrics: payload.metrics,
        exceptions: payload.exceptions,
        generatedAt: payload.generatedAt,
      },
    }).returning()
    if (!row) throw new Error('daily report persistence returned no row')
    return { row, inserted: !existing, updated: Boolean(existing), unchanged: false }
  })
  const report = hydrateReport(result.row)
  return {
    ...report,
    report,
    row: result.row,
    inserted: result.inserted,
    updated: result.updated,
    unchanged: result.unchanged,
  }
}

/** Build a date-bounded report without writing it. */
export async function generateReport(db: Db, input: ReportInput): Promise<FirmReport> {
  const { snapshot } = await buildReport(db, input)
  return {
    id: null,
    ...snapshot,
  }
}

/** Generate and idempotently persist one calendar-day report. */
export async function generateDailyReport(db: Db, input: ReportInput): Promise<UpsertedDailyReport> {
  const { snapshot } = await buildReport(db, { ...input, period: 'daily' }, 'daily')
  return persistReport(db, snapshot)
}

/** Generate and idempotently persist an explicit or seven-day weekly report. */
export async function generateWeeklyReport(db: Db, input: ReportInput): Promise<UpsertedDailyReport> {
  const { snapshot } = await buildReport(db, { ...input, period: 'weekly' }, 'weekly')
  return persistReport(db, snapshot)
}

/** Upsert a computed snapshot, or compute one when passed normal report options. */
export async function upsertDailyReport(
  db: Db,
  input: ReportInput | DailyReportSnapshotInput,
): Promise<UpsertedDailyReport> {
  if ('metrics' in input && 'status' in input) {
    return persistReport(db, snapshotFromInput(input))
  }
  const { snapshot } = await buildReport(db, input)
  return persistReport(db, snapshot)
}

export async function getDailyReport(
  db: Db,
  firm: number | { id: number },
  keyOrInput: string | ReportInput,
): Promise<FirmReport | null> {
  const firmId = firmIdValue(firm)
  await assertFirmExists(db, firmId)
  const key = typeof keyOrInput === 'string'
    ? keyOrInput
    : normalizeRange({ ...keyOrInput, firmId }, keyOrInput.period).reportKey
  const [row] = await db.select().from(dailyReports).where(and(
    eq(dailyReports.firmId, firmId),
    eq(dailyReports.day, key),
  )).limit(1)
  return row ? hydrateReport(row) : null
}

export const createDailyReport = generateDailyReport
export const createWeeklyReport = generateWeeklyReport
export const persistDailyReport = upsertDailyReport
export const saveDailyReport = upsertDailyReport
export const getReport = getDailyReport
