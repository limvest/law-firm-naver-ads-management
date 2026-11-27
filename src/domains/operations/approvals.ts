import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  approvalTasks,
  caseApprovals,
  caseEntities,
  caseEvidenceSnapshots,
  contentAssets,
  firmPolicies,
  outboxEvents,
  type EvidenceSnapshotFacts,
} from '@/lib/db/schema'
import { isValidContentQualityReport } from '@/domains/content/quality'
import { appendOutboxEvent } from './outbox'
import { createEventEnvelope, type EventJsonValue } from './event-envelope'

/** The persisted task names used by the operations queue. */
export const APPROVAL_TASK_TYPES = Object.freeze({
  caseReview: 'case_review',
  contentReview: 'content_review',
  brandReview: 'brand_review',
} as const)

export const APPROVAL_ACTOR_TYPES = Object.freeze({
  operator: 'operator',
  lawyer: 'lawyer',
} as const)

export type ApprovalTaskType = (typeof APPROVAL_TASK_TYPES)[keyof typeof APPROVAL_TASK_TYPES]
export type ApprovalDecision = 'approve' | 'reject' | 'block'
export type CaseApprovalDecision = 'approved' | 'rejected' | 'blocked'

export type ApprovalTaskRow = typeof approvalTasks.$inferSelect
export type CaseApprovalRow = typeof caseApprovals.$inferSelect
export type OutboxEventRow = typeof outboxEvents.$inferSelect
export type CaseEntityRow = typeof caseEntities.$inferSelect
export type ContentAssetRow = typeof contentAssets.$inferSelect

export type ApprovalTaskCreationOptions = {
  /** Limit firm-owned content tasks. Operator case tasks remain global. */
  readonly firmId?: number
  /** Limit the global case-review scan to these canonical case IDs. */
  readonly caseEntityIds?: readonly string[]
  /** Internal composition switch used by the case-only queue helper. */
  readonly includeFirmTasks?: boolean
  readonly now?: Date
}

export type ApprovalTaskCreationResult = {
  readonly caseReviewTasksCreated: number
  readonly caseReviewTasksExisting: number
  readonly firmApprovalTasksCreated: number
  readonly firmApprovalTasksExisting: number
  readonly created: readonly ApprovalTaskRow[]
  readonly existing: readonly ApprovalTaskRow[]
}

export type CaseDecisionInput = {
  readonly caseEntityId: string
  readonly decision: ApprovalDecision
  readonly actorType: string
  readonly actorId: string
  readonly reason: string
  readonly firmId?: number | null
  readonly policyVersion?: string
  readonly occurredAt?: Date
}

export type ApprovalTaskDecisionInput = {
  readonly taskId: string
  readonly decision: ApprovalDecision
  readonly actorType: string
  readonly actorId: string
  readonly reason: string
  /** Required for firm-owned tasks; must be omitted for the global operator task. */
  readonly firmId?: number | null
  readonly occurredAt?: Date
}

export type CaseDecisionResult = {
  readonly caseEntity: CaseEntityRow
  readonly approval: CaseApprovalRow
  readonly task: ApprovalTaskRow | null
  readonly outbox: OutboxEventRow
}

export type FirmApprovalTaskDecisionResult = {
  readonly task: ApprovalTaskRow
  readonly contentAsset: ContentAssetRow
  readonly outbox: OutboxEventRow
}

export type EvidenceGateCode = 'ok' | 'insufficient_evidence' | 'competitor_sitemap_title_only'

export type EvidenceGateResult = {
  readonly allowed: boolean
  readonly code: EvidenceGateCode
  readonly uniqueFactCount: number
  readonly independentSourceCount: number
  readonly reason: string
}

type TransactionalDb = Db
type FirmPolicyRow = typeof firmPolicies.$inferSelect
type EvidenceRow = typeof caseEvidenceSnapshots.$inferSelect

const DEFAULT_CASE_POLICY_VERSION = 'case-approval-v1'
const MISSING_FIRM_POLICY_VERSION = 'firm-policy-missing'
const CASE_REVIEW_TASK_REASON = 'corroborated case requires operator review before approval'
const REVIEW_ACTOR_TYPE = APPROVAL_ACTOR_TYPES.lawyer
const REVIEWABLE_ASSET_STATUSES = ['quality_review', 'brand_review'] as const

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`)
  return value.trim()
}

function requiredId(value: unknown, label: string): string {
  return requiredText(value, label)
}

function firmIdValue(value: unknown, label = 'firmId'): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return Number(value)
}

function validDate(value: Date | undefined, label: string): Date {
  const date = value ?? new Date()
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid date`)
  return new Date(date.getTime())
}

function normalizeDecision(value: ApprovalDecision): ApprovalDecision {
  if (value !== 'approve' && value !== 'reject' && value !== 'block') {
    throw new TypeError('decision must be approve, reject, or block')
  }
  return value
}

function validateActor(actorType: unknown, actorId: unknown, reason: unknown): {
  actorType: string
  actorId: string
  reason: string
} {
  return {
    actorType: requiredText(actorType, 'actorType'),
    actorId: requiredText(actorId, 'actorId'),
    reason: requiredText(reason, 'reason'),
  }
}

function caseDecisionValue(decision: ApprovalDecision): CaseApprovalDecision {
  if (decision === 'approve') return 'approved'
  if (decision === 'reject') return 'rejected'
  return 'blocked'
}

function approvalTaskStatus(decision: ApprovalDecision): 'approved' | 'rejected' {
  return decision === 'approve' ? 'approved' : 'rejected'
}

function taskTypeForAsset(asset: ContentAssetRow): ApprovalTaskType {
  return asset.assetType === 'ad_landing'
    ? APPROVAL_TASK_TYPES.brandReview
    : APPROVAL_TASK_TYPES.contentReview
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function taskIdForCase(caseEntityId: string): string {
  return deterministicUuid(`lawfirm-ads:approval-task:case-review:${caseEntityId}`)
}

function taskIdForAsset(asset: ContentAssetRow): string {
  return deterministicUuid(`lawfirm-ads:approval-task:${asset.firmId}:${asset.id}:${taskTypeForAsset(asset)}`)
}

function eventPolicyNumber(policyVersion: string): number {
  const match = /(?:^|[^0-9])(\d+)$/.exec(policyVersion)
  const parsed = match ? Number(match[1]) : 1
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

function eventActor(actorType: string, actorId: string): string {
  return `${actorType}:${actorId}`
}

function eventPayload(value: Record<string, unknown>): EventJsonValue {
  return value as EventJsonValue
}

async function appendApprovalEvent(
  db: TransactionalDb,
  input: {
    readonly eventType: string
    readonly aggregateType: string
    readonly aggregateId: string
    readonly firmId?: number | null
    readonly actorType: string
    readonly actorId: string
    readonly policyVersion: string
    readonly occurredAt: Date
    readonly idempotencyKey: string
    readonly payload: Record<string, unknown>
  },
): Promise<OutboxEventRow> {
  const envelope = createEventEnvelope<EventJsonValue>({
    eventType: input.eventType,
    aggregateId: input.aggregateId,
    firmId: input.firmId ?? null,
    actor: eventActor(input.actorType, input.actorId),
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
    correlationId: input.idempotencyKey,
    causationId: null,
    schemaVersion: 1,
    policyVersion: eventPolicyNumber(input.policyVersion),
    idempotencyKey: input.idempotencyKey,
    payload: eventPayload({
      ...input.payload,
      policyVersion: input.policyVersion,
    }),
  })
  const result = await appendOutboxEvent(db, {
    aggregateType: input.aggregateType,
    envelope,
  })
  return result.row
}

function factsFromEvidence(value: unknown): EvidenceSnapshotFacts {
  if (!value || typeof value !== 'object') {
    return { methods: [], infrastructure: [], amounts: [], citations: [] }
  }
  const facts = value as Partial<EvidenceSnapshotFacts>
  return {
    methods: Array.isArray(facts.methods) ? facts.methods.filter((item): item is string => typeof item === 'string') : [],
    infrastructure: Array.isArray(facts.infrastructure)
      ? facts.infrastructure.filter((item): item is { type: string; value: string } => (
        Boolean(item)
        && typeof item === 'object'
        && typeof (item as { type?: unknown }).type === 'string'
        && typeof (item as { value?: unknown }).value === 'string'
      ))
      : [],
    amounts: Array.isArray(facts.amounts) ? facts.amounts.filter((item): item is string => typeof item === 'string') : [],
    citations: Array.isArray(facts.citations)
      ? facts.citations.filter((item): item is EvidenceSnapshotFacts['citations'][number] => Boolean(item) && typeof item === 'object')
      : [],
  }
}

function competitorCitation(value: EvidenceSnapshotFacts['citations'][number]): boolean {
  const source = `${value.sourceFamily ?? ''} ${value.sourceUrl ?? ''}`.toLocaleLowerCase('ko-KR')
  return source.includes('competitor')
    || source.includes('lawfirm-sitemap')
    || source.includes('금융사기피해구제')
    || source.includes('sitemap')
}

function uniqueFactCount(facts: EvidenceSnapshotFacts): number {
  const values = [
    ...facts.methods.map((value) => `method:${value.trim()}`),
    ...facts.infrastructure.map((value) => `infra:${value.type.trim()}:${value.value.trim()}`),
    ...facts.amounts.map((value) => `amount:${value.trim()}`),
  ]
  return new Set(values.filter((value) => !value.endsWith(':'))).size
}

/**
 * Re-check the evidence at decision time.  A caller cannot make a case
 * publishable merely by setting `case_entities.status` to corroborated.
 */
export function evaluateCaseEvidenceGate(evidence: Pick<EvidenceRow, 'independentSourceCount' | 'facts'> | null): EvidenceGateResult {
  if (!evidence) {
    return {
      allowed: false,
      code: 'insufficient_evidence',
      uniqueFactCount: 0,
      independentSourceCount: 0,
      reason: 'no evidence snapshot is available',
    }
  }
  const facts = factsFromEvidence(evidence.facts)
  const citations = facts.citations.filter((citation) => citation.sourceFamily || citation.sourceUrl)
  const factsCount = uniqueFactCount(facts)
  const allCompetitor = citations.length > 0 && citations.every(competitorCitation)
  const titleOnly = allCompetitor && factsCount === 0
  const independentSourceCount = Number(evidence.independentSourceCount) || 0
  if (titleOnly) {
    return {
      allowed: false,
      code: 'competitor_sitemap_title_only',
      uniqueFactCount: factsCount,
      independentSourceCount,
      reason: 'competitor sitemap/title-only evidence is not case-specific evidence',
    }
  }
  const allowed = independentSourceCount >= 2 || (independentSourceCount >= 1 && factsCount >= 2)
  return {
    allowed,
    code: allowed ? 'ok' : 'insufficient_evidence',
    uniqueFactCount: factsCount,
    independentSourceCount,
    reason: allowed
      ? 'independent sources and case-specific facts meet the approval gate'
      : 'at least two independent sources or one source with two case-specific facts are required',
  }
}

async function insertApprovalTask(
  db: TransactionalDb,
  values: typeof approvalTasks.$inferInsert,
): Promise<{ row: ApprovalTaskRow; inserted: boolean }> {
  const [inserted] = await db.insert(approvalTasks)
    .values(values)
    .onConflictDoNothing({ target: approvalTasks.id })
    .returning()
  if (inserted) return { row: inserted, inserted: true }
  const [existing] = await db.select().from(approvalTasks)
    .where(eq(approvalTasks.id, values.id!))
    .limit(1)
  if (!existing) throw new Error('approval task idempotency conflict could not be resolved')
  if (
    existing.firmId !== (values.firmId ?? null)
    || existing.caseEntityId !== (values.caseEntityId ?? null)
    || existing.contentAssetId !== (values.contentAssetId ?? null)
    || existing.taskType !== values.taskType
    || existing.requiredActorType !== values.requiredActorType
  ) {
    throw new Error(`approval task idempotency collision: ${values.id}`)
  }
  return { row: existing, inserted: false }
}

async function latestEvidence(db: TransactionalDb, caseEntityId: string): Promise<EvidenceRow | null> {
  const rows = await db.select().from(caseEvidenceSnapshots)
    .where(eq(caseEvidenceSnapshots.caseEntityId, caseEntityId))
    .orderBy(asc(caseEvidenceSnapshots.capturedAt), asc(caseEvidenceSnapshots.id))
  return rows.at(-1) ?? null
}

function policyReason(policy: FirmPolicyRow | null, taskType: ApprovalTaskType): string {
  if (!policy) return `firm policy is missing; explicit ${taskType} approval is required`
  if (policy.contentAutoApprove) {
    return `asset is in ${taskType} and still requires an explicit actor decision under policy ${policy.policyVersion}`
  }
  return `firm policy ${policy.policyVersion} requires explicit ${taskType} approval`
}

async function firmPoliciesFor(
  db: TransactionalDb,
  firmIds: readonly number[],
): Promise<Map<number, FirmPolicyRow>> {
  if (!firmIds.length) return new Map()
  const rows = await db.select().from(firmPolicies).where(inArray(firmPolicies.firmId, [...new Set(firmIds)]))
  return new Map(rows.map((row) => [row.firmId, row]))
}

/**
 * Materialize the operator and firm approval queues.  Task IDs are stable
 * UUIDs, so a retry cannot create a second task even though the legacy table
 * predates a composite uniqueness constraint.
 */
export async function ensureApprovalTasks(
  db: Db,
  options: ApprovalTaskCreationOptions = {},
): Promise<ApprovalTaskCreationResult> {
  const now = validDate(options.now, 'now')
  const selectedCaseIds = options.caseEntityIds?.map((id) => requiredId(id, 'caseEntityId'))
  const selectedFirmId = options.firmId === undefined ? undefined : firmIdValue(options.firmId)

  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as TransactionalDb
    const corroboratedCases = selectedCaseIds?.length
      ? await transactionalDb.select().from(caseEntities).where(and(
        eq(caseEntities.status, 'corroborated'),
        inArray(caseEntities.id, selectedCaseIds),
      ))
      : await transactionalDb.select().from(caseEntities).where(eq(caseEntities.status, 'corroborated'))

    const created: ApprovalTaskRow[] = []
    const existing: ApprovalTaskRow[] = []
    let caseReviewTasksCreated = 0
    let caseReviewTasksExisting = 0
    for (const caseEntity of corroboratedCases) {
      const result = await insertApprovalTask(transactionalDb, {
        id: taskIdForCase(caseEntity.id),
        firmId: null,
        caseEntityId: caseEntity.id,
        contentAssetId: null,
        taskType: APPROVAL_TASK_TYPES.caseReview,
        status: 'pending',
        reason: CASE_REVIEW_TASK_REASON,
        requiredActorType: APPROVAL_ACTOR_TYPES.operator,
        createdAt: now,
      })
      if (result.inserted) {
        caseReviewTasksCreated += 1
        created.push(result.row)
      } else {
        caseReviewTasksExisting += 1
        existing.push(result.row)
      }
    }

    const assets = options.includeFirmTasks === false
      ? []
      : selectedFirmId === undefined
        ? await transactionalDb.select().from(contentAssets).where(inArray(contentAssets.status, [...REVIEWABLE_ASSET_STATUSES]))
        : await transactionalDb.select().from(contentAssets).where(and(
          eq(contentAssets.firmId, selectedFirmId),
          inArray(contentAssets.status, [...REVIEWABLE_ASSET_STATUSES]),
        ))
    const firmIds = [...new Set(assets.map((asset) => asset.firmId))]
    const policies = await firmPoliciesFor(transactionalDb, firmIds)
    const caseIds = [...new Set(assets.map((asset) => asset.caseEntityId))]
    const caseRows = caseIds.length
      ? await transactionalDb.select().from(caseEntities).where(inArray(caseEntities.id, caseIds))
      : []
    const caseById = new Map(caseRows.map((row) => [row.id, row]))
    let firmApprovalTasksCreated = 0
    let firmApprovalTasksExisting = 0
    for (const asset of assets) {
      // Assets cannot become publishable before their case is approved.  A
      // draft/review asset attached to an observed case is left for the case
      // workflow rather than exposed as a firm approval shortcut.
      if (caseById.get(asset.caseEntityId)?.status !== 'approved') continue
      const taskType = taskTypeForAsset(asset)
      const policy = policies.get(asset.firmId) ?? null
      const result = await insertApprovalTask(transactionalDb, {
        id: taskIdForAsset(asset),
        firmId: asset.firmId,
        caseEntityId: asset.caseEntityId,
        contentAssetId: asset.id,
        taskType,
        status: 'pending',
        reason: policyReason(policy, taskType),
        requiredActorType: REVIEW_ACTOR_TYPE,
        createdAt: now,
      })
      if (result.inserted) {
        firmApprovalTasksCreated += 1
        created.push(result.row)
      } else {
        firmApprovalTasksExisting += 1
        existing.push(result.row)
      }
    }

    return {
      caseReviewTasksCreated,
      caseReviewTasksExisting,
      firmApprovalTasksCreated,
      firmApprovalTasksExisting,
      created,
      existing,
    }
  })
}

/** Create only global operator review tasks; useful to run before firm fan-out. */
export async function ensureCaseReviewTasks(
  db: Db,
  options: Omit<ApprovalTaskCreationOptions, 'firmId'> = {},
): Promise<ApprovalTaskCreationResult> {
  return ensureApprovalTasks(db, { ...options, includeFirmTasks: false })
}

export async function createApprovalTasks(
  db: Db,
  options: ApprovalTaskCreationOptions = {},
): Promise<ApprovalTaskCreationResult> {
  return ensureApprovalTasks(db, options)
}

async function findCaseReviewTask(
  db: TransactionalDb,
  caseEntityId: string,
): Promise<ApprovalTaskRow | null> {
  const [row] = await db.select().from(approvalTasks).where(and(
    eq(approvalTasks.caseEntityId, caseEntityId),
    eq(approvalTasks.taskType, APPROVAL_TASK_TYPES.caseReview),
  )).orderBy(asc(approvalTasks.createdAt), asc(approvalTasks.id)).limit(1)
  return row ?? null
}

function assertCaseTransition(status: string, decision: ApprovalDecision): void {
  if (decision === 'approve' && status !== 'corroborated') {
    throw new Error(`illegal case approval transition: ${status} → approved`)
  }
  if (decision === 'reject' && !['observed', 'corroborated'].includes(status)) {
    throw new Error(`illegal case rejection transition from ${status}`)
  }
  if (decision === 'block' && !['observed', 'corroborated', 'approved'].includes(status)) {
    throw new Error(`illegal case block transition from ${status}`)
  }
}

async function loadFirmPolicy(
  db: TransactionalDb,
  firmId: number,
  decision: ApprovalDecision,
): Promise<FirmPolicyRow | null> {
  const [policy] = await db.select().from(firmPolicies).where(eq(firmPolicies.firmId, firmId)).limit(1)
  if (!policy && decision === 'approve') {
    throw new Error(`firm ${firmId} has no approval policy; refusing content approval`)
  }
  if (!policy) return null
  if (!policy.policyVersion.trim()) throw new Error(`firm ${firmId} has an invalid approval policy version`)
  return policy
}

function qualityReportAllowsApproval(report: unknown): boolean {
  if (!isValidContentQualityReport(report)) return false
  return report.evidenceReady
    && report.placeholderFree
    && report.linksReady
    && report.brandReady
    && report.complianceReady
    && report.uniqueFacts > 0
    && report.issues.length === 0
}

async function applyCaseDecision(
  db: TransactionalDb,
  input: CaseDecisionInput,
  taskId: string | null,
): Promise<CaseDecisionResult> {
  const decision = normalizeDecision(input.decision)
  const actor = validateActor(input.actorType, input.actorId, input.reason)
  const caseEntityId = requiredId(input.caseEntityId, 'caseEntityId')
  const occurredAt = validDate(input.occurredAt, 'occurredAt')
  const policyVersion = requiredText(input.policyVersion ?? DEFAULT_CASE_POLICY_VERSION, 'policyVersion')
  const firmId = input.firmId === undefined || input.firmId === null ? null : firmIdValue(input.firmId)

  const [caseEntity] = await db.select().from(caseEntities)
    .where(eq(caseEntities.id, caseEntityId)).limit(1)
  if (!caseEntity) throw new Error(`case entity not found: ${caseEntityId}`)
  assertCaseTransition(caseEntity.status, decision)
  if (decision === 'approve') {
    const evidence = await latestEvidence(db, caseEntityId)
    const gate = evaluateCaseEvidenceGate(evidence)
    if (!gate.allowed) throw new Error(`case approval blocked: ${gate.code} (${gate.reason})`)
  }
  if (firmId !== null) await loadFirmPolicy(db, firmId, decision)

  const storedDecision = caseDecisionValue(decision)
  const [approval] = await db.insert(caseApprovals).values({
    caseEntityId,
    firmId,
    decision: storedDecision,
    actorType: actor.actorType,
    actorId: actor.actorId,
    policyVersion,
    reason: actor.reason,
    createdAt: occurredAt,
  }).returning()
  if (!approval) throw new Error('case approval decision was not recorded')

  const nextStatus = decision === 'approve'
    ? 'approved'
    : decision === 'block'
      ? 'blocked'
      : caseEntity.status
  let updatedCase = caseEntity
  if (nextStatus !== caseEntity.status) {
    const [updated] = await db.update(caseEntities).set({
      status: nextStatus,
      updatedAt: occurredAt,
    }).where(and(
      eq(caseEntities.id, caseEntityId),
      eq(caseEntities.status, caseEntity.status),
    )).returning()
    if (!updated) throw new Error('case entity changed while recording approval')
    updatedCase = updated
  }

  const caseTask = taskId
    ? (await db.select().from(approvalTasks).where(eq(approvalTasks.id, taskId)).limit(1))[0] ?? null
    : await findCaseReviewTask(db, caseEntityId)
  const taskStatus = approvalTaskStatus(decision)
  let updatedTask: ApprovalTaskRow | null = null
  if (decision === 'approve') {
    if (caseTask?.status === 'pending') {
      const [updated] = await db.update(approvalTasks).set({
        status: taskStatus,
        reason: actor.reason,
        decidedBy: actor.actorId,
        decidedAt: occurredAt,
      }).where(and(
        eq(approvalTasks.id, caseTask.id),
        eq(approvalTasks.status, 'pending'),
      )).returning()
      updatedTask = updated ?? null
    }
  } else {
    const pendingTasks = await db.update(approvalTasks).set({
      status: taskStatus,
      reason: `${storedDecision}: ${actor.reason}`,
      decidedBy: actor.actorId,
      decidedAt: occurredAt,
    }).where(and(
      eq(approvalTasks.caseEntityId, caseEntityId),
      eq(approvalTasks.status, 'pending'),
    )).returning()
    updatedTask = pendingTasks.find((row) => row.id === taskId) ?? pendingTasks[0] ?? null
  }

  const idempotencyKey = `case-decision:${approval.id}`
  const outbox = await appendApprovalEvent(db, {
    eventType: `case.${storedDecision}`,
    aggregateType: 'case_entity',
    aggregateId: caseEntityId,
    firmId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    policyVersion,
    occurredAt,
    idempotencyKey,
    payload: {
      caseEntityId,
      approvalId: approval.id,
      taskId: updatedTask?.id ?? taskId,
      decision: storedDecision,
      fromStatus: caseEntity.status,
      toStatus: nextStatus,
      actorType: actor.actorType,
      actorId: actor.actorId,
      reason: actor.reason,
    },
  })
  return { caseEntity: updatedCase, approval, task: updatedTask, outbox }
}

/** Record an explicit global/firm case decision and its immutable event. */
export async function decideCaseApproval(
  db: Db,
  input: CaseDecisionInput,
): Promise<CaseDecisionResult> {
  return db.transaction(async (tx) => applyCaseDecision(
    tx as unknown as TransactionalDb,
    input,
    null,
  ))
}

export async function decideCaseReviewTask(
  db: Db,
  input: ApprovalTaskDecisionInput,
): Promise<CaseDecisionResult> {
  const decision = normalizeDecision(input.decision)
  const actor = validateActor(input.actorType, input.actorId, input.reason)
  const taskId = requiredId(input.taskId, 'taskId')
  if (input.firmId !== undefined && input.firmId !== null) {
    throw new Error('global operator case-review tasks cannot be decided in a firm scope')
  }
  if (actor.actorType !== APPROVAL_ACTOR_TYPES.operator) {
    throw new Error('case-review tasks require an operator actor')
  }
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as TransactionalDb
    const [task] = await transactionalDb.select().from(approvalTasks)
      .where(eq(approvalTasks.id, taskId)).limit(1)
    if (!task) throw new Error(`approval task not found: ${taskId}`)
    if (task.taskType !== APPROVAL_TASK_TYPES.caseReview || task.firmId !== null || !task.caseEntityId) {
      throw new Error('task is not a global operator case-review task')
    }
    if (task.status !== 'pending') throw new Error(`approval task is already ${task.status}`)
    if (task.requiredActorType !== actor.actorType) {
      throw new Error(`task requires actor type ${task.requiredActorType}`)
    }
    return applyCaseDecision(transactionalDb, {
      caseEntityId: task.caseEntityId,
      decision,
      actorType: actor.actorType,
      actorId: actor.actorId,
      reason: actor.reason,
      occurredAt: input.occurredAt,
    }, task.id)
  })
}

async function decideFirmApprovalTaskInTransaction(
  db: TransactionalDb,
  input: ApprovalTaskDecisionInput,
): Promise<FirmApprovalTaskDecisionResult> {
  const decision = normalizeDecision(input.decision)
  const actor = validateActor(input.actorType, input.actorId, input.reason)
  const taskId = requiredId(input.taskId, 'taskId')
  if (input.firmId === undefined || input.firmId === null) {
    throw new Error('firm approval task decisions require firmId')
  }
  const firmId = firmIdValue(input.firmId)
  const occurredAt = validDate(input.occurredAt, 'occurredAt')
  const [task] = await db.select().from(approvalTasks).where(eq(approvalTasks.id, taskId)).limit(1)
  if (!task) throw new Error(`approval task not found: ${taskId}`)
  if (task.firmId !== firmId) throw new Error(`approval task is scoped to firm ${task.firmId ?? 'global'}`)
  if (task.taskType !== APPROVAL_TASK_TYPES.contentReview && task.taskType !== APPROVAL_TASK_TYPES.brandReview) {
    throw new Error('task is not a firm content or brand approval task')
  }
  if (task.status !== 'pending') throw new Error(`approval task is already ${task.status}`)
  if (task.requiredActorType !== actor.actorType) {
    throw new Error(`task requires actor type ${task.requiredActorType}`)
  }
  if (!task.contentAssetId || !task.caseEntityId) throw new Error('firm approval task is missing its asset scope')

  const [asset] = await db.select().from(contentAssets).where(eq(contentAssets.id, task.contentAssetId)).limit(1)
  if (!asset || asset.firmId !== firmId || asset.caseEntityId !== task.caseEntityId) {
    throw new Error('content approval task does not match the firm-owned content asset')
  }
  const [caseEntity] = await db.select().from(caseEntities).where(eq(caseEntities.id, task.caseEntityId)).limit(1)
  if (!caseEntity) throw new Error('content approval task case entity not found')
  const policy = await loadFirmPolicy(db, firmId, decision)
  const expectedStatus = asset.assetType === 'seo_page' ? 'quality_review' : 'brand_review'
  if (asset.status !== expectedStatus) {
    throw new Error(`illegal ${asset.assetType} approval transition: ${asset.status} → ${decision === 'approve' ? 'approved' : 'rejected'}`)
  }

  if (decision === 'approve') {
    if (caseEntity.status !== 'approved') {
      throw new Error(`content approval blocked: case entity is ${caseEntity.status}`)
    }
    const evidence = await latestEvidence(db, caseEntity.id)
    const gate = evaluateCaseEvidenceGate(evidence)
    if (!gate.allowed) throw new Error(`content approval blocked: ${gate.code} (${gate.reason})`)
    if (!qualityReportAllowsApproval(asset.qualityReport)) {
      throw new Error('content approval blocked: quality report is not ready')
    }
  }
  if (decision === 'block') {
    throw new Error(`illegal ${asset.assetType} approval transition: ${asset.status} → blocked`)
  }

  const nextStatus = decision === 'approve'
    ? 'approved'
    : asset.assetType === 'seo_page'
      ? 'rejected'
      : asset.status
  let updatedAsset = asset
  if (nextStatus !== asset.status) {
    const [updated] = await db.update(contentAssets).set({
      status: nextStatus,
      updatedAt: occurredAt,
    }).where(and(
      eq(contentAssets.id, asset.id),
      eq(contentAssets.firmId, firmId),
      eq(contentAssets.status, asset.status),
    )).returning()
    if (!updated) throw new Error('content asset changed while recording approval')
    updatedAsset = updated
  }
  const [updatedTask] = await db.update(approvalTasks).set({
    status: approvalTaskStatus(decision),
    reason: actor.reason,
    decidedBy: actor.actorId,
    decidedAt: occurredAt,
  }).where(and(
    eq(approvalTasks.id, task.id),
    eq(approvalTasks.firmId, firmId),
    eq(approvalTasks.status, 'pending'),
  )).returning()
  if (!updatedTask) throw new Error('approval task changed while recording decision')

  const storedDecision = decision === 'approve' ? 'approved' : 'rejected'
  const idempotencyKey = `content-decision:${task.id}:${storedDecision}`
  const outbox = await appendApprovalEvent(db, {
    eventType: `content.${storedDecision}`,
    aggregateType: 'content_asset',
    aggregateId: asset.id,
    firmId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    policyVersion: policy?.policyVersion ?? MISSING_FIRM_POLICY_VERSION,
    occurredAt,
    idempotencyKey,
    payload: {
      approvalTaskId: task.id,
      contentAssetId: asset.id,
      caseEntityId: asset.caseEntityId,
      firmId,
      assetType: asset.assetType,
      decision: storedDecision,
      fromStatus: asset.status,
      toStatus: nextStatus,
      actorType: actor.actorType,
      actorId: actor.actorId,
      reason: actor.reason,
    },
  })
  return { task: updatedTask, contentAsset: updatedAsset, outbox }
}

export async function decideFirmApprovalTask(
  db: Db,
  input: ApprovalTaskDecisionInput,
): Promise<FirmApprovalTaskDecisionResult> {
  return db.transaction(async (tx) => decideFirmApprovalTaskInTransaction(
    tx as unknown as TransactionalDb,
    input,
  ))
}

/** Dispatch a decision through the task's own global or firm scope. */
export async function decideApprovalTask(
  db: Db,
  input: ApprovalTaskDecisionInput,
): Promise<CaseDecisionResult | FirmApprovalTaskDecisionResult> {
  const taskId = requiredId(input.taskId, 'taskId')
  const [task] = await db.select().from(approvalTasks).where(eq(approvalTasks.id, taskId)).limit(1)
  if (!task) throw new Error(`approval task not found: ${taskId}`)
  if (task.taskType === APPROVAL_TASK_TYPES.caseReview) {
    return decideCaseReviewTask(db, input)
  }
  return decideFirmApprovalTask(db, input)
}

export async function approveCase(db: Db, input: Omit<CaseDecisionInput, 'decision'>): Promise<CaseDecisionResult> {
  return decideCaseApproval(db, { ...input, decision: 'approve' })
}

export async function rejectCase(db: Db, input: Omit<CaseDecisionInput, 'decision'>): Promise<CaseDecisionResult> {
  return decideCaseApproval(db, { ...input, decision: 'reject' })
}

export async function blockCase(db: Db, input: Omit<CaseDecisionInput, 'decision'>): Promise<CaseDecisionResult> {
  return decideCaseApproval(db, { ...input, decision: 'block' })
}

export async function decideTask(
  db: Db,
  input: ApprovalTaskDecisionInput,
): Promise<CaseDecisionResult | FirmApprovalTaskDecisionResult> {
  return decideApprovalTask(db, input)
}

export type PendingFirmApproval = {
  readonly task: ApprovalTaskRow
  readonly contentAsset: ContentAssetRow
  readonly caseEntity: CaseEntityRow
}

/** Customer-safe pending queue; malformed or cross-tenant task links fail closed. */
export async function listPendingFirmApprovals(
  db: Db,
  firm: number | { id: number },
): Promise<PendingFirmApproval[]> {
  const firmId = firmIdValue(typeof firm === 'number' ? firm : firm.id)
  const tasks = await db.select().from(approvalTasks).where(and(
    eq(approvalTasks.firmId, firmId),
    eq(approvalTasks.status, 'pending'),
    inArray(approvalTasks.taskType, [APPROVAL_TASK_TYPES.contentReview, APPROVAL_TASK_TYPES.brandReview]),
  )).orderBy(asc(approvalTasks.createdAt), asc(approvalTasks.id))
  const assetIds = tasks.flatMap((task) => task.contentAssetId ? [task.contentAssetId] : [])
  const caseIds = tasks.flatMap((task) => task.caseEntityId ? [task.caseEntityId] : [])
  if (!assetIds.length || !caseIds.length) return []
  const [assets, cases] = await Promise.all([
    db.select().from(contentAssets).where(and(
      eq(contentAssets.firmId, firmId),
      inArray(contentAssets.id, assetIds),
    )),
    db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds)),
  ])
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const caseById = new Map(cases.map((caseEntity) => [caseEntity.id, caseEntity]))
  return tasks.flatMap((task) => {
    const contentAsset = task.contentAssetId ? assetById.get(task.contentAssetId) : null
    const caseEntity = task.caseEntityId ? caseById.get(task.caseEntityId) : null
    if (!contentAsset || !caseEntity || contentAsset.caseEntityId !== caseEntity.id) return []
    return [{ task, contentAsset, caseEntity }]
  })
}
