import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDb, type Db } from '@/lib/db/client'
import {
  dispatchOutbox,
  type OutboxEventRow,
} from '@/domains/operations/outbox-dispatcher'

export const OUTBOX_WEBHOOK_URL_ENV = 'OUTBOX_WEBHOOK_URL' as const
export const OUTBOX_WEBHOOK_BEARER_SECRET_ENV = 'OUTBOX_WEBHOOK_BEARER_SECRET' as const
export const OUTBOX_BATCH_SIZE_ENV = 'OUTBOX_BATCH_SIZE' as const
export const OUTBOX_MAX_EVENTS_ENV = 'OUTBOX_MAX_EVENTS' as const

export type OutboxWebhookConfig = {
  readonly url: string
  readonly bearerSecret: string
}

export type OutboxFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

export interface DrainOutboxOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly db?: Db
  readonly fetchImpl?: OutboxFetch
  readonly log?: (message: string) => void
}

export class OutboxWebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutboxWebhookConfigurationError'
  }
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
}

/** Validate the destination without ever including it in an error message. */
export function validateOutboxWebhookUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new OutboxWebhookConfigurationError('webhook URL is invalid')
  }

  if (parsed.username || parsed.password) {
    throw new OutboxWebhookConfigurationError('webhook URL credentials are not allowed')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost(parsed.hostname))) {
    throw new OutboxWebhookConfigurationError('webhook must use HTTPS outside localhost')
  }
  return parsed
}

export function readOutboxWebhookConfig(
  env: NodeJS.ProcessEnv = process.env,
): OutboxWebhookConfig | null {
  const url = env[OUTBOX_WEBHOOK_URL_ENV]?.trim() ?? ''
  const bearerSecret = env[OUTBOX_WEBHOOK_BEARER_SECRET_ENV]?.trim() ?? ''
  if (!url && !bearerSecret) return null
  if (!url || !bearerSecret) {
    throw new OutboxWebhookConfigurationError('webhook URL and bearer secret are both required')
  }
  return {
    url: validateOutboxWebhookUrl(url).toString(),
    bearerSecret,
  }
}

function optionalNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = env[key]?.trim()
  return value ? Number(value) : undefined
}

function webhookBody(event: OutboxEventRow): string {
  return JSON.stringify({
    ...event,
    occurredAt: event.occurredAt.toISOString(),
    recordedAt: event.recordedAt.toISOString(),
    publishedAt: event.publishedAt?.toISOString() ?? null,
  })
}

export function createOutboxWebhookDelivery(
  config: OutboxWebhookConfig,
  fetchImpl: OutboxFetch = fetch,
): (event: OutboxEventRow) => Promise<void> {
  return async (event) => {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.bearerSecret}`,
        'content-type': 'application/json',
        'idempotency-key': event.idempotencyKey,
      },
      body: webhookBody(event),
    })
    if (!response.ok) throw new Error('webhook delivery was not acknowledged')
  }
}

/**
 * Run one bounded drain. The caller (daily/fast pipeline) owns the shared
 * pipeline lock; this CLI intentionally does not create a second lock lane.
 */
export async function runDrainOutbox(options: DrainOutboxOptions = {}): Promise<number> {
  const env = options.env ?? process.env
  const log = options.log ?? console.log
  const config = readOutboxWebhookConfig(env)
  if (!config) {
    log('outbox-drain: webhook is not configured — skipped')
    return 0
  }

  const result = await dispatchOutbox(options.db ?? getDb(), {
    deliver: createOutboxWebhookDelivery(config, options.fetchImpl ?? fetch),
    batchSize: optionalNumber(env, OUTBOX_BATCH_SIZE_ENV),
    maxEvents: optionalNumber(env, OUTBOX_MAX_EVENTS_ENV),
  })
  log(`outbox-drain: ${JSON.stringify(result)}`)
  return result.failed > 0 ? 1 : 0
}

export async function main(): Promise<number> {
  return runDrainOutbox()
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main()
    .then((exitCode) => { process.exitCode = exitCode })
    .catch(() => {
      // Do not print provider URLs, bearer secrets, response bodies, or raw
      // network/database errors; operational logs only need the failure gate.
      console.error('outbox-drain: failed (details redacted)')
      process.exitCode = 1
    })
}
