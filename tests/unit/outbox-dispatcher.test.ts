import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, outboxEvents } from '@/lib/db/schema'
import { createEventEnvelope } from '@/domains/operations/event-envelope'
import { appendOutboxEvent } from '@/domains/operations/outbox'
import {
  dispatchOutbox,
  type OutboxEventRow,
} from '@/domains/operations/outbox-dispatcher'
import {
  readOutboxWebhookConfig,
  runDrainOutbox,
  validateOutboxWebhookUrl,
} from '../../scripts/agent/drain-outbox'

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values({
    id: 7,
    slug: 'firm-7',
    name: 'Firm 7',
    adLawyerName: 'Lawyer 7',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Seoul',
  })
}

async function appendEvent(
  db: Awaited<ReturnType<typeof createTestDb>>,
  aggregateId: string,
  recordedAt: string,
) {
  const result = await appendOutboxEvent(db, {
    aggregateType: 'case_entity',
    envelope: createEventEnvelope({
      eventId: `event-${aggregateId}`,
      eventType: 'case.approved',
      aggregateId,
      firmId: 7,
      actor: 'policy:test',
      occurredAt: recordedAt,
      recordedAt,
      correlationId: `run-${aggregateId}`,
      payload: { aggregateId },
    }),
  })
  return result.row
}

describe('operations outbox dispatcher', () => {
  it('delivers deterministic rows and marks only acknowledged rows', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    await appendEvent(db, 'case-3', '2026-08-10T00:00:03Z')
    await appendEvent(db, 'case-1', '2026-08-10T00:00:01Z')
    await appendEvent(db, 'case-2', '2026-08-10T00:00:02Z')

    const delivered: string[] = []
    const result = await dispatchOutbox(db, {
      batchSize: 2,
      maxEvents: 3,
      deliver: async (row) => {
        const [beforeAcknowledgement] = await db.select().from(outboxEvents)
          .where(eq(outboxEvents.id, row.id))
        expect(beforeAcknowledgement.publishedAt).toBeNull()
        delivered.push(row.aggregateId)
      },
    })

    expect(delivered).toEqual(['case-1', 'case-2', 'case-3'])
    expect(result).toEqual({ delivered: 3, failed: 0, pending: 0, skipped: 0 })
    const rows = await db.select().from(outboxEvents)
    expect(rows.every((row) => row.publishedAt instanceof Date)).toBe(true)
    expect(rows.every((row) => row.publishAttempts === 0)).toBe(true)
  })

  it('increments attempts and leaves failed delivery unpublished', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const failed = await appendEvent(db, 'case-failed', '2026-08-10T00:00:01Z')
    const delivered = await appendEvent(db, 'case-delivered', '2026-08-10T00:00:02Z')

    const result = await dispatchOutbox(db, async (row) => {
      if (row.id === failed.id) throw new Error('provider detail must not escape')
    })

    expect(result).toEqual({ delivered: 1, failed: 1, pending: 1, skipped: 0 })
    const [failedAfter] = await db.select().from(outboxEvents)
      .where(eq(outboxEvents.id, failed.id))
    const [deliveredAfter] = await db.select().from(outboxEvents)
      .where(eq(outboxEvents.id, delivered.id))
    expect(failedAfter).toMatchObject({ publishedAt: null, publishAttempts: 1 })
    expect(deliveredAfter.publishedAt).toBeInstanceOf(Date)
  })

  it('enforces batch and max-event bounds while reporting remaining backlog', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    await appendEvent(db, 'case-1', '2026-08-10T00:00:01Z')
    await appendEvent(db, 'case-2', '2026-08-10T00:00:02Z')
    await appendEvent(db, 'case-3', '2026-08-10T00:00:03Z')

    const seen: string[] = []
    const result = await dispatchOutbox(db, {
      batchSize: 1,
      maxEvents: 2,
      delivery: async (row) => { seen.push(row.aggregateId) },
    })

    expect(seen).toEqual(['case-1', 'case-2'])
    expect(result).toEqual({ delivered: 2, failed: 0, pending: 1, skipped: 0 })
  })

  it('treats an explicit negative acknowledgement as a failed delivery', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const row = await appendEvent(db, 'case-negative', '2026-08-10T00:00:01Z')

    const result = await dispatchOutbox(db, {
      deliver: async (): Promise<boolean> => false,
    })

    expect(result).toEqual({ delivered: 0, failed: 1, pending: 1, skipped: 0 })
    const [after] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, row.id))
    expect(after).toMatchObject({ publishedAt: null, publishAttempts: 1 })
  })
})

describe('drain-outbox CLI configuration', () => {
  it('allows HTTP only for localhost and rejects insecure external destinations', () => {
    expect(validateOutboxWebhookUrl('http://localhost:8787/hook').hostname).toBe('localhost')
    expect(validateOutboxWebhookUrl('http://127.0.0.1:8787/hook').protocol).toBe('http:')
    expect(() => validateOutboxWebhookUrl('http://webhook.example/hook')).toThrow(/HTTPS/)
    expect(() => validateOutboxWebhookUrl('ftp://webhook.example/hook')).toThrow()
    expect(() => validateOutboxWebhookUrl('https://user:pass@webhook.example/hook')).toThrow()
  })

  it('skips cleanly when webhook configuration is absent', async () => {
    const logs: string[] = []
    expect(readOutboxWebhookConfig({})).toBeNull()
    await expect(runDrainOutbox({
      env: {},
      log: (message) => logs.push(message),
      fetchImpl: async () => { throw new Error('must not call fetch') },
    })).resolves.toBe(0)
    expect(logs.join('\n')).toMatch(/skipped/)
  })

  it('returns nonzero for configured delivery failure without leaking secret or error text', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const row = await appendEvent(db, 'case-webhook-failed', '2026-08-10T00:00:01Z')
    const secret = 'super-secret-bearer-value'
    const logs: string[] = []

    const exitCode = await runDrainOutbox({
      env: {
        OUTBOX_WEBHOOK_URL: 'https://webhook.example/hook',
        OUTBOX_WEBHOOK_BEARER_SECRET: secret,
      },
      db,
      log: (message) => logs.push(message),
      fetchImpl: async () => new Response('provider-internal-secret', { status: 503 }),
    })

    expect(exitCode).toBe(1)
    expect(logs.join('\n')).not.toContain(secret)
    expect(logs.join('\n')).not.toContain('provider-internal-secret')
    const [after] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, row.id))
    expect(after).toMatchObject({ publishedAt: null, publishAttempts: 1 })
  })

  it('uses bearer authentication and acknowledges a successful webhook', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    await appendEvent(db, 'case-webhook-ok', '2026-08-10T00:00:01Z')
    const secret = 'another-secret-value'
    let request: { url: string | URL; init?: RequestInit } | null = null

    const exitCode = await runDrainOutbox({
      env: {
        OUTBOX_WEBHOOK_URL: 'https://webhook.example/hook',
        OUTBOX_WEBHOOK_BEARER_SECRET: secret,
      },
      db,
      fetchImpl: async (url, init) => {
        request = { url, init }
        return new Response(null, { status: 204 })
      },
      log: () => undefined,
    })

    expect(exitCode).toBe(0)
    expect(request?.url.toString()).toBe('https://webhook.example/hook')
    expect(request?.init?.headers).toMatchObject({ authorization: `Bearer ${secret}` })
    const body = JSON.parse(String(request?.init?.body)) as OutboxEventRow
    expect(body.aggregateId).toBe('case-webhook-ok')
    expect(body.payload).toEqual({ aggregateId: 'case-webhook-ok' })
  })
})
