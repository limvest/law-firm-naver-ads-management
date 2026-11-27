import { createHash, randomUUID } from 'node:crypto'

/** IDs are strings for UUIDs and slugs, but numeric database IDs are also valid. */
export type EventId = string | number

export type EventTimestamp = string
export type EventTimestampInput = Date | string

export type EventJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly EventJsonValue[]
  | { readonly [key: string]: EventJsonValue }

/**
 * The strategy contract leaves actor shape open so callers can represent a
 * human, service, or system actor without changing the envelope contract.
 */
export type EventActor = string | { readonly [key: string]: EventJsonValue }

export interface EventEnvelope<TPayload = unknown> {
  readonly eventId: EventId
  readonly eventType: string
  readonly aggregateId: EventId
  readonly firmId?: EventId
  readonly actor: EventActor
  readonly occurredAt: EventTimestamp
  readonly recordedAt: EventTimestamp
  readonly correlationId: EventId
  /** Null marks a root event with no preceding event in the causal chain. */
  readonly causationId: EventId | null
  readonly schemaVersion: number
  readonly policyVersion: number
  readonly idempotencyKey: string
  readonly payload: TPayload
}

export interface EventEnvelopeInput<TPayload = unknown> {
  readonly eventId?: EventId
  readonly eventType: string
  readonly aggregateId: EventId
  readonly firmId?: EventId | null
  readonly actor: EventActor
  readonly occurredAt?: EventTimestampInput
  readonly recordedAt?: EventTimestampInput
  readonly correlationId?: EventId | null
  readonly causationId?: EventId | null
  readonly schemaVersion?: number
  readonly policyVersion?: number
  readonly idempotencyKey?: string
  readonly payload: TPayload
}

/** The non-volatile fields used to derive an idempotency key. */
export interface StableIdempotencyInput<TPayload = unknown> {
  readonly eventType: string
  readonly aggregateId: EventId
  readonly firmId?: EventId | null
  readonly actor?: EventActor
  readonly causationId?: EventId | null
  readonly schemaVersion?: number
  readonly policyVersion?: number
  readonly payload: TPayload
}

export class EventEnvelopeValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    const normalizedIssues = [...issues]
    super(`Invalid event envelope: ${normalizedIssues.join('; ')}`)
    this.name = 'EventEnvelopeValidationError'
    this.issues = Object.freeze(normalizedIssues)
  }
}

const DEFAULT_SCHEMA_VERSION = 1
const DEFAULT_POLICY_VERSION = 1

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isValidId(value: unknown): value is EventId {
  if (typeof value === 'string') return value.trim().length > 0
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isValidVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function collectJsonIssues(
  value: unknown,
  path: string,
  issues: string[],
  ancestors: Set<object>,
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.push(`${path} must contain only finite numbers`)
    return
  }

  if (typeof value === 'undefined') {
    issues.push(`${path} must not be undefined`)
    return
  }

  if (typeof value !== 'object' || value instanceof Date || (!Array.isArray(value) && !isPlainRecord(value))) {
    issues.push(`${path} must be JSON-compatible`)
    return
  }

  if (ancestors.has(value)) {
    issues.push(`${path} must not contain circular references`)
    return
  }
  ancestors.add(value)

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectJsonIssues(item, `${path}[${index}]`, issues, ancestors))
  } else {
    for (const key of Object.keys(value)) collectJsonIssues(value[key], `${path}.${key}`, issues, ancestors)
  }

  ancestors.delete(value)
}

function collectActorIssues(value: unknown, issues: string[]): void {
  if (typeof value === 'string') {
    if (!value.trim()) issues.push('actor must be a non-empty string or object')
    return
  }

  if (!isPlainRecord(value) || Object.keys(value).length === 0) {
    issues.push('actor must be a non-empty string or object')
    return
  }
  collectJsonIssues(value, 'actor', issues, new Set())
}

function collectTimestampIssues(value: unknown, field: string, issues: string[]): void {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) issues.push(`${field} must be a valid timestamp`)
    return
  }
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(new Date(value).getTime())) {
    issues.push(`${field} must be a valid timestamp`)
  }
}

function collectEnvelopeIssues(value: unknown): string[] {
  if (!isPlainRecord(value)) return ['envelope must be a non-null object']

  const issues: string[] = []
  for (const field of ['eventId', 'aggregateId', 'correlationId'] as const) {
    if (!isValidId(value[field])) issues.push(`${field} must be a non-empty string or non-negative safe integer`)
  }

  if (typeof value.eventType !== 'string' || !value.eventType.trim()) {
    issues.push('eventType must be a non-empty string')
  }

  if ('firmId' in value && value.firmId !== undefined && !isValidId(value.firmId)) {
    issues.push('firmId must be a non-empty string or non-negative safe integer when provided')
  }
  if (!('causationId' in value) || typeof value.causationId === 'undefined') {
    issues.push('causationId is required (use null for a root event)')
  } else if (value.causationId !== null && !isValidId(value.causationId)) {
    issues.push('causationId must be null, a non-empty string, or a non-negative safe integer')
  }

  collectActorIssues(value.actor, issues)
  collectTimestampIssues(value.occurredAt, 'occurredAt', issues)
  collectTimestampIssues(value.recordedAt, 'recordedAt', issues)

  if (!isValidVersion(value.schemaVersion)) issues.push('schemaVersion must be a positive integer')
  if (!isValidVersion(value.policyVersion)) issues.push('policyVersion must be a positive integer')

  if (typeof value.idempotencyKey !== 'string' || !value.idempotencyKey.trim()) {
    issues.push('idempotencyKey must be a non-empty string')
  }

  if (!('payload' in value) || typeof value.payload === 'undefined') {
    issues.push('payload is required')
  } else {
    collectJsonIssues(value.payload, 'payload', issues, new Set())
  }

  return issues
}

function assertStableInput(input: StableIdempotencyInput): void {
  const issues: string[] = []
  if (typeof input.eventType !== 'string' || !input.eventType.trim()) {
    issues.push('eventType must be a non-empty string')
  }
  if (!isValidId(input.aggregateId)) {
    issues.push('aggregateId must be a non-empty string or non-negative safe integer')
  }
  if (input.firmId !== undefined && input.firmId !== null && !isValidId(input.firmId)) {
    issues.push('firmId must be a non-empty string or non-negative safe integer when provided')
  }
  if (input.causationId !== undefined && input.causationId !== null && !isValidId(input.causationId)) {
    issues.push('causationId must be null, a non-empty string, or a non-negative safe integer')
  }
  if (input.actor !== undefined) collectActorIssues(input.actor, issues)
  if (input.schemaVersion !== undefined && !isValidVersion(input.schemaVersion)) {
    issues.push('schemaVersion must be a positive integer')
  }
  if (input.policyVersion !== undefined && !isValidVersion(input.policyVersion)) {
    issues.push('policyVersion must be a positive integer')
  }
  if (typeof input.payload === 'undefined') issues.push('payload is required')
  else collectJsonIssues(input.payload, 'payload', issues, new Set())
  if (issues.length) throw new EventEnvelopeValidationError(issues)
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize a non-finite number')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object' || value instanceof Date || (!Array.isArray(value) && !isPlainRecord(value))) {
    throw new TypeError('Cannot canonicalize a non-JSON value')
  }
  if (ancestors.has(value)) throw new TypeError('Cannot canonicalize circular references')
  ancestors.add(value)

  let result: string
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`
  } else {
    result = `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`
    )).join(',')}}`
  }

  ancestors.delete(value)
  return result
}

/**
 * Derive a deterministic SHA-256 key from semantic event identity.
 * Event IDs and timestamps are deliberately excluded so retries can reuse it.
 */
export function stableIdempotencyKey<TPayload>(input: StableIdempotencyInput<TPayload>): string {
  assertStableInput(input)
  const canonical = canonicalJson({
    aggregateId: input.aggregateId,
    actor: input.actor ?? null,
    causationId: input.causationId ?? null,
    eventType: input.eventType,
    firmId: input.firmId ?? null,
    payload: input.payload,
    policyVersion: input.policyVersion ?? DEFAULT_POLICY_VERSION,
    schemaVersion: input.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
  }, new Set())
  return createHash('sha256').update(`lawfirm-ads:event-envelope:v1:${canonical}`, 'utf8').digest('hex')
}

function normalizeTimestamp(value: EventTimestampInput, field: string): EventTimestamp {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new EventEnvelopeValidationError([`${field} must be a valid timestamp`])
  return date.toISOString()
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item)) as T
  if (isPlainRecord(value)) {
    const clone: Record<string, unknown> = {}
    for (const key of Object.keys(value)) clone[key] = cloneJsonValue(value[key])
    return clone as T
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

/** Construct a complete, immutable envelope with safe defaults for generated fields. */
export function createEventEnvelope<TPayload>(input: EventEnvelopeInput<TPayload>): EventEnvelope<TPayload> {
  if (!isPlainRecord(input)) throw new EventEnvelopeValidationError(['envelope input must be a non-null object'])

  const eventId = input.eventId === undefined ? randomUUID() : input.eventId
  const now = new Date()
  const occurredAt = normalizeTimestamp(input.occurredAt === undefined ? now : input.occurredAt, 'occurredAt')
  const recordedAt = normalizeTimestamp(input.recordedAt === undefined ? now : input.recordedAt, 'recordedAt')
  const schemaVersion = input.schemaVersion === undefined ? DEFAULT_SCHEMA_VERSION : input.schemaVersion
  const policyVersion = input.policyVersion === undefined ? DEFAULT_POLICY_VERSION : input.policyVersion
  const correlationId = input.correlationId === undefined || input.correlationId === null
    ? eventId
    : input.correlationId
  // Validate actor/payload before cloning. This also protects the custom-key
  // path from recursing into a circular value that the helper would reject.
  assertStableInput({
    aggregateId: input.aggregateId,
    actor: input.actor,
    causationId: input.causationId ?? null,
    eventType: input.eventType,
    firmId: input.firmId,
    payload: input.payload,
    policyVersion,
    schemaVersion,
  })
  const idempotencyKey = input.idempotencyKey === undefined
    ? stableIdempotencyKey({
      aggregateId: input.aggregateId,
      actor: input.actor,
      causationId: input.causationId,
      eventType: input.eventType,
      firmId: input.firmId,
      payload: input.payload,
      policyVersion,
      schemaVersion,
    })
    : input.idempotencyKey

  const envelope: Record<string, unknown> = {
    eventId,
    eventType: input.eventType,
    aggregateId: input.aggregateId,
    actor: cloneJsonValue(input.actor),
    occurredAt,
    recordedAt,
    correlationId,
    schemaVersion,
    policyVersion,
    idempotencyKey,
    payload: cloneJsonValue(input.payload),
  }
  if (input.firmId !== undefined && input.firmId !== null) envelope.firmId = input.firmId
  envelope.causationId = input.causationId ?? null

  validateEventEnvelope(envelope)
  return deepFreeze(envelope) as EventEnvelope<TPayload>
}

/** Validate an envelope and throw one error containing every contract violation. */
export function validateEventEnvelope(value: unknown): asserts value is EventEnvelope {
  const issues = collectEnvelopeIssues(value)
  if (issues.length) throw new EventEnvelopeValidationError(issues)
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  try {
    validateEventEnvelope(value)
    return true
  } catch {
    return false
  }
}
