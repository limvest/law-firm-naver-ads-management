import { and, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  adExecutions,
  contentAssets,
  firmPolicies,
  firms,
  operationJobs,
  publicationChecks,
  publications,
} from '@/lib/db/schema'

type ContentAssetRow = typeof contentAssets.$inferSelect
type FirmPolicyRow = typeof firmPolicies.$inferSelect
type OperationJobRow = typeof operationJobs.$inferSelect
type PublicationRow = typeof publications.$inferSelect
type PublicationCheckRow = typeof publicationChecks.$inferSelect
type AdExecutionRow = typeof adExecutions.$inferSelect

const AUTOMATED_ASSET_STATES = new Set(['approved', 'published'])
const SUCCESSFUL_JOB_STATE = 'succeeded'
const HEALTHY_AD_STATES = new Set(['submitted', 'pending_review', 'live', 'paused', 'rejected'])
const UNVERIFIED_AD_REVIEW_STATES = new Set(['', 'not_submitted', 'unknown'])

export type CompletionIssue = {
  code: string
  firmId: number
  contentAssetId: string
  detail: string
}

export type PipelineCompletionManifest = {
  version: 1
  generatedAt: string
  complete: boolean
  mode: 'publish-only' | 'publish-and-live-ads'
  assets: {
    expected: number
    qualityReady: number
  }
  jobs: {
    expected: number
    succeeded: number
    missing: number
    nonTerminal: number
    deadOrFailed: number
    byState: Record<string, number>
  }
  publications: {
    expected: number
    verified: number
  }
  ads: {
    expected: number
    verified: number
  }
  issues: CompletionIssue[]
}

export type PipelineCompletionInput = {
  assets: readonly ContentAssetRow[]
  policies?: readonly FirmPolicyRow[]
  jobs: readonly OperationJobRow[]
  publications: readonly PublicationRow[]
  checks: readonly PublicationCheckRow[]
  adExecutions?: readonly AdExecutionRow[]
  liveAds?: boolean
  generatedAt?: Date
}

function qualityReady(asset: ContentAssetRow): boolean {
  const report = asset.qualityReport
  return Boolean(
    asset.evidenceSnapshotId
    && report
    && report.evidenceReady
    && report.placeholderFree
    && report.linksReady
    && report.brandReady
    && report.complianceReady
    && report.uniqueFacts > 0
    && report.issues.length === 0,
  )
}

function currentAssets(rows: readonly ContentAssetRow[]): ContentAssetRow[] {
  const byScope = new Map<string, ContentAssetRow>()
  for (const row of rows) {
    if (!AUTOMATED_ASSET_STATES.has(row.status)) continue
    const key = `${row.firmId}:${row.caseEntityId}:${row.assetType}`
    const current = byScope.get(key)
    if (!current || row.contentVersion > current.contentVersion) byScope.set(key, row)
  }
  return [...byScope.values()].sort((left, right) => (
    left.firmId - right.firmId
    || left.caseEntityId.localeCompare(right.caseEntityId)
    || left.assetType.localeCompare(right.assetType)
  ))
}

function latestPublication(
  rows: readonly PublicationRow[],
  asset: ContentAssetRow,
): PublicationRow | null {
  return rows
    .filter((row) => row.firmId === asset.firmId && row.contentAssetId === asset.id)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0] ?? null
}

function latestCheck(
  rows: readonly PublicationCheckRow[],
  publicationId: string,
): PublicationCheckRow | null {
  return rows
    .filter((row) => row.publicationId === publicationId)
    .sort((left, right) => right.checkedAt.getTime() - left.checkedAt.getTime())[0] ?? null
}

function healthyCheck(check: PublicationCheckRow | null): boolean {
  return Boolean(
    check
    && check.statusCode !== null
    && check.statusCode >= 200
    && check.statusCode < 300
    && check.canonicalOk
    && check.ctaOk
    && check.brandOk
    && check.placeholderFree,
  )
}

function expectedPrepareJob(asset: ContentAssetRow): string {
  const jobType = asset.assetType === 'seo_page'
    ? 'content.prepare-seo-publication'
    : 'content.prepare-ad-publication'
  return `${jobType}:${asset.id}:v${asset.contentVersion}`
}

function addIssue(
  issues: CompletionIssue[],
  asset: ContentAssetRow,
  code: string,
  detail: string,
): void {
  issues.push({ code, firmId: asset.firmId, contentAssetId: asset.id, detail })
}

/**
 * Evaluate the target pipeline's actual end state. Merely running the worker is
 * insufficient: every current asset needs both successful durable jobs and a
 * healthy HTTP verification snapshot. Live-ad mode additionally requires a
 * provider-created execution whose review state has been observed.
 */
export function calculatePipelineCompletion(
  input: PipelineCompletionInput,
): PipelineCompletionManifest {
  const assets = currentAssets(input.assets)
  const jobsByKey = new Map(input.jobs.map((row) => [row.idempotencyKey, row]))
  const policiesByFirm = new Map((input.policies ?? []).map((row) => [row.firmId, row]))
  const executionsByAsset = new Map((input.adExecutions ?? []).map((row) => [row.contentAssetId, row]))
  const byState: Record<string, number> = {}
  const expectedJobs: Array<OperationJobRow | null> = []
  const issues: CompletionIssue[] = []
  let qualityReadyCount = 0
  let verifiedPublications = 0
  let expectedAds = 0
  let verifiedAds = 0

  for (const asset of assets) {
    if (qualityReady(asset)) qualityReadyCount += 1
    else addIssue(issues, asset, 'content_quality_not_ready', 'current asset lacks a complete evidence-backed quality report')

    const prepareKey = expectedPrepareJob(asset)
    const prepareJob = jobsByKey.get(prepareKey) ?? null
    expectedJobs.push(prepareJob)
    if (!prepareJob) addIssue(issues, asset, 'prepare_job_missing', prepareKey)
    else if (prepareJob.state !== SUCCESSFUL_JOB_STATE) {
      addIssue(issues, asset, 'prepare_job_incomplete', `${prepareKey}:${prepareJob.state}`)
    }

    const publication = latestPublication(input.publications, asset)
    if (!publication) {
      expectedJobs.push(null)
      addIssue(issues, asset, 'publication_missing', 'no publication exists for the current content asset')
      continue
    }

    const verifyKey = `publication.verify-http:${publication.id}:v${asset.contentVersion}`
    const verifyJob = jobsByKey.get(verifyKey) ?? null
    expectedJobs.push(verifyJob)
    if (!verifyJob) addIssue(issues, asset, 'verification_job_missing', verifyKey)
    else if (verifyJob.state !== SUCCESSFUL_JOB_STATE) {
      addIssue(issues, asset, 'verification_job_incomplete', `${verifyKey}:${verifyJob.state}`)
    }

    const expectedIndexPolicy = asset.assetType === 'seo_page' ? 'index' : 'noindex'
    const check = latestCheck(input.checks, publication.id)
    const publicationReady = publication.status === 'live'
      && publication.deployedVersion === String(asset.contentVersion)
      && publication.indexPolicy === expectedIndexPolicy
      && healthyCheck(check)
      && publication.lastVerifiedAt !== null
    if (publicationReady) verifiedPublications += 1
    else addIssue(
      issues,
      asset,
      'publication_not_verified',
      `${publication.status}:v${publication.deployedVersion ?? 'none'}:${publication.indexPolicy}`,
    )

    const policy = policiesByFirm.get(asset.firmId)
    const adExpected = input.liveAds === true
      && asset.assetType === 'ad_landing'
      && policy?.adAutoSubmit === true
    if (!adExpected) continue

    expectedAds += 1
    const execution = executionsByAsset.get(asset.id)
    const adReady = Boolean(
      execution
      && execution.desiredActive
      && HEALTHY_AD_STATES.has(execution.status)
      && !UNVERIFIED_AD_REVIEW_STATES.has(execution.reviewStatus.trim().toLowerCase())
      && execution.campaignExternalId
      && execution.adGroupExternalId
      && execution.creativeExternalId,
    )
    if (adReady) verifiedAds += 1
    else addIssue(issues, asset, 'ad_not_post_verified', execution
      ? `${execution.status}:${execution.reviewStatus}`
      : 'approved live-ad policy has no execution')
  }

  let succeeded = 0
  let missing = 0
  let nonTerminal = 0
  let deadOrFailed = 0
  for (const job of expectedJobs) {
    if (!job) {
      missing += 1
      continue
    }
    byState[job.state] = (byState[job.state] ?? 0) + 1
    if (job.state === SUCCESSFUL_JOB_STATE) succeeded += 1
    else if (job.state === 'dead' || job.state === 'failed') deadOrFailed += 1
    else nonTerminal += 1
  }

  const complete = issues.length === 0
    && succeeded === expectedJobs.length
    && verifiedPublications === assets.length
    && verifiedAds === expectedAds

  return {
    version: 1,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    complete,
    mode: input.liveAds ? 'publish-and-live-ads' : 'publish-only',
    assets: { expected: assets.length, qualityReady: qualityReadyCount },
    jobs: {
      expected: expectedJobs.length,
      succeeded,
      missing,
      nonTerminal,
      deadOrFailed,
      byState,
    },
    publications: { expected: assets.length, verified: verifiedPublications },
    ads: { expected: expectedAds, verified: verifiedAds },
    issues,
  }
}

function chunks<T>(values: readonly T[], size = 500): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

/** Load the canonical rows required by the pure completion evaluator. */
export async function verifyPipelineCompletion(
  db: Db,
  options: { liveAds?: boolean; generatedAt?: Date } = {},
): Promise<PipelineCompletionManifest> {
  const firmRows = (await db.select().from(firms))
    .filter((row) => (row.status === 'pilot' || row.status === 'active') && row.landingReady)
  const firmIds = firmRows.map((row) => row.id)
  if (!firmIds.length) {
    return calculatePipelineCompletion({
      assets: [], jobs: [], publications: [], checks: [], policies: [], adExecutions: [],
      liveAds: options.liveAds, generatedAt: options.generatedAt,
    })
  }

  const [assetRows, policyRows] = await Promise.all([
    db.select().from(contentAssets).where(and(
      inArray(contentAssets.firmId, firmIds),
      inArray(contentAssets.status, [...AUTOMATED_ASSET_STATES]),
    )),
    db.select().from(firmPolicies).where(inArray(firmPolicies.firmId, firmIds)),
  ])
  const assets = currentAssets(assetRows)
  const assetIds = assets.map((row) => row.id)
  const publicationRows: PublicationRow[] = []
  const executionRows: AdExecutionRow[] = []
  for (const ids of chunks(assetIds)) {
    publicationRows.push(...await db.select().from(publications)
      .where(inArray(publications.contentAssetId, ids)))
    if (options.liveAds) {
      executionRows.push(...await db.select().from(adExecutions)
        .where(inArray(adExecutions.contentAssetId, ids)))
    }
  }

  const expectedJobKeys = assets.flatMap((asset) => {
    const publication = latestPublication(publicationRows, asset)
    return [
      expectedPrepareJob(asset),
      ...(publication ? [`publication.verify-http:${publication.id}:v${asset.contentVersion}`] : []),
    ]
  })
  const jobRows: OperationJobRow[] = []
  for (const keys of chunks(expectedJobKeys)) {
    jobRows.push(...await db.select().from(operationJobs)
      .where(inArray(operationJobs.idempotencyKey, keys)))
  }
  const checkRows: PublicationCheckRow[] = []
  for (const ids of chunks(publicationRows.map((row) => row.id))) {
    checkRows.push(...await db.select().from(publicationChecks)
      .where(inArray(publicationChecks.publicationId, ids)))
  }

  return calculatePipelineCompletion({
    assets,
    policies: policyRows,
    jobs: jobRows,
    publications: publicationRows,
    checks: checkRows,
    adExecutions: executionRows,
    liveAds: options.liveAds,
    generatedAt: options.generatedAt,
  })
}
