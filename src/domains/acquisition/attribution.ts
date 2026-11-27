/**
 * Pure acquisition attribution primitives.
 *
 * A session is tenant-scoped.  The session id alone is never enough to join
 * touchpoints: a firm id is part of the scope and a merge across either
 * boundary fails closed.  Case, asset, publication, ad execution, UTM and
 * referrer values stay on each touchpoint because one session can legitimately
 * visit more than one asset before creating a lead.
 */

export type AttributionId = string | number
export type TouchpointTimestamp = Date | string | number
export type UTMValue = string | number | boolean | null | undefined
export type UTMInput = Readonly<Record<string, UTMValue>>

type UnknownRecord = Record<string, unknown>

export interface TouchpointInput {
  readonly sessionId: AttributionId
  readonly firmId: AttributionId
  readonly caseEntityId?: AttributionId | null
  readonly contentAssetId?: AttributionId | null
  readonly publicationId?: AttributionId | null
  readonly adExecutionId?: AttributionId | null
  readonly utm?: UTMInput | null
  readonly referrer?: string | null
  /** Accept a URL-named alias used by browser event payloads. */
  readonly referrerUrl?: string | null
  readonly occurredAt?: TouchpointTimestamp | null
  /** Accept timestamp/created-at aliases from event rows. */
  readonly timestamp?: TouchpointTimestamp | null
  readonly createdAt?: TouchpointTimestamp | null
  readonly touchpointId?: AttributionId | null
  readonly id?: AttributionId | null
  readonly eventType?: string | null
  readonly type?: string | null
  readonly utmSource?: string | null
  readonly utmMedium?: string | null
  readonly utmCampaign?: string | null
  readonly utmTerm?: string | null
  readonly utmContent?: string | null
}

export interface AttributionKey {
  readonly sessionId: string
  readonly firmId: string
  readonly caseEntityId: string | null
  readonly contentAssetId: string | null
  readonly publicationId: string | null
  readonly adExecutionId: string | null
  readonly utm: Readonly<Record<string, string>>
  readonly referrer: string | null
}

export interface AttributionTouchpoint extends AttributionKey {
  readonly touchpointId: string | null
  readonly occurredAt: string | null
  readonly eventType: string | null
  readonly key: AttributionKey
}

export type Touchpoint = AttributionTouchpoint

export interface AttributionScope {
  readonly sessionId: string
  readonly firmId: string
}

export interface Attribution {
  readonly scope: AttributionScope
  readonly touchpoints: readonly AttributionTouchpoint[]
  readonly firstTouch: AttributionTouchpoint
  readonly lastTouch: AttributionTouchpoint
}

export type AttributionState = Attribution

export class AttributionScopeError extends Error {
  readonly code = 'ATTRIBUTION_SCOPE_MISMATCH'

  constructor(message: string) {
    super(message)
    this.name = 'AttributionScopeError'
  }
}

export type AttributionCompletenessField =
  | 'sessionId'
  | 'firmId'
  | 'caseEntityId'
  | 'contentAssetId'
  | 'publicationId'
  | 'adExecutionId'
  | 'utmOrReferrer'

export interface AttributionCompletenessOptions {
  /** SEO/referral paths do not have an ad execution. Paid paths do. */
  readonly requireAdExecution?: boolean
  readonly requireCaseEntity?: boolean
  readonly requireContentAsset?: boolean
  readonly requirePublication?: boolean
  readonly requireUtmOrReferrer?: boolean
}

export interface AttributionCompleteness {
  readonly complete: boolean
  readonly isComplete: boolean
  readonly missing: readonly AttributionCompletenessField[]
  readonly hasSessionId: boolean
  readonly hasFirmId: boolean
  readonly hasCaseEntityId: boolean
  readonly hasContentAssetId: boolean
  readonly hasPublicationId: boolean
  readonly hasAdExecutionId: boolean
  readonly hasUtm: boolean
  readonly hasReferrer: boolean
  readonly hasUtmOrReferrer: boolean
}

export type LeadTouchpointInput = Partial<TouchpointInput>

export interface LeadAttributionInput {
  readonly leadId?: AttributionId
  readonly id?: AttributionId
  readonly firmId: AttributionId
  readonly sessionId?: AttributionId | null
  readonly attribution?: Attribution | null
  readonly touchpoints?: readonly LeadTouchpointInput[]
  readonly firstTouch?: LeadTouchpointInput | null
  readonly lastTouch?: LeadTouchpointInput | null
  readonly status?: string | null
  readonly leadStatus?: string | null
  readonly stage?: string | null
  readonly qualificationStatus?: string | null
  readonly outcome?: string | null
  readonly matterOutcome?: string | null
  readonly qualified?: boolean | null
  readonly isQualified?: boolean | null
  readonly retained?: boolean | null
  readonly isRetained?: boolean | null
  readonly statusHistory?: readonly LeadStatusEntry[]
  readonly events?: readonly LeadStatusEntry[]
}

export type LeadStatusEntry =
  | string
  | {
      readonly status?: string | null
      readonly type?: string | null
      readonly eventType?: string | null
      readonly name?: string | null
    }

export interface LeadAttribution {
  readonly leadId: string
  readonly firmId: string
  readonly attribution: Attribution | null
  readonly completeness: AttributionCompleteness
  readonly attributionComplete: boolean
  readonly isAttributionComplete: boolean
  readonly qualified: boolean
  readonly isQualified: boolean
  readonly retained: boolean
  readonly isRetained: boolean
}

export type FunnelCounterOptions = AttributionCompletenessOptions & {
  readonly firmId?: AttributionId
}

export interface FunnelCounters {
  readonly totalLeads: number
  readonly attributedLeads: number
  readonly completeAttributionLeads: number
  readonly incompleteAttributionLeads: number
  readonly qualifiedLeads: number
  readonly retainedLeads: number
  readonly qualifiedWithCompleteAttribution: number
  readonly retainedWithCompleteAttribution: number
}

export const QUALIFIED_LEAD_STATUSES = [
  'qualified',
  'consultation_booked',
  'consultation_scheduled',
  'consulted',
  'matter_retained',
  'matter_closed',
  'retained',
  'closed',
] as const

export const RETAINED_LEAD_STATUSES = [
  'retained',
  'matter_retained',
  'matter_closed',
  'closed',
  'won',
  'hired',
  'engaged',
] as const

const QUALIFIED_STATUS_SET: ReadonlySet<string> = new Set(QUALIFIED_LEAD_STATUSES)
const RETAINED_STATUS_SET: ReadonlySet<string> = new Set(RETAINED_LEAD_STATUSES)
const PAID_MEDIA_SET: ReadonlySet<string> = new Set([
  'cpc',
  'ppc',
  'paid',
  'paid_search',
  'paid-social',
  'paid_social',
  'display',
  'native',
  'retargeting',
])

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function valueFrom(record: UnknownRecord, ...names: readonly string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name]
  }
  return undefined
}

function normalizeId(value: unknown, label: string, required: boolean): string | null {
  if (value === null || value === undefined) {
    if (required) throw new TypeError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${label} must be a string or number`)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`)
  }
  const normalized = String(value).trim()
  if (!normalized) {
    if (required) throw new TypeError(`${label} is required`)
    return null
  }
  return normalized
}

function normalizeText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = value.trim()
  return normalized || null
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  let date: Date
  if (value instanceof Date) {
    date = new Date(value.getTime())
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('occurredAt must be finite')
    date = new Date(value)
  } else if (typeof value === 'string') {
    const normalized = value.trim()
    if (!normalized) return null
    date = new Date(normalized)
  } else {
    throw new TypeError('occurredAt must be a Date, string, or number')
  }
  if (!Number.isFinite(date.getTime())) throw new TypeError('occurredAt must be a valid date')
  return date.toISOString()
}

function normalizeUtmValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new TypeError('UTM values must be scalar')
  }
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeUtm(input: UnknownRecord): Readonly<Record<string, string>> {
  const values = new Map<string, string>()
  const rawUtm = valueFrom(input, 'utm', 'utmParams', 'utm_params')
  if (rawUtm !== null && rawUtm !== undefined) {
    const utm = asRecord(rawUtm, 'utm')
    for (const [rawKey, rawValue] of Object.entries(utm)) {
      const key = rawKey.trim().toLowerCase()
      const value = normalizeUtmValue(rawValue)
      if (key && value !== null) values.set(key, value)
    }
  }

  const aliases: readonly (readonly [string, readonly string[]])[] = [
    ['utm_source', ['utmSource', 'utm_source']],
    ['utm_medium', ['utmMedium', 'utm_medium']],
    ['utm_campaign', ['utmCampaign', 'utm_campaign']],
    ['utm_term', ['utmTerm', 'utm_term']],
    ['utm_content', ['utmContent', 'utm_content']],
  ]
  for (const [key, names] of aliases) {
    const value = normalizeUtmValue(valueFrom(input, ...names))
    if (value !== null && !values.has(key)) values.set(key, value)
  }

  const sorted = [...values.entries()].sort(([a], [b]) => compareStrings(a, b))
  const result: Record<string, string> = {}
  for (const [key, value] of sorted) result[key] = value
  return Object.freeze(result)
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as UnknownRecord)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(String(value))
}

function keyFromTouchpoint(touchpoint: Omit<AttributionTouchpoint, 'key'>): AttributionKey {
  return Object.freeze({
    sessionId: touchpoint.sessionId,
    firmId: touchpoint.firmId,
    caseEntityId: touchpoint.caseEntityId,
    contentAssetId: touchpoint.contentAssetId,
    publicationId: touchpoint.publicationId,
    adExecutionId: touchpoint.adExecutionId,
    utm: touchpoint.utm,
    referrer: touchpoint.referrer,
  })
}

/** Normalize a raw touchpoint without mutating its input. */
export function normalizeTouchpoint(input: TouchpointInput): AttributionTouchpoint {
  const raw = asRecord(input, 'touchpoint')
  const base: Omit<AttributionTouchpoint, 'key'> = {
    touchpointId: normalizeId(valueFrom(raw, 'touchpointId', 'touchpoint_id', 'id'), 'touchpointId', false),
    sessionId: normalizeId(valueFrom(raw, 'sessionId', 'session_id'), 'sessionId', true) as string,
    firmId: normalizeId(valueFrom(raw, 'firmId', 'firm_id'), 'firmId', true) as string,
    caseEntityId: normalizeId(valueFrom(raw, 'caseEntityId', 'case_entity_id'), 'caseEntityId', false),
    contentAssetId: normalizeId(valueFrom(raw, 'contentAssetId', 'content_asset_id'), 'contentAssetId', false),
    publicationId: normalizeId(valueFrom(raw, 'publicationId', 'publication_id'), 'publicationId', false),
    adExecutionId: normalizeId(valueFrom(raw, 'adExecutionId', 'ad_execution_id'), 'adExecutionId', false),
    utm: normalizeUtm(raw),
    referrer: normalizeText(valueFrom(raw, 'referrer', 'referrerUrl', 'referrer_url'), 'referrer'),
    occurredAt: normalizeTimestamp(valueFrom(raw, 'occurredAt', 'occurred_at', 'timestamp', 'createdAt', 'created_at')),
    eventType: normalizeText(valueFrom(raw, 'eventType', 'event_type', 'type'), 'eventType'),
  }
  const key = keyFromTouchpoint(base)
  return Object.freeze({ ...base, key })
}

/** Return the full, tenant-scoped key used for a touchpoint. */
export function getAttributionKey(input: TouchpointInput): AttributionKey {
  return normalizeTouchpoint(input).key
}

export const buildAttributionKey = getAttributionKey

/** A stable key useful for idempotent event grouping and tests. */
export function serializeAttributionKey(input: TouchpointInput): string {
  return stableStringify(getAttributionKey(input))
}

export const serializeTouchpointKey = serializeAttributionKey

function scopeOf(touchpoint: AttributionTouchpoint): AttributionScope {
  return { sessionId: touchpoint.sessionId, firmId: touchpoint.firmId }
}

function assertSameScope(a: AttributionScope, b: AttributionScope): void {
  if (a.sessionId !== b.sessionId || a.firmId !== b.firmId) {
    throw new AttributionScopeError(
      `touchpoints must share sessionId and firmId (received ${a.sessionId}/${a.firmId} and ${b.sessionId}/${b.firmId})`,
    )
  }
}

function touchpointFingerprint(touchpoint: AttributionTouchpoint): string {
  return stableStringify({
    touchpointId: touchpoint.touchpointId,
    occurredAt: touchpoint.occurredAt,
    eventType: touchpoint.eventType,
    key: touchpoint.key,
  })
}

function touchpointIdentity(touchpoint: AttributionTouchpoint): string {
  return touchpoint.touchpointId
    ? `id:${touchpoint.touchpointId}`
    : `fingerprint:${touchpointFingerprint(touchpoint)}`
}

function compareTouchpoints(a: AttributionTouchpoint, b: AttributionTouchpoint): number {
  const aTime = a.occurredAt === null ? null : Date.parse(a.occurredAt)
  const bTime = b.occurredAt === null ? null : Date.parse(b.occurredAt)
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime
  if (aTime !== null && bTime === null) return -1
  if (aTime === null && bTime !== null) return 1

  const aTie = a.touchpointId ?? touchpointFingerprint(a)
  const bTie = b.touchpointId ?? touchpointFingerprint(b)
  const tie = compareStrings(aTie, bTie)
  if (tie !== 0) return tie
  return compareStrings(touchpointFingerprint(a), touchpointFingerprint(b))
}

function dedupeTouchpoints(touchpoints: readonly AttributionTouchpoint[]): AttributionTouchpoint[] {
  const byIdentity = new Map<string, AttributionTouchpoint[]>()
  for (const touchpoint of touchpoints) {
    const identity = touchpointIdentity(touchpoint)
    const matches = byIdentity.get(identity) ?? []
    matches.push(touchpoint)
    byIdentity.set(identity, matches)
  }

  const deduped: AttributionTouchpoint[] = []
  for (const matches of byIdentity.values()) {
    matches.sort(compareTouchpoints)
    deduped.push(matches[0])
  }
  return deduped
}

function buildAttributionFromNormalized(touchpoints: readonly AttributionTouchpoint[]): Attribution {
  if (!touchpoints.length) throw new RangeError('at least one touchpoint is required')
  const firstScope = scopeOf(touchpoints[0])
  for (const touchpoint of touchpoints.slice(1)) assertSameScope(firstScope, scopeOf(touchpoint))

  const sorted = dedupeTouchpoints(touchpoints).sort(compareTouchpoints)
  const immutableTouchpoints = Object.freeze([...sorted])
  const firstTouch = immutableTouchpoints[0]
  const lastTouch = immutableTouchpoints[immutableTouchpoints.length - 1]
  return Object.freeze({
    scope: Object.freeze(firstScope),
    touchpoints: immutableTouchpoints,
    firstTouch,
    lastTouch,
  })
}

/** Create a first/last attribution snapshot from one or more touchpoints. */
export function createAttribution(input: TouchpointInput): Attribution
export function createAttribution(input: readonly TouchpointInput[]): Attribution
export function createAttribution(input: TouchpointInput | readonly TouchpointInput[]): Attribution {
  const inputs = Array.isArray(input) ? input : [input]
  if (!inputs.length) throw new RangeError('at least one touchpoint is required')
  return buildAttributionFromNormalized(inputs.map(normalizeTouchpoint))
}

export const attributeTouchpoints = createAttribution

type AttributionMergeInput = TouchpointInput | Attribution | readonly TouchpointInput[]

function normalizedIncoming(input: AttributionMergeInput): AttributionTouchpoint[] {
  if (isAttribution(input)) return [...input.touchpoints]
  if (Array.isArray(input)) return input.map(normalizeTouchpoint)
  return [normalizeTouchpoint(input as TouchpointInput)]
}

/**
 * Merge later observations into an attribution snapshot.
 *
 * The function is order-independent for timestamped touchpoints and returns a
 * new immutable snapshot.  A different session or firm is rejected rather
 * than silently joining tenant data.
 */
export function mergeAttribution(
  current: Attribution,
  incoming: AttributionMergeInput,
): Attribution {
  if (!isAttribution(current)) throw new TypeError('current attribution is invalid')
  const incomingTouchpoints = normalizedIncoming(incoming)
  for (const touchpoint of incomingTouchpoints) {
    assertSameScope(current.scope, scopeOf(touchpoint))
  }
  return buildAttributionFromNormalized([...current.touchpoints, ...incomingTouchpoints])
}

export const mergeTouchpoint = mergeAttribution

export function mergeTouchpoints(input: readonly TouchpointInput[]): Attribution
export function mergeTouchpoints(current: Attribution, incoming: AttributionMergeInput): Attribution
export function mergeTouchpoints(
  input: Attribution | readonly TouchpointInput[],
  incoming?: AttributionMergeInput,
): Attribution {
  if (Array.isArray(input)) {
    if (incoming !== undefined) throw new TypeError('array form accepts one argument')
    return createAttribution(input)
  }
  if (incoming === undefined) throw new TypeError('incoming touchpoint is required')
  return mergeAttribution(input as Attribution, incoming)
}

function isAttribution(value: unknown): value is Attribution {
  if (typeof value !== 'object' || value === null) return false
  const record = value as UnknownRecord
  return Array.isArray(record.touchpoints)
    && typeof record.firstTouch === 'object'
    && record.firstTouch !== null
    && typeof record.lastTouch === 'object'
    && record.lastTouch !== null
    && typeof record.scope === 'object'
    && record.scope !== null
}

function touchpointsOf(attribution: Attribution | null | undefined): readonly AttributionTouchpoint[] {
  return attribution ? attribution.touchpoints : []
}

function anyTouchpoint(
  attribution: Attribution | null | undefined,
  predicate: (touchpoint: AttributionTouchpoint) => boolean,
): boolean {
  return touchpointsOf(attribution).some(predicate)
}

function isPaidTouchpoint(touchpoint: AttributionTouchpoint): boolean {
  if (touchpoint.adExecutionId !== null) return true
  const medium = touchpoint.utm.utm_medium?.toLowerCase()
  return medium !== undefined && PAID_MEDIA_SET.has(medium)
}

/** Derive field-level completeness without changing the attribution state. */
export function deriveAttributionCompleteness(
  attribution: Attribution | null | undefined,
  options: AttributionCompletenessOptions = {},
): AttributionCompleteness {
  const touchpoints = touchpointsOf(attribution)
  const hasSessionId = Boolean(attribution && attribution.scope.sessionId.trim().length > 0)
  const hasFirmId = Boolean(attribution && attribution.scope.firmId.trim().length > 0)
  const hasCaseEntityId = anyTouchpoint(attribution, (touchpoint) => touchpoint.caseEntityId !== null)
  const hasContentAssetId = anyTouchpoint(attribution, (touchpoint) => touchpoint.contentAssetId !== null)
  const hasPublicationId = anyTouchpoint(attribution, (touchpoint) => touchpoint.publicationId !== null)
  const hasAdExecutionId = anyTouchpoint(attribution, (touchpoint) => touchpoint.adExecutionId !== null)
  const hasUtm = anyTouchpoint(attribution, (touchpoint) => Object.keys(touchpoint.utm).length > 0)
  const hasReferrer = anyTouchpoint(attribution, (touchpoint) => touchpoint.referrer !== null)
  const hasUtmOrReferrer = hasUtm || hasReferrer
  const requiresAdExecution = options.requireAdExecution ?? touchpoints.some(isPaidTouchpoint)
  const missing: AttributionCompletenessField[] = []

  if (!hasSessionId) missing.push('sessionId')
  if (!hasFirmId) missing.push('firmId')
  if ((options.requireCaseEntity ?? true) && !hasCaseEntityId) missing.push('caseEntityId')
  if ((options.requireContentAsset ?? true) && !hasContentAssetId) missing.push('contentAssetId')
  if ((options.requirePublication ?? true) && !hasPublicationId) missing.push('publicationId')
  if (requiresAdExecution && !hasAdExecutionId) missing.push('adExecutionId')
  if ((options.requireUtmOrReferrer ?? true) && !hasUtmOrReferrer) missing.push('utmOrReferrer')

  const complete = missing.length === 0
  return Object.freeze({
    complete,
    isComplete: complete,
    missing: Object.freeze(missing),
    hasSessionId,
    hasFirmId,
    hasCaseEntityId,
    hasContentAssetId,
    hasPublicationId,
    hasAdExecutionId,
    hasUtm,
    hasReferrer,
    hasUtmOrReferrer,
  })
}

export const getAttributionCompleteness = deriveAttributionCompleteness
export const isAttributionComplete = (
  attribution: Attribution | null | undefined,
  options: AttributionCompletenessOptions = {},
): boolean => deriveAttributionCompleteness(attribution, options).complete

function normalizeStatus(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const normalized = value.trim().toLowerCase().replace(/[.\s-]+/g, '_')
  return normalized || null
}

function statusValues(input: LeadAttributionInput): string[] {
  const values: string[] = []
  const direct = [
    input.status,
    input.leadStatus,
    input.stage,
    input.qualificationStatus,
    input.outcome,
    input.matterOutcome,
  ]
  for (const value of direct) {
    const normalized = normalizeStatus(value)
    if (normalized) values.push(normalized)
  }

  for (const entries of [input.statusHistory ?? [], input.events ?? []]) {
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const normalized = normalizeStatus(entry)
        if (normalized) values.push(normalized)
        continue
      }
      const normalized = normalizeStatus(entry.status ?? entry.type ?? entry.eventType ?? entry.name)
      if (normalized) values.push(normalized)
    }
  }
  return values
}

function explicitBoolean(...values: readonly (boolean | null | undefined)[]): boolean | undefined {
  for (const value of values) {
    if (value !== null && value !== undefined) return value
  }
  return undefined
}

function leadAttributionFromInput(input: LeadAttributionInput, firmId: string): Attribution | null {
  let attribution = input.attribution ?? null
  if (attribution && attribution.scope.firmId !== firmId) {
    throw new AttributionScopeError(
      `lead firmId ${firmId} does not match attribution firmId ${attribution.scope.firmId}`,
    )
  }

  const rawTouchpoints: LeadTouchpointInput[] = [
    ...(input.touchpoints ?? []),
    ...(input.firstTouch ? [input.firstTouch] : []),
    ...(input.lastTouch ? [input.lastTouch] : []),
  ]
  for (const rawTouchpoint of rawTouchpoints) {
    const raw = asRecord(rawTouchpoint, 'lead touchpoint')
    const scoped = {
      ...raw,
      sessionId: valueFrom(raw, 'sessionId', 'session_id')
        ?? input.sessionId
        ?? attribution?.scope.sessionId,
      firmId: valueFrom(raw, 'firmId', 'firm_id') ?? firmId,
    } as TouchpointInput
    const touchpoint = normalizeTouchpoint(scoped)
    if (touchpoint.firmId !== firmId) {
      throw new AttributionScopeError(
        `lead firmId ${firmId} does not match touchpoint firmId ${touchpoint.firmId}`,
      )
    }
    attribution = attribution
      ? mergeAttribution(attribution, touchpoint)
      : createAttribution(touchpoint)
  }
  return attribution
}

/** Derive lead-level attribution and lifecycle flags from a pure input. */
export function deriveLeadAttribution(
  input: LeadAttributionInput,
  options: AttributionCompletenessOptions = {},
): LeadAttribution {
  const raw = asRecord(input, 'lead')
  const leadId = normalizeId(valueFrom(raw, 'leadId', 'lead_id', 'id'), 'leadId', true) as string
  const firmId = normalizeId(valueFrom(raw, 'firmId', 'firm_id'), 'firmId', true) as string
  const attribution = leadAttributionFromInput(input, firmId)
  const completeness = deriveAttributionCompleteness(attribution, options)
  const statuses = statusValues(input)
  const qualifiedOverride = explicitBoolean(input.qualified, input.isQualified)
  const retainedOverride = explicitBoolean(input.retained, input.isRetained)
  const retained = retainedOverride ?? statuses.some((status) => RETAINED_STATUS_SET.has(status))
  const qualified = (qualifiedOverride ?? statuses.some((status) => QUALIFIED_STATUS_SET.has(status))) || retained

  return Object.freeze({
    leadId,
    firmId,
    attribution,
    completeness,
    attributionComplete: completeness.complete,
    isAttributionComplete: completeness.complete,
    qualified,
    isQualified: qualified,
    retained,
    isRetained: retained,
  })
}

export const attributeLead = deriveLeadAttribution

function combineLeadAttribution(
  a: LeadAttribution,
  b: LeadAttribution,
  options: AttributionCompletenessOptions = {},
): LeadAttribution {
  if (a.leadId !== b.leadId || a.firmId !== b.firmId) {
    throw new AttributionScopeError('only the same lead within the same firm may be combined')
  }
  const attribution = a.attribution && b.attribution
    ? mergeAttribution(a.attribution, b.attribution)
    : a.attribution ?? b.attribution
  const completeness = deriveAttributionCompleteness(attribution, options)
  const qualified = a.qualified || b.qualified
  const retained = a.retained || b.retained
  return Object.freeze({
    leadId: a.leadId,
    firmId: a.firmId,
    attribution,
    completeness,
    attributionComplete: completeness.complete,
    isAttributionComplete: completeness.complete,
    qualified,
    isQualified: qualified,
    retained,
    isRetained: retained,
  })
}

function emptyCounters(): FunnelCounters {
  return {
    totalLeads: 0,
    attributedLeads: 0,
    completeAttributionLeads: 0,
    incompleteAttributionLeads: 0,
    qualifiedLeads: 0,
    retainedLeads: 0,
    qualifiedWithCompleteAttribution: 0,
    retainedWithCompleteAttribution: 0,
  }
}

/** Count distinct leads without joining equal lead ids across firms. */
export function deriveFunnelCounters(
  inputs: readonly LeadAttributionInput[],
  options: FunnelCounterOptions = {},
): FunnelCounters {
  const selectedFirmId = options.firmId === undefined
    ? undefined
    : normalizeId(options.firmId, 'firmId', true)
  const byLead = new Map<string, LeadAttribution>()

  for (const input of inputs) {
    const lead = deriveLeadAttribution(input, options)
    if (selectedFirmId !== undefined && lead.firmId !== selectedFirmId) continue
    const identity = `${lead.firmId}\u0000${lead.leadId}`
    const previous = byLead.get(identity)
    byLead.set(identity, previous ? combineLeadAttribution(previous, lead, options) : lead)
  }

  let counters = emptyCounters()
  for (const lead of byLead.values()) {
    counters = {
      ...counters,
      totalLeads: counters.totalLeads + 1,
      attributedLeads: counters.attributedLeads + (lead.attribution ? 1 : 0),
      completeAttributionLeads: counters.completeAttributionLeads + (lead.attributionComplete ? 1 : 0),
      incompleteAttributionLeads: counters.incompleteAttributionLeads + (lead.attributionComplete ? 0 : 1),
      qualifiedLeads: counters.qualifiedLeads + (lead.qualified ? 1 : 0),
      retainedLeads: counters.retainedLeads + (lead.retained ? 1 : 0),
      qualifiedWithCompleteAttribution: counters.qualifiedWithCompleteAttribution
        + (lead.qualified && lead.attributionComplete ? 1 : 0),
      retainedWithCompleteAttribution: counters.retainedWithCompleteAttribution
        + (lead.retained && lead.attributionComplete ? 1 : 0),
    }
  }
  return Object.freeze(counters)
}

export const aggregateFunnelCounters = deriveFunnelCounters
export const deriveLeadFunnelCounters = deriveFunnelCounters

/** Derive independent firm-scoped counter snapshots from one input set. */
export function deriveFunnelCountersByFirm(
  inputs: readonly LeadAttributionInput[],
  options: Omit<FunnelCounterOptions, 'firmId'> = {},
): Readonly<Record<string, FunnelCounters>> {
  const firmIds = new Set<string>()
  for (const input of inputs) {
    firmIds.add(normalizeId(input.firmId, 'firmId', true) as string)
  }
  const result: Record<string, FunnelCounters> = {}
  for (const firmId of [...firmIds].sort(compareStrings)) {
    result[firmId] = deriveFunnelCounters(inputs, { ...options, firmId })
  }
  return Object.freeze(result)
}
