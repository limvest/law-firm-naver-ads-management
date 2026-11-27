/**
 * Pure lead qualification, consultation, and matter-outcome lifecycle.
 *
 * This module deliberately has no persistence or route dependency.  A caller
 * loads a lead aggregate, applies one of the commands below, and persists the
 * returned immutable snapshot elsewhere.  Acquisition signals are kept
 * separate from outcome decisions: a form submission is evidence that a lead
 * was created, and a call click is evidence of intent, but neither is a
 * qualification or a consultation.
 */

export type OutcomeId = string | number
export type FirmId = OutcomeId
export type OutcomeTimestamp = Date | string | number
export type OutcomeActor = string | Readonly<Record<string, unknown>>

export const QUALIFICATION_STATUSES = [
  'pending',
  'qualified',
  'unqualified',
] as const

export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number]

export const CONSULTATION_STATUSES = [
  'booked',
  'completed',
  'cancelled',
  'no_show',
] as const

export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number]

export const MATTER_OUTCOME_STATUSES = [
  'retained',
  'not_retained',
  'closed',
] as const

export type MatterOutcomeStatus = (typeof MATTER_OUTCOME_STATUSES)[number]

/**
 * The aggregate status graph mirrors the event chain in the product
 * architecture.  Matter outcomes may be recorded after a booking or a
 * completed consultation because the target schema permits a booked
 * consultation to be the point at which a firm records an outcome.
 */
export const LEAD_LIFECYCLE_STATUSES = [
  'new',
  'qualified',
  'unqualified',
  'consultation_booked',
  'consultation_completed',
  'consultation_cancelled',
  'consultation_no_show',
  'matter_retained',
  'matter_not_retained',
  'matter_closed',
] as const

export type LeadLifecycleStatus = (typeof LEAD_LIFECYCLE_STATUSES)[number]
export type LeadOutcomeStatus = LeadLifecycleStatus

export const QUALIFICATION_TRANSITIONS: Readonly<
  Record<QualificationStatus, readonly QualificationStatus[]>
> = {
  pending: ['qualified', 'unqualified'],
  qualified: [],
  unqualified: [],
}

export const CONSULTATION_TRANSITIONS: Readonly<
  Record<ConsultationStatus, readonly ConsultationStatus[]>
> = {
  booked: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: ['booked'],
  no_show: ['booked'],
}

/** Matter outcomes are terminal once recorded. */
export const MATTER_OUTCOME_TRANSITIONS: Readonly<
  Record<MatterOutcomeStatus, readonly MatterOutcomeStatus[]>
> = {
  retained: [],
  not_retained: [],
  closed: [],
}

export const LEAD_LIFECYCLE_TRANSITIONS: Readonly<
  Record<LeadLifecycleStatus, readonly LeadLifecycleStatus[]>
> = {
  new: ['qualified', 'unqualified'],
  qualified: ['consultation_booked'],
  unqualified: [],
  consultation_booked: [
    'consultation_completed',
    'consultation_cancelled',
    'consultation_no_show',
    'matter_retained',
    'matter_not_retained',
    'matter_closed',
  ],
  consultation_completed: [
    'matter_retained',
    'matter_not_retained',
    'matter_closed',
  ],
  consultation_cancelled: ['consultation_booked'],
  consultation_no_show: ['consultation_booked'],
  matter_retained: [],
  matter_not_retained: [],
  matter_closed: [],
}

// Compatibility-friendly aliases for callers that call this the outcome
// graph rather than the lead graph.
export const LEAD_OUTCOME_STATUSES = LEAD_LIFECYCLE_STATUSES
export const LEAD_STATUSES = LEAD_LIFECYCLE_STATUSES
export const OUTCOME_STATUSES = LEAD_LIFECYCLE_STATUSES
export const LEAD_OUTCOME_TRANSITIONS = LEAD_LIFECYCLE_TRANSITIONS
export const LEAD_STATUS_TRANSITIONS = LEAD_LIFECYCLE_TRANSITIONS
export const OUTCOME_TRANSITIONS = LEAD_LIFECYCLE_TRANSITIONS
export const QUALIFICATION_ALLOWED_TRANSITIONS = QUALIFICATION_TRANSITIONS
export const QUALIFICATION_STATUS_TRANSITIONS = QUALIFICATION_TRANSITIONS
export const CONSULTATION_ALLOWED_TRANSITIONS = CONSULTATION_TRANSITIONS
export const CONSULTATION_STATUS_TRANSITIONS = CONSULTATION_TRANSITIONS
export const MATTER_OUTCOME_ALLOWED_TRANSITIONS = MATTER_OUTCOME_TRANSITIONS
export const MATTER_STATUS_TRANSITIONS = MATTER_OUTCOME_TRANSITIONS

export const FUNNEL_SIGNAL_TYPES = [
  'page_view',
  'call_click',
  'kakao_click',
  'form_step',
  'form_submit',
] as const

export type FunnelSignalType = (typeof FUNNEL_SIGNAL_TYPES)[number]

export const OUTCOME_EVENT_TYPES = [
  'lead.created',
  'lead.qualified',
  'lead.unqualified',
  'consultation.booked',
  'consultation.completed',
  'consultation.cancelled',
  'consultation.no_show',
  'matter.retained',
  'matter.not_retained',
  'matter.closed',
] as const

export type OutcomeEventType = (typeof OUTCOME_EVENT_TYPES)[number]

export class OutcomeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutcomeValidationError'
  }
}

export class OutcomeTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutcomeTransitionError'
  }
}

export class FirmIsolationError extends Error {
  readonly code = 'OUTCOME_FIRM_MISMATCH'

  constructor(message: string) {
    super(message)
    this.name = 'FirmIsolationError'
  }
}

// The aliases make the scope guard discoverable from either the outcome or
// tenancy vocabulary without introducing a second error type.
export { FirmIsolationError as OutcomeScopeError }
export { FirmIsolationError as OutcomeFirmIsolationError }

export interface OutcomeCommandOptions {
  readonly firmId?: FirmId
  readonly leadId?: OutcomeId
  readonly actor?: OutcomeActor
  readonly eventId?: OutcomeId
  readonly id?: OutcomeId
  readonly occurredAt?: OutcomeTimestamp | null
  readonly recordedAt?: OutcomeTimestamp | null
  readonly createdAt?: OutcomeTimestamp | null
  readonly at?: OutcomeTimestamp | null
  readonly reason?: string | null
}

export interface FunnelSignal {
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  readonly type: FunnelSignalType
  readonly eventType: FunnelSignalType
  readonly occurredAt: string | null
}

export interface FunnelSignalInput {
  readonly firmId?: FirmId | null
  readonly leadId?: OutcomeId | null
  readonly type?: FunnelSignalType | string | null
  readonly eventType?: FunnelSignalType | string | null
  readonly occurredAt?: OutcomeTimestamp | null
  readonly timestamp?: OutcomeTimestamp | null
  readonly createdAt?: OutcomeTimestamp | null
}

export interface QualificationRecord {
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  readonly status: QualificationStatus
  readonly reason: string | null
  readonly actor: OutcomeActor
  readonly decidedAt: string | null
}

export interface ConsultationRecord {
  readonly id: OutcomeId
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  readonly status: ConsultationStatus
  readonly scheduledAt: string | null
  readonly bookedAt: string | null
  readonly completedAt: string | null
  readonly updatedAt: string | null
  readonly actor: OutcomeActor
}

export interface MatterOutcomeRecord {
  readonly id: OutcomeId
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  readonly consultationId: OutcomeId | null
  readonly status: MatterOutcomeStatus
  readonly reason: string | null
  readonly feeBand: string | null
  readonly decidedAt: string | null
  readonly updatedAt: string | null
  readonly actor: OutcomeActor
}

export interface StatusHistoryEvent {
  readonly id: string
  readonly eventId: string
  readonly eventType: OutcomeEventType
  readonly aggregateId: OutcomeId
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  readonly fromStatus: LeadLifecycleStatus | null
  readonly toStatus: LeadLifecycleStatus
  readonly reason: string | null
  readonly actor: OutcomeActor
  readonly occurredAt: string | null
  readonly recordedAt: string | null
  /** Non-enumerable compatibility aliases for event-oriented consumers. */
  readonly type: OutcomeEventType
  readonly from: LeadLifecycleStatus | null
  readonly to: LeadLifecycleStatus
  readonly createdAt: string | null
}

export type LeadStatusHistoryEvent = StatusHistoryEvent
export type OutcomeStatusHistoryEvent = StatusHistoryEvent

export interface LeadOutcomeLifecycle {
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  readonly status: LeadLifecycleStatus
  readonly qualification: QualificationRecord
  readonly consultation: ConsultationRecord | null
  readonly matterOutcome: MatterOutcomeRecord | null
  readonly signals: readonly FunnelSignal[]
  readonly statusHistory: readonly StatusHistoryEvent[]
  /** Alias for consumers that call the append-only list simply `history`. */
  readonly history: readonly StatusHistoryEvent[]
}

export type OutcomeLifecycle = LeadOutcomeLifecycle
export type LeadLifecycle = LeadOutcomeLifecycle

export interface CreateLeadLifecycleInput {
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  readonly actor?: OutcomeActor
  readonly eventId?: OutcomeId
  readonly occurredAt?: OutcomeTimestamp | null
  readonly recordedAt?: OutcomeTimestamp | null
  readonly signals?: readonly (FunnelSignalInput | FunnelSignalType | string)[]
  readonly events?: readonly (FunnelSignalInput | FunnelSignalType | string)[]
  readonly touchpoints?: readonly (FunnelSignalInput | FunnelSignalType | string)[]
}

export interface QualifyLeadInput extends OutcomeCommandOptions {
  readonly status?: Exclude<QualificationStatus, 'pending'>
  readonly decision?: Exclude<QualificationStatus, 'pending'>
  readonly qualified?: boolean
  readonly isQualified?: boolean
  /** Browser/source events are never qualification decisions. */
  readonly source?: FunnelSignalType | string | null
  readonly eventType?: FunnelSignalType | string | null
}

export interface BookConsultationInput extends OutcomeCommandOptions {
  readonly consultationId?: OutcomeId
  readonly scheduledAt?: OutcomeTimestamp | null
  readonly bookedAt?: OutcomeTimestamp | null
  /** `call_click` and `form_submit` are intentionally rejected here. */
  readonly source?: FunnelSignalType | string | null
  readonly eventType?: FunnelSignalType | string | null
}

export interface ConsultationTransitionInput extends OutcomeCommandOptions {
  readonly completedAt?: OutcomeTimestamp | null
  readonly updatedAt?: OutcomeTimestamp | null
}

export interface RecordMatterOutcomeInput extends OutcomeCommandOptions {
  readonly status: MatterOutcomeStatus
  readonly consultationId?: OutcomeId | null
  readonly feeBand?: string | null
  readonly retainedReason?: string | null
  readonly notRetainedReason?: string | null
  readonly decidedAt?: OutcomeTimestamp | null
  readonly updatedAt?: OutcomeTimestamp | null
}

export interface FunnelSnapshotInput {
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  readonly status?: LeadLifecycleStatus | string | null
  readonly qualification?:
    | Pick<QualificationRecord, 'status'>
    | { readonly status?: string | null; readonly qualified?: boolean | null }
    | null
  readonly consultation?:
    | Pick<ConsultationRecord, 'status'>
    | { readonly status?: string | null }
    | null
  readonly matterOutcome?:
    | Pick<MatterOutcomeRecord, 'status' | 'feeBand'>
    | { readonly status?: string | null; readonly feeBand?: string | null }
    | null
  readonly signals?: readonly (FunnelSignalInput | FunnelSignalType | string)[]
  readonly events?: readonly (FunnelSignalInput | FunnelSignalType | string)[]
  readonly touchpoints?: readonly (FunnelSignalInput | FunnelSignalType | string)[]
  readonly statusHistory?: readonly StatusHistoryInput[]
  readonly qualified?: boolean | null
  readonly isQualified?: boolean | null
  readonly retained?: boolean | null
  readonly isRetained?: boolean | null
}

export type FunnelRecord = LeadOutcomeLifecycle | FunnelSnapshotInput

export interface StatusHistoryInput {
  readonly firmId?: FirmId | null
  readonly leadId?: OutcomeId | null
  readonly aggregateId?: OutcomeId | null
  readonly eventType?: string | null
  readonly type?: string | null
  readonly fromStatus?: LeadLifecycleStatus | string | null
  readonly toStatus?: LeadLifecycleStatus | string | null
  readonly from?: LeadLifecycleStatus | string | null
  readonly to?: LeadLifecycleStatus | string | null
}

export interface FunnelSummaryOptions {
  readonly firmId?: FirmId
}

export interface FunnelSummary {
  readonly totalLeads: number
  readonly formSubmits: number
  readonly callClicks: number
  readonly qualifiedLeads: number
  readonly unqualifiedLeads: number
  readonly consultationsBooked: number
  readonly consultationsCompleted: number
  readonly consultationsCancelled: number
  readonly consultationsNoShow: number
  readonly retainedMatters: number
  readonly notRetainedMatters: number
  readonly closedMatters: number
  readonly mattersWithFeeBand: number
  readonly qualificationRate: number | null
  readonly consultationRate: number | null
  readonly retentionRate: number | null
}

const QUALIFICATION_STATUS_SET: ReadonlySet<string> = new Set(QUALIFICATION_STATUSES)
const CONSULTATION_STATUS_SET: ReadonlySet<string> = new Set(CONSULTATION_STATUSES)
const MATTER_STATUS_SET: ReadonlySet<string> = new Set(MATTER_OUTCOME_STATUSES)
const LIFECYCLE_STATUS_SET: ReadonlySet<string> = new Set(LEAD_LIFECYCLE_STATUSES)
const SIGNAL_TYPE_SET: ReadonlySet<string> = new Set(FUNNEL_SIGNAL_TYPES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new OutcomeValidationError('circular values are not supported')
    seen.add(value)
    const clone = value.map((item) => cloneValue(item, seen)) as T
    seen.delete(value)
    return clone
  }

  if (isRecord(value)) {
    if (seen.has(value)) throw new OutcomeValidationError('circular values are not supported')
    seen.add(value)
    const clone: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) clone[key] = cloneValue(child, seen)
    seen.delete(value)
    return clone as T
  }

  return value
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value as object)) return value
  seen.add(value as object)
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return value
}

function validId(value: unknown): value is OutcomeId {
  if (typeof value === 'string') return value.trim().length > 0
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function normalizeId(value: unknown, label: string): OutcomeId {
  if (!validId(value)) throw new OutcomeValidationError(`${label} must be a non-empty string or non-negative integer`)
  return typeof value === 'string' ? value.trim() : value
}

function idKey(value: OutcomeId): string {
  return String(value).trim()
}

function normalizeTimestamp(value: OutcomeTimestamp | null | undefined, label: string): string | null {
  if (value === undefined || value === null) return null
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new OutcomeValidationError(`${label} must be a valid timestamp`)
  return date.toISOString()
}

function normalizeText(value: string | null | undefined, label: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new OutcomeValidationError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw new OutcomeValidationError(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized && required) throw new OutcomeValidationError(`${label} is required`)
  return normalized || null
}

function normalizeActor(actor: OutcomeActor | undefined): OutcomeActor {
  if (actor === undefined) return 'system'
  if (typeof actor === 'string') {
    const normalized = actor.trim()
    if (!normalized) throw new OutcomeValidationError('actor must not be empty')
    return normalized
  }
  if (!isRecord(actor)) throw new OutcomeValidationError('actor must be a non-empty string or object')
  if (Object.keys(actor).length === 0) throw new OutcomeValidationError('actor must not be empty')
  return cloneValue(actor)
}

function normalizeFirmId(value: unknown, label = 'firmId'): FirmId {
  return normalizeId(value, label)
}

function normalizeLeadId(value: unknown, label = 'leadId'): OutcomeId {
  return normalizeId(value, label)
}

function isSameFirmValue(a: FirmId, b: FirmId): boolean {
  return idKey(a) === idKey(b)
}

/** Compare tenant IDs without allowing a lead ID or slug to cross firms. */
export function isSameFirm(a: FirmId, b: FirmId): boolean {
  return isSameFirmValue(normalizeFirmId(a, 'firm id'), normalizeFirmId(b, 'firm id'))
}

/** Assert that two records are in the same firm before combining them. */
export function assertFirmIsolation(
  expectedFirmId: FirmId,
  actualFirmId: FirmId,
  subject = 'outcome',
): void {
  const expected = normalizeFirmId(expectedFirmId, 'expected firm id')
  const actual = normalizeFirmId(actualFirmId, 'actual firm id')
  if (!isSameFirmValue(expected, actual)) {
    throw new FirmIsolationError(`${subject} belongs to firm ${actual}, not ${expected}`)
  }
}

export const assertSameFirm = assertFirmIsolation
export const assertFirmScope = assertFirmIsolation
export const assertFirmAccess = assertFirmIsolation

export function assertLeadIsolation(
  expected: Pick<LeadOutcomeLifecycle, 'firmId' | 'leadId'>,
  actual: Pick<LeadOutcomeLifecycle, 'firmId' | 'leadId'>,
): void {
  assertFirmIsolation(expected.firmId, actual.firmId, 'lead')
  if (idKey(normalizeLeadId(expected.leadId, 'expected lead id')) !== idKey(normalizeLeadId(actual.leadId, 'actual lead id'))) {
    throw new FirmIsolationError(`expected lead ${actual.leadId} to be ${expected.leadId}`)
  }
}

function signalType(value: unknown): FunnelSignalType {
  if (typeof value !== 'string' || !SIGNAL_TYPE_SET.has(value)) {
    throw new OutcomeValidationError(
      `unknown funnel signal; expected one of ${FUNNEL_SIGNAL_TYPES.join(', ')}`,
    )
  }
  return value as FunnelSignalType
}

function statusEventType(status: LeadLifecycleStatus): OutcomeEventType {
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

function isLifecycleStatus(value: unknown): value is LeadLifecycleStatus {
  return typeof value === 'string' && LIFECYCLE_STATUS_SET.has(value)
}

function makeHistoryEvent(
  lifecycle: Pick<LeadOutcomeLifecycle, 'firmId' | 'leadId' | 'statusHistory'>,
  fromStatus: LeadLifecycleStatus | null,
  toStatus: LeadLifecycleStatus,
  options: OutcomeCommandOptions = {},
): StatusHistoryEvent {
  const eventId = normalizeId(
    options.eventId ?? options.id ?? `${lifecycle.leadId}:status:${lifecycle.statusHistory.length + 1}`,
    'event id',
  )
  const eventIdString = String(eventId)
  const occurredAt = normalizeTimestamp(
    options.occurredAt ?? options.at ?? options.createdAt,
    'occurredAt',
  )
  const recordedAt = normalizeTimestamp(options.recordedAt, 'recordedAt') ?? occurredAt
  const event = {
    id: eventIdString,
    eventId: eventIdString,
    eventType: statusEventType(toStatus),
    aggregateId: lifecycle.leadId,
    firmId: lifecycle.firmId,
    leadId: lifecycle.leadId,
    fromStatus,
    toStatus,
    reason: normalizeText(options.reason, 'reason'),
    actor: normalizeActor(options.actor),
    occurredAt,
    recordedAt,
  } as StatusHistoryEvent
  Object.defineProperties(event, {
    type: { value: event.eventType },
    from: { value: event.fromStatus },
    to: { value: event.toStatus },
    createdAt: { value: event.recordedAt },
  })
  return deepFreeze(event)
}

function cloneQualification(record: QualificationRecord): QualificationRecord {
  return {
    firmId: record.firmId,
    leadId: record.leadId,
    status: record.status,
    reason: record.reason,
    actor: cloneValue(record.actor),
    decidedAt: record.decidedAt,
  }
}

function cloneConsultation(record: ConsultationRecord | null): ConsultationRecord | null {
  if (!record) return null
  return {
    id: record.id,
    firmId: record.firmId,
    leadId: record.leadId,
    status: record.status,
    scheduledAt: record.scheduledAt,
    bookedAt: record.bookedAt,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt,
    actor: cloneValue(record.actor),
  }
}

function cloneMatterOutcome(record: MatterOutcomeRecord | null): MatterOutcomeRecord | null {
  if (!record) return null
  return {
    id: record.id,
    firmId: record.firmId,
    leadId: record.leadId,
    consultationId: record.consultationId,
    status: record.status,
    reason: record.reason,
    feeBand: record.feeBand,
    decidedAt: record.decidedAt,
    updatedAt: record.updatedAt,
    actor: cloneValue(record.actor),
  }
}

function cloneHistoryEvent(event: StatusHistoryEvent): StatusHistoryEvent {
  const clone = {
    ...event,
    actor: cloneValue(event.actor),
  } as unknown as StatusHistoryEvent
  Object.defineProperties(clone, {
    type: { value: event.type ?? event.eventType },
    from: { value: event.from ?? event.fromStatus },
    to: { value: event.to ?? event.toStatus },
    createdAt: { value: event.createdAt ?? event.recordedAt },
  })
  return clone
}

function createSignal(
  lifecycle: Pick<LeadOutcomeLifecycle, 'firmId' | 'leadId'>,
  input: FunnelSignalInput | FunnelSignalType | string,
): FunnelSignal {
  const source: FunnelSignalInput = typeof input === 'string'
    ? { type: input }
    : input
  if (source.firmId !== undefined && source.firmId !== null) {
    assertFirmIsolation(lifecycle.firmId, source.firmId, 'funnel signal')
  }
  if (source.leadId !== undefined && source.leadId !== null) {
    if (idKey(normalizeLeadId(source.leadId, 'signal lead id')) !== idKey(lifecycle.leadId)) {
      throw new FirmIsolationError(`funnel signal belongs to lead ${source.leadId}, not ${lifecycle.leadId}`)
    }
  }
  const type = signalType(source.type ?? source.eventType)
  const occurredAt = normalizeTimestamp(
    source.occurredAt ?? source.timestamp ?? source.createdAt,
    'signal occurredAt',
  )
  return deepFreeze({
    firmId: lifecycle.firmId,
    leadId: lifecycle.leadId,
    type,
    eventType: type,
    occurredAt,
  })
}

function lifecycleSnapshot(input: {
  firmId: FirmId
  leadId: OutcomeId
  status: LeadLifecycleStatus
  qualification: QualificationRecord
  consultation: ConsultationRecord | null
  matterOutcome: MatterOutcomeRecord | null
  signals: readonly FunnelSignal[]
  statusHistory: readonly StatusHistoryEvent[]
}): LeadOutcomeLifecycle {
  const statusHistory = input.statusHistory.map(cloneHistoryEvent)
  const lifecycle = {
    firmId: input.firmId,
    leadId: input.leadId,
    status: input.status,
    qualification: cloneQualification(input.qualification),
    consultation: cloneConsultation(input.consultation),
    matterOutcome: cloneMatterOutcome(input.matterOutcome),
    signals: input.signals.map((signal) => ({ ...signal })),
    statusHistory,
  } as unknown as LeadOutcomeLifecycle
  Object.defineProperty(lifecycle, 'history', { value: statusHistory })
  return deepFreeze(lifecycle)
}

function assertLifecycleScope(lifecycle: LeadOutcomeLifecycle): void {
  normalizeFirmId(lifecycle.firmId)
  normalizeLeadId(lifecycle.leadId)
  assertFirmIsolation(lifecycle.firmId, lifecycle.qualification.firmId, 'qualification')
  if (idKey(normalizeLeadId(lifecycle.qualification.leadId)) !== idKey(lifecycle.leadId)) {
    throw new FirmIsolationError('qualification does not belong to the lead')
  }
  if (lifecycle.consultation) {
    assertFirmIsolation(lifecycle.firmId, lifecycle.consultation.firmId, 'consultation')
    if (idKey(normalizeLeadId(lifecycle.consultation.leadId)) !== idKey(lifecycle.leadId)) {
      throw new FirmIsolationError('consultation does not belong to the lead')
    }
  }
  if (lifecycle.matterOutcome) {
    assertFirmIsolation(lifecycle.firmId, lifecycle.matterOutcome.firmId, 'matter outcome')
    if (idKey(normalizeLeadId(lifecycle.matterOutcome.leadId)) !== idKey(lifecycle.leadId)) {
      throw new FirmIsolationError('matter outcome does not belong to the lead')
    }
    if (lifecycle.consultation && lifecycle.matterOutcome.consultationId !== null) {
      if (idKey(normalizeId(lifecycle.matterOutcome.consultationId, 'matter consultation id')) !== idKey(lifecycle.consultation.id)) {
        throw new FirmIsolationError('matter outcome references another consultation')
      }
    }
  }
  for (const signal of lifecycle.signals) {
    assertFirmIsolation(lifecycle.firmId, signal.firmId, 'funnel signal')
    if (idKey(normalizeLeadId(signal.leadId, 'signal lead id')) !== idKey(lifecycle.leadId)) {
      throw new FirmIsolationError('funnel signal does not belong to the lead')
    }
  }
  for (const event of lifecycle.statusHistory) {
    assertFirmIsolation(lifecycle.firmId, event.firmId, 'status history')
    if (idKey(normalizeLeadId(event.leadId, 'history lead id')) !== idKey(lifecycle.leadId)) {
      throw new FirmIsolationError('status history does not belong to the lead')
    }
  }
}

function appendLifecycleTransition(
  lifecycle: LeadOutcomeLifecycle,
  toStatus: LeadLifecycleStatus,
  options: OutcomeCommandOptions = {},
  patch: Partial<Pick<LeadOutcomeLifecycle, 'qualification' | 'consultation' | 'matterOutcome'>> = {},
): LeadOutcomeLifecycle {
  assertLifecycleScope(lifecycle)
  assertLeadTransition(lifecycle.status, toStatus)
  const event = makeHistoryEvent(lifecycle, lifecycle.status, toStatus, options)
  return lifecycleSnapshot({
    firmId: lifecycle.firmId,
    leadId: lifecycle.leadId,
    status: toStatus,
    qualification: patch.qualification ?? lifecycle.qualification,
    consultation: patch.consultation === undefined ? lifecycle.consultation : patch.consultation,
    matterOutcome: patch.matterOutcome === undefined ? lifecycle.matterOutcome : patch.matterOutcome,
    signals: lifecycle.signals,
    statusHistory: [...lifecycle.statusHistory, event],
  })
}

/** Return whether an edge exists in the documented aggregate graph. */
export function canTransitionLead(
  from: LeadLifecycleStatus,
  to: LeadLifecycleStatus,
): boolean {
  return LEAD_LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false
}

export const canTransitionLeadLifecycle = canTransitionLead
export const canTransitionOutcome = canTransitionLead
export const canTransition = canTransitionLead

export function assertLeadTransition(from: LeadLifecycleStatus, to: LeadLifecycleStatus): void {
  if (!canTransitionLead(from, to)) {
    throw new OutcomeTransitionError(`illegal lead outcome transition: ${from} → ${to}`)
  }
}

export const assertLeadLifecycleTransition = assertLeadTransition
export const assertOutcomeTransition = assertLeadTransition
export const assertTransition = assertLeadTransition

export function transitionLeadLifecycle(
  lifecycle: LeadOutcomeLifecycle,
  toStatus: LeadLifecycleStatus,
  options: OutcomeCommandOptions = {},
): LeadOutcomeLifecycle {
  return appendLifecycleTransition(lifecycle, toStatus, options)
}

export const transitionOutcome = transitionLeadLifecycle
export const transition = transitionLeadLifecycle

/** Status-only form, matching the state helpers in the other pure domains. */
export function transitionLeadStatusOnly(
  from: LeadLifecycleStatus,
  to: LeadLifecycleStatus,
): LeadLifecycleStatus {
  assertLeadTransition(from, to)
  return to
}

export const applyLeadStatusTransition = transitionLeadStatusOnly

export function transitionLeadStatus(
  lifecycle: LeadOutcomeLifecycle,
  toStatus: LeadLifecycleStatus,
  options?: OutcomeCommandOptions,
): LeadOutcomeLifecycle
export function transitionLeadStatus(
  from: LeadLifecycleStatus,
  to: LeadLifecycleStatus,
): LeadLifecycleStatus
export function transitionLeadStatus(
  first: LeadOutcomeLifecycle | LeadLifecycleStatus,
  second: LeadLifecycleStatus,
  options: OutcomeCommandOptions = {},
): LeadOutcomeLifecycle | LeadLifecycleStatus {
  if (typeof first === 'string') return transitionLeadStatusOnly(first, second)
  return transitionLeadLifecycle(first, second, options)
}

export function canTransitionQualification(
  from: QualificationStatus,
  to: QualificationStatus,
): boolean {
  return QUALIFICATION_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertQualificationTransition(
  from: QualificationStatus,
  to: QualificationStatus,
): void {
  if (!canTransitionQualification(from, to)) {
    throw new OutcomeTransitionError(`illegal qualification transition: ${from} → ${to}`)
  }
}

export function transitionQualificationStatus(
  from: QualificationStatus,
  to: QualificationStatus,
): QualificationStatus {
  assertQualificationTransition(from, to)
  return to
}

export function canTransitionConsultation(
  from: ConsultationStatus,
  to: ConsultationStatus,
): boolean {
  return CONSULTATION_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertConsultationTransition(
  from: ConsultationStatus,
  to: ConsultationStatus,
): void {
  if (!canTransitionConsultation(from, to)) {
    throw new OutcomeTransitionError(`illegal consultation transition: ${from} → ${to}`)
  }
}

export function transitionConsultationStatusOnly(
  from: ConsultationStatus,
  to: ConsultationStatus,
): ConsultationStatus {
  assertConsultationTransition(from, to)
  return to
}

export function canTransitionMatterOutcome(
  from: MatterOutcomeStatus,
  to: MatterOutcomeStatus,
): boolean {
  return MATTER_OUTCOME_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertMatterOutcomeTransition(
  from: MatterOutcomeStatus,
  to: MatterOutcomeStatus,
): void {
  if (!canTransitionMatterOutcome(from, to)) {
    throw new OutcomeTransitionError(`illegal matter outcome transition: ${from} → ${to}`)
  }
}

export function transitionMatterOutcomeStatus(
  from: MatterOutcomeStatus,
  to: MatterOutcomeStatus,
): MatterOutcomeStatus {
  assertMatterOutcomeTransition(from, to)
  return to
}

/** Create a pending lead.  Initial signals never infer a qualification. */
export function createLeadLifecycle(input: CreateLeadLifecycleInput): LeadOutcomeLifecycle {
  const firmId = normalizeFirmId(input.firmId)
  const leadId = normalizeLeadId(input.leadId)
  const initial: LeadOutcomeLifecycle = {
    firmId,
    leadId,
    status: 'new',
    qualification: {
      firmId,
      leadId,
      status: 'pending',
      reason: null,
      actor: normalizeActor(input.actor),
      decidedAt: null,
    },
    consultation: null,
    matterOutcome: null,
    signals: [],
    statusHistory: [],
    history: [],
  }
  const createdEvent = makeHistoryEvent(initial, null, 'new', {
    eventId: input.eventId,
    actor: input.actor,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
  })
  let lifecycle = lifecycleSnapshot({ ...initial, statusHistory: [createdEvent] })
  const signals = [
    ...(input.signals ?? []),
    ...(input.events ?? []),
    ...(input.touchpoints ?? []),
  ]
  for (const signal of signals) lifecycle = recordFunnelSignal(lifecycle, signal)
  return lifecycle
}

export const createLeadOutcomeLifecycle = createLeadLifecycle
export const createOutcomeLifecycle = createLeadLifecycle
export const createLead = createLeadLifecycle

function commandOptionValue(
  input: QualifyLeadInput | string | boolean,
): { decision: Exclude<QualificationStatus, 'pending'>; options: OutcomeCommandOptions; source?: string | null } {
  if (typeof input === 'boolean') return { decision: input ? 'qualified' : 'unqualified', options: {} }
  if (typeof input === 'string') {
    if (input !== 'qualified' && input !== 'unqualified') {
      throw new OutcomeValidationError('qualification decision must be qualified or unqualified')
    }
    return { decision: input, options: {} }
  }
  const decision = input.status
    ?? input.decision
    ?? (input.qualified === true || input.isQualified === true
      ? 'qualified'
      : input.qualified === false || input.isQualified === false
        ? 'unqualified'
        : undefined)
  if (decision !== 'qualified' && decision !== 'unqualified') {
    throw new OutcomeValidationError('qualification decision must be qualified or unqualified')
  }
  return { decision, options: input, source: input.source ?? input.eventType }
}

export function qualifyLead(
  lifecycle: LeadOutcomeLifecycle,
  input: QualifyLeadInput | Exclude<QualificationStatus, 'pending'> | boolean,
): LeadOutcomeLifecycle {
  assertLifecycleScope(lifecycle)
  const parsed = commandOptionValue(input)
  if (parsed.source === 'form_submit' || parsed.source === 'call_click') {
    throw new OutcomeValidationError('a funnel signal is not a qualification decision')
  }
  if (lifecycle.qualification.status !== 'pending' || lifecycle.status !== 'new') {
    throw new OutcomeTransitionError(`lead cannot be qualified from ${lifecycle.status}`)
  }
  assertQualificationTransition(lifecycle.qualification.status, parsed.decision)
  if (parsed.options.firmId !== undefined) assertFirmIsolation(lifecycle.firmId, parsed.options.firmId, 'qualification')
  if (parsed.options.leadId !== undefined && idKey(normalizeLeadId(parsed.options.leadId)) !== idKey(lifecycle.leadId)) {
    throw new FirmIsolationError('qualification command belongs to another lead')
  }
  const decidedAt = normalizeTimestamp(
    parsed.options.occurredAt ?? parsed.options.at ?? parsed.options.createdAt,
    'qualification decidedAt',
  )
  const qualification: QualificationRecord = {
    firmId: lifecycle.firmId,
    leadId: lifecycle.leadId,
    status: parsed.decision,
    reason: normalizeText(parsed.options.reason, 'qualification reason'),
    actor: normalizeActor(parsed.options.actor),
    decidedAt,
  }
  return appendLifecycleTransition(lifecycle, parsed.decision, parsed.options, { qualification })
}

export const recordQualification = qualifyLead
export const decideQualification = qualifyLead

export function recordFunnelSignal(
  lifecycle: LeadOutcomeLifecycle,
  input: FunnelSignalInput | FunnelSignalType | string,
): LeadOutcomeLifecycle {
  assertLifecycleScope(lifecycle)
  const signal = createSignal(lifecycle, input)
  return lifecycleSnapshot({
    firmId: lifecycle.firmId,
    leadId: lifecycle.leadId,
    status: lifecycle.status,
    qualification: lifecycle.qualification,
    consultation: lifecycle.consultation,
    matterOutcome: lifecycle.matterOutcome,
    signals: [...lifecycle.signals, signal],
    statusHistory: lifecycle.statusHistory,
  })
}

export const recordLeadSignal = recordFunnelSignal
export const recordTouchpoint = recordFunnelSignal
export const appendFunnelSignal = recordFunnelSignal

function assertCommandScope(
  lifecycle: LeadOutcomeLifecycle,
  options: OutcomeCommandOptions,
  subject: string,
): void {
  if (options.firmId !== undefined) assertFirmIsolation(lifecycle.firmId, options.firmId, subject)
  if (options.leadId !== undefined) {
    if (idKey(normalizeLeadId(options.leadId)) !== idKey(lifecycle.leadId)) {
      throw new FirmIsolationError(`${subject} command belongs to another lead`)
    }
  }
}

function consultationIdFor(lifecycle: LeadOutcomeLifecycle, input: BookConsultationInput): OutcomeId {
  return normalizeId(
    input.consultationId ?? `${lifecycle.leadId}:consultation:${lifecycle.statusHistory.length + 1}`,
    'consultation id',
  )
}

export function bookConsultation(
  lifecycle: LeadOutcomeLifecycle,
  input: BookConsultationInput = {},
): LeadOutcomeLifecycle {
  assertLifecycleScope(lifecycle)
  assertCommandScope(lifecycle, input, 'consultation')
  if (input.source === 'call_click' || input.eventType === 'call_click') {
    throw new OutcomeValidationError('a call click is not a consultation')
  }
  if (input.source === 'form_submit' || input.eventType === 'form_submit') {
    throw new OutcomeValidationError('a form submission is not a consultation')
  }
  if (lifecycle.qualification.status !== 'qualified') {
    throw new OutcomeTransitionError('only a qualified lead can book a consultation')
  }
  if (
    lifecycle.consultation &&
    lifecycle.consultation.status !== 'cancelled' &&
    lifecycle.consultation.status !== 'no_show'
  ) {
    throw new OutcomeTransitionError(`consultation cannot be booked from ${lifecycle.consultation.status}`)
  }
  if (lifecycle.consultation && input.consultationId !== undefined) {
    if (idKey(normalizeId(input.consultationId, 'consultation id')) !== idKey(lifecycle.consultation.id)) {
      throw new FirmIsolationError('consultation command references another consultation')
    }
  }
  if (lifecycle.status !== 'qualified' && lifecycle.status !== 'consultation_cancelled' && lifecycle.status !== 'consultation_no_show') {
    throw new OutcomeTransitionError(`consultation cannot be booked from ${lifecycle.status}`)
  }
  const now = normalizeTimestamp(input.bookedAt ?? input.occurredAt ?? input.at ?? input.createdAt, 'consultation bookedAt')
  const existingId = lifecycle.consultation?.id
  const consultation: ConsultationRecord = {
    id: existingId ?? consultationIdFor(lifecycle, input),
    firmId: lifecycle.firmId,
    leadId: lifecycle.leadId,
    status: 'booked',
    scheduledAt: normalizeTimestamp(input.scheduledAt, 'consultation scheduledAt'),
    bookedAt: now,
    completedAt: null,
    updatedAt: now,
    actor: normalizeActor(input.actor),
  }
  return appendLifecycleTransition(lifecycle, 'consultation_booked', input, { consultation })
}

export const scheduleConsultation = bookConsultation
export const createConsultation = bookConsultation

export function transitionConsultation(
  lifecycle: LeadOutcomeLifecycle,
  toStatus: ConsultationStatus,
  options: ConsultationTransitionInput = {},
): LeadOutcomeLifecycle {
  assertLifecycleScope(lifecycle)
  assertCommandScope(lifecycle, options, 'consultation')
  if (!lifecycle.consultation) throw new OutcomeTransitionError('lead has no consultation')
  assertConsultationTransition(lifecycle.consultation.status, toStatus)
  if (toStatus === 'booked') {
    return bookConsultation(lifecycle, options)
  }
  const lifecycleStatus: LeadLifecycleStatus = toStatus === 'completed'
    ? 'consultation_completed'
    : toStatus === 'cancelled'
      ? 'consultation_cancelled'
      : 'consultation_no_show'
  assertLeadTransition(lifecycle.status, lifecycleStatus)
  const at = normalizeTimestamp(
    options.completedAt ?? options.updatedAt ?? options.occurredAt ?? options.at ?? options.createdAt,
    'consultation status time',
  )
  const consultation: ConsultationRecord = {
    ...lifecycle.consultation,
    status: toStatus,
    completedAt: toStatus === 'completed' ? at : lifecycle.consultation.completedAt,
    updatedAt: at ?? lifecycle.consultation.updatedAt,
    actor: normalizeActor(options.actor),
  }
  return appendLifecycleTransition(lifecycle, lifecycleStatus, options, { consultation })
}

export function transitionConsultationStatus(
  lifecycle: LeadOutcomeLifecycle,
  toStatus: ConsultationStatus,
  options?: ConsultationTransitionInput,
): LeadOutcomeLifecycle
export function transitionConsultationStatus(
  from: ConsultationStatus,
  to: ConsultationStatus,
): ConsultationStatus
export function transitionConsultationStatus(
  first: LeadOutcomeLifecycle | ConsultationStatus,
  second: ConsultationStatus,
  options: ConsultationTransitionInput = {},
): LeadOutcomeLifecycle | ConsultationStatus {
  if (typeof first === 'string') return transitionConsultationStatusOnly(first, second)
  return transitionConsultation(first, second, options)
}
export const updateConsultation = transitionConsultation
export const updateConsultationStatus = transitionConsultation

function matterLifecycleStatus(status: MatterOutcomeStatus): LeadLifecycleStatus {
  return status === 'retained'
    ? 'matter_retained'
    : status === 'not_retained'
      ? 'matter_not_retained'
      : 'matter_closed'
}

function matterEventReason(input: RecordMatterOutcomeInput): string | null {
  // Outcome reasons are required for retained/not-retained decisions so a
  // dashboard cannot turn an unexplained business decision into a KPI.
  const reason = input.reason
    ?? (input.status === 'not_retained' ? input.notRetainedReason : input.retainedReason)
  return normalizeText(reason, 'matter outcome reason', input.status !== 'closed')
}

export function recordMatterOutcome(
  lifecycle: LeadOutcomeLifecycle,
  input: RecordMatterOutcomeInput,
): LeadOutcomeLifecycle {
  assertLifecycleScope(lifecycle)
  assertCommandScope(lifecycle, input, 'matter outcome')
  if (!MATTER_STATUS_SET.has(input.status)) {
    throw new OutcomeValidationError(`unknown matter outcome status: ${input.status}`)
  }
  if (!lifecycle.consultation) {
    throw new OutcomeTransitionError('a consultation is required before recording a matter outcome')
  }
  if (lifecycle.consultation.status !== 'booked' && lifecycle.consultation.status !== 'completed') {
    throw new OutcomeTransitionError(`matter outcome cannot follow ${lifecycle.consultation.status} consultation`)
  }
  if (lifecycle.matterOutcome) {
    throw new OutcomeTransitionError('matter outcome is already recorded')
  }
  if (input.consultationId !== undefined && input.consultationId !== null) {
    if (idKey(normalizeId(input.consultationId, 'matter consultation id')) !== idKey(lifecycle.consultation.id)) {
      throw new FirmIsolationError('matter outcome references another consultation')
    }
  }
  const toStatus = matterLifecycleStatus(input.status)
  assertLeadTransition(lifecycle.status, toStatus)
  const decidedAt = normalizeTimestamp(
    input.decidedAt ?? input.occurredAt ?? input.at ?? input.createdAt,
    'matter outcome decidedAt',
  )
  const outcome: MatterOutcomeRecord = {
    id: normalizeId(input.eventId ?? input.id ?? `${lifecycle.leadId}:matter:${lifecycle.statusHistory.length + 1}`, 'matter outcome id'),
    firmId: lifecycle.firmId,
    leadId: lifecycle.leadId,
    consultationId: lifecycle.consultation.id,
    status: input.status,
    reason: matterEventReason(input),
    feeBand: normalizeText(input.feeBand, 'fee band'),
    decidedAt,
    updatedAt: normalizeTimestamp(input.updatedAt, 'matter outcome updatedAt') ?? decidedAt,
    actor: normalizeActor(input.actor),
  }
  return appendLifecycleTransition(lifecycle, toStatus, { ...input, reason: outcome.reason }, { matterOutcome: outcome })
}

export const setMatterOutcome = recordMatterOutcome
export const recordMatter = recordMatterOutcome

function snapshotStatus(value: unknown): LeadLifecycleStatus | null {
  return isLifecycleStatus(value) ? value : null
}

function historyEventType(input: StatusHistoryInput): string | null {
  return input.eventType ?? input.type ?? null
}

function signalInputsOf(input: FunnelSnapshotInput): readonly (FunnelSignalInput | FunnelSignalType | string)[] {
  return [
    ...(input.signals ?? []),
    ...(input.events ?? []),
    ...(input.touchpoints ?? []),
  ]
}

interface FunnelFacts {
  readonly firmId: FirmId
  readonly leadId: OutcomeId
  formSubmit: boolean
  callClick: boolean
  qualified: boolean
  unqualified: boolean
  consultationBooked: boolean
  consultationCompleted: boolean
  consultationCancelled: boolean
  consultationNoShow: boolean
  retained: boolean
  notRetained: boolean
  closed: boolean
  feeBand: boolean
}

function makeFunnelFacts(firmId: FirmId, leadId: OutcomeId): FunnelFacts {
  return {
    firmId,
    leadId,
    formSubmit: false,
    callClick: false,
    qualified: false,
    unqualified: false,
    consultationBooked: false,
    consultationCompleted: false,
    consultationCancelled: false,
    consultationNoShow: false,
    retained: false,
    notRetained: false,
    closed: false,
    feeBand: false,
  }
}

function applySignalFacts(
  facts: FunnelFacts,
  signal: FunnelSignalInput | FunnelSignalType | string,
): void {
  const source: FunnelSignalInput = typeof signal === 'string' ? { type: signal } : signal
  if (source.firmId !== undefined && source.firmId !== null) assertFirmIsolation(facts.firmId, source.firmId, 'funnel signal')
  if (source.leadId !== undefined && source.leadId !== null) {
    if (idKey(normalizeLeadId(source.leadId, 'signal lead id')) !== idKey(facts.leadId)) {
      throw new FirmIsolationError('funnel signal does not belong to the lead')
    }
  }
  const type = signalType(source.type ?? source.eventType)
  if (type === 'form_submit') facts.formSubmit = true
  if (type === 'call_click') facts.callClick = true
}

function applyStatusFacts(facts: FunnelFacts, status: unknown): void {
  switch (snapshotStatus(status)) {
    case 'qualified': facts.qualified = true; return
    case 'unqualified': facts.unqualified = true; return
    case 'consultation_booked': facts.consultationBooked = true; return
    case 'consultation_completed': facts.consultationBooked = true; facts.consultationCompleted = true; return
    case 'consultation_cancelled': facts.consultationBooked = true; facts.consultationCancelled = true; return
    case 'consultation_no_show': facts.consultationBooked = true; facts.consultationNoShow = true; return
    case 'matter_retained': facts.consultationBooked = true; facts.retained = true; return
    case 'matter_not_retained': facts.consultationBooked = true; facts.notRetained = true; return
    case 'matter_closed': facts.consultationBooked = true; facts.closed = true; return
    default: return
  }
}

function applyHistoryFacts(facts: FunnelFacts, history: readonly StatusHistoryInput[]): void {
  for (const event of history) {
    if (event.firmId !== undefined && event.firmId !== null) assertFirmIsolation(facts.firmId, event.firmId, 'status history')
    const eventLeadId = event.leadId ?? event.aggregateId
    if (eventLeadId !== undefined && eventLeadId !== null) {
      if (idKey(normalizeLeadId(eventLeadId, 'history lead id')) !== idKey(facts.leadId)) {
        throw new FirmIsolationError('status history does not belong to the lead')
      }
    }
    const type = historyEventType(event)
    switch (type) {
      case 'lead.qualified': facts.qualified = true; break
      case 'lead.unqualified': facts.unqualified = true; break
      case 'consultation.booked': facts.consultationBooked = true; break
      case 'consultation.completed': facts.consultationBooked = true; facts.consultationCompleted = true; break
      case 'consultation.cancelled': facts.consultationBooked = true; facts.consultationCancelled = true; break
      case 'consultation.no_show': facts.consultationBooked = true; facts.consultationNoShow = true; break
      case 'matter.retained': facts.consultationBooked = true; facts.retained = true; break
      case 'matter.not_retained': facts.consultationBooked = true; facts.notRetained = true; break
      case 'matter.closed': facts.consultationBooked = true; facts.closed = true; break
      default: applyStatusFacts(facts, event.toStatus ?? event.to)
    }
  }
}

function factsForRecord(record: FunnelRecord): FunnelFacts {
  const firmId = normalizeFirmId(record.firmId)
  const leadId = normalizeLeadId(record.leadId)
  const facts = makeFunnelFacts(firmId, leadId)

  if ('statusHistory' in record && record.statusHistory) {
    applyHistoryFacts(facts, record.statusHistory as readonly StatusHistoryInput[])
  }

  const signalInputs = 'signals' in record
    ? [
        ...(record.signals ?? []),
        ...('events' in record ? (record.events ?? []) : []),
        ...('touchpoints' in record ? (record.touchpoints ?? []) : []),
      ]
    : signalInputsOf(record)
  for (const signal of signalInputs) {
    applySignalFacts(facts, signal)
  }

  if ('status' in record) applyStatusFacts(facts, record.status)
  if ('qualified' in record && record.qualified === true) facts.qualified = true
  if ('isQualified' in record && record.isQualified === true) facts.qualified = true
  if ('retained' in record && record.retained === true) facts.retained = true
  if ('isRetained' in record && record.isRetained === true) facts.retained = true

  const qualification = record.qualification
  if (qualification?.status === 'qualified') facts.qualified = true
  if (qualification && 'qualified' in qualification && qualification.qualified === true) facts.qualified = true
  if (qualification?.status === 'unqualified') facts.unqualified = true

  const consultation = record.consultation
  if (consultation?.status === 'booked') facts.consultationBooked = true
  if (consultation?.status === 'completed') {
    facts.consultationBooked = true
    facts.consultationCompleted = true
  }
  if (consultation?.status === 'cancelled') {
    facts.consultationBooked = true
    facts.consultationCancelled = true
  }
  if (consultation?.status === 'no_show') {
    facts.consultationBooked = true
    facts.consultationNoShow = true
  }

  const outcome = record.matterOutcome
  if (outcome?.status === 'retained') {
    facts.consultationBooked = true
    facts.retained = true
  }
  if (outcome?.status === 'not_retained') {
    facts.consultationBooked = true
    facts.notRetained = true
  }
  if (outcome?.status === 'closed') {
    facts.consultationBooked = true
    facts.closed = true
  }
  if (outcome?.feeBand) facts.feeBand = true

  return facts
}

function mergeFunnelFacts(target: FunnelFacts, source: FunnelFacts): void {
  assertFirmIsolation(target.firmId, source.firmId, 'funnel summary')
  if (idKey(target.leadId) !== idKey(source.leadId)) throw new FirmIsolationError('funnel summary lead collision')
  target.formSubmit ||= source.formSubmit
  target.callClick ||= source.callClick
  target.qualified ||= source.qualified
  target.unqualified ||= source.unqualified
  target.consultationBooked ||= source.consultationBooked
  target.consultationCompleted ||= source.consultationCompleted
  target.consultationCancelled ||= source.consultationCancelled
  target.consultationNoShow ||= source.consultationNoShow
  target.retained ||= source.retained
  target.notRetained ||= source.notRetained
  target.closed ||= source.closed
  target.feeBand ||= source.feeBand
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function addSummaryAliases(summary: FunnelSummary): FunnelSummary {
  // Non-enumerable aliases keep the canonical serialized summary compact while
  // supporting common dashboard vocabulary (`qualified`, `consultations`, ...).
  Object.defineProperties(summary, {
    forms: { value: summary.formSubmits },
    qualified: { value: summary.qualifiedLeads },
    consultations: { value: summary.consultationsBooked },
    retained: { value: summary.retainedMatters },
    notRetained: { value: summary.notRetainedMatters },
  })
  return summary
}

/** Aggregate distinct `(firmId, leadId)` records without cross-tenant joins. */
export function deriveFunnelSummary(
  records: readonly FunnelRecord[],
  options: FunnelSummaryOptions = {},
): FunnelSummary {
  const scopedFirm = options.firmId === undefined ? undefined : normalizeFirmId(options.firmId, 'firm id')
  const byLead = new Map<string, FunnelFacts>()
  for (const record of records) {
    const facts = factsForRecord(record)
    if (scopedFirm !== undefined && !isSameFirmValue(scopedFirm, facts.firmId)) continue
    const key = `${idKey(facts.firmId)}:${idKey(facts.leadId)}`
    const existing = byLead.get(key)
    if (existing) mergeFunnelFacts(existing, facts)
    else byLead.set(key, facts)
  }

  let formSubmits = 0
  let callClicks = 0
  let qualifiedLeads = 0
  let unqualifiedLeads = 0
  let consultationsBooked = 0
  let consultationsCompleted = 0
  let consultationsCancelled = 0
  let consultationsNoShow = 0
  let retainedMatters = 0
  let notRetainedMatters = 0
  let closedMatters = 0
  let mattersWithFeeBand = 0
  for (const facts of byLead.values()) {
    if (facts.formSubmit) formSubmits += 1
    if (facts.callClick) callClicks += 1
    if (facts.qualified) qualifiedLeads += 1
    if (facts.unqualified) unqualifiedLeads += 1
    if (facts.consultationBooked) consultationsBooked += 1
    if (facts.consultationCompleted) consultationsCompleted += 1
    if (facts.consultationCancelled) consultationsCancelled += 1
    if (facts.consultationNoShow) consultationsNoShow += 1
    if (facts.retained) retainedMatters += 1
    if (facts.notRetained) notRetainedMatters += 1
    if (facts.closed) closedMatters += 1
    if (facts.feeBand) mattersWithFeeBand += 1
  }
  const summary = {
    totalLeads: byLead.size,
    formSubmits,
    callClicks,
    qualifiedLeads,
    unqualifiedLeads,
    consultationsBooked,
    consultationsCompleted,
    consultationsCancelled,
    consultationsNoShow,
    retainedMatters,
    notRetainedMatters,
    closedMatters,
    mattersWithFeeBand,
    qualificationRate: ratio(qualifiedLeads, byLead.size),
    consultationRate: ratio(consultationsBooked, qualifiedLeads),
    retentionRate: ratio(retainedMatters, consultationsBooked),
  } satisfies FunnelSummary
  return deepFreeze(addSummaryAliases(summary))
}

export const summarizeFunnel = deriveFunnelSummary
export const getFunnelSummary = deriveFunnelSummary
export const funnelSummary = deriveFunnelSummary

export function deriveFunnelSummaryByFirm(
  records: readonly FunnelRecord[],
): Readonly<Record<string, FunnelSummary>> {
  const firmIds = new Map<string, FirmId>()
  for (const record of records) {
    const firmId = normalizeFirmId(record.firmId)
    firmIds.set(idKey(firmId), firmId)
  }
  const result: Record<string, FunnelSummary> = {}
  for (const [key, firmId] of firmIds) result[key] = deriveFunnelSummary(records, { firmId })
  return deepFreeze(result)
}

export const summarizeFunnelByFirm = deriveFunnelSummaryByFirm
export const getFunnelSummaryByFirm = deriveFunnelSummaryByFirm

/** Return an immutable copy of the append-only status history. */
export function getStatusHistory(
  lifecycle: LeadOutcomeLifecycle,
  firmId?: FirmId,
): readonly StatusHistoryEvent[] {
  assertLifecycleScope(lifecycle)
  if (firmId !== undefined) assertFirmIsolation(firmId, lifecycle.firmId, 'status history')
  return deepFreeze(lifecycle.statusHistory.map(cloneHistoryEvent))
}

export const statusHistoryFor = getStatusHistory
