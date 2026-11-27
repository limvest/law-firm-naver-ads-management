import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { operationJobAttempts, operationJobs, firms } from '@/lib/db/schema'
import { createTestDb } from '../helpers/test-db'
import {
  claimJob,
  createPostgresJobQueue,
  deadLetterJob,
  enqueueJob,
  failJob,
  requeueJob,
  succeedJob,
} from '@/platform/jobs/postgres-queue'

const t0 = new Date('2026-01-01T00:00:00.000Z')

async function seedFirms(db: Awaited<ReturnType<typeof createTestDb>>): Promise<void> {
  await db.insert(firms).values([
    {
      id: 1,
      slug: 'firm-one',
      name: 'Firm One',
      adLawyerName: 'Lawyer One',
      phone: '010-0000-0001',
      phoneIntl: '+82-10-0000-0001',
      address: 'Seoul',
      addressRegion: 'Seoul',
      addressLocality: 'Jongno',
    },
    {
      id: 2,
      slug: 'firm-two',
      name: 'Firm Two',
      adLawyerName: 'Lawyer Two',
      phone: '010-0000-0002',
      phoneIntl: '+82-10-0000-0002',
      address: 'Busan',
      addressRegion: 'Busan',
      addressLocality: 'Haeundae',
    },
  ])
}

describe('Postgres durable operation queue', () => {
  it('enqueues idempotently and rejects a key reused for different semantics', async () => {
    const db = await createTestDb()
    await seedFirms(db)

    const input = {
      jobType: 'sync-case',
      idempotencyKey: 'firm-1:sync-case:case-1',
      firmId: 1,
      payload: { caseId: 'case-1' },
    } as const
    const first = await enqueueJob(db, input)
    const second = await enqueueJob(db, input)

    const reordered = await enqueueJob(db, {
      ...input,
      payload: { nested: { b: 2, a: 1 }, caseId: 'case-1' },
      idempotencyKey: 'firm-1:sync-case:case-ordered',
    })
    const reorderedReplay = await enqueueJob(db, {
      ...input,
      payload: { caseId: 'case-1', nested: { a: 1, b: 2 } },
      idempotencyKey: 'firm-1:sync-case:case-ordered',
    })

    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(reorderedReplay.row.id).toBe(reordered.row.id)
    expect(second.row.id).toBe(first.row.id)
    expect(await db.select().from(operationJobs)).toHaveLength(2)

    await expect(enqueueJob(db, { ...input, payload: { caseId: 'case-2' } }))
      .rejects.toThrow(/idempotency collision/)
    await expect(enqueueJob(db, { ...input, firmId: 2 }))
      .rejects.toThrow(/idempotency collision/)
  })

  it('claims only due jobs in the requested firm and records a running attempt', async () => {
    const db = await createTestDb()
    await seedFirms(db)
    const firmOne = await enqueueJob(db, {
      jobType: 'firm-one-job',
      idempotencyKey: 'firm-1:job-1',
      firmId: 1,
      payload: { n: 1 },
      priority: 10,
      now: t0,
    })
    const firmTwo = await enqueueJob(db, {
      jobType: 'firm-two-job',
      idempotencyKey: 'firm-2:job-1',
      firmId: 2,
      payload: { n: 2 },
      now: t0,
    })
    await enqueueJob(db, {
      jobType: 'future-job',
      idempotencyKey: 'firm-1:future',
      firmId: 1,
      payload: {},
      availableAt: new Date(t0.getTime() + 10_000),
      now: t0,
    })

    const claimed = await claimJob(db, {
      workerId: 'worker-one',
      firmId: 1,
      now: t0,
      leaseDurationMs: 5_000,
    })
    expect(claimed).toMatchObject({
      id: firmOne.row.id,
      state: 'running',
      firmId: 1,
      attempts: 1,
      leaseOwner: 'worker-one',
      leaseExpiresAt: new Date(t0.getTime() + 5_000),
    })
    expect(await claimJob(db, { workerId: 'worker-two', firmId: 1, now: t0 })).toBeNull()

    const attempts = await db.select().from(operationJobAttempts)
      .where(eq(operationJobAttempts.jobId, firmOne.row.id))
    expect(attempts).toMatchObject([{
      jobId: firmOne.row.id,
      attempt: 1,
      workerId: 'worker-one',
      state: 'running',
      finishedAt: null,
    }])

    const otherFirmClaim = await claimJob(db, {
      workerId: 'worker-two',
      firmId: 2,
      now: t0,
      leaseDurationMs: 5_000,
    })
    expect(otherFirmClaim?.id).toBe(firmTwo.row.id)
    expect(await claimJob(db, { workerId: 'worker-global', firmId: 1, now: new Date(t0.getTime() + 1_000) }))
      .toBeNull()
  })

  it('requires the firm and active lease for success, then closes the attempt atomically', async () => {
    const db = await createTestDb()
    await seedFirms(db)
    const { row } = await enqueueJob(db, {
      jobType: 'publish',
      idempotencyKey: 'firm-1:publish:1',
      firmId: 1,
      payload: { publicationId: 'p1' },
      now: t0,
    })
    await claimJob(db, { workerId: 'worker-one', firmId: 1, now: t0, leaseDurationMs: 5_000 })

    expect(await succeedJob(db, {
      id: row.id,
      workerId: 'worker-one',
      firmId: 2,
      now: new Date(t0.getTime() + 1_000),
    })).toBeNull()

    const succeeded = await succeedJob(db, {
      id: row.id,
      workerId: 'worker-one',
      firmId: 1,
      now: new Date(t0.getTime() + 1_000),
    })
    expect(succeeded).toMatchObject({
      id: row.id,
      state: 'succeeded',
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: new Date(t0.getTime() + 1_000),
    })
    const [attempt] = await db.select().from(operationJobAttempts)
      .where(and(eq(operationJobAttempts.jobId, row.id), eq(operationJobAttempts.attempt, 1)))
    expect(attempt).toMatchObject({ state: 'succeeded', finishedAt: new Date(t0.getTime() + 1_000), error: null })

    expect(await succeedJob(db, {
      id: row.id,
      workerId: 'worker-one',
      firmId: 1,
      now: new Date(t0.getTime() + 2_000),
    })).toBeNull()
  })

  it('retries with capped exponential backoff and can be dead-lettered after exhaustion', async () => {
    const db = await createTestDb()
    await seedFirms(db)
    const queue = createPostgresJobQueue(db, {
      leaseDurationMs: 10_000,
      backoff: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 2_500 },
    })
    const { row } = await queue.enqueue({
      jobType: 'crawl',
      idempotencyKey: 'firm-1:crawl:1',
      firmId: 1,
      payload: { url: 'https://example.test' },
      maxAttempts: 3,
      now: t0,
    })

    await queue.claim({ workerId: 'worker-one', firmId: 1, now: t0 })
    const retryOne = await queue.fail({
      id: row.id,
      workerId: 'worker-one',
      firmId: 1,
      error: 'upstream unavailable',
      now: new Date(t0.getTime() + 10),
    })
    expect(retryOne).toMatchObject({
      state: 'retryable',
      attempts: 1,
      availableAt: new Date(t0.getTime() + 1_010),
      lastError: 'upstream unavailable',
    })
    expect(await queue.claim({ workerId: 'worker-one', firmId: 1, now: new Date(t0.getTime() + 500) }))
      .toBeNull()

    await queue.claim({ workerId: 'worker-one', firmId: 1, now: new Date(t0.getTime() + 1_010) })
    const retryTwo = await queue.fail({
      id: row.id,
      workerId: 'worker-one',
      firmId: 1,
      retryable: true,
      error: { code: 'HTTP_503', message: 'still unavailable' },
      now: new Date(t0.getTime() + 1_020),
    })
    expect(retryTwo?.availableAt).toEqual(new Date(t0.getTime() + 3_020))

    await queue.claim({ workerId: 'worker-one', firmId: 1, now: new Date(t0.getTime() + 3_020) })
    const exhausted = await queue.fail({
      id: row.id,
      workerId: 'worker-one',
      firmId: 1,
      retryable: true,
      error: new Error('permanent after retries'),
      now: new Date(t0.getTime() + 3_030),
    })
    expect(exhausted).toMatchObject({ state: 'failed', finishedAt: new Date(t0.getTime() + 3_030) })

    const dead = await deadLetterJob(db, {
      id: row.id,
      firmId: 1,
      reason: { code: 'OPERATOR_REVIEW', message: 'moved to dead letter' },
      now: new Date(t0.getTime() + 3_040),
    })
    expect(dead).toMatchObject({
      state: 'dead',
      lastError: 'moved to dead letter',
      finishedAt: new Date(t0.getTime() + 3_040),
      leaseOwner: null,
    })

    const attempts = await db.select().from(operationJobAttempts)
      .where(eq(operationJobAttempts.jobId, row.id))
      .orderBy(operationJobAttempts.attempt)
    expect(attempts.map((attempt) => attempt.state)).toEqual(['retryable', 'retryable', 'failed'])
    expect(await deadLetterJob(db, { id: row.id, firmId: 2, now: new Date(t0.getTime() + 4_000) })).toBeNull()

    expect(await requeueJob(db, { id: row.id, firmId: 2, now: new Date(t0.getTime() + 4_100) })).toBeNull()
    const requeued = await requeueJob(db, { id: row.id, firmId: 1, now: new Date(t0.getTime() + 4_100) })
    expect(requeued).toMatchObject({
      state: 'queued',
      attempts: 3,
      maxAttempts: 6,
      availableAt: new Date(t0.getTime() + 4_100),
      finishedAt: null,
      leaseOwner: null,
    })
    expect(await claimJob(db, {
      workerId: 'operator-recovery-worker',
      firmId: 1,
      now: new Date(t0.getTime() + 4_100),
    })).toMatchObject({ state: 'running', attempts: 4 })
  })

  it('does not allow a stale lease to complete a job', async () => {
    const db = await createTestDb()
    await seedFirms(db)
    const { row } = await enqueueJob(db, {
      jobType: 'short-lease',
      idempotencyKey: 'firm-1:short-lease:1',
      firmId: 1,
      payload: {},
      now: t0,
    })
    await claimJob(db, { workerId: 'worker-one', firmId: 1, now: t0, leaseDurationMs: 100 })

    expect(await succeedJob(db, {
      id: row.id,
      workerId: 'worker-one',
      firmId: 1,
      now: new Date(t0.getTime() + 100),
    })).toBeNull()
    expect(await failJob(db, {
      id: row.id,
      workerId: 'worker-one',
      firmId: 1,
      error: 'late worker',
      now: new Date(t0.getTime() + 101),
    })).toBeNull()
  })
})
