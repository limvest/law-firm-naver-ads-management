import { and, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  contentAssets,
  firmPolicies,
  firms,
  operationAlerts,
  operationJobs,
  publications,
} from '@/lib/db/schema'
import {
  noopPublicationCacheInvalidator,
  planPublications,
  recordPublicationVerification,
  type PublicationCacheInvalidator,
} from '@/domains/publishing'
import { planAdExecutions } from '@/domains/advertising'
import {
  claimJobs,
  deadLetterJob,
  enqueueJob,
  failJob,
  succeedJob,
  type FirmScope,
  type OperationJobRow,
} from './postgres-queue'

export type JobHandlerContext = {
  db: Db
  job: OperationJobRow
  workerId: string
  now: Date
}

export type JobHandlerResult = Record<string, unknown> | void
export type JobHandler = (context: JobHandlerContext) => Promise<JobHandlerResult>
export type JobHandlerMap = Readonly<Record<string, JobHandler>>

export type WorkerBatchResult = {
  claimed: number
  succeeded: number
  retryable: number
  dead: number
  jobs: Array<{ id: string; jobType: string; state: string; detail?: JobHandlerResult }>
}

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentJobError'
  }
}

function payloadString(job: OperationJobRow, key: string): string {
  const value = job.payload[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new PermanentJobError(`${job.jobType} payload.${key} is required`)
  }
  return value.trim()
}

function requireFirm(job: OperationJobRow): number {
  if (job.firmId === null) throw new PermanentJobError(`${job.jobType} requires a firm scope`)
  return job.firmId
}

async function openAlert(
  db: Db,
  input: {
    job: OperationJobRow
    alertType: string
    severity: 'warning' | 'critical'
    message: string
    detail?: Record<string, unknown>
    now: Date
  },
): Promise<void> {
  const [existing] = await db.select({ id: operationAlerts.id }).from(operationAlerts).where(and(
    eq(operationAlerts.jobId, input.job.id),
    eq(operationAlerts.alertType, input.alertType),
    eq(operationAlerts.status, 'open'),
  )).limit(1)
  if (existing) return
  await db.insert(operationAlerts).values({
    firmId: input.job.firmId,
    jobId: input.job.id,
    alertType: input.alertType,
    severity: input.severity,
    message: input.message,
    detail: input.detail,
    openedAt: input.now,
  })
}

function placeholderFree(html: string): boolean {
  return !/(\{\{[^}]+\}\}|\{(?:성명|경찰청|연도|발주자)[^}]*\}|—\s*건|게시\s*전\s*확정|href=["']#["'])/i.test(html)
}

function canonicalPresent(html: string, expected: string): boolean {
  const canonicalTag = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i)?.[0]
    ?? html.match(/<link\b[^>]*\bhref=["'][^"']+["'][^>]*\brel=["']canonical["'][^>]*>/i)?.[0]
  return Boolean(canonicalTag?.includes(expected))
}

export function createDefaultJobHandlers(options: {
  fetchImpl?: typeof fetch
  invalidateCache?: PublicationCacheInvalidator
} = {}): JobHandlerMap {
  const fetchImpl = options.fetchImpl ?? fetch
  const invalidateCache = options.invalidateCache ?? noopPublicationCacheInvalidator
  const preparePublication: JobHandler = async ({ db, job, now }) => {
    const firmId = requireFirm(job)
    const contentAssetId = payloadString(job, 'contentAssetId')
    const expectedAssetType = job.jobType === 'content.prepare-seo-publication' ? 'seo_page' : 'ad_landing'
    const [asset] = await db.select().from(contentAssets).where(and(
      eq(contentAssets.id, contentAssetId),
      eq(contentAssets.firmId, firmId),
      eq(contentAssets.assetType, expectedAssetType),
    )).limit(1)
    if (!asset) throw new PermanentJobError('content asset not found in job firm/type scope')
    if (asset.status !== 'approved' && asset.status !== 'published') {
      throw new PermanentJobError(`content asset is not approved: ${asset.status}`)
    }
    await planPublications(db, { firmIds: [firmId], invalidateCache })
    const [publication] = await db.select().from(publications).where(and(
      eq(publications.firmId, firmId),
      eq(publications.contentAssetId, contentAssetId),
    )).limit(1)
    if (!publication) throw new Error('publication plan did not produce a deployable URL')
    await enqueueJob(db, {
      jobType: 'publication.verify-http',
      firmId,
      caseEntityId: asset.caseEntityId,
      idempotencyKey: `publication.verify-http:${publication.id}:v${asset.contentVersion}`,
      payload: {
        publicationId: publication.id,
        contentAssetId: asset.id,
        expectedVersion: String(asset.contentVersion),
      },
      priority: 60,
      maxAttempts: 5,
      now,
    })
    return { publicationId: publication.id, url: publication.url }
  }

  const verifyPublication: JobHandler = async ({ db, job, now }) => {
    const firmId = requireFirm(job)
    const publicationId = payloadString(job, 'publicationId')
    const [[publication], [firm]] = await Promise.all([
      db.select().from(publications).where(and(
        eq(publications.id, publicationId),
        eq(publications.firmId, firmId),
      )).limit(1),
      db.select().from(firms).where(eq(firms.id, firmId)).limit(1),
    ])
    if (!publication || !firm) throw new PermanentJobError('publication or firm not found in job scope')
    let response: Response
    try {
      response = await fetchImpl(publication.url, {
        redirect: 'follow',
        headers: { 'user-agent': 'lawfirm-ads-publication-check/1.0' },
      })
    } catch (error) {
      throw new Error(`publication fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`publication returned HTTP ${response.status}`)
    }
    const html = await response.text()
    const verification = {
      statusCode: response.status,
      canonicalOk: canonicalPresent(html, publication.canonicalUrl),
      ctaOk: /(?:href=["']tel:|\/api\/leads|data-lead)/i.test(html),
      brandOk: html.includes(firm.name),
      placeholderFree: placeholderFree(html),
      verifiedVersion: String(job.payload.expectedVersion ?? publication.deployedVersion ?? ''),
    }
    const result = await recordPublicationVerification(db, {
      publicationId: publication.id,
      verification,
      checkedAt: now,
      invalidateCache,
    })
    let advertisingPlan: { created: number; updated: number; unchanged: number; skipped: number } | null = null
    if (result.publication.status === 'live') {
      const [asset] = await db.select().from(contentAssets).where(and(
        eq(contentAssets.id, publication.contentAssetId),
        eq(contentAssets.firmId, firmId),
      )).limit(1)
      if (asset?.assetType === 'ad_landing') {
        const [policy] = await db.select().from(firmPolicies)
          .where(eq(firmPolicies.firmId, firmId)).limit(1)
        const plan = await planAdExecutions(db, {
          firmId,
          publicationId: publication.id,
          contentAssetIds: [asset.id],
          desiredActive: Boolean(policy?.adAutoSubmit),
          asOf: now,
        })
        advertisingPlan = {
          created: plan.created,
          updated: plan.updated,
          unchanged: plan.unchanged,
          skipped: plan.skipped.length,
        }
      }
    }
    if (result.publication.status === 'blocked') {
      await openAlert(db, {
        job,
        alertType: 'publication.blocked',
        severity: 'critical',
        message: `Publication blocked by verification: ${result.reasonCodes.join(', ')}`,
        detail: { publicationId, url: publication.url, reasonCodes: result.reasonCodes },
        now,
      })
    }
    return {
      publicationId,
      status: result.publication.status,
      reasonCodes: result.reasonCodes,
      advertisingPlan,
    }
  }

  return Object.freeze({
    'content.prepare-seo-publication': preparePublication,
    'content.prepare-ad-publication': preparePublication,
    'publication.verify-http': verifyPublication,
  })
}

export async function runWorkerBatch(
  db: Db,
  options: {
    workerId: string
    handlers?: JobHandlerMap
    limit?: number
    firmId?: FirmScope
    jobTypes?: readonly string[]
    now?: Date
    leaseDurationMs?: number
    invalidateCache?: PublicationCacheInvalidator
  },
): Promise<WorkerBatchResult> {
  const now = options.now ?? new Date()
  const handlers = options.handlers ?? createDefaultJobHandlers({ invalidateCache: options.invalidateCache })
  const claimed = await claimJobs(db, {
    workerId: options.workerId,
    firmId: options.firmId,
    jobTypes: options.jobTypes,
    now,
    limit: options.limit ?? 25,
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
  })
  const result: WorkerBatchResult = { claimed: claimed.length, succeeded: 0, retryable: 0, dead: 0, jobs: [] }
  for (const job of claimed) {
    const handler = handlers[job.jobType]
    try {
      if (!handler) throw new PermanentJobError(`no handler registered for ${job.jobType}`)
      const detail = await handler({ db, job, workerId: options.workerId, now })
      const succeeded = await succeedJob(db, {
        id: job.id,
        workerId: options.workerId,
        firmId: job.firmId,
        now,
      })
      if (!succeeded) throw new Error('job lease expired before success could be recorded')
      result.succeeded += 1
      result.jobs.push({ id: job.id, jobType: job.jobType, state: 'succeeded', detail })
    } catch (error) {
      const permanent = error instanceof PermanentJobError
      const failed = await failJob(db, {
        id: job.id,
        workerId: options.workerId,
        firmId: job.firmId,
        now,
        retryable: !permanent,
        error: error instanceof Error ? error : String(error),
      })
      if (!failed) {
        result.retryable += 1
        result.jobs.push({ id: job.id, jobType: job.jobType, state: 'lease_lost' })
        continue
      }
      if (failed.state === 'retryable') {
        result.retryable += 1
        result.jobs.push({ id: job.id, jobType: job.jobType, state: 'retryable' })
        continue
      }
      const dead = await deadLetterJob(db, {
        id: job.id,
        firmId: job.firmId,
        reason: failed.lastError ?? 'worker failed permanently',
        now,
      })
      const terminal = dead ?? failed
      await openAlert(db, {
        job: terminal,
        alertType: 'job.dead_letter',
        severity: 'critical',
        message: terminal.lastError ?? `Job ${job.jobType} failed permanently`,
        detail: { jobType: job.jobType, attempts: terminal.attempts },
        now,
      })
      result.dead += 1
      result.jobs.push({ id: job.id, jobType: job.jobType, state: terminal.state })
    }
  }
  return result
}

export async function runWorkersUntilIdle(
  db: Db,
  options: Parameters<typeof runWorkerBatch>[1] & { maxJobs?: number },
): Promise<WorkerBatchResult> {
  const maxJobs = options.maxJobs ?? 1_000
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) throw new RangeError('maxJobs must be a positive integer')
  const total: WorkerBatchResult = { claimed: 0, succeeded: 0, retryable: 0, dead: 0, jobs: [] }
  while (total.claimed < maxJobs) {
    const remaining = maxJobs - total.claimed
    const batch = await runWorkerBatch(db, { ...options, limit: Math.min(options.limit ?? 25, remaining) })
    total.claimed += batch.claimed
    total.succeeded += batch.succeeded
    total.retryable += batch.retryable
    total.dead += batch.dead
    total.jobs.push(...batch.jobs)
    if (batch.claimed === 0) break
  }
  return total
}
