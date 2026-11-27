import { createHash } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  caseEntities,
  contentAssets,
  firmPolicies,
  firms,
  type FirmAdConfig,
} from '@/lib/db/schema'
import { createEventEnvelope } from '@/domains/operations/event-envelope'
import { appendOutboxEvent } from '@/domains/operations/outbox'
import {
  normalizeNaverAdPolicy,
  type NaverAdAction,
} from './policy'

type FirmPolicyRow = typeof firmPolicies.$inferSelect

export const CUSTOMER_AD_POLICY_ACTIONS = Object.freeze([
  'register',
  'activate',
  'pause',
  'decrease_bid',
  'increase_bid',
  'recommend_pause',
] as const satisfies readonly NaverAdAction[])

const POLICY_ACTION_SET = new Set<string>(CUSTOMER_AD_POLICY_ACTIONS)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class CustomerAdPolicyValidationError extends Error {
  readonly code = 'CUSTOMER_AD_POLICY_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'CustomerAdPolicyValidationError'
  }
}

export type FirmAdPolicyCaseOption = {
  readonly id: string
  readonly canonicalName: string
  readonly slug: string
  readonly assetStatus: string
}

export type FirmAdPolicyView = {
  readonly policy: FirmPolicyRow | null
  readonly cases: readonly FirmAdPolicyCaseOption[]
  readonly approved: boolean
}

export type SaveFirmAdPolicyInput = {
  readonly firmId: number
  readonly monthlyBudget: number
  readonly dailyBudget: number
  readonly bidCeiling: number
  readonly allowedCaseEntityIds: readonly string[]
  readonly allowedActions: readonly string[]
  readonly autoSubmit?: boolean
  readonly approvedBy: string
  readonly reason: string
  readonly occurredAt?: Date
}

export type SaveFirmAdPolicyResult = {
  readonly policy: FirmPolicyRow
  readonly inserted: boolean
  readonly updated: boolean
  readonly unchanged: boolean
  readonly auditEventInserted: boolean
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CustomerAdPolicyValidationError(`${label} is required`)
  }
  return value.trim()
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new CustomerAdPolicyValidationError(`${label} must be a positive integer`)
  }
  return Number(value)
}

function normalizeFirmId(value: unknown): number {
  return positiveInteger(value, 'firmId')
}

function normalizeIds(values: readonly string[]): string[] {
  const ids = [...new Set(values.map((value) => requiredText(value, 'caseEntityId')))].sort()
  if (!ids.length) throw new CustomerAdPolicyValidationError('at least one case must be approved')
  if (ids.some((id) => !UUID_PATTERN.test(id))) {
    throw new CustomerAdPolicyValidationError('allowed case IDs must be canonical UUIDs')
  }
  return ids
}

function normalizeActions(values: readonly string[]): NaverAdAction[] {
  const actions = [...new Set(values.map((value) => requiredText(value, 'allowedAction')))].sort()
  if (!actions.length) throw new CustomerAdPolicyValidationError('at least one advertising action must be approved')
  const unsupported = actions.filter((action) => !POLICY_ACTION_SET.has(action))
  if (unsupported.length) {
    throw new CustomerAdPolicyValidationError(`unsupported advertising actions: ${unsupported.join(', ')}`)
  }
  return actions as NaverAdAction[]
}

function validOccurredAt(value: Date | undefined): Date {
  const date = value ? new Date(value.getTime()) : new Date()
  if (Number.isNaN(date.getTime())) throw new CustomerAdPolicyValidationError('occurredAt must be valid')
  return date
}

function canonicalPolicyVersion(value: {
  firmId: number
  monthlyBudget: number
  dailyBudget: number
  bidCeiling: number
  allowedCaseEntityIds: readonly string[]
  allowedActions: readonly string[]
  autoSubmit: boolean
}): string {
  const digest = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 16)
  return `firm-${value.firmId}-ad-policy-v1-${digest}`
}

function sameStrings(left: readonly string[] | null, right: readonly string[]): boolean {
  if (!left || left.length !== right.length) return false
  return [...left].sort().every((value, index) => value === right[index])
}

export async function getFirmAdPolicyView(db: Db, firmIdInput: number): Promise<FirmAdPolicyView> {
  const firmId = normalizeFirmId(firmIdInput)
  const [[policy], assets] = await Promise.all([
    db.select().from(firmPolicies).where(eq(firmPolicies.firmId, firmId)).limit(1),
    db.select({
      id: caseEntities.id,
      canonicalName: caseEntities.canonicalName,
      slug: caseEntities.slug,
      assetStatus: contentAssets.status,
    }).from(contentAssets).innerJoin(
      caseEntities,
      eq(contentAssets.caseEntityId, caseEntities.id),
    ).where(and(
      eq(contentAssets.firmId, firmId),
      eq(contentAssets.assetType, 'ad_landing'),
      eq(caseEntities.status, 'approved'),
    )),
  ])

  const byCase = new Map<string, FirmAdPolicyCaseOption>()
  for (const row of assets) {
    const existing = byCase.get(row.id)
    if (!existing || row.assetStatus > existing.assetStatus) byCase.set(row.id, row)
  }
  const cases = [...byCase.values()].sort((left, right) => (
    left.canonicalName.localeCompare(right.canonicalName, 'ko-KR') || left.id.localeCompare(right.id)
  ))
  return {
    policy: policy ?? null,
    cases,
    approved: Boolean(policy?.approvedBy && policy.approvedAt),
  }
}

/**
 * Persist the customer's explicit spend/scope boundary and an append-only audit event.
 * The function changes local intent only; it never invokes Naver or spends money.
 */
export async function saveFirmAdPolicy(
  db: Db,
  input: SaveFirmAdPolicyInput,
): Promise<SaveFirmAdPolicyResult> {
  const firmId = normalizeFirmId(input.firmId)
  const monthlyBudget = positiveInteger(input.monthlyBudget, 'monthlyBudget')
  const dailyBudget = positiveInteger(input.dailyBudget, 'dailyBudget')
  const bidCeiling = positiveInteger(input.bidCeiling, 'bidCeiling')
  if (bidCeiling < 70) {
    throw new CustomerAdPolicyValidationError('bidCeiling must be at least 70')
  }
  if (dailyBudget > monthlyBudget) {
    throw new CustomerAdPolicyValidationError('dailyBudget cannot exceed monthlyBudget')
  }
  const allowedCaseEntityIds = normalizeIds(input.allowedCaseEntityIds)
  const allowedActions = normalizeActions(input.allowedActions)
  const approvedBy = requiredText(input.approvedBy, 'approvedBy')
  const reason = requiredText(input.reason, 'reason')
  if (reason.length < 5) throw new CustomerAdPolicyValidationError('reason must contain at least 5 characters')
  const occurredAt = validOccurredAt(input.occurredAt)
  const autoSubmit = input.autoSubmit === true

  const normalized = normalizeNaverAdPolicy({
    monthlyBudget,
    dailyBudget,
    bidCeiling,
    allowedCaseEntityIds,
    allowedActions,
    customerApproved: true,
    dryRun: false,
  })
  if (normalized.validationErrors.length) {
    throw new CustomerAdPolicyValidationError(normalized.validationErrors.join(', '))
  }
  const policyVersion = canonicalPolicyVersion({
    firmId,
    monthlyBudget,
    dailyBudget,
    bidCeiling,
    allowedCaseEntityIds,
    allowedActions,
    autoSubmit,
  })
  const auditKey = `firm-ad-policy-approved:${firmId}:${policyVersion}:${createHash('sha256').update(`${approvedBy}:${reason}`, 'utf8').digest('hex').slice(0, 16)}`

  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const [firm] = await transactionalDb.select().from(firms).where(eq(firms.id, firmId)).limit(1)
    if (!firm) throw new CustomerAdPolicyValidationError(`firm ${firmId} was not found`)

    const eligibleRows = await transactionalDb.select({ id: caseEntities.id }).from(contentAssets).innerJoin(
      caseEntities,
      eq(contentAssets.caseEntityId, caseEntities.id),
    ).where(and(
      eq(contentAssets.firmId, firmId),
      eq(contentAssets.assetType, 'ad_landing'),
      eq(caseEntities.status, 'approved'),
      inArray(caseEntities.id, allowedCaseEntityIds),
    ))
    const eligibleIds = new Set(eligibleRows.map((row) => row.id))
    const outsideScope = allowedCaseEntityIds.filter((id) => !eligibleIds.has(id))
    if (outsideScope.length) {
      throw new CustomerAdPolicyValidationError('one or more selected cases are not approved for this firm')
    }

    const [existing] = await transactionalDb.select().from(firmPolicies)
      .where(eq(firmPolicies.firmId, firmId)).limit(1)
    const semanticUnchanged = Boolean(existing
      && existing.policyVersion === policyVersion
      && existing.monthlyBudget === monthlyBudget
      && existing.dailyBudget === dailyBudget
      && existing.bidCeiling === bidCeiling
      && existing.adAutoSubmit === autoSubmit
      && sameStrings(existing.allowedCaseEntityIds, allowedCaseEntityIds)
      && sameStrings(existing.allowedActions, allowedActions)
      && existing.approvedBy === approvedBy
      && existing.approvedAt)

    const payload = {
      policyVersion,
      monthlyBudget,
      dailyBudget,
      bidCeiling,
      allowedCaseEntityIds,
      allowedActions,
      autoSubmit,
      reason,
    } as const
    const audit = await appendOutboxEvent(transactionalDb, {
      aggregateType: 'firm_ad_policy',
      envelope: createEventEnvelope({
        eventType: 'firm.ad_policy.approved',
        aggregateId: `firm:${firmId}:ad-policy`,
        firmId,
        actor: { type: 'customer', id: approvedBy },
        occurredAt,
        recordedAt: occurredAt,
        correlationId: auditKey,
        causationId: null,
        schemaVersion: 1,
        policyVersion: 1,
        idempotencyKey: auditKey,
        payload,
      }),
    })

    if (semanticUnchanged) {
      return {
        policy: existing!,
        inserted: false,
        updated: false,
        unchanged: true,
        auditEventInserted: audit.inserted,
      }
    }

    let policy: FirmPolicyRow
    if (existing) {
      const [updated] = await transactionalDb.update(firmPolicies).set({
        policyVersion,
        adAutoSubmit: autoSubmit,
        allowedActions,
        allowedCaseEntityIds,
        monthlyBudget,
        dailyBudget,
        bidCeiling,
        approvedBy,
        approvedAt: occurredAt,
        updatedAt: occurredAt,
      }).where(and(eq(firmPolicies.id, existing.id), eq(firmPolicies.firmId, firmId))).returning()
      if (!updated) throw new Error('firm advertising policy update returned no row')
      policy = updated
    } else {
      const [inserted] = await transactionalDb.insert(firmPolicies).values({
        firmId,
        policyVersion,
        contentAutoApprove: false,
        adAutoSubmit: autoSubmit,
        allowedActions,
        allowedCaseEntityIds,
        monthlyBudget,
        dailyBudget,
        bidCeiling,
        approvedBy,
        approvedAt: occurredAt,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }).returning()
      if (!inserted) throw new Error('firm advertising policy insert returned no row')
      policy = inserted
    }

    const legacyAdConfig: FirmAdConfig = {
      ...(firm.adConfig ?? {}),
      bidAmt: bidCeiling,
      dailyBudget,
      useDailyBudget: true,
    }
    await transactionalDb.update(firms).set({
      adConfig: legacyAdConfig,
    }).where(eq(firms.id, firmId))

    return {
      policy,
      inserted: !existing,
      updated: Boolean(existing),
      unchanged: false,
      auditEventInserted: audit.inserted,
    }
  })
}
