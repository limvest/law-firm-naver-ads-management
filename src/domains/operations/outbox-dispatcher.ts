import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { outboxEvents } from '@/lib/db/schema'
import {
  listPendingOutboxEvents,
  recordOutboxPublishFailure,
} from './outbox'

export type OutboxEventRow = typeof outboxEvents.$inferSelect

/**
 * A delivery function is deliberately the only provider-specific dependency
 * of the dispatcher. Resolving acknowledges delivery; returning false is an
 * explicit negative acknowledgement and is treated like a failed delivery.
 */
export type OutboxDelivery = (
  event: OutboxEventRow,
) => Promise<unknown>

export interface OutboxDispatcherOptions {
  /** Preferred name for the injected delivery function. */
  readonly deliver?: OutboxDelivery
  /** Alias kept for callers that use the noun form. */
  readonly delivery?: OutboxDelivery
  /** Number of rows processed in one in-memory batch. */
  readonly batchSize?: number
  /** Maximum rows this invocation may attempt. */
  readonly maxEvents?: number
  readonly firmId?: number
  /** Fixed clock or clock function used when acknowledging a row. */
  readonly now?: Date | (() => Date)
}

export interface OutboxDispatchSummary {
  readonly delivered: number
  readonly failed: number
  /** Rows still unpublished when the bounded run finished. */
  readonly pending: number
  /** Acknowledged rows that another writer had already published. */
  readonly skipped: number
}

export const DEFAULT_OUTBOX_BATCH_SIZE = 100
export const DEFAULT_OUTBOX_MAX_EVENTS = 1_000
export const MAX_OUTBOX_BATCH_SIZE = 1_000
export const MAX_OUTBOX_EVENTS = 1_000

type OutboxDispatcherRunOptions = Omit<OutboxDispatcherOptions, 'deliver' | 'delivery'>

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new RangeError(`${label} must be a positive integer`)
  }
  return normalized
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const normalized = positiveBound(value, fallback, label)
  if (normalized > maximum) throw new RangeError(`${label} must be at most ${maximum}`)
  return normalized
}

function validateFirmId(firmId: number | undefined): void {
  if (firmId === undefined) return
  if (!Number.isSafeInteger(firmId) || firmId < 0) {
    throw new RangeError('firmId must be a non-negative safe integer')
  }
}

function acknowledgeAt(now: Date | (() => Date) | undefined): Date {
  const value = typeof now === 'function' ? now() : now ?? new Date()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError('now must be a valid Date')
  }
  return value
}

/**
 * Mark a row only if it is still unpublished. This is intentionally local to
 * the dispatcher: the legacy append/outbox helper's publish marker also
 * normalizes attempts, while a successful delivery must not add an attempt.
 */
async function markPublishedAfterAcknowledgement(
  db: Db,
  id: string,
  publishedAt: Date,
): Promise<boolean> {
  const rows = await db.update(outboxEvents).set({ publishedAt })
    .where(and(eq(outboxEvents.id, id), isNull(outboxEvents.publishedAt)))
    .returning({ id: outboxEvents.id })
  return rows.length === 1
}

function resolveDelivery(
  input: OutboxDispatcherOptions | OutboxDelivery,
  positional?: OutboxDispatcherRunOptions,
): { delivery: OutboxDelivery; options: OutboxDispatcherRunOptions } {
  if (typeof input === 'function') return { delivery: input, options: positional ?? {} }
  const delivery = input.deliver ?? input.delivery
  if (!delivery) throw new TypeError('outbox delivery function is required')
  return { delivery, options: input }
}

async function pendingCount(
  db: Db,
  firmId: number | undefined,
): Promise<number> {
  // listPendingOutboxEvents is deliberately bounded; the summary therefore
  // never turns a drain invocation into an unbounded read.
  const rows = await listPendingOutboxEvents(db, {
    limit: MAX_OUTBOX_EVENTS,
    firmId,
  })
  return rows.length
}

/**
 * Drain unpublished outbox rows in deterministic order.
 *
 * Rows are selected once, then delivered sequentially in bounded batches. A
 * row is marked only after its delivery promise acknowledges; any thrown or
 * explicit false result increments publishAttempts and remains unpublished.
 */
export function dispatchOutbox(
  db: Db,
  options: OutboxDispatcherOptions,
): Promise<OutboxDispatchSummary>
export function dispatchOutbox(
  db: Db,
  delivery: OutboxDelivery,
  options?: OutboxDispatcherRunOptions,
): Promise<OutboxDispatchSummary>
export async function dispatchOutbox(
  db: Db,
  input: OutboxDispatcherOptions | OutboxDelivery,
  positional?: OutboxDispatcherRunOptions,
): Promise<OutboxDispatchSummary> {
  const resolved = resolveDelivery(input, positional)
  const batchSize = boundedOption(
    resolved.options.batchSize,
    DEFAULT_OUTBOX_BATCH_SIZE,
    MAX_OUTBOX_BATCH_SIZE,
    'batchSize',
  )
  const maxEvents = boundedOption(
    resolved.options.maxEvents,
    DEFAULT_OUTBOX_MAX_EVENTS,
    MAX_OUTBOX_EVENTS,
    'maxEvents',
  )
  validateFirmId(resolved.options.firmId)

  const rows = await listPendingOutboxEvents(db, {
    limit: maxEvents,
    firmId: resolved.options.firmId,
  })
  let delivered = 0
  let failed = 0
  let skipped = 0

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    for (const row of batch) {
      try {
        const acknowledged = await resolved.delivery(row)
        if (acknowledged === false) throw new Error('delivery was not acknowledged')
        if (await markPublishedAfterAcknowledgement(db, row.id, acknowledgeAt(resolved.options.now))) {
          delivered += 1
        } else {
          skipped += 1
        }
      } catch (error) {
        failed += 1
        // Keep the row unpublished on every delivery failure. The repository
        // helper performs a compare-and-set increment for concurrent safety.
        await recordOutboxPublishFailure(db, row.id)
        void error
      }
    }
  }

  return {
    delivered,
    failed,
    pending: await pendingCount(db, resolved.options.firmId),
    skipped,
  }
}

/** Explicit aliases for callers that describe the operation as a drain/run. */
export const drainOutbox = dispatchOutbox
export const runOutboxDispatcher = dispatchOutbox
