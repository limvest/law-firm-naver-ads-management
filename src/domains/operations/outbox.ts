import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { outboxEvents } from '@/lib/db/schema'
import {
  validateEventEnvelope,
  type EventEnvelope,
  type EventJsonValue,
} from './event-envelope'

type OutboxRow = typeof outboxEvents.$inferSelect

export type AppendOutboxInput = {
  aggregateType: string
  envelope: EventEnvelope<EventJsonValue>
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${label} must not be empty`)
  return normalized
}

function objectPayload(payload: EventJsonValue): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TypeError('outbox payload must be a JSON object')
  }
  return payload as Record<string, unknown>
}

function actorValue(actor: EventEnvelope['actor']): string {
  return typeof actor === 'string' ? actor : JSON.stringify(actor)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameSemanticEvent(row: OutboxRow, input: AppendOutboxInput): boolean {
  const { envelope } = input
  return row.eventType === envelope.eventType
    && row.aggregateType === input.aggregateType.trim()
    && row.aggregateId === String(envelope.aggregateId)
    && row.firmId === (envelope.firmId === undefined ? null : Number(envelope.firmId))
    && row.actor === actorValue(envelope.actor)
    && row.correlationId === String(envelope.correlationId)
    && row.causationId === (envelope.causationId === null ? null : String(envelope.causationId))
    && row.schemaVersion === String(envelope.schemaVersion)
    && row.policyVersion === String(envelope.policyVersion)
    && canonicalJson(row.payload) === canonicalJson(envelope.payload)
}

/**
 * Append an immutable domain event. Replaying an identical envelope is safe;
 * reusing its idempotency key for different semantics is rejected loudly.
 */
export async function appendOutboxEvent(
  db: Db,
  input: AppendOutboxInput,
): Promise<{ row: OutboxRow; inserted: boolean }> {
  validateEventEnvelope(input.envelope)
  const aggregateType = required(input.aggregateType, 'aggregate type')
  const firmId = input.envelope.firmId === undefined
    ? null
    : Number(input.envelope.firmId)
  if (firmId !== null && (!Number.isSafeInteger(firmId) || firmId < 0)) {
    throw new TypeError('outbox firm id must be a non-negative integer')
  }

  const values: typeof outboxEvents.$inferInsert = {
    eventType: input.envelope.eventType,
    aggregateType,
    aggregateId: String(input.envelope.aggregateId),
    firmId,
    actor: actorValue(input.envelope.actor),
    occurredAt: new Date(input.envelope.occurredAt),
    recordedAt: new Date(input.envelope.recordedAt),
    correlationId: String(input.envelope.correlationId),
    causationId: input.envelope.causationId === null
      ? null
      : String(input.envelope.causationId),
    schemaVersion: String(input.envelope.schemaVersion),
    policyVersion: String(input.envelope.policyVersion),
    idempotencyKey: input.envelope.idempotencyKey,
    payload: objectPayload(input.envelope.payload),
  }

  const [inserted] = await db.insert(outboxEvents)
    .values(values)
    .onConflictDoNothing({ target: outboxEvents.idempotencyKey })
    .returning()
  if (inserted) return { row: inserted, inserted: true }

  const [existing] = await db.select().from(outboxEvents)
    .where(eq(outboxEvents.idempotencyKey, input.envelope.idempotencyKey))
    .limit(1)
  if (!existing) throw new Error('outbox idempotency conflict could not be resolved')
  if (!sameSemanticEvent(existing, { ...input, aggregateType })) {
    throw new Error(`outbox idempotency collision: ${input.envelope.idempotencyKey}`)
  }
  return { row: existing, inserted: false }
}

export async function listPendingOutboxEvents(
  db: Db,
  options: { limit?: number; firmId?: number } = {},
): Promise<OutboxRow[]> {
  const limit = options.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('outbox limit must be between 1 and 1000')
  }
  const filter = options.firmId === undefined
    ? isNull(outboxEvents.publishedAt)
    : and(isNull(outboxEvents.publishedAt), eq(outboxEvents.firmId, options.firmId))
  return db.select().from(outboxEvents)
    .where(filter)
    .orderBy(asc(outboxEvents.recordedAt), asc(outboxEvents.id))
    .limit(limit)
}

export async function markOutboxPublished(
  db: Db,
  id: string,
  publishedAt = new Date(),
): Promise<boolean> {
  const rows = await db.update(outboxEvents).set({
    publishedAt,
    publishAttempts: 1,
  }).where(and(eq(outboxEvents.id, id), isNull(outboxEvents.publishedAt)))
    .returning({ id: outboxEvents.id })
  return rows.length === 1
}

export async function recordOutboxPublishFailure(db: Db, id: string): Promise<boolean> {
  const [row] = await db.select({ attempts: outboxEvents.publishAttempts })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.id, id), isNull(outboxEvents.publishedAt)))
    .limit(1)
  if (!row) return false
  const updated = await db.update(outboxEvents).set({
    publishAttempts: row.attempts + 1,
  }).where(and(
    eq(outboxEvents.id, id),
    isNull(outboxEvents.publishedAt),
    eq(outboxEvents.publishAttempts, row.attempts),
  )).returning({ id: outboxEvents.id })
  return updated.length === 1
}
