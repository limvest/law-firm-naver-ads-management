import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gte } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  consultations,
  leadQualifications,
  leadStatusHistory,
  leads,
  matterOutcomes,
} from '@/lib/db/schema'
import { appendOutboxEvent } from '@/domains/operations/outbox'
import { createEventEnvelope, type EventJsonValue } from '@/domains/operations/event-envelope'
import {
  assertConsultationTransition,
  assertQualificationTransition,
  OutcomeTransitionError,
  OutcomeValidationError,
  type ConsultationStatus,
  type LeadLifecycleStatus,
  type MatterOutcomeStatus,
  type QualificationStatus,
} from './lifecycle'

type LeadRow = typeof leads.$inferSelect
type QualificationRow = typeof leadQualifications.$inferSelect
type ConsultationRow = typeof consultations.$inferSelect
type MatterOutcomeRow = typeof matterOutcomes.$inferSelect
type HistoryRow = typeof leadStatusHistory.$inferSelect

export type LeadOutcomeSnapshot = {
  lead: LeadRow
  status: LeadLifecycleStatus
  qualification: QualificationRow | null
  consultation: ConsultationRow | null
  matterOutcome: MatterOutcomeRow | null
  history: HistoryRow[]
}

export type OutcomeSummary = {
  totalLeads: number
  qualifiedLeads: number
  unqualifiedLeads: number
  consultationsBooked: number
  consultationsCompleted: number
  consultationsCancelled: number
  consultationsNoShow: number
  retainedMatters: number
  notRetainedMatters: number
  closedMatters: number
  mattersWithFeeBand: number
  attributedQualifiedLeads: number
  attributedRetainedMatters: number
  qualificationRate: number | null
  consultationRate: number | null
  retentionRate: number | null
  attributionRate: number | null
  feeBands: Record<string, number>
}

type CommandBase = {
  actor: string
  reason?: string | null
  occurredAt?: Date
}

export class OutcomePersistenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutcomePersistenceError'
  }
}

function requiredActor(value: string): string {
  const actor = value.trim()
  if (!actor) throw new OutcomeValidationError('actor must not be empty')
  return actor
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function assertChronology(occurredAt: Date, lead: LeadRow, history: readonly HistoryRow[]): void {
  if (Number.isNaN(occurredAt.getTime())) throw new OutcomeValidationError('occurredAt must be a valid timestamp')
  const lastRecordedAt = history.at(-1)?.createdAt ?? lead.createdAt
  if (occurredAt.getTime() < lead.createdAt.getTime() || occurredAt.getTime() < lastRecordedAt.getTime()) {
    throw new OutcomeValidationError('outcome transition cannot occur before the lead or previous transition')
  }
}

function firmIdValue(value: number | { id: number }): number {
  const id = typeof value === 'number' ? value : value.id
  if (!Number.isSafeInteger(id) || id <= 0) throw new OutcomeValidationError('firm id must be a positive integer')
  return id
}

function historyKey(parts: readonly (string | number | null)[]): string {
  return createHash('sha256')
    .update(`lawfirm-ads:outcome-history:v1:${JSON.stringify(parts)}`)
    .digest('hex')
}

function lifecycleStatus(
  qualification: QualificationRow | null,
  consultation: ConsultationRow | null,
  matter: MatterOutcomeRow | null,
): LeadLifecycleStatus {
  if (matter?.status === 'retained') return 'matter_retained'
  if (matter?.status === 'not_retained') return 'matter_not_retained'
  if (matter?.status === 'closed') return 'matter_closed'
  if (consultation?.status === 'completed') return 'consultation_completed'
  if (consultation?.status === 'cancelled') return 'consultation_cancelled'
  if (consultation?.status === 'no_show') return 'consultation_no_show'
  if (consultation?.status === 'booked') return 'consultation_booked'
  if (qualification?.status === 'qualified') return 'qualified'
  if (qualification?.status === 'unqualified') return 'unqualified'
  return 'new'
}

function legacyLeadStatus(status: LeadLifecycleStatus): string {
  switch (status) {
    case 'new': return 'new'
    case 'qualified': return '검토중'
    case 'unqualified': return '종결'
    case 'consultation_booked': return '상담예약'
    case 'consultation_completed': return '상담'
    case 'consultation_cancelled':
    case 'consultation_no_show':
    case 'matter_not_retained':
    case 'matter_closed': return '종결'
    case 'matter_retained': return '수임'
  }
}

function eventType(status: LeadLifecycleStatus): string {
  switch (status) {
    case 'new': return 'lead.created'
    case 'qualified': return 'lead.qualified'
    case 'unqualified': return 'lead.unqualified'
    case 'consultation_booked': return 'consultation.booked'
    case 'consultation_completed': return 'consultation.completed'
    case 'consultation_cancelled': return 'consultation.cancelled'
    case 'consultation_no_show': return 'consultation.no_show'
    case 'matter_retained': return 'matter.retained'
    case 'matter_not_retained': return 'matter.not_retained'
    case 'matter_closed': return 'matter.closed'
  }
}

async function scopedLead(db: Db, firmId: number, leadId: string): Promise<LeadRow> {
  const [lead] = await db.select().from(leads).where(and(
    eq(leads.id, leadId),
    eq(leads.firmId, firmId),
  )).limit(1)
  if (!lead) throw new OutcomePersistenceError('lead not found in firm scope')
  return lead
}

async function loadRelated(db: Db, firmId: number, leadId: string): Promise<{
  qualification: QualificationRow | null
  consultation: ConsultationRow | null
  matter: MatterOutcomeRow | null
  history: HistoryRow[]
}> {
  const [[qualification], [consultation], [matter], history] = await Promise.all([
    db.select().from(leadQualifications).where(and(
      eq(leadQualifications.firmId, firmId),
      eq(leadQualifications.leadId, leadId),
    )).limit(1),
    db.select().from(consultations).where(and(
      eq(consultations.firmId, firmId),
      eq(consultations.leadId, leadId),
    )).orderBy(desc(consultations.updatedAt), desc(consultations.id)).limit(1),
    db.select().from(matterOutcomes).where(and(
      eq(matterOutcomes.firmId, firmId),
      eq(matterOutcomes.leadId, leadId),
    )).limit(1),
    db.select().from(leadStatusHistory).where(and(
      eq(leadStatusHistory.firmId, firmId),
      eq(leadStatusHistory.leadId, leadId),
    )).orderBy(asc(leadStatusHistory.createdAt), asc(leadStatusHistory.id)),
  ])
  return {
    qualification: qualification ?? null,
    consultation: consultation ?? null,
    matter: matter ?? null,
    history,
  }
}

async function appendEvent(
  db: Db,
  input: {
    firmId: number
    lead: LeadRow
    fromStatus: LeadLifecycleStatus | null
    toStatus: LeadLifecycleStatus
    actor: string
    reason: string | null
    occurredAt: Date
    previousHistoryId: string | null
    payload?: Record<string, EventJsonValue>
  },
): Promise<void> {
  const key = historyKey([
    input.firmId,
    input.lead.id,
    input.previousHistoryId,
    input.fromStatus,
    input.toStatus,
  ])
  await db.insert(leadStatusHistory).values({
    idempotencyKey: key,
    firmId: input.firmId,
    leadId: input.lead.id,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason,
    actor: input.actor,
    createdAt: input.occurredAt,
  }).onConflictDoNothing({ target: leadStatusHistory.idempotencyKey })

  const payload: Record<string, EventJsonValue> = {
    leadId: input.lead.id,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason,
    caseEntityId: input.lead.caseEntityId,
    contentAssetId: input.lead.contentAssetId,
    publicationId: input.lead.publicationId,
    adExecutionId: input.lead.adExecutionId,
    sessionId: input.lead.sessionId,
    ...(input.payload ?? {}),
  }
  await appendOutboxEvent(db, {
    aggregateType: 'lead_outcome',
    envelope: createEventEnvelope({
      eventType: eventType(input.toStatus),
      aggregateId: input.lead.id,
      firmId: input.firmId,
      actor: input.actor,
      occurredAt: input.occurredAt,
      recordedAt: input.occurredAt,
      correlationId: input.lead.id,
      causationId: input.previousHistoryId,
      idempotencyKey: key,
      payload,
    }),
  })
}

async function ensureCreatedHistory(db: Db, lead: LeadRow, actor: string): Promise<HistoryRow[]> {
  const related = await loadRelated(db, lead.firmId, lead.id)
  if (related.history.length) return related.history
  await appendEvent(db, {
    firmId: lead.firmId,
    lead,
    fromStatus: null,
    toStatus: 'new',
    actor,
    reason: null,
    occurredAt: lead.createdAt,
    previousHistoryId: null,
    payload: { vertical: lead.vertical, slug: lead.slug },
  })
  return (await loadRelated(db, lead.firmId, lead.id)).history
}

export async function getLeadOutcome(
  db: Db,
  firm: number | { id: number },
  leadId: string,
): Promise<LeadOutcomeSnapshot | null> {
  const firmId = firmIdValue(firm)
  const [lead] = await db.select().from(leads).where(and(
    eq(leads.id, leadId),
    eq(leads.firmId, firmId),
  )).limit(1)
  if (!lead) return null
  const related = await loadRelated(db, firmId, leadId)
  return {
    lead,
    status: lifecycleStatus(related.qualification, related.consultation, related.matter),
    qualification: related.qualification,
    consultation: related.consultation,
    matterOutcome: related.matter,
    history: related.history,
  }
}

/** Create the append-only root event for a newly accepted lead. Safe to replay. */
export async function initializeLeadOutcome(
  db: Db,
  input: { firmId: number; leadId: string; actor?: string },
): Promise<LeadOutcomeSnapshot> {
  const firmId = firmIdValue(input.firmId)
  const actor = requiredActor(input.actor ?? 'system:intake')
  await db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const lead = await scopedLead(transactionalDb, firmId, input.leadId)
    await ensureCreatedHistory(transactionalDb, lead, actor)
  })
  const snapshot = await getLeadOutcome(db, firmId, input.leadId)
  if (!snapshot) throw new OutcomePersistenceError('lead disappeared after initialization')
  return snapshot
}

export async function qualifyLeadForFirm(
  db: Db,
  firm: number | { id: number },
  leadId: string,
  input: CommandBase & { status: Exclude<QualificationStatus, 'pending'> },
): Promise<LeadOutcomeSnapshot> {
  const firmId = firmIdValue(firm)
  const actor = requiredActor(input.actor)
  const reason = optionalText(input.reason)
  const occurredAt = input.occurredAt ?? new Date()
  await db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const lead = await scopedLead(transactionalDb, firmId, leadId)
    let history = await ensureCreatedHistory(transactionalDb, lead, actor)
    const related = await loadRelated(transactionalDb, firmId, leadId)
    if (related.qualification) {
      if (related.qualification.status === input.status) return
      throw new OutcomeTransitionError(`qualification is already ${related.qualification.status}`)
    }
    if (lifecycleStatus(null, related.consultation, related.matter) !== 'new') {
      throw new OutcomeTransitionError('lead is no longer awaiting qualification')
    }
    assertQualificationTransition('pending', input.status)
    assertChronology(occurredAt, lead, history)
    await tx.insert(leadQualifications).values({
      firmId,
      leadId,
      status: input.status,
      reason,
      actor,
      decidedAt: occurredAt,
    })
    const toStatus: LeadLifecycleStatus = input.status
    await tx.update(leads).set({ status: legacyLeadStatus(toStatus) }).where(and(
      eq(leads.id, leadId),
      eq(leads.firmId, firmId),
    ))
    const previous = history.at(-1) ?? null
    await appendEvent(transactionalDb, {
      firmId, lead, fromStatus: 'new', toStatus, actor, reason, occurredAt,
      previousHistoryId: previous?.id ?? null,
    })
  })
  const snapshot = await getLeadOutcome(db, firmId, leadId)
  if (!snapshot) throw new OutcomePersistenceError('lead disappeared after qualification')
  return snapshot
}

export async function bookConsultationForFirm(
  db: Db,
  firm: number | { id: number },
  leadId: string,
  input: CommandBase & { scheduledAt?: Date | null },
): Promise<LeadOutcomeSnapshot> {
  const firmId = firmIdValue(firm)
  const actor = requiredActor(input.actor)
  const reason = optionalText(input.reason)
  const occurredAt = input.occurredAt ?? new Date()
  await db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const lead = await scopedLead(transactionalDb, firmId, leadId)
    const history = await ensureCreatedHistory(transactionalDb, lead, actor)
    const related = await loadRelated(transactionalDb, firmId, leadId)
    if (related.matter) throw new OutcomeTransitionError('matter outcome is already recorded')
    if (related.qualification?.status !== 'qualified') {
      throw new OutcomeTransitionError('only a qualified lead can book a consultation')
    }
    if (related.consultation?.status === 'booked') return
    if (related.consultation && !['cancelled', 'no_show'].includes(related.consultation.status)) {
      throw new OutcomeTransitionError(`consultation cannot be booked from ${related.consultation.status}`)
    }
    const fromStatus = lifecycleStatus(related.qualification, related.consultation, null)
    assertChronology(occurredAt, lead, history)
    if (related.consultation) {
      assertConsultationTransition(related.consultation.status as ConsultationStatus, 'booked')
      const updated = await tx.update(consultations).set({
        status: 'booked',
        scheduledAt: input.scheduledAt ?? null,
        completedAt: null,
        updatedAt: occurredAt,
      }).where(and(
        eq(consultations.id, related.consultation.id),
        eq(consultations.firmId, firmId),
        eq(consultations.status, related.consultation.status),
      )).returning({ id: consultations.id })
      if (!updated.length) throw new OutcomeTransitionError('consultation changed concurrently')
    } else {
      await tx.insert(consultations).values({
        firmId,
        leadId,
        status: 'booked',
        scheduledAt: input.scheduledAt ?? null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
    }
    await tx.update(leads).set({ status: legacyLeadStatus('consultation_booked') }).where(and(
      eq(leads.id, leadId), eq(leads.firmId, firmId),
    ))
    await appendEvent(transactionalDb, {
      firmId, lead, fromStatus, toStatus: 'consultation_booked', actor, reason, occurredAt,
      previousHistoryId: history.at(-1)?.id ?? null,
      payload: { scheduledAt: input.scheduledAt?.toISOString() ?? null },
    })
  })
  const snapshot = await getLeadOutcome(db, firmId, leadId)
  if (!snapshot) throw new OutcomePersistenceError('lead disappeared after consultation booking')
  return snapshot
}

export async function transitionConsultationForFirm(
  db: Db,
  firm: number | { id: number },
  leadId: string,
  input: CommandBase & { status: Exclude<ConsultationStatus, 'booked'> },
): Promise<LeadOutcomeSnapshot> {
  const firmId = firmIdValue(firm)
  const actor = requiredActor(input.actor)
  const reason = optionalText(input.reason)
  const occurredAt = input.occurredAt ?? new Date()
  await db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const lead = await scopedLead(transactionalDb, firmId, leadId)
    const history = await ensureCreatedHistory(transactionalDb, lead, actor)
    const related = await loadRelated(transactionalDb, firmId, leadId)
    if (!related.consultation) throw new OutcomeTransitionError('lead has no consultation')
    if (related.consultation.status === input.status) return
    if (related.matter) throw new OutcomeTransitionError('matter outcome is already recorded')
    assertConsultationTransition(related.consultation.status as ConsultationStatus, input.status)
    assertChronology(occurredAt, lead, history)
    const toStatus: LeadLifecycleStatus = input.status === 'completed'
      ? 'consultation_completed'
      : input.status === 'cancelled'
        ? 'consultation_cancelled'
        : 'consultation_no_show'
    const updated = await tx.update(consultations).set({
      status: input.status,
      completedAt: input.status === 'completed' ? occurredAt : related.consultation.completedAt,
      updatedAt: occurredAt,
    }).where(and(
      eq(consultations.id, related.consultation.id),
      eq(consultations.firmId, firmId),
      eq(consultations.status, related.consultation.status),
    )).returning({ id: consultations.id })
    if (!updated.length) throw new OutcomeTransitionError('consultation changed concurrently')
    await tx.update(leads).set({ status: legacyLeadStatus(toStatus) }).where(and(
      eq(leads.id, leadId), eq(leads.firmId, firmId),
    ))
    await appendEvent(transactionalDb, {
      firmId,
      lead,
      fromStatus: lifecycleStatus(related.qualification, related.consultation, null),
      toStatus,
      actor,
      reason,
      occurredAt,
      previousHistoryId: history.at(-1)?.id ?? null,
    })
  })
  const snapshot = await getLeadOutcome(db, firmId, leadId)
  if (!snapshot) throw new OutcomePersistenceError('lead disappeared after consultation transition')
  return snapshot
}

export async function recordMatterOutcomeForFirm(
  db: Db,
  firm: number | { id: number },
  leadId: string,
  input: CommandBase & { status: MatterOutcomeStatus; feeBand?: string | null },
): Promise<LeadOutcomeSnapshot> {
  const firmId = firmIdValue(firm)
  const actor = requiredActor(input.actor)
  const reason = optionalText(input.reason)
  const feeBand = optionalText(input.feeBand)
  const occurredAt = input.occurredAt ?? new Date()
  if (input.status !== 'closed' && !reason) {
    throw new OutcomeValidationError('matter outcome reason is required')
  }
  await db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const lead = await scopedLead(transactionalDb, firmId, leadId)
    const history = await ensureCreatedHistory(transactionalDb, lead, actor)
    const related = await loadRelated(transactionalDb, firmId, leadId)
    if (related.matter) {
      if (related.matter.status === input.status && related.matter.reason === reason && related.matter.feeBand === feeBand) return
      throw new OutcomeTransitionError('matter outcome is already recorded')
    }
    if (!related.consultation || !['booked', 'completed'].includes(related.consultation.status)) {
      throw new OutcomeTransitionError('a booked or completed consultation is required')
    }
    assertChronology(occurredAt, lead, history)
    const toStatus: LeadLifecycleStatus = input.status === 'retained'
      ? 'matter_retained'
      : input.status === 'not_retained'
        ? 'matter_not_retained'
        : 'matter_closed'
    await tx.insert(matterOutcomes).values({
      firmId,
      leadId,
      consultationId: related.consultation.id,
      status: input.status,
      reason,
      feeBand,
      decidedAt: occurredAt,
      updatedAt: occurredAt,
    })
    await tx.update(leads).set({ status: legacyLeadStatus(toStatus) }).where(and(
      eq(leads.id, leadId), eq(leads.firmId, firmId),
    ))
    await appendEvent(transactionalDb, {
      firmId,
      lead,
      fromStatus: lifecycleStatus(related.qualification, related.consultation, null),
      toStatus,
      actor,
      reason,
      occurredAt,
      previousHistoryId: history.at(-1)?.id ?? null,
      payload: { feeBand, consultationId: related.consultation.id },
    })
  })
  const snapshot = await getLeadOutcome(db, firmId, leadId)
  if (!snapshot) throw new OutcomePersistenceError('lead disappeared after matter outcome')
  return snapshot
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function hasCanonicalAttribution(lead: LeadRow): boolean {
  return Boolean(
    lead.sessionId
    && lead.caseEntityId
    && lead.contentAssetId
    && lead.publicationId,
  )
}

export async function outcomeSummaryForFirm(
  db: Db,
  firm: number | { id: number },
  options: { since?: Date; vertical?: string } = {},
): Promise<OutcomeSummary> {
  const firmId = firmIdValue(firm)
  const leadFilters = [eq(leads.firmId, firmId)]
  if (options.since) leadFilters.push(gte(leads.createdAt, options.since))
  if (options.vertical) leadFilters.push(eq(leads.vertical, options.vertical))
  const leadRows = await db.select().from(leads).where(and(...leadFilters))
  const leadIds = new Set(leadRows.map((lead) => lead.id))
  const [qualificationRows, consultationRows, matterRows] = await Promise.all([
    db.select().from(leadQualifications).where(eq(leadQualifications.firmId, firmId)),
    db.select().from(consultations).where(eq(consultations.firmId, firmId)).orderBy(desc(consultations.updatedAt)),
    db.select().from(matterOutcomes).where(eq(matterOutcomes.firmId, firmId)),
  ])
  const qualifications = qualificationRows.filter((row) => leadIds.has(row.leadId))
  const latestConsultation = new Map<string, ConsultationRow>()
  for (const row of consultationRows) if (leadIds.has(row.leadId) && !latestConsultation.has(row.leadId)) latestConsultation.set(row.leadId, row)
  const matters = matterRows.filter((row) => leadIds.has(row.leadId))
  const qualifiedIds = new Set(qualifications.filter((row) => row.status === 'qualified').map((row) => row.leadId))
  const retainedIds = new Set(matters.filter((row) => row.status === 'retained').map((row) => row.leadId))
  const attributedQualifiedLeads = leadRows.filter((lead) => qualifiedIds.has(lead.id) && hasCanonicalAttribution(lead)).length
  const attributedRetainedMatters = leadRows.filter((lead) => retainedIds.has(lead.id) && hasCanonicalAttribution(lead)).length
  const feeBands: Record<string, number> = {}
  for (const row of matters) if (row.feeBand) feeBands[row.feeBand] = (feeBands[row.feeBand] ?? 0) + 1
  const consultationsBooked = latestConsultation.size
  const retainedMatters = retainedIds.size
  const summary: OutcomeSummary = {
    totalLeads: leadRows.length,
    qualifiedLeads: qualifiedIds.size,
    unqualifiedLeads: qualifications.filter((row) => row.status === 'unqualified').length,
    consultationsBooked,
    consultationsCompleted: [...latestConsultation.values()].filter((row) => row.status === 'completed').length,
    consultationsCancelled: [...latestConsultation.values()].filter((row) => row.status === 'cancelled').length,
    consultationsNoShow: [...latestConsultation.values()].filter((row) => row.status === 'no_show').length,
    retainedMatters,
    notRetainedMatters: matters.filter((row) => row.status === 'not_retained').length,
    closedMatters: matters.filter((row) => row.status === 'closed').length,
    mattersWithFeeBand: matters.filter((row) => Boolean(row.feeBand)).length,
    attributedQualifiedLeads,
    attributedRetainedMatters,
    qualificationRate: ratio(qualifiedIds.size, leadRows.length),
    consultationRate: ratio(consultationsBooked, qualifiedIds.size),
    retentionRate: ratio(retainedMatters, consultationsBooked),
    attributionRate: ratio(attributedQualifiedLeads, qualifiedIds.size),
    feeBands,
  }
  return summary
}
