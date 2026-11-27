/**
 * Pure domain model for durable jobs.
 *
 * Persistence and workers deliberately live outside this module.  A caller
 * loads a JobRecord, applies one command, and persists the returned record in
 * one transaction.  Dates are copied on input/output so a transition cannot
 * mutate a record that is still held by a caller.
 */

declare const jobIdBrand: unique symbol
declare const idempotencyKeyBrand: unique symbol
declare const leaseIdBrand: unique symbol
declare const attemptNumberBrand: unique symbol

export type JobId = string & { readonly [jobIdBrand]: 'JobId' }
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: 'IdempotencyKey' }
export type LeaseId = string & { readonly [leaseIdBrand]: 'LeaseId' }
export type AttemptNumber = number & { readonly [attemptNumberBrand]: 'AttemptNumber' }

export const JOB_STATES = [
  'queued',
  'running',
  'retryable',
  'failed',
  'succeeded',
  'dead',
] as const

export type JobState = (typeof JOB_STATES)[number]
export type JobStatus = JobState

/**
 * The state graph is intentionally small.  `failed` is a permanent failure
 * until an operator moves it to dead-letter; `retryable` is the only state a
 * worker may claim again.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running'],
  running: ['retryable', 'failed', 'succeeded'],
  retryable: ['running', 'dead'],
  failed: ['dead'],
  succeeded: [],
  dead: [],
}

export interface JobLease {
  readonly leaseId: LeaseId
  readonly owner: string
  readonly acquiredAt: Date
  readonly expiresAt: Date
}

export interface JobFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details?: unknown
}

export type JobFailureInput =
  | string
  | {
      readonly code?: string
      readonly message: string
      readonly retryable?: boolean
      readonly details?: unknown
    }

export interface JobAttempt {
  readonly number: AttemptNumber
  readonly leaseId: LeaseId
  readonly startedAt: Date
  readonly finishedAt: Date | null
  readonly error: JobFailure | null
}

export interface BackoffPolicy {
  /** Delay after the first failed attempt. */
  readonly baseDelayMs: number
  /** Exponential multiplier applied for each subsequent failed attempt. */
  readonly factor: number
  /** Upper bound for a calculated delay. */
  readonly maxDelayMs: number
}

export interface RetryPolicy extends BackoffPolicy {
  /** Total number of attempts, including the first claim. */
  readonly maxAttempts: number
}

/** Input aliases keep the domain API friendly to common queue terminology. */
export interface BackoffPolicyInput {
  readonly baseDelayMs?: number
  readonly initialDelayMs?: number
  readonly factor?: number
  readonly multiplier?: number
  readonly maxDelayMs?: number
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 5 * 60 * 1_000,
})

export interface JobRecord {
  readonly id: JobId
  readonly idempotencyKey: IdempotencyKey
  readonly state: JobState
  /** Number of claims made; zero is valid only for a queued job. */
  readonly attempt: AttemptNumber
  readonly retryPolicy: RetryPolicy
  /** When queued/retryable, the earliest time at which the job may be claimed. */
  readonly nextRunAt: Date | null
  readonly lease: JobLease | null
  readonly attempts: readonly JobAttempt[]
  readonly lastError: JobFailure | null
  readonly result: unknown
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateQueuedJobInput {
  readonly id: string
  readonly idempotencyKey: string
  readonly maxAttempts?: number
  readonly retryPolicy?: Partial<RetryPolicy> & BackoffPolicyInput
  readonly backoff?: BackoffPolicyInput
  readonly now?: Date
}

interface TimedCommand {
  readonly at?: Date
  /** `now` is accepted as a readable alias for callers applying commands. */
  readonly now?: Date
}

export type JobTransition =
  | (TimedCommand & {
      readonly type: 'claim'
      readonly lease: JobLease
    })
  | (TimedCommand & {
      readonly type: 'renew-lease' | 'renew'
      readonly leaseId: LeaseId
      readonly expiresAt: Date
    })
  | (TimedCommand & {
      readonly type: 'succeed'
      readonly leaseId: LeaseId
      readonly result?: unknown
    })
  | (TimedCommand & {
      readonly type: 'retry'
      readonly leaseId: LeaseId
      readonly error?: JobFailureInput
    })
  | (TimedCommand & {
      readonly type: 'fail'
      readonly leaseId: LeaseId
      readonly error?: JobFailureInput
      readonly retryable?: boolean
    })
  | (TimedCommand & {
      readonly type: 'dead-letter' | 'dead'
      readonly reason?: JobFailureInput
    })

export class JobTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobTransitionError'
  }
}

export class JobInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobInvariantError'
  }
}

function cloneDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`)
  }
  return new Date(value.getTime())
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }
  return value
}

export function asJobId(value: string): JobId {
  return nonEmpty(value, 'job id') as JobId
}

export function asIdempotencyKey(value: string): IdempotencyKey {
  return nonEmpty(value, 'idempotency key') as IdempotencyKey
}

export function asLeaseId(value: string): LeaseId {
  return nonEmpty(value, 'lease id') as LeaseId
}

export function asAttemptNumber(value: number): AttemptNumber {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('attempt number must be a non-negative integer')
  }
  return value as AttemptNumber
}

function normalizeBackoff(input: BackoffPolicyInput = {}): BackoffPolicy {
  const baseDelayMs = input.baseDelayMs ?? input.initialDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs
  const factor = input.factor ?? input.multiplier ?? DEFAULT_RETRY_POLICY.factor
  const maxDelayMs = input.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs

  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError('backoff base delay must be a finite non-negative number')
  }
  if (!Number.isFinite(factor) || factor < 1) {
    throw new RangeError('backoff factor must be a finite number greater than or equal to 1')
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError('backoff maximum delay must be a finite non-negative number')
  }

  return { baseDelayMs, factor, maxDelayMs }
}

function normalizeRetryPolicy(input: {
  readonly maxAttempts?: number
  readonly retryPolicy?: Partial<RetryPolicy> & BackoffPolicyInput
  readonly backoff?: BackoffPolicyInput
}): RetryPolicy {
  const supplied: Partial<RetryPolicy> & BackoffPolicyInput = input.retryPolicy ?? input.backoff ?? {}
  const maxAttempts = input.maxAttempts ?? supplied.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('max attempts must be a positive integer')
  }

  return Object.freeze({ maxAttempts, ...normalizeBackoff(supplied) })
}

/**
 * Calculate an exponential retry delay for a 1-based failed attempt number.
 * The function has no clock or randomness, which makes backoff decisions
 * deterministic and safe to test before persistence.
 */
export function calculateRetryDelay(
  attempt: number,
  policy: BackoffPolicyInput = DEFAULT_RETRY_POLICY,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('retry attempt must be a positive integer')
  }

  const { baseDelayMs, factor, maxDelayMs } = normalizeBackoff(policy)
  const exponent = attempt - 1
  const rawDelay = baseDelayMs * Math.pow(factor, exponent)
  if (!Number.isFinite(rawDelay)) return maxDelayMs
  return Math.min(maxDelayMs, rawDelay)
}

export const calculateBackoffDelay = calculateRetryDelay

export function createLease(input: {
  readonly leaseId: string
  readonly owner: string
  readonly acquiredAt: Date
  readonly expiresAt: Date
}): JobLease {
  const acquiredAt = cloneDate(input.acquiredAt, 'lease acquiredAt')
  const expiresAt = cloneDate(input.expiresAt, 'lease expiresAt')
  nonEmpty(input.owner, 'lease owner')
  asLeaseId(input.leaseId)
  if (expiresAt.getTime() <= acquiredAt.getTime()) {
    throw new RangeError('lease expiresAt must be after acquiredAt')
  }

  return {
    leaseId: input.leaseId as LeaseId,
    owner: input.owner,
    acquiredAt,
    expiresAt,
  }
}

export function isLeaseActive(lease: JobLease, at: Date): boolean {
  const time = cloneDate(at, 'lease check time').getTime()
  return lease.acquiredAt.getTime() <= time && time < lease.expiresAt.getTime()
}

export function isRetryDue(job: Pick<JobRecord, 'nextRunAt'>, at: Date): boolean {
  if (!job.nextRunAt) return false
  return job.nextRunAt.getTime() <= cloneDate(at, 'retry check time').getTime()
}

export function isTerminalState(state: JobState): state is 'succeeded' | 'dead' {
  return state === 'succeeded' || state === 'dead'
}

export function canTransition(from: JobState, to: JobState): boolean {
  return (JOB_TRANSITIONS[from] ?? []).includes(to)
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new JobTransitionError(`illegal job transition: ${from} → ${to}`)
  }
}

function commandTime(command: TimedCommand): Date {
  return cloneDate(command.at ?? command.now ?? new Date(), 'transition time')
}

function normalizeFailure(input: JobFailureInput | undefined, retryable: boolean): JobFailure {
  if (typeof input === 'string' || input === undefined) {
    return {
      code: 'JOB_FAILED',
      message: input ?? 'job failed',
      retryable,
    }
  }

  return {
    code: input.code ?? 'JOB_FAILED',
    message: input.message,
    retryable,
    ...(input.details === undefined ? {} : { details: input.details }),
  }
}

function failureInputRequestsRetry(input: JobFailureInput | undefined): boolean {
  return typeof input === 'object' && input !== null && input.retryable === true
}

function cloneLease(lease: JobLease): JobLease {
  return {
    leaseId: lease.leaseId,
    owner: lease.owner,
    acquiredAt: cloneDate(lease.acquiredAt, 'lease acquiredAt'),
    expiresAt: cloneDate(lease.expiresAt, 'lease expiresAt'),
  }
}

function cloneFailure(error: JobFailure | null): JobFailure | null {
  if (!error) return null
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  }
}

function cloneAttempt(attempt: JobAttempt): JobAttempt {
  return {
    number: attempt.number,
    leaseId: attempt.leaseId,
    startedAt: cloneDate(attempt.startedAt, 'attempt startedAt'),
    finishedAt: attempt.finishedAt ? cloneDate(attempt.finishedAt, 'attempt finishedAt') : null,
    error: cloneFailure(attempt.error),
  }
}

function cloneJob(job: JobRecord): JobRecord {
  return {
    ...job,
    retryPolicy: { ...job.retryPolicy },
    nextRunAt: job.nextRunAt ? cloneDate(job.nextRunAt, 'job nextRunAt') : null,
    lease: job.lease ? cloneLease(job.lease) : null,
    attempts: job.attempts.map(cloneAttempt),
    lastError: cloneFailure(job.lastError),
    createdAt: cloneDate(job.createdAt, 'job createdAt'),
    updatedAt: cloneDate(job.updatedAt, 'job updatedAt'),
  }
}

function finishCurrentAttempt(job: JobRecord, at: Date, error: JobFailure | null): readonly JobAttempt[] {
  if (job.attempts.length === 0) {
    throw new JobInvariantError('a running job must have a current attempt')
  }
  const attempts = job.attempts.map(cloneAttempt)
  const current = attempts[attempts.length - 1]
  if (current.number !== job.attempt || current.finishedAt !== null) {
    throw new JobInvariantError('the current attempt is not open')
  }
  attempts[attempts.length - 1] = {
    ...current,
    finishedAt: cloneDate(at, 'attempt finishedAt'),
    error: cloneFailure(error),
  }
  return attempts
}

function assertRunningLease(job: JobRecord, leaseId: LeaseId, at: Date): JobLease {
  if (job.state !== 'running') {
    throw new JobTransitionError(`job command requires running state, got ${job.state}`)
  }
  if (!job.lease) {
    throw new JobInvariantError('running job must have a lease')
  }
  if (job.lease.leaseId !== leaseId) {
    throw new JobTransitionError('lease does not own the running job')
  }
  if (!isLeaseActive(job.lease, at)) {
    throw new JobTransitionError('lease has expired')
  }
  return job.lease
}

function transitionClaim(job: JobRecord, command: Extract<JobTransition, { type: 'claim' }>, at: Date): JobRecord {
  if (job.state !== 'queued' && job.state !== 'retryable') {
    throw new JobTransitionError(`job cannot be claimed from ${job.state}`)
  }
  if (job.state === 'retryable' && !isRetryDue(job, at)) {
    throw new JobTransitionError('retryable job is not due')
  }
  if (!isLeaseActive(command.lease, at)) {
    throw new JobTransitionError('claim lease must be active at claim time')
  }
  if (command.lease.acquiredAt.getTime() > at.getTime()) {
    throw new JobTransitionError('claim lease cannot start in the future')
  }

  const nextAttempt = job.attempt + 1
  if (nextAttempt > job.retryPolicy.maxAttempts) {
    throw new JobTransitionError('job has exhausted its retry attempts')
  }

  const attempt: JobAttempt = {
    number: asAttemptNumber(nextAttempt),
    leaseId: command.lease.leaseId,
    startedAt: cloneDate(at, 'attempt startedAt'),
    finishedAt: null,
    error: null,
  }

  return {
    ...cloneJob(job),
    state: 'running',
    attempt: asAttemptNumber(nextAttempt),
    nextRunAt: null,
    lease: cloneLease(command.lease),
    attempts: [...job.attempts.map(cloneAttempt), attempt],
    lastError: null,
    updatedAt: cloneDate(at, 'job updatedAt'),
  }
}

function transitionRenewLease(
  job: JobRecord,
  command: Extract<JobTransition, { type: 'renew-lease' | 'renew' }>,
  at: Date,
): JobRecord {
  const lease = assertRunningLease(job, command.leaseId, at)
  const expiresAt = cloneDate(command.expiresAt, 'lease expiresAt')
  if (expiresAt.getTime() <= at.getTime()) {
    throw new JobTransitionError('renewed lease must expire after the renewal time')
  }
  if (expiresAt.getTime() <= lease.expiresAt.getTime()) {
    throw new JobTransitionError('renewed lease must extend the existing lease')
  }

  return {
    ...cloneJob(job),
    lease: { ...cloneLease(lease), expiresAt },
    updatedAt: cloneDate(at, 'job updatedAt'),
  }
}

function transitionSucceed(
  job: JobRecord,
  command: Extract<JobTransition, { type: 'succeed' }>,
  at: Date,
): JobRecord {
  assertRunningLease(job, command.leaseId, at)
  assertTransition(job.state, 'succeeded')
  return {
    ...cloneJob(job),
    state: 'succeeded',
    lease: null,
    nextRunAt: null,
    attempts: finishCurrentAttempt(job, at, null),
    lastError: null,
    result: command.result ?? null,
    updatedAt: cloneDate(at, 'job updatedAt'),
  }
}

function transitionFailure(
  job: JobRecord,
  command: Extract<JobTransition, { type: 'fail' | 'retry' }>,
  at: Date,
): JobRecord {
  assertRunningLease(job, command.leaseId, at)
  const wantsRetry = command.type === 'retry'
    || command.retryable === true
    || (command.type === 'fail' && command.retryable === undefined && failureInputRequestsRetry(command.error))
  const error = normalizeFailure(command.error, wantsRetry)
  const shouldRetry = wantsRetry && job.attempt < job.retryPolicy.maxAttempts
  const nextState: 'retryable' | 'failed' = shouldRetry ? 'retryable' : 'failed'
  assertTransition(job.state, nextState)

  const nextRunAt = shouldRetry
    ? new Date(at.getTime() + calculateRetryDelay(job.attempt, job.retryPolicy))
    : null

  return {
    ...cloneJob(job),
    state: nextState,
    lease: null,
    nextRunAt,
    attempts: finishCurrentAttempt(job, at, error),
    lastError: cloneFailure(error),
    result: null,
    updatedAt: cloneDate(at, 'job updatedAt'),
  }
}

function transitionDeadLetter(
  job: JobRecord,
  command: Extract<JobTransition, { type: 'dead-letter' | 'dead' }>,
  at: Date,
): JobRecord {
  assertTransition(job.state, 'dead')
  if (job.lease) {
    throw new JobInvariantError('dead-letter job must not retain a lease')
  }

  const reason = command.reason === undefined
    ? job.lastError
    : normalizeFailure(command.reason, false)

  return {
    ...cloneJob(job),
    state: 'dead',
    lease: null,
    nextRunAt: null,
    lastError: cloneFailure(reason),
    updatedAt: cloneDate(at, 'job updatedAt'),
  }
}

/**
 * Apply one domain command without mutating the input record.
 *
 * Claim and completion commands carry a lease id.  A worker with a stale or
 * different lease therefore cannot publish a success/failure over a newer
 * claim, even before a database layer adds its compare-and-swap condition.
 */
export function transitionJob(job: JobRecord, command: JobTransition): JobRecord {
  assertJobInvariant(job)
  const at = commandTime(command)

  switch (command.type) {
    case 'claim':
      return transitionClaim(job, command, at)
    case 'renew':
    case 'renew-lease':
      return transitionRenewLease(job, command, at)
    case 'succeed':
      return transitionSucceed(job, command, at)
    case 'retry':
    case 'fail':
      return transitionFailure(job, command, at)
    case 'dead':
    case 'dead-letter':
      return transitionDeadLetter(job, command, at)
  }
}

export const applyJobTransition = transitionJob

export function createQueuedJob(input: CreateQueuedJobInput): JobRecord {
  const now = cloneDate(input.now ?? new Date(), 'job createdAt')
  const retryPolicy = normalizeRetryPolicy(input)
  return {
    id: asJobId(input.id),
    idempotencyKey: asIdempotencyKey(input.idempotencyKey),
    state: 'queued',
    attempt: asAttemptNumber(0),
    retryPolicy,
    nextRunAt: cloneDate(now, 'job nextRunAt'),
    lease: null,
    attempts: [],
    lastError: null,
    result: null,
    createdAt: cloneDate(now, 'job createdAt'),
    updatedAt: cloneDate(now, 'job updatedAt'),
  }
}

/**
 * Validate durable invariants.  A repository adapter can call this after
 * deserializing a row and before applying a transition.
 */
export function assertJobInvariant(job: JobRecord): void {
  if (!JOB_STATES.includes(job.state)) {
    throw new JobInvariantError(`unknown job state: ${String(job.state)}`)
  }
  asJobId(job.id)
  asIdempotencyKey(job.idempotencyKey)
  asAttemptNumber(job.attempt)
  normalizeRetryPolicy(job.retryPolicy)
  cloneDate(job.createdAt, 'job createdAt')
  cloneDate(job.updatedAt, 'job updatedAt')
  if (job.attempts.length !== job.attempt) {
    throw new JobInvariantError('attempt count does not match attempt history')
  }
  if (job.state === 'queued' && job.attempt !== 0) {
    throw new JobInvariantError('queued job must not have attempts')
  }
  if ((job.state === 'queued' || job.state === 'retryable') && !job.nextRunAt) {
    throw new JobInvariantError(`${job.state} job must have nextRunAt`)
  }
  if (job.state !== 'queued' && job.state !== 'retryable' && job.nextRunAt) {
    throw new JobInvariantError(`${job.state} job must not have nextRunAt`)
  }
  if (job.state === 'running' && !job.lease) {
    throw new JobInvariantError('running job must have a lease')
  }
  if (job.state !== 'running' && job.lease) {
    throw new JobInvariantError(`${job.state} job must not have a lease`)
  }
  if (job.lease) {
    asLeaseId(job.lease.leaseId)
    nonEmpty(job.lease.owner, 'lease owner')
    const acquiredAt = cloneDate(job.lease.acquiredAt, 'lease acquiredAt')
    const expiresAt = cloneDate(job.lease.expiresAt, 'lease expiresAt')
    if (expiresAt.getTime() <= acquiredAt.getTime()) {
      throw new JobInvariantError('lease expiresAt must be after acquiredAt')
    }
    const currentAttempt = job.attempts[job.attempts.length - 1]
    if (currentAttempt && currentAttempt.leaseId !== job.lease.leaseId) {
      throw new JobInvariantError('running lease must match the current attempt')
    }
  }

  for (let index = 0; index < job.attempts.length; index += 1) {
    const attempt = job.attempts[index]
    if (attempt.number !== index + 1) {
      throw new JobInvariantError('attempt history must be sequential and 1-based')
    }
    cloneDate(attempt.startedAt, 'attempt startedAt')
    if (attempt.finishedAt) cloneDate(attempt.finishedAt, 'attempt finishedAt')
    if (index === job.attempts.length - 1 && job.state === 'running' && attempt.finishedAt) {
      throw new JobInvariantError('running job must have an open current attempt')
    }
    if (index < job.attempts.length - 1 && !attempt.finishedAt) {
      throw new JobInvariantError('only the current attempt may be open')
    }
  }
}
