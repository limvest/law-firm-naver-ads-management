import { describe, expect, it } from 'vitest'
import {
  JOB_STATES,
  JOB_TRANSITIONS,
  JobTransitionError,
  asLeaseId,
  calculateBackoffDelay,
  calculateRetryDelay,
  canTransition,
  createLease,
  createQueuedJob,
  isLeaseActive,
  isRetryDue,
  transitionJob,
} from '@/domains/operations/job-state'

const t0 = new Date('2026-01-01T00:00:00.000Z')
const leaseEnd = new Date('2026-01-01T00:05:00.000Z')

function lease(id = 'lease-1', acquiredAt = t0, expiresAt = leaseEnd) {
  return createLease({ leaseId: id, owner: 'worker-a', acquiredAt, expiresAt })
}

function queued(maxAttempts = 3) {
  return createQueuedJob({
    id: 'job-1',
    idempotencyKey: 'firm-1:job-1',
    maxAttempts,
    retryPolicy: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 10_000 },
    now: t0,
  })
}

function running(maxAttempts = 3) {
  return transitionJob(queued(maxAttempts), {
    type: 'claim',
    lease: lease(),
    at: t0,
  })
}

describe('job-state transition graph', () => {
  it('exposes the complete state set and rejects every unlisted edge', () => {
    expect(JOB_STATES).toEqual(['queued', 'running', 'retryable', 'failed', 'succeeded', 'dead'])

    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        const expected = JOB_TRANSITIONS[from].includes(to)
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected)
      }
    }
  })

  it.each([
    ['queued', ['running']],
    ['running', ['retryable', 'failed', 'succeeded']],
    ['retryable', ['running', 'dead']],
    ['failed', ['dead']],
    ['succeeded', []],
    ['dead', []],
  ] as const)('has the expected outgoing edges from %s', (state, targets) => {
    expect(JOB_TRANSITIONS[state]).toEqual(targets)
  })
})

describe('retry delay calculation', () => {
  it('uses exponential backoff from the 1-based failed attempt and clamps it', () => {
    const policy = { baseDelayMs: 250, factor: 2, maxDelayMs: 900 }
    expect(calculateRetryDelay(1, policy)).toBe(250)
    expect(calculateRetryDelay(2, policy)).toBe(500)
    expect(calculateRetryDelay(3, policy)).toBe(900)
    expect(calculateRetryDelay(20, policy)).toBe(900)
    expect(calculateBackoffDelay(2, policy)).toBe(500)
  })

  it('accepts initialDelay/multiplier aliases and validates bad input', () => {
    expect(calculateRetryDelay(2, { initialDelayMs: 100, multiplier: 3, maxDelayMs: 10_000 })).toBe(300)
    expect(() => calculateRetryDelay(0)).toThrow(RangeError)
    expect(() => calculateRetryDelay(1, { baseDelayMs: -1 })).toThrow(RangeError)
    expect(() => calculateRetryDelay(1, { factor: 0 })).toThrow(RangeError)
  })
})

describe('durable job transitions', () => {
  it('creates an idempotent queued record with no lease and zero attempts', () => {
    const job = queued()
    expect(job).toMatchObject({
      id: 'job-1',
      idempotencyKey: 'firm-1:job-1',
      state: 'queued',
      attempt: 0,
      nextRunAt: t0,
      lease: null,
      attempts: [],
      lastError: null,
    })
    expect(job.createdAt).not.toBe(t0)
    expect(job.updatedAt).not.toBe(t0)
    expect(job.createdAt).toEqual(t0)
    expect(job.retryPolicy.maxAttempts).toBe(3)
  })

  it('claims a due job, increments the attempt, and records the lease', () => {
    const before = queued()
    const claimed = transitionJob(before, { type: 'claim', lease: lease(), at: t0 })

    expect(claimed.state).toBe('running')
    expect(claimed.attempt).toBe(1)
    expect(claimed.nextRunAt).toBeNull()
    expect(claimed.lease?.leaseId).toBe(asLeaseId('lease-1'))
    expect(claimed.attempts).toHaveLength(1)
    expect(claimed.attempts[0]).toMatchObject({ number: 1, leaseId: 'lease-1', finishedAt: null, error: null })
    expect(before.state).toBe('queued')
    expect(before.attempts).toHaveLength(0)
  })

  it('does not claim an expired, future, or not-yet-due lease/job', () => {
    expect(() => transitionJob(queued(), {
      type: 'claim',
      lease: lease('expired', new Date('2025-12-31T23:00:00.000Z'), t0),
      at: t0,
    })).toThrow(JobTransitionError)

    expect(() => transitionJob(queued(), {
      type: 'claim',
      lease: lease('future', new Date('2026-01-01T00:01:00.000Z'), new Date('2026-01-01T00:05:00.000Z')),
      at: t0,
    })).toThrow(JobTransitionError)

    const retryable = transitionJob(running(), {
      type: 'retry',
      leaseId: asLeaseId('lease-1'),
      error: 'temporary outage',
      at: t0,
    })
    expect(() => transitionJob(retryable, {
      type: 'claim',
      lease: lease('too-early', t0, leaseEnd),
      at: new Date('2026-01-01T00:00:00.999Z'),
    })).toThrow(JobTransitionError)
  })

  it('rejects stale or expired completion leases', () => {
    const job = running()
    expect(() => transitionJob(job, {
      type: 'succeed',
      leaseId: asLeaseId('other-lease'),
      at: t0,
    })).toThrow(/lease does not own/)

    expect(() => transitionJob(job, {
      type: 'succeed',
      leaseId: asLeaseId('lease-1'),
      at: leaseEnd,
    })).toThrow(/expired/)
  })

  it('renews an active lease only when the expiry is extended', () => {
    const renewed = transitionJob(running(), {
      type: 'renew-lease',
      leaseId: asLeaseId('lease-1'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      at: new Date('2026-01-01T00:01:00.000Z'),
    })
    expect(renewed.state).toBe('running')
    expect(renewed.lease?.expiresAt).toEqual(new Date('2026-01-01T00:10:00.000Z'))

    expect(() => transitionJob(running(), {
      type: 'renew',
      leaseId: asLeaseId('lease-1'),
      expiresAt: leaseEnd,
      at: t0,
    })).toThrow(/extend/)
  })

  it('succeeds with a closed attempt and released lease', () => {
    const job = running()
    const succeeded = transitionJob(job, {
      type: 'succeed',
      leaseId: asLeaseId('lease-1'),
      result: { published: true },
      at: new Date('2026-01-01T00:00:30.000Z'),
    })

    expect(succeeded).toMatchObject({ state: 'succeeded', attempt: 1, lease: null, nextRunAt: null, lastError: null })
    expect(succeeded.result).toEqual({ published: true })
    expect(succeeded.attempts[0].finishedAt).toEqual(new Date('2026-01-01T00:00:30.000Z'))
    expect(succeeded.attempts[0].error).toBeNull()
  })

  it('schedules retryable failure using attempt-based exponential backoff', () => {
    const retryable = transitionJob(running(), {
      type: 'fail',
      leaseId: asLeaseId('lease-1'),
      error: { code: 'UPSTREAM_503', message: 'upstream unavailable' },
      retryable: true,
      at: t0,
    })

    expect(retryable).toMatchObject({ state: 'retryable', attempt: 1, lease: null, lastError: { code: 'UPSTREAM_503', retryable: true } })
    expect(retryable.nextRunAt).toEqual(new Date('2026-01-01T00:00:01.000Z'))
    expect(retryable.attempts[0].finishedAt).toEqual(t0)
    expect(retryable.attempts[0].error).toMatchObject({ code: 'UPSTREAM_503', message: 'upstream unavailable' })

    const inferredRetryable = transitionJob(running(), {
      type: 'fail',
      leaseId: asLeaseId('lease-1'),
      error: { code: 'UPSTREAM_429', message: 'rate limited', retryable: true },
      at: t0,
    })
    expect(inferredRetryable.state).toBe('retryable')
  })

  it('moves non-retryable and exhausted failures to failed', () => {
    const permanent = transitionJob(running(), {
      type: 'fail',
      leaseId: asLeaseId('lease-1'),
      error: 'invalid payload',
      at: t0,
    })
    expect(permanent).toMatchObject({ state: 'failed', nextRunAt: null, lease: null, lastError: { retryable: false } })

    const oneAttempt = running(1)
    const exhausted = transitionJob(oneAttempt, {
      type: 'retry',
      leaseId: asLeaseId('lease-1'),
      error: 'still unavailable',
      at: t0,
    })
    expect(exhausted.state).toBe('failed')
    expect(exhausted.nextRunAt).toBeNull()
    expect(exhausted.lastError?.retryable).toBe(true)
  })

  it('reclaims a due retryable job with a new lease and attempt', () => {
    const first = running()
    const retryable = transitionJob(first, {
      type: 'retry',
      leaseId: asLeaseId('lease-1'),
      error: 'temporary error',
      at: t0,
    })
    const secondAt = new Date('2026-01-01T00:00:01.000Z')
    const reclaimed = transitionJob(retryable, {
      type: 'claim',
      lease: lease('lease-2', secondAt, new Date('2026-01-01T00:05:00.000Z')),
      at: secondAt,
    })

    expect(reclaimed.state).toBe('running')
    expect(reclaimed.attempt).toBe(2)
    expect(reclaimed.attempts).toHaveLength(2)
    expect(reclaimed.attempts[0].finishedAt).toEqual(t0)
    expect(reclaimed.attempts[1]).toMatchObject({ number: 2, leaseId: 'lease-2', finishedAt: null })
  })

  it('dead-letters retryable and failed jobs, preserving a reason when supplied', () => {
    const retryable = transitionJob(running(), {
      type: 'retry',
      leaseId: asLeaseId('lease-1'),
      error: 'temporary error',
      at: t0,
    })
    const deadRetry = transitionJob(retryable, { type: 'dead-letter', at: t0 })
    expect(deadRetry).toMatchObject({ state: 'dead', lease: null, nextRunAt: null, lastError: { message: 'temporary error' } })

    const failed = transitionJob(running(), {
      type: 'fail',
      leaseId: asLeaseId('lease-1'),
      error: 'permanent error',
      at: t0,
    })
    const deadFailed = transitionJob(failed, {
      type: 'dead',
      reason: { code: 'MANUAL_DEAD_LETTER', message: 'operator quarantine' },
      at: t0,
    })
    expect(deadFailed).toMatchObject({ state: 'dead', lastError: { code: 'MANUAL_DEAD_LETTER', retryable: false } })
  })

  it('keeps idempotency identity and prior records unchanged through transitions', () => {
    const first = running()
    const snapshot = JSON.stringify(first)
    const next = transitionJob(first, {
      type: 'succeed',
      leaseId: asLeaseId('lease-1'),
      at: new Date('2026-01-01T00:00:01.000Z'),
    })

    expect(next.id).toBe(first.id)
    expect(next.idempotencyKey).toBe(first.idempotencyKey)
    expect(JSON.stringify(first)).toBe(snapshot)
    expect(next.lease).toBeNull()
    expect(first.lease).not.toBeNull()
  })
})

describe('lease and identifier domain helpers', () => {
  it('checks lease activity with an exclusive expiry boundary', () => {
    const current = lease()
    expect(isLeaseActive(current, t0)).toBe(true)
    expect(isLeaseActive(current, new Date('2026-01-01T00:04:59.999Z'))).toBe(true)
    expect(isLeaseActive(current, leaseEnd)).toBe(false)
    expect(isRetryDue({ nextRunAt: new Date('2026-01-01T00:01:00.000Z') }, t0)).toBe(false)
    expect(isRetryDue({ nextRunAt: new Date('2026-01-01T00:01:00.000Z') }, new Date('2026-01-01T00:01:00.000Z'))).toBe(true)
  })

  it('rejects empty identifiers and invalid lease windows', () => {
    expect(() => createQueuedJob({ id: '', idempotencyKey: 'key', now: t0 })).toThrow(TypeError)
    expect(() => createQueuedJob({ id: 'job', idempotencyKey: '  ', now: t0 })).toThrow(TypeError)
    expect(() => createLease({ leaseId: '', owner: 'worker', acquiredAt: t0, expiresAt: leaseEnd })).toThrow(TypeError)
    expect(() => createLease({ leaseId: 'lease', owner: 'worker', acquiredAt: t0, expiresAt: t0 })).toThrow(RangeError)
  })
})
