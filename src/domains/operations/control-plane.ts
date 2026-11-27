import { and, eq, inArray, isNull, type AnyColumn, type SQL } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  approvalTasks,
  caseApprovals,
  caseEntities,
  dailyReports,
  firms,
  intelligenceSources,
  operationAlerts,
  operationJobAttempts,
  operationJobs,
  publicationChecks,
  publications,
  sourceRuns,
} from '@/lib/db/schema'

/**
 * `undefined` reads the complete control-plane view. `null` is useful for
 * callers that need only global rows; a number reads exactly one firm.
 *
 * The target schema intentionally keeps intelligence sources and case
 * entities global. Tenant-owned queues are filtered at the database query
 * boundary below rather than filtered after a cross-tenant result is built.
 */
export type OperationsFirmScope = number | null | undefined

export interface OperationsControlPlaneQueryOptions {
  readonly firmId?: OperationsFirmScope
  /** Maximum rows returned in each operator queue. Counts are unbounded. */
  readonly queueLimit?: number
  /** Maximum recent reports returned. The report count is unbounded. */
  readonly reportLimit?: number
  /** Clock used only when an alert contains an explicit SLA deadline. */
  readonly asOf?: Date
}

export type SourceHealthState =
  | 'disabled'
  | 'never_run'
  | 'running'
  | 'succeeded'
  | 'warning'
  | 'failed'
  | 'unknown'

export type SourceRunSummary = Pick<
  typeof sourceRuns.$inferSelect,
  'id' | 'runKey' | 'trigger' | 'attempted' | 'sourceKey' | 'sourceName' | 'sourceType' | 'sourceFamily'
  | 'sourceUrl' | 'collectorMethod' | 'status' | 'itemsSeen' | 'itemsAccepted' | 'latencyMs' | 'error'
  | 'startedAt' | 'finishedAt'
>

export type SourceHealthQueueItem = Pick<
  typeof intelligenceSources.$inferSelect,
  'id' | 'sourceKey' | 'name' | 'sourceType' | 'sourceFamily' | 'baseUrl' | 'enabled' | 'cadenceMinutes'
> & {
  readonly health: SourceHealthState
  readonly latestRun: SourceRunSummary | null
}

export type CaseApprovalSummary = Pick<
  typeof caseApprovals.$inferSelect,
  'id' | 'firmId' | 'decision' | 'actorType' | 'actorId' | 'policyVersion' | 'reason' | 'createdAt'
>

export type CaseReviewQueueItem = Pick<
  typeof caseEntities.$inferSelect,
  'id' | 'canonicalName' | 'slug' | 'category' | 'status' | 'confidence' | 'lastSeenAt' | 'updatedAt'
> & {
  readonly latestApproval: CaseApprovalSummary | null
}

export type ApprovalQueueItem = Pick<
  typeof approvalTasks.$inferSelect,
  'id' | 'firmId' | 'caseEntityId' | 'contentAssetId' | 'taskType' | 'status' | 'reason'
  | 'requiredActorType' | 'decidedBy' | 'decidedAt' | 'createdAt'
>

export type PublicationCheckSummary = Pick<
  typeof publicationChecks.$inferSelect,
  'id' | 'statusCode' | 'canonicalOk' | 'ctaOk' | 'brandOk' | 'placeholderFree' | 'checkedAt' | 'detail'
>

export type PublicationBacklogQueueItem = Pick<
  typeof publications.$inferSelect,
  'id' | 'firmId' | 'contentAssetId' | 'domain' | 'url' | 'canonicalUrl' | 'indexPolicy' | 'status'
  | 'deployedVersion' | 'lastError' | 'publishedAt' | 'lastVerifiedAt' | 'createdAt' | 'updatedAt'
> & {
  readonly latestCheck: PublicationCheckSummary | null
}

export type OperationJobAttemptSummary = Pick<
  typeof operationJobAttempts.$inferSelect,
  'id' | 'attempt' | 'workerId' | 'state' | 'error' | 'startedAt' | 'finishedAt'
>

export type OperationJobQueueItem = Pick<
  typeof operationJobs.$inferSelect,
  'id' | 'jobType' | 'state' | 'firmId' | 'caseEntityId' | 'idempotencyKey' | 'priority' | 'attempts'
  | 'maxAttempts' | 'availableAt' | 'leaseOwner' | 'leaseExpiresAt' | 'lastError' | 'createdAt'
  | 'updatedAt' | 'finishedAt' | 'payload'
> & {
  readonly attemptCount: number
  readonly latestAttempt: OperationJobAttemptSummary | null
}

export type AlertSlaState = 'tracked' | 'breached' | 'untracked'

export type OperationAlertQueueItem = Pick<
  typeof operationAlerts.$inferSelect,
  'id' | 'firmId' | 'jobId' | 'alertType' | 'severity' | 'status' | 'message' | 'detail' | 'openedAt' | 'resolvedAt'
> & {
  readonly slaDueAt: Date | null
  readonly slaState: AlertSlaState
}

export type FirmStatusQueueItem = Pick<
  typeof firms.$inferSelect,
  'id' | 'slug' | 'name' | 'status' | 'landingReady' | 'domain' | 'createdAt'
>

export type RecentDailyReport = typeof dailyReports.$inferSelect

export interface OperationsControlPlane {
  readonly scope: {
    readonly kind: 'all' | 'global' | 'firm'
    readonly firmId: number | null
  }
  readonly sourceHealth: {
    readonly total: number
    readonly enabled: number
    readonly disabled: number
    readonly healthy: number
    readonly neverRun: number
    readonly running: number
    readonly warning: number
    readonly failed: number
    readonly unknown: number
    readonly byState: Readonly<Record<SourceHealthState, number>>
    readonly queue: readonly SourceHealthQueueItem[]
  }
  readonly caseReview: {
    readonly count: number
    readonly byStatus: Readonly<Record<string, number>>
    readonly queue: readonly CaseReviewQueueItem[]
  }
  readonly approvals: {
    readonly count: number
    readonly byTaskType: Readonly<Record<string, number>>
    readonly queue: readonly ApprovalQueueItem[]
  }
  readonly publicationBacklog: {
    readonly count: number
    readonly pending: number
    readonly stale: number
    readonly failed: number
    readonly blocked: number
    readonly byStatus: Readonly<Record<string, number>>
    readonly queue: readonly PublicationBacklogQueueItem[]
  }
  readonly jobs: {
    readonly count: number
    readonly queued: number
    readonly running: number
    readonly retryable: number
    readonly failed: number
    readonly succeeded: number
    readonly dead: number
    readonly byState: Readonly<Record<string, number>>
    readonly retryQueue: readonly OperationJobQueueItem[]
    readonly failedQueue: readonly OperationJobQueueItem[]
    readonly deadQueue: readonly OperationJobQueueItem[]
  }
  readonly alerts: {
    /** Active alerts are open or acknowledged; resolved alerts are not queued. */
    readonly count: number
    readonly total: number
    readonly open: number
    readonly acknowledged: number
    readonly resolved: number
    readonly critical: number
    readonly warning: number
    readonly info: number
    readonly bySeverity: Readonly<Record<string, number>>
    readonly sla: {
      /** Only alerts with an explicit deadline in `detail` are tracked. */
      readonly tracked: number
      readonly untracked: number
      readonly breached: number
      readonly activeBreached: number
    }
    readonly queue: readonly OperationAlertQueueItem[]
  }
  readonly firms: {
    readonly count: number
    readonly byStatus: Readonly<Record<string, number>>
    readonly queue: readonly FirmStatusQueueItem[]
  }
  readonly reports: {
    readonly count: number
    readonly recent: readonly RecentDailyReport[]
  }
}

type FirmScope = OperationsFirmScope
type SourceRow = typeof intelligenceSources.$inferSelect
type SourceRunRow = typeof sourceRuns.$inferSelect
type CaseEntityRow = typeof caseEntities.$inferSelect
type CaseApprovalRow = typeof caseApprovals.$inferSelect
type ApprovalTaskRow = typeof approvalTasks.$inferSelect
type PublicationRow = typeof publications.$inferSelect
type PublicationCheckRow = typeof publicationChecks.$inferSelect
type OperationJobRow = typeof operationJobs.$inferSelect
type OperationJobAttemptRow = typeof operationJobAttempts.$inferSelect
type OperationAlertRow = typeof operationAlerts.$inferSelect
type FirmRow = typeof firms.$inferSelect

const PUBLICATION_BACKLOG_STATES = new Set(['pending', 'stale', 'failed', 'blocked'])
const CASE_REVIEW_STATES = new Set(['observed', 'corroborated'])
const ACTIVE_ALERT_STATES = new Set(['open', 'acknowledged'])
const SOURCE_STATES: readonly SourceHealthState[] = [
  'disabled',
  'never_run',
  'running',
  'succeeded',
  'warning',
  'failed',
  'unknown',
]

function assertFirmScope(firmId: FirmScope): void {
  if (firmId === undefined || firmId === null) return
  if (!Number.isSafeInteger(firmId) || firmId < 0) {
    throw new TypeError('firmId must be a non-negative safe integer')
  }
}

function assertLimit(value: number | undefined, label: string, fallback: number): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return limit
}

function validAsOf(value: Date | undefined): Date {
  const asOf = value ?? new Date()
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError('asOf must be a valid Date')
  }
  return new Date(asOf.getTime())
}

function firmFilter(column: AnyColumn, firmId: FirmScope): SQL | undefined {
  if (firmId === undefined) return undefined
  return firmId === null ? isNull(column) : eq(column, firmId)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function milliseconds(value: Date | null | undefined): number | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  return value.getTime()
}

function compareDatesAscending(left: Date | null | undefined, right: Date | null | undefined): number {
  const leftValue = milliseconds(left)
  const rightValue = milliseconds(right)
  if (leftValue === null && rightValue === null) return 0
  if (leftValue === null) return 1
  if (rightValue === null) return -1
  return leftValue - rightValue
}

function compareDatesDescending(left: Date | null | undefined, right: Date | null | undefined): number {
  return compareDatesAscending(right, left)
}

function countBy<T>(rows: readonly T[], value: (row: T) => string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of rows) {
    const key = value(row)
    result[key] = (result[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareStrings(left, right)))
}

function sourceHealth(source: SourceRow, latestRun: SourceRunRow | undefined): SourceHealthState {
  if (!source.enabled) return 'disabled'
  if (!latestRun) return 'never_run'
  if (latestRun.status === 'skipped') return 'succeeded'
  if (
    latestRun.status === 'running'
    || latestRun.status === 'succeeded'
    || latestRun.status === 'warning'
    || latestRun.status === 'failed'
  ) {
    return latestRun.status
  }
  return 'unknown'
}

function sourceRunSummary(row: SourceRunRow): SourceRunSummary {
  return {
    id: row.id,
    runKey: row.runKey,
    trigger: row.trigger,
    attempted: row.attempted,
    sourceKey: row.sourceKey,
    sourceName: row.sourceName,
    sourceType: row.sourceType,
    sourceFamily: row.sourceFamily,
    sourceUrl: row.sourceUrl,
    collectorMethod: row.collectorMethod,
    status: row.status,
    itemsSeen: row.itemsSeen,
    itemsAccepted: row.itemsAccepted,
    latencyMs: row.latencyMs,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

function caseApprovalSummary(row: CaseApprovalRow): CaseApprovalSummary {
  return {
    id: row.id,
    firmId: row.firmId,
    decision: row.decision,
    actorType: row.actorType,
    actorId: row.actorId,
    policyVersion: row.policyVersion,
    reason: row.reason,
    createdAt: row.createdAt,
  }
}

function approvalQueueItem(row: ApprovalTaskRow): ApprovalQueueItem {
  return {
    id: row.id,
    firmId: row.firmId,
    caseEntityId: row.caseEntityId,
    contentAssetId: row.contentAssetId,
    taskType: row.taskType,
    status: row.status,
    reason: row.reason,
    requiredActorType: row.requiredActorType,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  }
}

function publicationCheckSummary(row: PublicationCheckRow): PublicationCheckSummary {
  return {
    id: row.id,
    statusCode: row.statusCode,
    canonicalOk: row.canonicalOk,
    ctaOk: row.ctaOk,
    brandOk: row.brandOk,
    placeholderFree: row.placeholderFree,
    checkedAt: row.checkedAt,
    detail: row.detail,
  }
}

function publicationQueueItem(row: PublicationRow, latestCheck: PublicationCheckRow | undefined): PublicationBacklogQueueItem {
  return {
    id: row.id,
    firmId: row.firmId,
    contentAssetId: row.contentAssetId,
    domain: row.domain,
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    indexPolicy: row.indexPolicy,
    status: row.status,
    deployedVersion: row.deployedVersion,
    lastError: row.lastError,
    publishedAt: row.publishedAt,
    lastVerifiedAt: row.lastVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestCheck: latestCheck ? publicationCheckSummary(latestCheck) : null,
  }
}

function attemptSummary(row: OperationJobAttemptRow): OperationJobAttemptSummary {
  return {
    id: row.id,
    attempt: row.attempt,
    workerId: row.workerId,
    state: row.state,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

function jobQueueItem(
  row: OperationJobRow,
  attemptRows: readonly OperationJobAttemptRow[],
): OperationJobQueueItem {
  const latestAttempt = [...attemptRows].sort((left, right) => (
    right.attempt - left.attempt
    || compareDatesDescending(left.startedAt, right.startedAt)
    || compareStrings(left.id, right.id)
  ))[0]
  return {
    id: row.id,
    jobType: row.jobType,
    state: row.state,
    firmId: row.firmId,
    caseEntityId: row.caseEntityId,
    idempotencyKey: row.idempotencyKey,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    payload: row.payload,
    attemptCount: attemptRows.length,
    latestAttempt: latestAttempt ? attemptSummary(latestAttempt) : null,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function dateFromUnknown(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime())
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function explicitSlaDueAt(row: OperationAlertRow): Date | null {
  const detail = asRecord(row.detail)
  if (!detail) return null

  const keys = ['slaDueAt', 'sla_due_at', 'dueAt', 'due_at', 'deadlineAt', 'deadline_at']
  const nested = [detail, asRecord(detail.sla), asRecord(detail.slaWindow)].filter(
    (value): value is Record<string, unknown> => value !== null,
  )
  for (const record of nested) {
    for (const key of keys) {
      const dueAt = dateFromUnknown(record[key])
      if (dueAt) return dueAt
    }
  }

  // A duration is only meaningful when the producer explicitly persisted it.
  const minutesValue = detail.slaMinutes ?? detail.sla_minutes
  const minutes = typeof minutesValue === 'number'
    ? minutesValue
    : typeof minutesValue === 'string' && minutesValue.trim() ? Number(minutesValue) : NaN
  if (Number.isFinite(minutes) && minutes >= 0) {
    return new Date(row.openedAt.getTime() + minutes * 60_000)
  }
  return null
}

function alertSlaState(dueAt: Date | null, asOf: Date): AlertSlaState {
  if (!dueAt) return 'untracked'
  return dueAt.getTime() <= asOf.getTime() ? 'breached' : 'tracked'
}

function alertQueueItem(row: OperationAlertRow, asOf: Date): OperationAlertQueueItem {
  const slaDueAt = explicitSlaDueAt(row)
  return {
    id: row.id,
    firmId: row.firmId,
    jobId: row.jobId,
    alertType: row.alertType,
    severity: row.severity,
    status: row.status,
    message: row.message,
    detail: row.detail,
    openedAt: row.openedAt,
    resolvedAt: row.resolvedAt,
    slaDueAt,
    slaState: alertSlaState(slaDueAt, asOf),
  }
}

function firmStatusQueueItem(row: FirmRow): FirmStatusQueueItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    landingReady: row.landingReady,
    domain: row.domain,
    createdAt: row.createdAt,
  }
}

function scopeDescriptor(firmId: FirmScope): OperationsControlPlane['scope'] {
  if (firmId === undefined) return { kind: 'all', firmId: null }
  if (firmId === null) return { kind: 'global', firmId: null }
  return { kind: 'firm', firmId }
}

/**
 * Read the durable operations model for an operator surface.
 *
 * This function is intentionally read-only. It returns counts from persisted
 * rows and queue entries from those same rows; it does not estimate cadence,
 * infer publication success, or turn missing data into a positive metric.
 */
export async function queryOperationsControlPlane(
  db: Db,
  options: OperationsControlPlaneQueryOptions = {},
): Promise<OperationsControlPlane> {
  const firmId = options.firmId
  assertFirmScope(firmId)
  const queueLimit = assertLimit(options.queueLimit, 'queueLimit', 100)
  const reportLimit = assertLimit(options.reportLimit, 'reportLimit', 20)
  const asOf = validAsOf(options.asOf)

  // Intelligence sources/runs are global by schema design. Latest means the
  // greatest startedAt, with id as a deterministic tie breaker.
  const sourceRows = await db.select().from(intelligenceSources)
  const sourceRunRows = await db.select().from(sourceRuns)
  const latestRunBySource = new Map<string, SourceRunRow>()
  for (const run of sourceRunRows) {
    const current = latestRunBySource.get(run.sourceId)
    if (
      !current
      || compareDatesDescending(run.startedAt, current.startedAt) < 0
      || (compareDatesDescending(run.startedAt, current.startedAt) === 0 && compareStrings(run.id, current.id) < 0)
    ) {
      latestRunBySource.set(run.sourceId, run)
    }
  }
  const sourceItems = sourceRows.map((source) => ({
    source,
    health: sourceHealth(source, latestRunBySource.get(source.id)),
    latestRun: latestRunBySource.get(source.id),
  })).sort((left, right) => (
    compareStrings(left.source.sourceKey, right.source.sourceKey)
    || compareStrings(left.source.id, right.source.id)
  ))
  const sourceByState = Object.fromEntries(SOURCE_STATES.map((state) => [
    state,
    sourceItems.filter((item) => item.health === state).length,
  ])) as Record<SourceHealthState, number>
  const sourceHealthQueue = sourceItems.map(({ source, health, latestRun }) => ({
    id: source.id,
    sourceKey: source.sourceKey,
    name: source.name,
    sourceType: source.sourceType,
    sourceFamily: source.sourceFamily,
    baseUrl: source.baseUrl,
    enabled: source.enabled,
    cadenceMinutes: source.cadenceMinutes,
    health,
    latestRun: latestRun ? sourceRunSummary(latestRun) : null,
  })).slice(0, queueLimit)

  // A case entity has no firm_id. In a firm view, only entities with an
  // approval record in that firm are visible, preventing another firm's case
  // approval history from entering the tenant queue.
  const scopedCaseApprovals = firmId === undefined
    ? await db.select().from(caseApprovals)
    : await db.select().from(caseApprovals).where(firmFilter(caseApprovals.firmId, firmId))
  const caseRows: CaseEntityRow[] = firmId === undefined
    ? await db.select().from(caseEntities)
    : await (() => {
        const caseIds = [...new Set(scopedCaseApprovals.map((approval) => approval.caseEntityId))]
        return caseIds.length
          ? db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds))
          : Promise.resolve([] as CaseEntityRow[])
      })()
  const latestApprovalByCase = new Map<string, CaseApprovalRow>()
  for (const approval of scopedCaseApprovals) {
    const current = latestApprovalByCase.get(approval.caseEntityId)
    if (
      !current
      || compareDatesDescending(approval.createdAt, current.createdAt) < 0
      || (compareDatesDescending(approval.createdAt, current.createdAt) === 0 && compareStrings(approval.id, current.id) < 0)
    ) {
      latestApprovalByCase.set(approval.caseEntityId, approval)
    }
  }
  const caseReviewRows = caseRows
    .filter((row) => CASE_REVIEW_STATES.has(row.status))
    .sort((left, right) => (
      (left.status === right.status ? 0 : left.status === 'observed' ? -1 : 1)
      || compareDatesDescending(left.lastSeenAt, right.lastSeenAt)
      || compareStrings(left.id, right.id)
    ))
  const caseReviewQueue = caseReviewRows.map((row) => ({
    id: row.id,
    canonicalName: row.canonicalName,
    slug: row.slug,
    category: row.category,
    status: row.status,
    confidence: row.confidence,
    lastSeenAt: row.lastSeenAt,
    updatedAt: row.updatedAt,
    latestApproval: latestApprovalByCase.has(row.id)
      ? caseApprovalSummary(latestApprovalByCase.get(row.id)!)
      : null,
  })).slice(0, queueLimit)

  const pendingApprovalRows = firmId === undefined
    ? await db.select().from(approvalTasks).where(eq(approvalTasks.status, 'pending'))
    : await db.select().from(approvalTasks).where(and(
        eq(approvalTasks.status, 'pending'),
        firmFilter(approvalTasks.firmId, firmId),
      ))
  const approvalQueue = [...pendingApprovalRows]
    .sort((left, right) => (
      compareDatesAscending(left.createdAt, right.createdAt)
      || compareStrings(left.taskType, right.taskType)
      || compareStrings(left.id, right.id)
    ))
    .map(approvalQueueItem)
    .slice(0, queueLimit)

  const publicationRows = firmId === undefined
    ? await db.select().from(publications)
    : await db.select().from(publications).where(firmFilter(publications.firmId, firmId))
  const publicationByStatus = countBy(publicationRows, (row) => row.status)
  const publicationBacklogRows = publicationRows.filter((row) => PUBLICATION_BACKLOG_STATES.has(row.status))
  const publicationIds = publicationBacklogRows.map((row) => row.id)
  const publicationCheckRows = publicationIds.length
    ? await db.select().from(publicationChecks).where(inArray(publicationChecks.publicationId, publicationIds))
    : []
  const latestCheckByPublication = new Map<string, PublicationCheckRow>()
  for (const check of publicationCheckRows) {
    const current = latestCheckByPublication.get(check.publicationId)
    if (
      !current
      || compareDatesDescending(check.checkedAt, current.checkedAt) < 0
      || (compareDatesDescending(check.checkedAt, current.checkedAt) === 0 && compareStrings(check.id, current.id) < 0)
    ) {
      latestCheckByPublication.set(check.publicationId, check)
    }
  }
  const publicationStatusRank: Record<string, number> = { failed: 0, blocked: 1, stale: 2, pending: 3 }
  const publicationQueue = [...publicationBacklogRows]
    .sort((left, right) => (
      (publicationStatusRank[left.status] ?? 99) - (publicationStatusRank[right.status] ?? 99)
      || compareDatesAscending(left.updatedAt, right.updatedAt)
      || compareStrings(left.id, right.id)
    ))
    .map((row) => publicationQueueItem(row, latestCheckByPublication.get(row.id)))
    .slice(0, queueLimit)

  const jobRows = firmId === undefined
    ? await db.select().from(operationJobs)
    : await db.select().from(operationJobs).where(firmFilter(operationJobs.firmId, firmId))
  const jobByState = countBy(jobRows, (row) => row.state)
  const jobIds = jobRows.map((row) => row.id)
  const attemptRows = jobIds.length
    ? await db.select().from(operationJobAttempts).where(inArray(operationJobAttempts.jobId, jobIds))
    : []
  const attemptsByJob = new Map<string, OperationJobAttemptRow[]>()
  for (const attempt of attemptRows) {
    const rows = attemptsByJob.get(attempt.jobId) ?? []
    rows.push(attempt)
    attemptsByJob.set(attempt.jobId, rows)
  }
  const retryableRows = jobRows.filter((row) => row.state === 'retryable')
  const failedRows = jobRows.filter((row) => row.state === 'failed')
  const deadRows = jobRows.filter((row) => row.state === 'dead')
  const jobSort = (left: OperationJobRow, right: OperationJobRow): number => (
    compareDatesAscending(left.availableAt, right.availableAt)
    || left.priority - right.priority
    || compareDatesAscending(left.updatedAt, right.updatedAt)
    || compareStrings(left.id, right.id)
  )
  const deadJobSort = (left: OperationJobRow, right: OperationJobRow): number => (
    compareDatesAscending(left.updatedAt, right.updatedAt)
    || compareStrings(left.id, right.id)
  )
  const queuedJobs = (rows: readonly OperationJobRow[], comparator: (left: OperationJobRow, right: OperationJobRow) => number) => (
    [...rows].sort(comparator).map((row) => jobQueueItem(row, attemptsByJob.get(row.id) ?? [])).slice(0, queueLimit)
  )

  const alertRows = firmId === undefined
    ? await db.select().from(operationAlerts)
    : await db.select().from(operationAlerts).where(firmFilter(operationAlerts.firmId, firmId))
  const activeAlertRows = alertRows.filter((row) => ACTIVE_ALERT_STATES.has(row.status))
  const activeBySeverity = countBy(activeAlertRows, (row) => row.severity)
  let trackedSla = 0
  let untrackedSla = 0
  let breachedSla = 0
  let activeBreachedSla = 0
  for (const alert of alertRows) {
    const dueAt = explicitSlaDueAt(alert)
    if (!dueAt) {
      untrackedSla += 1
      continue
    }
    trackedSla += 1
    const resolvedAt = alert.resolvedAt
    const breached = alert.status !== 'resolved'
      ? dueAt.getTime() <= asOf.getTime()
      : Boolean(resolvedAt && resolvedAt.getTime() > dueAt.getTime())
    if (breached) breachedSla += 1
    if (ACTIVE_ALERT_STATES.has(alert.status) && dueAt.getTime() <= asOf.getTime()) activeBreachedSla += 1
  }
  const alertQueue = [...activeAlertRows]
    .sort((left, right) => {
      const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 }
      const leftDueAt = explicitSlaDueAt(left)
      const rightDueAt = explicitSlaDueAt(right)
      return (severityRank[left.severity] ?? 99) - (severityRank[right.severity] ?? 99)
        || compareDatesAscending(leftDueAt, rightDueAt)
        || compareDatesAscending(left.openedAt, right.openedAt)
        || compareStrings(left.id, right.id)
    })
    .map((row) => alertQueueItem(row, asOf))
    .slice(0, queueLimit)

  const firmRows = firmId === null
    ? []
    : firmId === undefined
      ? await db.select().from(firms)
      : await db.select().from(firms).where(eq(firms.id, firmId))
  const firmQueue = [...firmRows]
    .sort((left, right) => left.id - right.id)
    .map(firmStatusQueueItem)
    .slice(0, queueLimit)

  const reportRows = firmId === undefined
    ? await db.select().from(dailyReports)
    : await db.select().from(dailyReports).where(firmFilter(dailyReports.firmId, firmId))
  const recentReports = [...reportRows]
    .sort((left, right) => (
      compareDatesDescending(left.generatedAt, right.generatedAt)
      || compareStrings(right.day, left.day)
      || compareStrings(left.id, right.id)
    ))
    .slice(0, reportLimit)

  return {
    scope: scopeDescriptor(firmId),
    sourceHealth: {
      total: sourceRows.length,
      enabled: sourceRows.filter((source) => source.enabled).length,
      disabled: sourceByState.disabled,
      healthy: sourceByState.succeeded,
      neverRun: sourceByState.never_run,
      running: sourceByState.running,
      warning: sourceByState.warning,
      failed: sourceByState.failed,
      unknown: sourceByState.unknown,
      byState: sourceByState,
      queue: sourceHealthQueue,
    },
    caseReview: {
      count: caseReviewRows.length,
      byStatus: countBy(caseReviewRows, (row) => row.status),
      queue: caseReviewQueue,
    },
    approvals: {
      count: pendingApprovalRows.length,
      byTaskType: countBy(pendingApprovalRows, (row) => row.taskType),
      queue: approvalQueue,
    },
    publicationBacklog: {
      count: publicationBacklogRows.length,
      pending: publicationByStatus.pending ?? 0,
      stale: publicationByStatus.stale ?? 0,
      failed: publicationByStatus.failed ?? 0,
      blocked: publicationByStatus.blocked ?? 0,
      byStatus: publicationByStatus,
      queue: publicationQueue,
    },
    jobs: {
      count: retryableRows.length + failedRows.length + deadRows.length,
      queued: jobByState.queued ?? 0,
      running: jobByState.running ?? 0,
      retryable: jobByState.retryable ?? 0,
      failed: jobByState.failed ?? 0,
      succeeded: jobByState.succeeded ?? 0,
      dead: jobByState.dead ?? 0,
      byState: jobByState,
      retryQueue: queuedJobs(retryableRows, jobSort),
      failedQueue: queuedJobs(failedRows, jobSort),
      deadQueue: queuedJobs(deadRows, deadJobSort),
    },
    alerts: {
      count: activeAlertRows.length,
      total: alertRows.length,
      open: alertRows.filter((row) => row.status === 'open').length,
      acknowledged: alertRows.filter((row) => row.status === 'acknowledged').length,
      resolved: alertRows.filter((row) => row.status === 'resolved').length,
      critical: activeBySeverity.critical ?? 0,
      warning: activeBySeverity.warning ?? 0,
      info: activeBySeverity.info ?? 0,
      bySeverity: activeBySeverity,
      sla: {
        tracked: trackedSla,
        untracked: untrackedSla,
        breached: breachedSla,
        activeBreached: activeBreachedSla,
      },
      queue: alertQueue,
    },
    firms: {
      count: firmRows.length,
      byStatus: countBy(firmRows, (row) => row.status),
      queue: firmQueue,
    },
    reports: {
      count: reportRows.length,
      recent: recentReports,
    },
  }
}

export const getOperationsControlPlane = queryOperationsControlPlane
export const getOperationsControlPlaneSnapshot = queryOperationsControlPlane
