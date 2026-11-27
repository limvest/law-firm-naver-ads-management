import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, outboxEvents } from '@/lib/db/schema'
import { createEventEnvelope } from '@/domains/operations/event-envelope'
import {
  appendOutboxEvent,
  listPendingOutboxEvents,
  markOutboxPublished,
  recordOutboxPublishFailure,
} from '@/domains/operations/outbox'

function event(overrides: Record<string, unknown> = {}) {
  return createEventEnvelope({
    eventId: 'event-1',
    eventType: 'case.approved',
    aggregateId: 'case-1',
    firmId: 7,
    actor: 'policy:case-evidence-v1',
    occurredAt: '2026-08-10T00:00:00Z',
    recordedAt: '2026-08-10T00:00:01Z',
    correlationId: 'daily-2026-08-10',
    payload: { caseEntityId: 'case-1', status: 'approved' },
    ...overrides,
  })
}

async function seedFirms(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values([7, 9].map((id) => ({
    id,
    slug: `firm-${id}`,
    name: `Firm ${id}`,
    adLawyerName: `Lawyer ${id}`,
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Seoul',
  })))
}

describe('operations outbox', () => {
  it('appends the event envelope and makes identical replay idempotent', async () => {
    const db = await createTestDb()
    await seedFirms(db)
    const first = await appendOutboxEvent(db, { aggregateType: 'case_entity', envelope: event() })
    const replay = await appendOutboxEvent(db, { aggregateType: 'case_entity', envelope: event({ eventId: 'event-2' }) })

    expect(first.inserted).toBe(true)
    expect(replay.inserted).toBe(false)
    expect(replay.row.id).toBe(first.row.id)
    expect(replay.row).toMatchObject({
      eventType: 'case.approved',
      aggregateType: 'case_entity',
      aggregateId: 'case-1',
      firmId: 7,
      actor: 'policy:case-evidence-v1',
      correlationId: 'daily-2026-08-10',
      schemaVersion: '1',
      policyVersion: '1',
      publishAttempts: 0,
    })
    expect(await db.select().from(outboxEvents)).toHaveLength(1)
  })

  it('rejects a reused key with different semantic content', async () => {
    const db = await createTestDb()
    await seedFirms(db)
    const original = event()
    await appendOutboxEvent(db, { aggregateType: 'case_entity', envelope: original })
    const collision = event({
      eventType: 'case.blocked',
      idempotencyKey: original.idempotencyKey,
      payload: { caseEntityId: 'case-1', status: 'blocked' },
    })
    await expect(appendOutboxEvent(db, { aggregateType: 'case_entity', envelope: collision }))
      .rejects.toThrow(/idempotency collision/)
  })

  it('lists pending rows by tenant and records publish attempts', async () => {
    const db = await createTestDb()
    await seedFirms(db)
    const first = await appendOutboxEvent(db, { aggregateType: 'case_entity', envelope: event() })
    await appendOutboxEvent(db, {
      aggregateType: 'case_entity',
      envelope: event({ eventId: 'event-9', firmId: 9, aggregateId: 'case-9' }),
    })

    expect(await listPendingOutboxEvents(db, { firmId: 7 })).toHaveLength(1)
    expect(await recordOutboxPublishFailure(db, first.row.id)).toBe(true)
    expect(await recordOutboxPublishFailure(db, first.row.id)).toBe(true)
    const [failed] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, first.row.id))
    expect(failed.publishAttempts).toBe(2)

    const publishedAt = new Date('2026-08-10T00:10:00Z')
    expect(await markOutboxPublished(db, first.row.id, publishedAt)).toBe(true)
    expect(await markOutboxPublished(db, first.row.id, publishedAt)).toBe(false)
    expect(await recordOutboxPublishFailure(db, first.row.id)).toBe(false)
    expect(await listPendingOutboxEvents(db, { firmId: 7 })).toHaveLength(0)
    expect(await listPendingOutboxEvents(db)).toHaveLength(1)
  })

  it('requires object payloads and validates paging limits', async () => {
    const db = await createTestDb()
    await expect(appendOutboxEvent(db, {
      aggregateType: 'case_entity',
      envelope: event({ payload: 'not-an-object' }),
    })).rejects.toThrow(/JSON object/)
    await expect(listPendingOutboxEvents(db, { limit: 0 })).rejects.toThrow(RangeError)
  })
})
