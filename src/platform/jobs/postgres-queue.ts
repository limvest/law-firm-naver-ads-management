import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { operationJobAttempts, operationJobs } from '@/lib/db/schema'

export type OperationJobRow = typeof operationJobs.$inferSelect
export type OperationJobAttemptRow = typeof operationJobAttempts.$inferSelect

/** `undefined` means an unrestricted queue-wide operation; `null` means global jobs only. */
export type FirmScope = number | null | undefined

export interface EnqueueJobInput {
  readonly id?: string
  readonly jobType: string
  readonly idempotencyKey: string
  readonly firmId?: number | null
  readonly caseEntityId?: string | null
  readonly payload: Record<string, unknown>
  readonly priority?: number
  readonly maxAttempts?: number
  readonly availableAt?: Date
  readonly now?: Date
}

export interface ClaimJobInput {
  readonly workerId: string
  readonly firmId?: number | null
  readonly jobTypes?: readonly string[]
  readonly now?: Date
  readonly leaseDurationMs?: number
}

export interface ClaimJobsInput extends ClaimJobInput {
  readonly limit?: number
}

export interface LeaseJobInput {
  readonly id: string
  readonly workerId: string
  readonly firmId?: number | null
  readonly now?: Date
}

export type JobErrorInput =
  | string
  | Error
  | {
      readonly code?: string
      readonly message?: string
      readonly [key: string]: unknown
    }

export interface BackoffPolicy {
  readonly baseDelayMs?: number
  readonly factor?: number
  readonly maxDelayMs?: number
}

export interface FailJobInput extends LeaseJobInput {
  /** Defaults to true; use `false` for a permanent failure before dead-lettering. */
  readonly retryable?: boolean
  readonly error?: JobErrorInput
  readonly backoff?: BackoffPolicy
}

export interface DeadLetterJobInput {
  readonly id: string
  readonly firmId?: number | null
  readonly reason?: JobErrorInput
  readonly now?: Date
}

export interface RequeueJobInput {
  readonly id: string
  readonly firmId?: number | null
  readonly now?: Date
}

export interface PostgresJobQueueOptions {
  readonly leaseDurationMs?: number
  readonly backoff?: BackoffPolicy
  readonly retryableByDefault?: boolean
}

export interface EnqueueJobResult {
  readonly row: OperationJobRow
  readonly inserted: boolean
}

const DEFAULT_LEASE_DURATION_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_PRIORITY = 100
const DEFAULT_BACKOFF = Object.freeze({
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 5 * 60 * 1_000,
})
const MAX_CLAIM_RETRIES = 4

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }
  return value
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`)
  }
  return new Date(value.getTime())
}

function optionalFirmId(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('firm id must be a non-negative safe integer')
  }
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`)
  }
  return value
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validatePayload(value: Record<string, unknown>): Record<string, unknown> {
  if (!plainObject(value)) throw new TypeError('job payload must be a JSON object')
  return value
}

function firmScope(firmId: FirmScope): SQLWrapper | undefined {
  if (firmId === undefined) return undefined
  return firmId === null ? isNull(operationJobs.firmId) : eq(operationJobs.firmId, firmId)
}

function jobWhere(firmId: FirmScope, ...conditions: Array<SQLWrapper | undefined>) {
  return and(...conditions, firmScope(firmId))
}

/** Raw SQL scope for statements that alias operation_jobs as `j`. */
function jobFirmScopeSql(firmId: FirmScope): SQLWrapper {
  if (firmId === undefined) return sql`true`
  return firmId === null ? sql`j.firm_id is null` : sql`j.firm_id = ${firmId}`
}

function firstReturnedId(result: unknown): string | null {
  const rows = (result as { rows?: Array<Record<string, unknown>> } | null)?.rows
  const id = rows?.[0]?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function firstReturnedOutcome(result: unknown): string | null {
  const rows = (result as { rows?: Array<Record<string, unknown>> } | null)?.rows
  const outcome = rows?.[0]?.outcome
  return typeof outcome === 'string' ? outcome : null
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime()
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

function samePayload(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function errorText(error: JobErrorInput | undefined): string {
  if (error === undefined) return 'job failed'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error.message === 'string') return error.message
  return JSON.stringify(error)
}

function normalizedBackoff(input: BackoffPolicy | undefined): {
  readonly baseDelayMs: number
  readonly factor: number
  readonly maxDelayMs: number
} {
  const baseDelayMs = input?.baseDelayMs ?? DEFAULT_BACKOFF.baseDelayMs
  const factor = input?.factor ?? DEFAULT_BACKOFF.factor
  const maxDelayMs = input?.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError('backoff base delay must be finite and non-negative')
  }
  if (!Number.isFinite(factor) || factor < 1) {
    throw new RangeError('backoff factor must be finite and at least 1')
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError('backoff maximum delay must be finite and non-negative')
  }
  return { baseDelayMs, factor, maxDelayMs }
}

function retryDelay(attempt: number, policy: BackoffPolicy | undefined): number {
  const { baseDelayMs, factor, maxDelayMs } = normalizedBackoff(policy)
  const raw = baseDelayMs * Math.pow(factor, attempt - 1)
  return Number.isFinite(raw) ? Math.min(raw, maxDelayMs) : maxDelayMs
}

function validateLeaseDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('lease duration must be finite and greater than zero')
  }
  return value
}

function sameEnqueueSemantics(
  row: OperationJobRow,
  input: {
    readonly id?: string
    readonly jobType: string
    readonly firmId: number | null
    readonly caseEntityId: string | null
    readonly payload: Record<string, unknown>
    readonly priority: number
    readonly maxAttempts: number
    readonly availableAt?: Date
  },
): boolean {
  return (input.id === undefined || row.id === input.id)
    && row.jobType === input.jobType
    && row.firmId === input.firmId
    && row.caseEntityId === input.caseEntityId
    && samePayload(row.payload, input.payload)
    && row.priority === input.priority
    && row.maxAttempts === input.maxAttempts
    && (input.availableAt === undefined || sameDate(row.availableAt, input.availableAt))
}

/**
 * Insert a durable job exactly once for an idempotency key. A repeated key is
 * accepted only when it describes the same job; reusing a key for another
 * firm or payload fails instead of returning a row from the wrong scope.
 */
export async function enqueueJob(db: Db, input: EnqueueJobInput): Promise<EnqueueJobResult> {
  const jobType = requiredText(input.jobType, 'job type')
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key')
  const firmId = optionalFirmId(input.firmId) ?? null
  const caseEntityId = input.caseEntityId === undefined || input.caseEntityId === null
    ? null
    : requiredText(input.caseEntityId, 'case entity id')
  const payload = validatePayload(input.payload)
  const priority = input.priority ?? DEFAULT_PRIORITY
  nonNegativeInteger(Math.abs(priority), 'priority')
  const maxAttempts = positiveInteger(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'max attempts')
  const now = validDate(input.now ?? new Date(), 'enqueue time')
  const requestedAvailableAt = input.availableAt === undefined
    ? undefined
    : validDate(input.availableAt, 'availableAt')
  const availableAt = requestedAvailableAt ?? now
  const id = input.id === undefined ? undefined : requiredText(input.id, 'job id')

  const values: typeof operationJobs.$inferInsert = {
    ...(id === undefined ? {} : { id }),
    jobType,
    firmId,
    caseEntityId,
    idempotencyKey,
    payload,
    priority,
    maxAttempts,
    availableAt,
    createdAt: now,
    updatedAt: now,
  }

  const [inserted] = await db.insert(operationJobs)
    .values(values)
    .onConflictDoNothing({ target: operationJobs.idempotencyKey })
    .returning()
  if (inserted) return { row: inserted, inserted: true }

  // The uniqueness constraint is the idempotency gate. This follow-up read is
  // deliberately a separate statement so it also sees a concurrently committed
  // winner after ON CONFLICT waited for that transaction.
  const [existing] = await db.select().from(operationJobs)
    .where(and(
      eq(operationJobs.idempotencyKey, idempotencyKey),
      firmScope(firmId),
    ))
    .limit(1)
  if (!existing) {
    throw new Error(`job idempotency collision outside firm scope: ${idempotencyKey}`)
  }
  if (!sameEnqueueSemantics(existing, {
    id,
    jobType,
    firmId,
    caseEntityId,
    payload,
    priority,
    maxAttempts,
    availableAt: requestedAvailableAt,
  })) {
    throw new Error(`job idempotency collision: ${idempotencyKey}`)
  }
  return { row: existing, inserted: false }
}

/**
 * Claim one due queued/retryable job. Candidate reads are deliberately not
 * paired with `FOR UPDATE SKIP LOCKED`: Neon HTTP and PGlite do not share the
 * same locking surface. The selected row is therefore only a hint; the
 * compare-and-set update is the ownership gate, and a losing claimant retries.
 */
export async function claimJob(db: Db, input: ClaimJobInput): Promise<OperationJobRow | null> {
  const workerId = requiredText(input.workerId, 'worker id')
  const firmId = optionalFirmId(input.firmId)
  const now = validDate(input.now ?? new Date(), 'claim time')
  const leaseDurationMs = validateLeaseDuration(input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)
  const jobTypes = input.jobTypes?.map((value) => requiredText(value, 'job type')) ?? []
  if (jobTypes.length > 50) throw new RangeError('job type filter cannot exceed 50 values')
  const jobTypeFilter = jobTypes.length
    ? sql`j.job_type in (${sql.join(jobTypes.map((value) => sql`${value}`), sql`, `)})`
    : sql`true`
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs)
  if (Number.isNaN(leaseExpiresAt.getTime())) throw new RangeError('lease expiry is outside Date range')

  for (let retry = 0; retry < MAX_CLAIM_RETRIES; retry++) {
    // One PostgreSQL statement owns both state changes. The candidate is only a
    // hint; the UPDATE is the CAS gate, and a unique-attempt failure rolls the
    // entire statement back before a lease can escape without its audit row.
    const result = await db.execute(sql`
      with candidate as materialized (
        select j.id, j.state, j.attempts
        from operation_jobs j
        where j.state in ('queued', 'retryable')
          and j.available_at <= ${now}
          and j.attempts < j.max_attempts
          and (
            j.lease_owner is null
            or j.lease_expires_at is null
            or j.lease_expires_at <= ${now}
          )
          and ${jobFirmScopeSql(firmId)}
          and ${jobTypeFilter}
        order by j.available_at, j.priority, j.created_at, j.id
        limit 1
      ), claimed as (
        update operation_jobs j
        set state = 'running',
            attempts = j.attempts + 1,
            available_at = ${now},
            lease_owner = ${workerId},
            lease_expires_at = ${leaseExpiresAt},
            last_error = null,
            updated_at = ${now},
            finished_at = null
        from candidate c
        where j.id = c.id
          and j.state = c.state
          and j.attempts = c.attempts
          and j.available_at <= ${now}
          and j.attempts < j.max_attempts
          and (
            j.lease_owner is null
            or j.lease_expires_at is null
            or j.lease_expires_at <= ${now}
          )
          and ${jobFirmScopeSql(firmId)}
        returning j.id, j.attempts
      ), recorded_attempt as (
        insert into operation_job_attempts (
          job_id, attempt, worker_id, state, started_at
        )
        select id, attempts, ${workerId}, 'running', ${now}
        from claimed
        returning job_id
      )
      select c.id, 'claimed'::text as outcome
      from claimed c
      inner join recorded_attempt a on a.job_id = c.id
      union all
      select null::uuid as id,
        case when exists (select 1 from candidate) then 'lost' else 'empty' end as outcome
      where not exists (select 1 from recorded_attempt)
      limit 1
    `)
    const claimedId = firstReturnedId(result)
    if (claimedId) {
      const [claimed] = await db.select().from(operationJobs)
        .where(eq(operationJobs.id, claimedId))
        .limit(1)
      if (!claimed) throw new Error(`claimed job disappeared: ${claimedId}`)
      return claimed
    }
    if (firstReturnedOutcome(result) === 'empty') return null
  }
  return null
}

export async function claimJobs(db: Db, input: ClaimJobsInput): Promise<OperationJobRow[]> {
  const limit = input.limit ?? 1
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('claim limit must be between 1 and 1000')
  }
  const jobs: OperationJobRow[] = []
  for (let index = 0; index < limit; index++) {
    const job = await claimJob(db, input)
    if (!job) break
    jobs.push(job)
  }
  return jobs
}

/** Complete only the currently leased attempt. Stale workers receive `null`. */
export async function succeedJob(db: Db, input: LeaseJobInput): Promise<OperationJobRow | null> {
  const id = requiredText(input.id, 'job id')
  const workerId = requiredText(input.workerId, 'worker id')
  const firmId = optionalFirmId(input.firmId)
  const now = validDate(input.now ?? new Date(), 'success time')

  const result = await db.execute(sql`
    with updated_job as (
      update operation_jobs j
      set state = 'succeeded',
          lease_owner = null,
          lease_expires_at = null,
          updated_at = ${now},
          finished_at = ${now},
          available_at = ${now},
          last_error = null
      where j.id = ${id}::uuid
        and j.state = 'running'
        and j.lease_owner = ${workerId}
        and j.lease_expires_at > ${now}
        and ${jobFirmScopeSql(firmId)}
        and exists (
          select 1 from operation_job_attempts a
          where a.job_id = j.id
            and a.attempt = j.attempts
            and a.worker_id = ${workerId}
            and a.state = 'running'
            and a.finished_at is null
        )
      returning j.id, j.attempts
    ), closed_attempt as (
      update operation_job_attempts a
      set state = 'succeeded', finished_at = ${now}, error = null
      from updated_job j
      where a.job_id = j.id
        and a.attempt = j.attempts
        and a.worker_id = ${workerId}
        and a.state = 'running'
        and a.finished_at is null
      returning a.job_id
    )
    select j.id
    from updated_job j
    inner join closed_attempt a on a.job_id = j.id
    limit 1
  `)
  const updatedId = firstReturnedId(result)
  if (!updatedId) return null
  const [updated] = await db.select().from(operationJobs)
    .where(eq(operationJobs.id, updatedId))
    .limit(1)
  return updated ?? null
}

/**
 * Record a failure and schedule the next attempt when retryable. The default
 * is retryable because callers can use `deadLetterJob` for an explicit
 * operator/permanent terminal decision; pass `retryable: false` to stop first.
 */
export async function failJob(db: Db, input: FailJobInput): Promise<OperationJobRow | null> {
  const id = requiredText(input.id, 'job id')
  const workerId = requiredText(input.workerId, 'worker id')
  const firmId = optionalFirmId(input.firmId)
  const now = validDate(input.now ?? new Date(), 'failure time')
  const failure = errorText(input.error)
  const retryable = input.retryable ?? true
  const backoff = input.backoff

  const [current] = await db.select().from(operationJobs)
    .where(jobWhere(firmId,
      eq(operationJobs.id, id),
      eq(operationJobs.state, 'running'),
      eq(operationJobs.leaseOwner, workerId),
      gt(operationJobs.leaseExpiresAt, now),
    ))
    .limit(1)
  if (!current) return null

  const shouldRetry = retryable && current.attempts < current.maxAttempts
  const nextState = shouldRetry ? 'retryable' : 'failed'
  const availableAt = shouldRetry
    ? new Date(now.getTime() + retryDelay(current.attempts, backoff))
    : now
  const finishedAt = shouldRetry ? null : now
  const result = await db.execute(sql`
    with updated_job as (
      update operation_jobs j
      set state = ${nextState},
          available_at = ${availableAt},
          lease_owner = null,
          lease_expires_at = null,
          last_error = ${failure},
          updated_at = ${now},
          finished_at = ${finishedAt}
      where j.id = ${id}::uuid
        and j.state = 'running'
        and j.attempts = ${current.attempts}
        and j.lease_owner = ${workerId}
        and j.lease_expires_at > ${now}
        and ${jobFirmScopeSql(firmId)}
        and exists (
          select 1 from operation_job_attempts a
          where a.job_id = j.id
            and a.attempt = j.attempts
            and a.worker_id = ${workerId}
            and a.state = 'running'
            and a.finished_at is null
        )
      returning j.id, j.attempts
    ), closed_attempt as (
      update operation_job_attempts a
      set state = ${nextState}, error = ${failure}, finished_at = ${now}
      from updated_job j
      where a.job_id = j.id
        and a.attempt = j.attempts
        and a.worker_id = ${workerId}
        and a.state = 'running'
        and a.finished_at is null
      returning a.job_id
    )
    select j.id
    from updated_job j
    inner join closed_attempt a on a.job_id = j.id
    limit 1
  `)
  const updatedId = firstReturnedId(result)
  if (!updatedId) return null
  const [updated] = await db.select().from(operationJobs)
    .where(eq(operationJobs.id, updatedId))
    .limit(1)
  return updated ?? null
}

export async function retryJob(
  db: Db,
  input: Omit<FailJobInput, 'retryable'>,
): Promise<OperationJobRow | null> {
  return failJob(db, { ...input, retryable: true })
}

/** Move a non-running job to dead-letter, preserving its last error by default. */
export async function deadLetterJob(
  db: Db,
  input: DeadLetterJobInput,
): Promise<OperationJobRow | null> {
  const id = requiredText(input.id, 'job id')
  const firmId = optionalFirmId(input.firmId)
  const now = validDate(input.now ?? new Date(), 'dead-letter time')
  const reason = input.reason === undefined ? undefined : errorText(input.reason)

  const setValues: Partial<typeof operationJobs.$inferInsert> = {
    state: 'dead',
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
    finishedAt: now,
    ...(reason === undefined ? {} : { lastError: reason }),
  }

  const [updated] = await db.update(operationJobs).set(setValues).where(jobWhere(firmId,
    eq(operationJobs.id, id),
    inArray(operationJobs.state, ['retryable', 'failed']),
    or(
      isNull(operationJobs.leaseOwner),
      isNull(operationJobs.leaseExpiresAt),
      lte(operationJobs.leaseExpiresAt, now),
    ),
  )).returning()
  return updated ?? null
}

/**
 * Explicit operator recovery for a stopped job. Attempt history and its
 * monotonically increasing attempt number are preserved; the configured retry
 * budget is extended by one full budget instead of rewinding the counter.
 * Running/succeeded jobs can never be requeued through this path.
 */
export async function requeueJob(
  db: Db,
  input: RequeueJobInput,
): Promise<OperationJobRow | null> {
  const id = requiredText(input.id, 'job id')
  const firmId = optionalFirmId(input.firmId)
  const now = validDate(input.now ?? new Date(), 'requeue time')
  const [updated] = await db.update(operationJobs).set({
    state: 'queued',
    maxAttempts: sql`${operationJobs.maxAttempts} + ${operationJobs.attempts}`,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    finishedAt: null,
    updatedAt: now,
  }).where(jobWhere(firmId,
    eq(operationJobs.id, id),
    inArray(operationJobs.state, ['retryable', 'failed', 'dead']),
    or(
      isNull(operationJobs.leaseOwner),
      isNull(operationJobs.leaseExpiresAt),
      lte(operationJobs.leaseExpiresAt, now),
    ),
  )).returning()
  return updated ?? null
}

export class PostgresJobQueue {
  constructor(
    private readonly db: Db,
    private readonly options: PostgresJobQueueOptions = {},
  ) {
    if (options.leaseDurationMs !== undefined) validateLeaseDuration(options.leaseDurationMs)
    if (options.backoff !== undefined) normalizedBackoff(options.backoff)
    if (options.retryableByDefault !== undefined && typeof options.retryableByDefault !== 'boolean') {
      throw new TypeError('retryableByDefault must be boolean')
    }
  }

  enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    return enqueueJob(this.db, input)
  }

  claim(input: ClaimJobInput): Promise<OperationJobRow | null> {
    return claimJob(this.db, {
      ...input,
      leaseDurationMs: input.leaseDurationMs ?? this.options.leaseDurationMs,
    })
  }

  claimMany(input: ClaimJobsInput): Promise<OperationJobRow[]> {
    return claimJobs(this.db, {
      ...input,
      leaseDurationMs: input.leaseDurationMs ?? this.options.leaseDurationMs,
    })
  }

  succeed(input: LeaseJobInput): Promise<OperationJobRow | null> {
    return succeedJob(this.db, input)
  }

  fail(input: FailJobInput): Promise<OperationJobRow | null> {
    return failJob(this.db, {
      ...input,
      retryable: input.retryable ?? this.options.retryableByDefault,
      backoff: input.backoff ?? this.options.backoff,
    })
  }

  retry(input: Omit<FailJobInput, 'retryable'>): Promise<OperationJobRow | null> {
    return retryJob(this.db, {
      ...input,
      backoff: input.backoff ?? this.options.backoff,
    })
  }

  deadLetter(input: DeadLetterJobInput): Promise<OperationJobRow | null> {
    return deadLetterJob(this.db, input)
  }

  requeue(input: RequeueJobInput): Promise<OperationJobRow | null> {
    return requeueJob(this.db, input)
  }
}

export function createPostgresJobQueue(
  db: Db,
  options: PostgresJobQueueOptions = {},
): PostgresJobQueue {
  return new PostgresJobQueue(db, options)
}

// Operation-prefixed aliases keep call sites explicit when more queue types are added.
export const enqueueOperationJob = enqueueJob
export const claimOperationJob = claimJob
export const succeedOperationJob = succeedJob
export const failOperationJob = failJob
export const deadLetterOperationJob = deadLetterJob
export const requeueOperationJob = requeueJob
