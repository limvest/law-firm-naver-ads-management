import { describe, expect, it } from 'vitest'
import {
  createEventEnvelope,
  EventEnvelopeValidationError,
  isEventEnvelope,
  stableIdempotencyKey,
  validateEventEnvelope,
} from '@/domains/operations/event-envelope'

const input = {
  eventType: 'lead.created',
  aggregateId: 'lead-123',
  firmId: 'firm-7',
  actor: { kind: 'system', id: 'intake-api' },
  occurredAt: '2026-08-10T01:02:03Z',
  recordedAt: '2026-08-10T01:02:04Z',
  correlationId: 'correlation-1',
  causationId: 'request-1',
  schemaVersion: 2,
  policyVersion: 3,
  payload: { source: 'naver', lead: { id: 'lead-123' } },
}

describe('event envelope', () => {
  it('constructs the complete append-only contract and normalizes timestamps', () => {
    const envelope = createEventEnvelope(input)

    expect(envelope).toMatchObject({
      eventId: expect.any(String),
      eventType: 'lead.created',
      aggregateId: 'lead-123',
      firmId: 'firm-7',
      actor: { kind: 'system', id: 'intake-api' },
      occurredAt: '2026-08-10T01:02:03.000Z',
      recordedAt: '2026-08-10T01:02:04.000Z',
      correlationId: 'correlation-1',
      causationId: 'request-1',
      schemaVersion: 2,
      policyVersion: 3,
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      payload: { source: 'naver', lead: { id: 'lead-123' } },
    })
    expect(isEventEnvelope(envelope)).toBe(true)
  })

  it('generates an event id, correlation id, timestamps, versions, and a stable key', () => {
    const first = createEventEnvelope({
      eventType: 'case.approved',
      aggregateId: 'case-1',
      actor: 'operator:1',
      payload: { approved: true },
    })
    const second = createEventEnvelope({
      eventType: 'case.approved',
      aggregateId: 'case-1',
      actor: 'operator:1',
      payload: { approved: true },
    })

    expect(first.eventId).toEqual(expect.any(String))
    expect(first.eventId).not.toBe(second.eventId)
    expect(first.correlationId).toBe(first.eventId)
    expect(first.causationId).toBeNull()
    expect(first.schemaVersion).toBe(1)
    expect(first.policyVersion).toBe(1)
    expect(first.occurredAt).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/))
    expect(first.recordedAt).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/))
    expect(first.idempotencyKey).toBe(second.idempotencyKey)
  })

  it('accepts Date timestamps and numeric firm IDs while omitting null optionals', () => {
    const envelope = createEventEnvelope({
      ...input,
      firmId: 42,
      occurredAt: new Date('2026-08-10T01:02:03.456Z'),
      recordedAt: new Date('2026-08-10T01:02:04.567Z'),
      correlationId: null,
      causationId: null,
    })

    expect(envelope.firmId).toBe(42)
    expect(envelope.occurredAt).toBe('2026-08-10T01:02:03.456Z')
    expect(envelope.recordedAt).toBe('2026-08-10T01:02:04.567Z')
    expect(envelope.correlationId).toBe(envelope.eventId)
    expect(envelope.causationId).toBeNull()
  })

  it('derives the same key despite object insertion order and volatile envelope fields', () => {
    const keyA = stableIdempotencyKey({
      eventType: 'lead.created',
      aggregateId: 'lead-1',
      firmId: 9,
      actor: { id: 'worker', kind: 'system' },
      causationId: 'request-1',
      schemaVersion: 2,
      policyVersion: 4,
      payload: { z: 3, nested: { b: false, a: true } },
    })
    const keyB = stableIdempotencyKey({
      policyVersion: 4,
      payload: { nested: { a: true, b: false }, z: 3 },
      actor: { kind: 'system', id: 'worker' },
      aggregateId: 'lead-1',
      eventType: 'lead.created',
      firmId: 9,
      schemaVersion: 2,
      causationId: 'request-1',
    })

    expect(keyA).toBe(keyB)
    expect(keyA).toMatch(/^[a-f0-9]{64}$/)

    const retryA = createEventEnvelope({ ...input, eventId: 'event-a', occurredAt: '2026-01-01T00:00:00Z', recordedAt: '2026-01-01T00:00:01Z' })
    const retryB = createEventEnvelope({ ...input, eventId: 'event-b', occurredAt: '2027-01-01T00:00:00Z', recordedAt: '2027-01-01T00:00:01Z' })
    expect(retryA.idempotencyKey).toBe(retryB.idempotencyKey)
  })

  it('changes the key when semantic identity changes', () => {
    const base = {
      eventType: 'case.approved',
      aggregateId: 'case-1',
      actor: 'system',
      payload: { approved: true },
    }
    const key = stableIdempotencyKey(base)
    expect(stableIdempotencyKey({ ...base, eventType: 'case.rejected' })).not.toBe(key)
    expect(stableIdempotencyKey({ ...base, aggregateId: 'case-2' })).not.toBe(key)
    expect(stableIdempotencyKey({ ...base, actor: 'operator:1' })).not.toBe(key)
    expect(stableIdempotencyKey({ ...base, payload: { approved: false } })).not.toBe(key)
    expect(stableIdempotencyKey({ ...base, firmId: 1 })).not.toBe(key)
    expect(stableIdempotencyKey({ ...base, schemaVersion: 2 })).not.toBe(key)
  })

  it('copies and freezes the envelope and nested actor/payload', () => {
    const actor = { kind: 'system' }
    const payload = { nested: { count: 1 } }
    const envelope = createEventEnvelope({ eventType: 'job.created', aggregateId: 'job-1', actor, payload })

    actor.kind = 'human'
    payload.nested.count = 2

    expect(envelope.actor).toEqual({ kind: 'system' })
    expect(envelope.payload).toEqual({ nested: { count: 1 } })
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(envelope.actor)).toBe(true)
    expect(Object.isFrozen(envelope.payload)).toBe(true)
    expect(Object.isFrozen((envelope.payload as { nested: object }).nested)).toBe(true)
  })
})

describe('event envelope validation', () => {
  it('reports all missing and malformed contract fields', () => {
    expect(() => validateEventEnvelope({
      eventId: '',
      eventType: ' ',
      aggregateId: null,
      actor: {},
      occurredAt: 'not-a-date',
      recordedAt: new Date('invalid'),
      correlationId: '',
      schemaVersion: 0,
      policyVersion: 1.5,
      idempotencyKey: '',
      payload: undefined,
    })).toThrow(EventEnvelopeValidationError)

    try {
      validateEventEnvelope({
        eventId: '',
        eventType: ' ',
        aggregateId: null,
        actor: {},
        occurredAt: 'not-a-date',
        recordedAt: new Date('invalid'),
        correlationId: '',
        causationId: null,
        schemaVersion: 0,
        policyVersion: 1.5,
        idempotencyKey: '',
        payload: undefined,
      })
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(EventEnvelopeValidationError)
      expect((error as EventEnvelopeValidationError).issues.length).toBeGreaterThan(6)
      expect((error as EventEnvelopeValidationError).issues).toContain('payload is required')
    }
  })

  it.each([
    ['event type', { eventType: '' }],
    ['aggregate id', { aggregateId: '' }],
    ['actor', { actor: null }],
    ['occurred timestamp', { occurredAt: 'invalid' }],
    ['recorded timestamp', { recordedAt: 'invalid' }],
    ['schema version', { schemaVersion: 0 }],
    ['policy version', { policyVersion: 0 }],
    ['idempotency key', { idempotencyKey: '' }],
    ['payload', { payload: undefined }],
  ])('rejects an invalid %s', (_, override) => {
    expect(() => createEventEnvelope({ ...input, ...override } as never)).toThrow(EventEnvelopeValidationError)
  })

  it('rejects non-JSON payloads and circular references', () => {
    expect(() => createEventEnvelope({ ...input, payload: { callback: () => undefined } } as never)).toThrow(/JSON-compatible/)

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => createEventEnvelope({ ...input, payload: circular })).toThrow(/circular references/)
    expect(() => createEventEnvelope({ ...input, idempotencyKey: 'provided-key', payload: circular })).toThrow(/circular references/)
  })

  it('supports a caller-provided idempotency key without recomputing it', () => {
    const envelope = createEventEnvelope({ ...input, idempotencyKey: 'command-2026-08-10-1' })
    expect(envelope.idempotencyKey).toBe('command-2026-08-10-1')
    expect(isEventEnvelope(envelope)).toBe(true)
  })

  it('returns false instead of throwing for structural checks', () => {
    expect(isEventEnvelope(null)).toBe(false)
    expect(isEventEnvelope({ ...input })).toBe(false)
    expect(isEventEnvelope(createEventEnvelope(input))).toBe(true)
  })
})
