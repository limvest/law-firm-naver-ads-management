import { and, asc, desc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  productLeadProfiles,
  productLeadStageHistory,
  type ProductLeadStage,
} from '@/lib/db/schema'

export const PRODUCT_LEAD_PACKAGES = ['founding_pilot', 'core', 'growth', 'managed_ops'] as const
export type ProductLeadPackage = typeof PRODUCT_LEAD_PACKAGES[number]

export const PRODUCT_LEAD_STAGES = [
  'targeted',
  'contacted',
  'interview',
  'demo',
  'pilot',
  'active',
  'lost',
] as const satisfies readonly ProductLeadStage[]

export type GtmPipelineStage = typeof PRODUCT_LEAD_STAGES[number]
export type ProductLeadProfileRow = typeof productLeadProfiles.$inferSelect
export type ProductLeadStageHistoryRow = typeof productLeadStageHistory.$inferSelect
export type GtmPipelineRow = ProductLeadProfileRow & {
  /** History is optional at the type boundary for callers that build panel fixtures. */
  history?: ProductLeadStageHistoryRow[]
}

export type GtmPipelineScope =
  | { firmId: number }
  | { platformFirmId: number }

export type ProductLeadProfileListOptions = {
  limit?: number
  offset?: number
}

export type GtmGateKey = 'targets' | 'interviews' | 'qualifiedDemos' | 'paidPilots'

export type GtmGateProgress = {
  key: GtmGateKey
  label: string
  target: number
  current: number
  remaining: number
  complete: boolean
}

export type GtmPipeline = {
  firmId: number
  rows: GtmPipelineRow[]
  gates: GtmGateProgress[]
  history?: ProductLeadStageHistoryRow[]
}

export type ProductLeadStageTransitionInput = {
  firmId: number
  leadId: string
  toStage: GtmPipelineStage
  lostReason?: string | null
  evidenceNote?: string | null
  actor?: string
  now?: Date
}

export type ProductLeadFollowUpInput = {
  firmId: number
  leadId: string
  followUpAt: Date | string | null
  now?: Date
}

export const GTM_EVIDENCE_NOTE_MAX_LENGTH = 280

const SUBSTANTIVE_GTM_STAGES: readonly GtmPipelineStage[] = [
  'targeted',
  'interview',
  'demo',
  'pilot',
  'active',
  'lost',
]

const STAGE_RANK: Record<Exclude<GtmPipelineStage, 'lost'>, number> = {
  targeted: 0,
  contacted: 1,
  interview: 2,
  demo: 3,
  pilot: 4,
  active: 5,
}

const GATE_DEFINITIONS: readonly {
  key: GtmGateKey
  label: string
  target: number
  minimumStage?: Exclude<GtmPipelineStage, 'lost'>
}[] = [
  { key: 'targets', label: '목표 사무소', target: 30 },
  { key: 'interviews', label: '인터뷰', target: 10, minimumStage: 'interview' },
  { key: 'qualifiedDemos', label: '적격 데모', target: 5, minimumStage: 'demo' },
  { key: 'paidPilots', label: '유료 파일럿', target: 1, minimumStage: 'pilot' },
]

function positiveFirmId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('firmId must be a positive integer')
  }
  return value
}

function scopeFirmId(scope: GtmPipelineScope | number): number {
  if (typeof scope === 'number') return positiveFirmId(scope)
  if ('firmId' in scope) return positiveFirmId(scope.firmId)
  return positiveFirmId(scope.platformFirmId)
}

function validStage(value: string): GtmPipelineStage {
  if ((PRODUCT_LEAD_STAGES as readonly string[]).includes(value)) return value as GtmPipelineStage
  throw new TypeError(`invalid product lead stage: ${value}`)
}

function validLeadId(value: string): string {
  const leadId = value.trim()
  if (!leadId) throw new TypeError('leadId must not be empty')
  return leadId
}

function validNow(value: Date | undefined): Date {
  const now = value ?? new Date()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date')
  return now
}

function normalizeFollowUp(value: Date | string | null): Date | null {
  if (value === null || value === '') return null
  const followUpAt = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(followUpAt.getTime())) throw new TypeError('followUpAt must be a valid date or null')
  return followUpAt
}

export function normalizeGtmEvidenceNote(value: string | null | undefined): string | null {
  const note = value?.trim() ?? ''
  if (note.length > GTM_EVIDENCE_NOTE_MAX_LENGTH) {
    throw new TypeError(`evidenceNote must be ${GTM_EVIDENCE_NOTE_MAX_LENGTH} characters or fewer`)
  }
  return note || null
}

export function requiresGtmEvidenceNote(stage: string): boolean {
  return (SUBSTANTIVE_GTM_STAGES as readonly string[]).includes(stage)
}

function milestoneEvidenceNote(stage: GtmPipelineStage, value: string | null | undefined): string | null {
  const note = normalizeGtmEvidenceNote(value)
  if (requiresGtmEvidenceNote(stage) && !note) {
    throw new TypeError(`evidenceNote is required for GTM milestone: ${stage}`)
  }
  return note
}

/**
 * The GTM pipeline is intentionally linear. A stage can advance one step or
 * be marked lost; skipping a qualification step would make gate counts look
 * complete without the corresponding founder-led evidence.
 */
export function canTransitionProductLeadStage(
  fromStage: string,
  toStage: string,
): boolean {
  if (!(PRODUCT_LEAD_STAGES as readonly string[]).includes(fromStage)) return false
  if (!(PRODUCT_LEAD_STAGES as readonly string[]).includes(toStage)) return false
  if (fromStage === toStage) return true
  if (fromStage === 'lost' || toStage === 'targeted') return false
  if (toStage === 'lost') return true
  return STAGE_RANK[toStage as Exclude<GtmPipelineStage, 'lost'>]
    === STAGE_RANK[fromStage as Exclude<GtmPipelineStage, 'lost'>] + 1
}

export function validateProductLeadStageTransition(fromStage: string, toStage: string): true {
  validStage(fromStage)
  validStage(toStage)
  if (!canTransitionProductLeadStage(fromStage, toStage)) {
    throw new Error(`invalid product lead stage transition: ${fromStage} -> ${toStage}`)
  }
  return true
}

/**
 * Count reached milestones from the append-only ledger. When history is not
 * supplied this keeps the old pure-function behavior for non-persisted
 * callers; getGtmPipeline always supplies queried history.
 */
export function calculateGtmGateProgress(
  rows: readonly Pick<ProductLeadProfileRow, 'leadId' | 'stage'>[],
  history?: readonly Pick<ProductLeadStageHistoryRow, 'leadId' | 'fromStage' | 'toStage'>[],
): GtmGateProgress[] {
  const milestones = history ?? rows.map((row) => ({
    leadId: row.leadId,
    fromStage: null,
    toStage: row.stage,
  }))
  const reachedByLead = new Map<string, { hasTarget: boolean; highestRank: number }>()
  for (const milestone of milestones) {
    const current = reachedByLead.get(milestone.leadId) ?? { hasTarget: false, highestRank: -1 }
    for (const stage of [milestone.fromStage, milestone.toStage]) {
      if (typeof stage !== 'string') continue
      if (!(PRODUCT_LEAD_STAGES as readonly string[]).includes(stage)) continue
      current.hasTarget = true
      if (stage === 'lost') continue
      current.highestRank = Math.max(
        current.highestRank,
        STAGE_RANK[stage as Exclude<GtmPipelineStage, 'lost'>],
      )
    }
    reachedByLead.set(milestone.leadId, current)
  }
  return GATE_DEFINITIONS.map((definition) => {
    const current = [...reachedByLead.values()].filter((milestone) => (
      definition.minimumStage
        ? milestone.highestRank >= STAGE_RANK[definition.minimumStage]
        : milestone.hasTarget
    )).length
    return {
      key: definition.key,
      label: definition.label,
      target: definition.target,
      current,
      remaining: Math.max(0, definition.target - current),
      complete: current >= definition.target,
    }
  })
}

export const computeGtmGateProgress = calculateGtmGateProgress

/**
 * List only structured profile columns. Contact PII lives on the encrypted
 * legacy lead row and is deliberately not joined into this operator query.
 */
export async function listProductLeadProfiles(
  db: Db,
  scope: GtmPipelineScope | number,
  options: ProductLeadProfileListOptions = {},
): Promise<ProductLeadProfileRow[]> {
  const firmId = scopeFirmId(scope)
  const limit = options.limit ?? 100
  const offset = options.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) throw new TypeError('limit must be an integer from 1 to 500')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative integer')
  return db.select().from(productLeadProfiles)
    .where(eq(productLeadProfiles.firmId, firmId))
    .orderBy(desc(productLeadProfiles.updatedAt), desc(productLeadProfiles.createdAt), asc(productLeadProfiles.leadId))
    .limit(limit)
    .offset(offset)
}

export async function listProductLeadStageHistory(
  db: Db,
  scope: GtmPipelineScope | number,
): Promise<ProductLeadStageHistoryRow[]> {
  const firmId = scopeFirmId(scope)
  return db.select().from(productLeadStageHistory)
    .where(eq(productLeadStageHistory.firmId, firmId))
    .orderBy(desc(productLeadStageHistory.createdAt), desc(productLeadStageHistory.id))
}

export async function getProductLeadStageHistory(
  db: Db,
  scope: GtmPipelineScope | number,
  leadId: string,
): Promise<ProductLeadStageHistoryRow[]> {
  const firmId = scopeFirmId(scope)
  const normalizedLeadId = validLeadId(leadId)
  return db.select().from(productLeadStageHistory).where(and(
    eq(productLeadStageHistory.firmId, firmId),
    eq(productLeadStageHistory.leadId, normalizedLeadId),
  )).orderBy(desc(productLeadStageHistory.createdAt), desc(productLeadStageHistory.id))
}

export async function getGtmPipeline(
  db: Db,
  scope: GtmPipelineScope | number,
  options: ProductLeadProfileListOptions = {},
): Promise<GtmPipeline> {
  const firmId = scopeFirmId(scope)
  const [rows, history] = await Promise.all([
    listProductLeadProfiles(db, firmId, options),
    listProductLeadStageHistory(db, firmId),
  ])
  const historyByLead = new Map<string, ProductLeadStageHistoryRow[]>()
  for (const event of history) {
    const current = historyByLead.get(event.leadId) ?? []
    current.push(event)
    historyByLead.set(event.leadId, current)
  }
  const rowsWithHistory = rows.map((row) => ({
    ...row,
    history: historyByLead.get(row.leadId) ?? [],
  }))
  return {
    firmId,
    rows: rowsWithHistory,
    gates: calculateGtmGateProgress(rows, history),
    history,
  }
}

export const listGtmPipeline = getGtmPipeline
export const queryGtmPipeline = getGtmPipeline

export async function transitionProductLeadStage(
  db: Db,
  input: ProductLeadStageTransitionInput,
): Promise<ProductLeadProfileRow | null> {
  const firmId = positiveFirmId(input.firmId)
  const leadId = validLeadId(input.leadId)
  const toStage = validStage(input.toStage)
  const now = validNow(input.now)
  const actor = (input.actor ?? 'operator-console').trim()
  if (!actor) throw new TypeError('actor must not be empty')
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const [current] = await transactionalDb.select().from(productLeadProfiles).where(and(
      eq(productLeadProfiles.leadId, leadId),
      eq(productLeadProfiles.firmId, firmId),
    )).limit(1)
    if (!current) return null
    validateProductLeadStageTransition(current.stage, toStage)
    if (current.stage === toStage) return current
    const lostReason = toStage === 'lost'
      ? (input.lostReason ?? '').trim()
      : null
    if (toStage === 'lost' && !lostReason) throw new TypeError('lostReason is required when marking a lead lost')
    const evidenceNote = milestoneEvidenceNote(toStage, input.evidenceNote)
    const [updated] = await transactionalDb.update(productLeadProfiles).set({
      stage: toStage,
      lostReason,
      updatedAt: now,
    }).where(and(
      eq(productLeadProfiles.leadId, leadId),
      eq(productLeadProfiles.firmId, firmId),
      eq(productLeadProfiles.stage, current.stage),
    )).returning()
    if (!updated) return null
    await transactionalDb.insert(productLeadStageHistory).values({
      leadId,
      firmId,
      fromStage: current.stage,
      toStage,
      evidenceNote,
      actor,
      createdAt: now,
    })
    return updated
  })
}

export async function setProductLeadFollowUp(
  db: Db,
  input: ProductLeadFollowUpInput,
): Promise<ProductLeadProfileRow | null> {
  const firmId = positiveFirmId(input.firmId)
  const leadId = validLeadId(input.leadId)
  const now = validNow(input.now)
  const followUpAt = normalizeFollowUp(input.followUpAt)
  const [updated] = await db.update(productLeadProfiles).set({
    followUpAt,
    updatedAt: now,
  }).where(and(
    eq(productLeadProfiles.leadId, leadId),
    eq(productLeadProfiles.firmId, firmId),
  )).returning()
  return updated ?? null
}

export const markProductLeadLost = (
  db: Db,
  input: Omit<ProductLeadStageTransitionInput, 'toStage'>,
) => transitionProductLeadStage(db, { ...input, toStage: 'lost' })
