/**
 * Weekly Qualified Response Coverage (WQRC)
 *
 * A firm x case is counted only the first time it has an evidence-backed,
 * verified public response path. A healthy indexable SEO publication is one
 * path; a verified noindex landing with an approved ad execution is the other.
 * Counting the first qualifying timestamp prevents a routine health recheck
 * from inflating weekly coverage.
 */

export type ResponseCoverageAsset = Readonly<{
  id: string
  caseEntityId: string
  assetType: string
  evidenceSnapshotId: string | null
  qualityReport: unknown
  createdAt: Date
}>

export type ResponseCoveragePublication = Readonly<{
  id: string
  contentAssetId: string
  status: string
  indexPolicy: string
  publishedAt: Date | null
}>

export type ResponseCoverageCheck = Readonly<{
  publicationId: string
  statusCode: number | null
  canonicalOk: boolean
  ctaOk: boolean
  brandOk: boolean
  placeholderFree: boolean
  checkedAt: Date
}>

export type ResponseCoverageAdExecution = Readonly<{
  caseEntityId: string
  contentAssetId: string
  publicationId: string | null
  status: string
  reviewStatus: string
  updatedAt: Date
}>

export type QualifiedResponsePath = 'seo' | 'approved_ad'

export type QualifiedResponseCoverageCase = Readonly<{
  caseEntityId: string
  qualifiedAt: Date
  paths: readonly QualifiedResponsePath[]
}>

export type QualifiedResponseCoverage = Readonly<{
  total: number
  seo: number
  approvedAd: number
  both: number
  cases: readonly QualifiedResponseCoverageCase[]
}>

export type QualifiedResponseCoverageInput = Readonly<{
  since: Date
  until: Date
  assets: readonly ResponseCoverageAsset[]
  publications: readonly ResponseCoveragePublication[]
  checks: readonly ResponseCoverageCheck[]
  adExecutions: readonly ResponseCoverageAdExecution[]
}>

type ReadyPath = Readonly<{
  caseEntityId: string
  path: QualifiedResponsePath
  qualifiedAt: Date
}>

const APPROVED_AD_STATES = new Set(['submitted', 'pending_review', 'live', 'paused'])

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid date`)
  }
  return new Date(value.getTime())
}

function qualityReady(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const report = value as Record<string, unknown>
  return report.evidenceReady === true
    && report.placeholderFree === true
    && report.linksReady === true
    && report.brandReady === true
    && report.complianceReady === true
    && typeof report.uniqueFacts === 'number'
    && Number.isFinite(report.uniqueFacts)
    && report.uniqueFacts > 0
}

function checkReady(check: ResponseCoverageCheck): boolean {
  return check.statusCode !== null
    && check.statusCode >= 200
    && check.statusCode < 300
    && check.canonicalOk
    && check.ctaOk
    && check.brandOk
    && check.placeholderFree
}

function latestDate(...values: readonly Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())))
}

function earliestSuccessfulCheck(
  checks: readonly ResponseCoverageCheck[],
  publicationId: string,
): ResponseCoverageCheck | null {
  return checks
    .filter((check) => check.publicationId === publicationId && checkReady(check))
    .sort((left, right) => left.checkedAt.getTime() - right.checkedAt.getTime())[0] ?? null
}

function readyPaths(input: QualifiedResponseCoverageInput): ReadyPath[] {
  const assetById = new Map(input.assets.map((asset) => [asset.id, asset]))
  const executionsByPublication = new Map<string, ResponseCoverageAdExecution[]>()
  for (const execution of input.adExecutions) {
    if (!execution.publicationId) continue
    const rows = executionsByPublication.get(execution.publicationId) ?? []
    rows.push(execution)
    executionsByPublication.set(execution.publicationId, rows)
  }

  const paths: ReadyPath[] = []
  for (const publication of input.publications) {
    if (publication.status !== 'live') continue
    const asset = assetById.get(publication.contentAssetId)
    if (!asset || !asset.evidenceSnapshotId || !qualityReady(asset.qualityReport)) continue
    const successfulCheck = earliestSuccessfulCheck(input.checks, publication.id)
    if (!successfulCheck) continue

    const baseQualifiedAt = latestDate(
      asset.createdAt,
      publication.publishedAt ?? successfulCheck.checkedAt,
      successfulCheck.checkedAt,
    )
    if (asset.assetType === 'seo_page' && publication.indexPolicy === 'index') {
      paths.push({ caseEntityId: asset.caseEntityId, path: 'seo', qualifiedAt: baseQualifiedAt })
    }
    if (asset.assetType !== 'ad_landing' || publication.indexPolicy !== 'noindex') continue
    const execution = (executionsByPublication.get(publication.id) ?? [])
      .filter((row) => row.caseEntityId === asset.caseEntityId
        && row.contentAssetId === asset.id
        && row.reviewStatus === 'approved'
        && APPROVED_AD_STATES.has(row.status))
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())[0]
    if (!execution) continue
    paths.push({
      caseEntityId: asset.caseEntityId,
      path: 'approved_ad',
      qualifiedAt: latestDate(baseQualifiedAt, execution.updatedAt),
    })
  }
  return paths
}

export function calculateQualifiedResponseCoverage(
  input: QualifiedResponseCoverageInput,
): QualifiedResponseCoverage {
  const since = validDate(input.since, 'since')
  const until = validDate(input.until, 'until')
  if (since >= until) throw new TypeError('since must be before until')

  const byCase = new Map<string, ReadyPath[]>()
  for (const path of readyPaths(input)) {
    const rows = byCase.get(path.caseEntityId) ?? []
    rows.push(path)
    byCase.set(path.caseEntityId, rows)
  }

  const cases = [...byCase.entries()].flatMap<QualifiedResponseCoverageCase>(([caseEntityId, paths]) => {
    const firstQualifiedAt = new Date(Math.min(...paths.map((path) => path.qualifiedAt.getTime())))
    if (firstQualifiedAt < since || firstQualifiedAt >= until) return []
    const availablePaths = [...new Set(
      paths.filter((path) => path.qualifiedAt < until).map((path) => path.path),
    )].sort() as QualifiedResponsePath[]
    return [{ caseEntityId, qualifiedAt: firstQualifiedAt, paths: availablePaths }]
  }).sort((left, right) => (
    left.qualifiedAt.getTime() - right.qualifiedAt.getTime()
      || left.caseEntityId.localeCompare(right.caseEntityId)
  ))

  return {
    total: cases.length,
    seo: cases.filter((item) => item.paths.includes('seo')).length,
    approvedAd: cases.filter((item) => item.paths.includes('approved_ad')).length,
    both: cases.filter((item) => item.paths.length === 2).length,
    cases,
  }
}
