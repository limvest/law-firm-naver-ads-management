import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  adDailyStatsV2,
  adExecutions,
  caseEntities,
  caseOpportunities,
  contentAssets,
  leads,
  publicationChecks,
  publications,
  visitorSessions,
} from '@/lib/db/schema'
import { outcomeSummaryForFirm, type OutcomeSummary } from '@/domains/outcomes'
import {
  getSearchDashboardSummary,
  type SearchDashboardSummary,
} from '@/domains/search'
import {
  calculateQualifiedResponseCoverage,
  type QualifiedResponseCoverage,
} from './response-coverage'

const DAY_MS = 86_400_000
const TERMINAL_LEAD_STATUSES = new Set(['수임', '종결'])

export type CustomerOverviewOptions = {
  since?: Date
  until?: Date
  leadSlaHours?: number
  queueLimit?: number
}

export type CustomerLeadQueueItem = {
  id: string
  slug: string | null
  status: string
  priority: string
  assignedLawyer: string | null
  createdAt: Date
  followUpAt: Date | null
  lastContactAt: Date | null
  overdue: boolean
  slaBreached: boolean
}

export type CustomerOpportunity = {
  caseEntityId: string
  canonicalName: string
  category: string
  score: number
  recommendation: string
  reasons: string[]
  calculatedAt: Date
}

export type CustomerAdAttention = {
  adExecutionId: string
  caseEntityId: string
  canonicalName: string
  status: string
  reviewStatus: string
  cost: number
  clicks: number
  conversions: number
  reason: string
}

export type CustomerOverview = {
  firmId: number
  period: { since: Date; until: Date; days: number }
  metrics: {
    spend: number
    impressions: number
    adClicks: number
    visits: number
    leads: number
    qualified: number
    consultations: number
    retained: number
    attributedQualified: number
    attributedRetained: number
    attributionRate: number | null
    costPerQualified: number | null
    costPerRetained: number | null
    /** Weekly Qualified Response Coverage for this overview period. */
    wqrc: number
  }
  leadQueue: {
    newCount: number
    overdue: number
    slaBreached: number
    unassigned: number
    items: CustomerLeadQueueItem[]
  }
  opportunities: CustomerOpportunity[]
  adAttention: CustomerAdAttention[]
  publications: {
    live: number
    pending: number
    blockedOrFailed: number
  }
  responseCoverage: QualifiedResponseCoverage
  search: SearchDashboardSummary
  outcomes: OutcomeSummary
}

function positiveFirmId(value: number | { id: number }): number {
  const id = typeof value === 'number' ? value : value.id
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('firm id must be a positive integer')
  return id
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid date`)
  return new Date(value)
}

function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function leadPriorityWeight(priority: string): number {
  return priority === 'urgent' ? 4 : priority === 'high' ? 3 : priority === 'normal' ? 2 : 1
}

/**
 * Customer-facing overview. Every row is scoped by firm_id and the headline
 * metrics describe customer outcomes, never platform-wide inventory.
 */
export async function customerOverviewForFirm(
  db: Db,
  firm: number | { id: number },
  options: CustomerOverviewOptions = {},
): Promise<CustomerOverview> {
  const firmId = positiveFirmId(firm)
  const until = validDate(options.until ?? new Date(), 'until')
  const since = validDate(options.since ?? new Date(until.getTime() - 7 * DAY_MS), 'since')
  if (since >= until) throw new TypeError('since must be before until')
  const leadSlaHours = options.leadSlaHours ?? 4
  if (!Number.isFinite(leadSlaHours) || leadSlaHours <= 0) throw new TypeError('leadSlaHours must be positive')
  const queueLimit = options.queueLimit ?? 8
  if (!Number.isSafeInteger(queueLimit) || queueLimit <= 0) throw new TypeError('queueLimit must be a positive integer')
  const slaBoundary = new Date(until.getTime() - leadSlaHours * 3_600_000)
  const sinceDay = dayKey(since)
  const untilDay = dayKey(until)

  const [
    periodSessions,
    allLeadRows,
    adStats,
    executionRows,
    opportunityRows,
    assetRows,
    publicationRows,
    outcomes,
    search,
  ] = await Promise.all([
    db.select().from(visitorSessions).where(and(
      eq(visitorSessions.firmId, firmId),
      gte(visitorSessions.startedAt, since),
      lte(visitorSessions.startedAt, until),
    )),
    db.select().from(leads).where(eq(leads.firmId, firmId)).orderBy(desc(leads.createdAt)),
    db.select().from(adDailyStatsV2).where(eq(adDailyStatsV2.firmId, firmId)),
    db.select().from(adExecutions).where(eq(adExecutions.firmId, firmId)),
    db.select().from(caseOpportunities).where(eq(caseOpportunities.firmId, firmId)),
    db.select().from(contentAssets).where(eq(contentAssets.firmId, firmId)),
    db.select().from(publications).where(eq(publications.firmId, firmId)),
    outcomeSummaryForFirm(db, firmId, { since }),
    getSearchDashboardSummary(db, firmId, {
      since: sinceDay,
      until: untilDay,
      asOf: until,
    }),
  ])
  const publicationCheckRows = publicationRows.length
    ? await db.select().from(publicationChecks).where(inArray(
        publicationChecks.publicationId,
        publicationRows.map((row) => row.id),
      ))
    : []
  const responseCoverage = calculateQualifiedResponseCoverage({
    since,
    until,
    assets: assetRows,
    publications: publicationRows,
    checks: publicationCheckRows,
    adExecutions: executionRows,
  })

  const periodLeads = allLeadRows.filter((lead) => lead.createdAt >= since && lead.createdAt <= until)
  const periodAdStats = adStats.filter((row) => row.day >= sinceDay && row.day <= untilDay)
  const spend = periodAdStats.reduce((sum, row) => sum + row.cost, 0)
  const impressions = periodAdStats.reduce((sum, row) => sum + row.impressions, 0)
  const adClicks = periodAdStats.reduce((sum, row) => sum + row.clicks, 0)

  const activeLeads = allLeadRows.filter((lead) => !TERMINAL_LEAD_STATUSES.has(lead.status))
  const queueItems: CustomerLeadQueueItem[] = activeLeads.map((lead) => ({
    id: lead.id,
    slug: lead.slug,
    status: lead.status,
    priority: lead.priority,
    assignedLawyer: lead.assignedLawyer,
    createdAt: lead.createdAt,
    followUpAt: lead.followUpAt,
    lastContactAt: lead.lastContactAt,
    overdue: Boolean(lead.followUpAt && lead.followUpAt < until),
    slaBreached: !lead.lastContactAt && lead.createdAt < slaBoundary,
  })).sort((left, right) => (
    Number(right.slaBreached) - Number(left.slaBreached)
    || Number(right.overdue) - Number(left.overdue)
    || leadPriorityWeight(right.priority) - leadPriorityWeight(left.priority)
    || right.createdAt.getTime() - left.createdAt.getTime()
  ))

  const opportunityCaseIds = [...new Set(opportunityRows.map((row) => row.caseEntityId))]
  const executionCaseIds = [...new Set(executionRows.map((row) => row.caseEntityId))]
  const caseIds = [...new Set([...opportunityCaseIds, ...executionCaseIds])]
  const caseRows = caseIds.length
    ? await db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds))
    : []
  const caseById = new Map(caseRows.map((row) => [row.id, row]))

  const opportunities = opportunityRows
    .filter((row) => row.scopeKey === `firm:${firmId}` && ['publish', 'watch'].includes(row.recommendation))
    .sort((left, right) => right.score - left.score || right.calculatedAt.getTime() - left.calculatedAt.getTime())
    .slice(0, 8)
    .flatMap<CustomerOpportunity>((row) => {
      const entity = caseById.get(row.caseEntityId)
      return entity ? [{
        caseEntityId: entity.id,
        canonicalName: entity.canonicalName,
        category: entity.category,
        score: row.score,
        recommendation: row.recommendation,
        reasons: row.reasons,
        calculatedAt: row.calculatedAt,
      }] : []
    })

  const statsByExecution = new Map<string, { cost: number; clicks: number; conversions: number }>()
  for (const row of periodAdStats) {
    const current = statsByExecution.get(row.adExecutionId) ?? { cost: 0, clicks: 0, conversions: 0 }
    current.cost += row.cost
    current.clicks += row.clicks
    current.conversions += row.conversions
    statsByExecution.set(row.adExecutionId, current)
  }
  const adAttention = executionRows.flatMap<CustomerAdAttention>((execution) => {
    const stats = statsByExecution.get(execution.id) ?? { cost: 0, clicks: 0, conversions: 0 }
    const entity = caseById.get(execution.caseEntityId)
    const reason = execution.reviewStatus === 'rejected'
      ? execution.reviewReason || '광고 심사 거절 사유를 확인하세요.'
      : execution.status === 'pending_review'
        ? '광고 심사가 아직 완료되지 않았습니다.'
        : stats.clicks >= 10 && stats.conversions === 0
          ? '클릭은 발생했지만 상담 전환이 없어 랜딩과 검색어 검토가 필요합니다.'
          : null
    return reason && entity ? [{
      adExecutionId: execution.id,
      caseEntityId: execution.caseEntityId,
      canonicalName: entity.canonicalName,
      status: execution.status,
      reviewStatus: execution.reviewStatus,
      cost: stats.cost,
      clicks: stats.clicks,
      conversions: stats.conversions,
      reason,
    }] : []
  }).sort((left, right) => right.cost - left.cost || left.canonicalName.localeCompare(right.canonicalName, 'ko'))

  return {
    firmId,
    period: {
      since,
      until,
      days: Math.max(1, Math.ceil((until.getTime() - since.getTime()) / DAY_MS)),
    },
    metrics: {
      spend,
      impressions,
      adClicks,
      visits: periodSessions.length,
      leads: periodLeads.length,
      qualified: outcomes.qualifiedLeads,
      consultations: outcomes.consultationsBooked,
      retained: outcomes.retainedMatters,
      attributedQualified: outcomes.attributedQualifiedLeads,
      attributedRetained: outcomes.attributedRetainedMatters,
      attributionRate: outcomes.attributionRate,
      costPerQualified: outcomes.qualifiedLeads ? spend / outcomes.qualifiedLeads : null,
      costPerRetained: outcomes.retainedMatters ? spend / outcomes.retainedMatters : null,
      wqrc: responseCoverage.total,
    },
    leadQueue: {
      newCount: activeLeads.filter((lead) => lead.status === 'new').length,
      overdue: queueItems.filter((lead) => lead.overdue).length,
      slaBreached: queueItems.filter((lead) => lead.slaBreached).length,
      unassigned: activeLeads.filter((lead) => !lead.assignedLawyer).length,
      items: queueItems.slice(0, queueLimit),
    },
    opportunities,
    adAttention,
    publications: {
      live: publicationRows.filter((row) => row.status === 'live').length,
      pending: publicationRows.filter((row) => row.status === 'pending').length,
      blockedOrFailed: publicationRows.filter((row) => row.status === 'blocked' || row.status === 'failed').length,
    },
    responseCoverage,
    search,
    outcomes,
  }
}

export const getCustomerOverview = customerOverviewForFirm
