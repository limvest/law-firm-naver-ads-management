import { and, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  adDailyStatsV2,
  adExecutions,
  firmPolicies,
  leadQualifications,
  leads,
  matterOutcomes,
  publications,
  searchQueryStats,
  sourceItems,
  contentAssets,
} from '@/lib/db/schema'
import type { OpportunityFirmContext, OpportunityGlobalContext } from './types'

export type OpportunityGlobalContextMap = ReadonlyMap<string, OpportunityGlobalContext>
export type OpportunityFirmCaseContextMap = ReadonlyMap<string, OpportunityFirmContext>

export type DerivedOpportunityContexts = {
  globalByCase: OpportunityGlobalContextMap
  firmByCase: OpportunityFirmCaseContextMap
}

export type DeriveOpportunityContextOptions = {
  caseEntityIds: readonly string[]
  firmIds: readonly number[]
  asOf?: Date | string
  velocityWindowDays?: number
  searchWindowDays?: number
  adWindowDays?: number
}

type Counter = { recent: number; previous: number }
type SearchAggregate = { impressions: number }
type AdAggregate = { clicks: number; cost: number }
type ReviewAggregate = { approved: number; rejected: number }
type OutcomeAggregate = {
  qualified: number
  unqualified: number
  retained: number
  notRetained: number
}

export function opportunityFirmCaseKey(firmId: number, caseEntityId: string): string {
  return `${firmId}:${caseEntityId}`
}

function validDate(value: Date | string | undefined, label: string): Date {
  const date = value === undefined ? new Date() : value instanceof Date ? new Date(value) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`)
  return date
}

function positiveDays(value: number | undefined, fallback: number, label: string): number {
  const days = value ?? fallback
  if (!Number.isSafeInteger(days) || days <= 0) throw new TypeError(`${label} must be a positive integer`)
  return days
}

function dateAtStartOfWindow(asOf: Date, days: number): number {
  return asOf.getTime() - days * 86_400_000
}

function dayTimestamp(day: string): number | null {
  const value = Date.parse(`${day}T00:00:00.000Z`)
  return Number.isFinite(value) ? value : null
}

/**
 * Build scorer inputs from observed product data. Missing measurements stay
 * missing; this function never substitutes approval or synthetic demo state
 * for provider review, search, advertising, or customer outcomes.
 */
export async function deriveOpportunityContexts(
  db: Db,
  options: DeriveOpportunityContextOptions,
): Promise<DerivedOpportunityContexts> {
  const caseEntityIds = [...new Set(options.caseEntityIds)]
  const firmIds = [...new Set(options.firmIds)]
  const globalByCase = new Map<string, OpportunityGlobalContext>()
  const firmByCase = new Map<string, OpportunityFirmContext>()
  if (caseEntityIds.length === 0) return { globalByCase, firmByCase }

  const asOf = validDate(options.asOf, 'asOf')
  const velocityWindowDays = positiveDays(options.velocityWindowDays, 14, 'velocityWindowDays')
  const searchWindowDays = positiveDays(options.searchWindowDays, 30, 'searchWindowDays')
  const adWindowDays = positiveDays(options.adWindowDays, 30, 'adWindowDays')
  const velocityRecentStart = dateAtStartOfWindow(asOf, velocityWindowDays)
  const velocityPreviousStart = dateAtStartOfWindow(asOf, velocityWindowDays * 2)
  const searchStart = dateAtStartOfWindow(asOf, searchWindowDays)
  const adStart = dateAtStartOfWindow(asOf, adWindowDays)

  const sourceRows = await db.select({
    caseEntityId: sourceItems.caseEntityId,
    observedAt: sourceItems.observedAt,
  }).from(sourceItems).where(inArray(sourceItems.caseEntityId, caseEntityIds))

  const velocity = new Map<string, Counter>()
  for (const row of sourceRows) {
    if (!row.caseEntityId) continue
    const observedAt = row.observedAt.getTime()
    if (observedAt > asOf.getTime() || observedAt < velocityPreviousStart) continue
    const counter = velocity.get(row.caseEntityId) ?? { recent: 0, previous: 0 }
    if (observedAt >= velocityRecentStart) counter.recent += 1
    else counter.previous += 1
    velocity.set(row.caseEntityId, counter)
  }

  const assetRows = await db.select({
    id: contentAssets.id,
    caseEntityId: contentAssets.caseEntityId,
  }).from(contentAssets).where(inArray(contentAssets.caseEntityId, caseEntityIds))
  const caseByAsset = new Map(assetRows.map((row) => [row.id, row.caseEntityId]))
  const assetIds = [...caseByAsset.keys()]
  const publicationRows = assetIds.length === 0
    ? []
    : await db.select({ id: publications.id, contentAssetId: publications.contentAssetId })
      .from(publications)
      .where(inArray(publications.contentAssetId, assetIds))
  const caseByPublication = new Map(
    publicationRows.flatMap((row) => {
      const caseEntityId = caseByAsset.get(row.contentAssetId)
      return caseEntityId ? [[row.id, caseEntityId] as const] : []
    }),
  )
  const publicationIds = [...caseByPublication.keys()]
  const searchRows = publicationIds.length === 0
    ? []
    : await db.select({
      publicationId: searchQueryStats.publicationId,
      day: searchQueryStats.day,
      impressions: searchQueryStats.impressions,
    }).from(searchQueryStats).where(inArray(searchQueryStats.publicationId, publicationIds))
  const search = new Map<string, SearchAggregate>()
  for (const row of searchRows) {
    if (!row.publicationId) continue
    const caseEntityId = caseByPublication.get(row.publicationId)
    const timestamp = dayTimestamp(row.day)
    if (!caseEntityId || timestamp === null || timestamp < searchStart || timestamp > asOf.getTime()) continue
    const aggregate = search.get(caseEntityId) ?? { impressions: 0 }
    aggregate.impressions += Math.max(0, row.impressions)
    search.set(caseEntityId, aggregate)
  }

  const executionRows = firmIds.length === 0
    ? []
    : await db.select({
      id: adExecutions.id,
      firmId: adExecutions.firmId,
      caseEntityId: adExecutions.caseEntityId,
      reviewStatus: adExecutions.reviewStatus,
    }).from(adExecutions).where(and(
      inArray(adExecutions.caseEntityId, caseEntityIds),
      inArray(adExecutions.firmId, firmIds),
    ))
  const executionById = new Map(executionRows.map((row) => [row.id, row]))
  const review = new Map<string, ReviewAggregate>()
  for (const row of executionRows) {
    if (row.reviewStatus !== 'approved' && row.reviewStatus !== 'rejected') continue
    const aggregate = review.get(row.caseEntityId) ?? { approved: 0, rejected: 0 }
    if (row.reviewStatus === 'approved') aggregate.approved += 1
    else aggregate.rejected += 1
    review.set(row.caseEntityId, aggregate)
  }
  const executionIds = [...executionById.keys()]
  const adRows = executionIds.length === 0
    ? []
    : await db.select({
      adExecutionId: adDailyStatsV2.adExecutionId,
      day: adDailyStatsV2.day,
      clicks: adDailyStatsV2.clicks,
      cost: adDailyStatsV2.cost,
    }).from(adDailyStatsV2).where(inArray(adDailyStatsV2.adExecutionId, executionIds))
  const ads = new Map<string, AdAggregate>()
  for (const row of adRows) {
    const execution = executionById.get(row.adExecutionId)
    const timestamp = dayTimestamp(row.day)
    if (!execution || timestamp === null || timestamp < adStart || timestamp > asOf.getTime()) continue
    const aggregate = ads.get(execution.caseEntityId) ?? { clicks: 0, cost: 0 }
    aggregate.clicks += Math.max(0, row.clicks)
    aggregate.cost += Math.max(0, row.cost)
    ads.set(execution.caseEntityId, aggregate)
  }

  for (const caseEntityId of caseEntityIds) {
    const context: OpportunityGlobalContext = {}
    const velocityAggregate = velocity.get(caseEntityId)
    if (velocityAggregate) {
      const denominator = velocityAggregate.recent + velocityAggregate.previous
      context.velocity = denominator === 0
        ? 0
        : (velocityAggregate.recent - velocityAggregate.previous) / denominator
    }
    const searchAggregate = search.get(caseEntityId)
    if (searchAggregate) context.searchVolume = searchAggregate.impressions
    const adAggregate = ads.get(caseEntityId)
    if (adAggregate && adAggregate.clicks > 0) context.averageCpc = adAggregate.cost / adAggregate.clicks
    const reviewAggregate = review.get(caseEntityId)
    if (reviewAggregate) {
      const decided = reviewAggregate.approved + reviewAggregate.rejected
      if (decided > 0) context.reviewProbability = reviewAggregate.approved / decided
    }
    if (Object.keys(context).length > 0) globalByCase.set(caseEntityId, context)
  }

  if (firmIds.length === 0) return { globalByCase, firmByCase }

  const leadRows = await db.select({
    id: leads.id,
    firmId: leads.firmId,
    caseEntityId: leads.caseEntityId,
  }).from(leads).where(and(
    inArray(leads.caseEntityId, caseEntityIds),
    inArray(leads.firmId, firmIds),
  ))
  const leadById = new Map(leadRows.map((row) => [row.id, row]))
  const leadIds = [...leadById.keys()]
  const qualificationRows = leadIds.length === 0
    ? []
    : await db.select({ leadId: leadQualifications.leadId, status: leadQualifications.status })
      .from(leadQualifications)
      .where(inArray(leadQualifications.leadId, leadIds))
  const outcomeRows = leadIds.length === 0
    ? []
    : await db.select({ leadId: matterOutcomes.leadId, status: matterOutcomes.status })
      .from(matterOutcomes)
      .where(inArray(matterOutcomes.leadId, leadIds))
  const outcomes = new Map<string, OutcomeAggregate>()
  for (const row of qualificationRows) {
    const lead = leadById.get(row.leadId)
    if (!lead?.caseEntityId || (row.status !== 'qualified' && row.status !== 'unqualified')) continue
    const key = opportunityFirmCaseKey(lead.firmId, lead.caseEntityId)
    const aggregate = outcomes.get(key) ?? { qualified: 0, unqualified: 0, retained: 0, notRetained: 0 }
    if (row.status === 'qualified') aggregate.qualified += 1
    else aggregate.unqualified += 1
    outcomes.set(key, aggregate)
  }
  for (const row of outcomeRows) {
    const lead = leadById.get(row.leadId)
    if (!lead?.caseEntityId || (row.status !== 'retained' && row.status !== 'not_retained')) continue
    const key = opportunityFirmCaseKey(lead.firmId, lead.caseEntityId)
    const aggregate = outcomes.get(key) ?? { qualified: 0, unqualified: 0, retained: 0, notRetained: 0 }
    if (row.status === 'retained') aggregate.retained += 1
    else aggregate.notRetained += 1
    outcomes.set(key, aggregate)
  }

  const policyRows = await db.select({
    firmId: firmPolicies.firmId,
    allowedCaseEntityIds: firmPolicies.allowedCaseEntityIds,
  }).from(firmPolicies).where(inArray(firmPolicies.firmId, firmIds))
  const policyByFirm = new Map(policyRows.map((row) => [row.firmId, row.allowedCaseEntityIds]))

  for (const firmId of firmIds) {
    for (const caseEntityId of caseEntityIds) {
      const key = opportunityFirmCaseKey(firmId, caseEntityId)
      const aggregate = outcomes.get(key)
      const context: OpportunityFirmContext = {}
      if (aggregate) {
        const qualificationDecisions = aggregate.qualified + aggregate.unqualified
        if (qualificationDecisions > 0) {
          context.qualifiedConsultationRate = aggregate.qualified / qualificationDecisions
        }
        const retentionDecisions = aggregate.retained + aggregate.notRetained
        if (retentionDecisions > 0) context.retainedRate = aggregate.retained / retentionDecisions
      }
      const allowedCases = policyByFirm.get(firmId)
      if (allowedCases) context.preference = allowedCases.includes(caseEntityId) ? 1 : 0
      if (Object.keys(context).length > 0) firmByCase.set(key, context)
    }
  }

  return { globalByCase, firmByCase }
}
