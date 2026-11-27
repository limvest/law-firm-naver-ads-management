import type { dailyReports } from '@/lib/db/schema'
import type { ReportRecommendation } from './reporting'

export type ExportableReport = Pick<
  typeof dailyReports.$inferSelect,
  'day' | 'status' | 'metrics' | 'exceptions' | 'generatedAt'
> & {
  /** Optional for callers exporting an in-memory report snapshot. */
  recommendations?: readonly ReportRecommendation[]
}

const METRIC_COLUMNS = [
  // Keep the original headline columns first for spreadsheet compatibility.
  'spend', 'impressions', 'adClicks', 'visits', 'pageViews', 'leads', 'qualified',
  'consultations', 'retained', 'notRetained', 'attributionRate', 'costPerQualified',
  'costPerRetained', 'slaBreached',
  // Additive detail columns mirror the persisted report metric snapshot.
  'adSpend', 'adCost', 'adImpressions', 'adConversions', 'adCtr', 'adCpc',
  'searchImpressions', 'searchClicks', 'searchCtr', 'searchIndexableUrls',
  'searchObservedUrls', 'searchIndexedUrls', 'searchIndexRate', 'searchIndexPending',
  'searchAveragePosition', 'indexableUrls', 'observedUrls', 'indexedUrls', 'indexRate',
  'uniqueVisitors', 'attributedLeads', 'attributedQualified', 'attributedQualifiedLeads',
  'qualifiedAttributionRate', 'attributedConsultations', 'attributedConsultationsCompleted',
  'consultationAttributionRate', 'consultationsCompleted', 'attributedRetained',
  'attributedRetainedMatters', 'retainedAttributionRate', 'notRetainedMatters',
  'closedMatters', 'outcomePending', 'leadAttributionRate', 'costPerLead',
  'costPerAttributedQualified', 'costPerAttributedRetained', 'pendingLeads',
  'pendingLeadSla', 'overdueLeads', 'unassignedLeads', 'newOpportunities',
  'newOpportunityCount', 'opportunityPublish', 'opportunityWatch', 'opportunityHold',
  'opportunityBlock', 'pauseRecommendations', 'pauseRecommendationCount',
  'improvementRecommendations', 'improvementRecommendationCount', 'recommendationCount',
] as const

type ExportMetricValue = number | null | readonly ReportRecommendation[] | undefined

function metricValue(row: ExportableReport, key: string): ExportMetricValue {
  const metrics = row.metrics as Record<string, ExportMetricValue>
  const value = metrics[key]
  if (value !== undefined) return value
  const alias: Record<string, string> = {
    adSpend: 'spend',
    adCost: 'spend',
    adImpressions: 'impressions',
    searchIndexableUrls: 'indexableUrls',
    searchObservedUrls: 'observedUrls',
    searchIndexedUrls: 'indexedUrls',
    searchIndexRate: 'indexRate',
    attributedQualifiedLeads: 'attributedQualified',
    attributedRetainedMatters: 'attributedRetained',
    notRetainedMatters: 'notRetained',
    newOpportunityCount: 'newOpportunities',
    pauseRecommendationCount: 'pauseRecommendations',
    improvementRecommendationCount: 'improvementRecommendations',
    costPerAttributedQualified: 'costPerQualified',
    costPerAttributedRetained: 'costPerRetained',
  }
  return alias[key] ? metrics[alias[key]] : value
}

function recommendationList(row: ExportableReport): readonly ReportRecommendation[] {
  if (row.recommendations) return row.recommendations
  const stored = metricValue(row, 'recommendations')
  return Array.isArray(stored) ? stored : []
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined
    ? ''
    : Array.isArray(value)
      ? value.join(' | ')
      : String(value)
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

export function reportsToCsv(rows: readonly ExportableReport[]): string {
  const headers = [
    'report_key',
    'status',
    'generated_at',
    ...METRIC_COLUMNS,
    'exceptions',
    'recommendations',
    'calculation_pending',
  ]
  const lines = rows.map((row) => {
    const recommendations = recommendationList(row)
    const pending = METRIC_COLUMNS.filter((key) => metricValue(row, key) == null).join(' | ')
    const values = [
      row.day,
      row.status,
      row.generatedAt.toISOString(),
      ...METRIC_COLUMNS.map((key) => metricValue(row, key) ?? null),
      row.exceptions,
      recommendations.map((item) => `${item.code}: ${item.message}`),
      pending,
    ]
    return values.map(csvCell).join(',')
  })
  return [headers.join(','), ...lines].join('\r\n')
}

export function reportsToJson(rows: readonly ExportableReport[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    reports: rows.map((row) => ({
      reportKey: row.day,
      period: row.day.startsWith('week:') ? 'weekly' : 'daily',
      status: row.status,
      generatedAt: row.generatedAt.toISOString(),
      metrics: row.metrics,
      exceptions: row.exceptions,
      recommendations: recommendationList(row),
      calculationPending: METRIC_COLUMNS.filter((key) => metricValue(row, key) == null),
    })),
  }, null, 2)
}
