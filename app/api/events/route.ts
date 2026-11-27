import { z } from 'zod'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { getDb, type Db } from '@/lib/db/client'
import { events } from '@/lib/db/schema'
import { isBotUA } from '@/lib/tracking/bots'
import { SESSION_COOKIE, LAST_TOUCH_COOKIE } from '@/lib/tracking/utm'
import { resolveFirmForSubmission, UnrecognizedIntakeHostError } from '@/lib/engine/public-firm'
import { recordTouchpoint, resolveAttributionIds } from '@/domains/acquisition'
import { isAdditiveSchemaUnavailable } from '@/lib/db/schema-compat'
import { notifyContactEvent } from '@/lib/telegram'
import { incidentNameForTracking } from '@/lib/tracking/incident-name'
import { API_BODY_LIMITS, logApiFailure, logPublicApiSecurityEvent, readJsonBody, requestHost, trustedClientIp, validatePublicApiRequest } from '@/lib/api-security'
import { consumeApiRateLimit, PUBLIC_EVENT_RATE_LIMIT } from '@/lib/leads/rate-limit'

export const runtime = 'nodejs'

export const eventTypeSchema = z.enum([
  'page_view', 'call_click', 'kakao_click', 'form_step', 'form_submit',
])

const eventInputSchema = z.object({
  type: eventTypeSchema,
  slug: z.string().max(200).optional(),
  variant: z.string().max(40).optional(),
  firmId: z.number().int().positive().optional(),
  routeToken: z.string().max(100).optional(),
})

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie') ?? ''
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return m ? (name === SESSION_COOKIE ? m[1]?.slice(0, 128) : m[1]) : undefined
}

function readTouch(req: Request, name: string): Record<string, string> | undefined {
  const v = readCookie(req, name)
  if (!v) return undefined
  try {
    return JSON.parse(decodeURIComponent(v))
  } catch {
    return undefined
  }
}

const EVENT_DEDUPE_WINDOW_MS = 60 * 1000

type EventIdentity = {
  firmId: number
  type: string
  slug?: string
  variant?: string
  sessionId?: string
  host: string
  clientIp: string | null
}

type StoredEvent = { id: string; createdAt: Date }

const eventLocks = new Map<string, Promise<void>>()
const anonymousEventSeen = new WeakMap<object, Map<string, number>>()

function eventKey(identity: EventIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    identity.firmId,
    identity.type,
    identity.slug ?? null,
    identity.variant ?? null,
    identity.sessionId ?? null,
    identity.host,
    identity.clientIp,
  ])).digest('hex')
}

async function withEventLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = eventLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  eventLocks.set(key, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (eventLocks.get(key) === current) eventLocks.delete(key)
  }
}

function anonymousSeen(db: Db): Map<string, number> {
  const existing = anonymousEventSeen.get(db as object)
  if (existing) return existing
  const created = new Map<string, number>()
  anonymousEventSeen.set(db as object, created)
  return created
}

async function writeEventOnce<T>(
  db: Db,
  request: Request,
  identity: EventIdentity,
  writer: () => Promise<T>,
): Promise<{ kind: 'duplicate' } | { kind: 'rate_limited' } | { kind: 'inserted'; value: T }> {
  const key = eventKey(identity)
  return withEventLock(key, async () => {
    const now = Date.now()
    if (identity.sessionId) {
      const [existing] = await db.select({ id: events.id }).from(events).where(and(
        // The database has no client-supplied idempotency column, so the
        // existing event dimensions provide a bounded retry signature.
        identity.slug === undefined ? isNull(events.slug) : eq(events.slug, identity.slug),
        identity.variant === undefined ? isNull(events.variant) : eq(events.variant, identity.variant),
        eq(events.firmId, identity.firmId),
        eq(events.type, identity.type),
        eq(events.sessionId, identity.sessionId),
        gt(events.createdAt, new Date(now - EVENT_DEDUPE_WINDOW_MS)),
      )).limit(1)
      if (existing) return { kind: 'duplicate' }
    } else if (identity.clientIp) {
      const seen = anonymousSeen(db)
      for (const [seenKey, seenAt] of seen) {
        if (now - seenAt >= EVENT_DEDUPE_WINDOW_MS) seen.delete(seenKey)
      }
      if (now - (seen.get(key) ?? 0) < EVENT_DEDUPE_WINDOW_MS) return { kind: 'duplicate' }
    }

    if (!await consumeApiRateLimit(db, request, PUBLIC_EVENT_RATE_LIMIT)) {
      return { kind: 'rate_limited' }
    }
    const value = await writer()
    if (identity.clientIp && !identity.sessionId) anonymousSeen(db).set(key, now)
    return { kind: 'inserted', value }
  })
}

export async function POST(request: Request) {
  const rejected = validatePublicApiRequest(request)
  if (rejected) return rejected

  const body = await readJsonBody(request, {
    maxBytes: API_BODY_LIMITS.events,
    // Existing Naver landing pages use sendBeacon(string), which sends
    // JSON with text/plain;charset=UTF-8 rather than application/json.
    allowTextPlainJson: true,
  })
  if (!body.ok) return body.response

  const parsed = eventInputSchema.safeParse(body.value)
  if (!parsed.success) {
    logPublicApiSecurityEvent(request, { status: 400, eventType: 'invalid_request', eventClass: 'attack', outcome: 'blocked', blockReason: 'invalid_request' })
    return new Response(null, { status: 400 })
  }

  if (!isBotUA(request.headers.get('user-agent'))) {
    try {
      const db = getDb()
      const firm = await resolveFirmForSubmission(db, request, parsed.data)
      const sessionId = readCookie(request, SESSION_COOKIE)
      const touch = readTouch(request, LAST_TOUCH_COOKIE)
      const identity: EventIdentity = {
        firmId: firm.id,
        type: parsed.data.type,
        slug: parsed.data.slug,
        variant: parsed.data.variant,
        sessionId,
        host: requestHost(request) ?? 'unknown-host',
        clientIp: trustedClientIp(request),
      }

      const result = await writeEventOnce(db, request, identity, async () => {
        let canonical: Awaited<ReturnType<typeof resolveAttributionIds>> = null
        try {
          canonical = await resolveAttributionIds(db, { firmId: firm.id, slug: parsed.data.slug, touch })
        } catch {
          logApiFailure('events:canonical-attribution')
        }
        const legacyEvent = {
          firmId: firm.id,
          type: parsed.data.type,
          slug: parsed.data.slug,
          variant: parsed.data.variant,
          sessionId,
          utm: touch,
        }
        let event: StoredEvent | undefined
        try {
          ;[event] = await db.insert(events).values({
            ...legacyEvent,
            caseEntityId: canonical?.caseEntityId,
            contentAssetId: canonical?.contentAssetId,
            publicationId: canonical?.publicationId,
            adExecutionId: canonical?.adExecutionId,
          }).returning({ id: events.id, createdAt: events.createdAt })
        } catch (error) {
          if (!isAdditiveSchemaUnavailable(error)) throw error
          // Migration 0018 전 DB에서도 기존 analytics intake는 유지한다.
          ;[event] = await db.insert(events).values(legacyEvent)
            .returning({ id: events.id, createdAt: events.createdAt })
        }
        if (!event) throw new Error('event insert returned no row')
        return { event, canonical }
      })

      if (result.kind === 'rate_limited') {
        logPublicApiSecurityEvent(request, { status: 429, eventType: 'rate_limit_exceeded', eventClass: 'attack', outcome: 'blocked', blockReason: 'rate_limited', includeRawIp: true })
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': '300', 'Cache-Control': 'no-store' },
        })
      }
      if (result.kind === 'duplicate') {
        logPublicApiSecurityEvent(request, { status: 204, eventType: 'api_duplicate_suppressed', outcome: 'observed' })
        return new Response(null, { status: 204 })
      }

      const { event, canonical } = result.value
      if (sessionId) {
        try {
          await recordTouchpoint(db, {
            touchpointId: event.id,
            sessionId,
            firmId: firm.id,
            caseEntityId: canonical?.caseEntityId,
            contentAssetId: canonical?.contentAssetId,
            publicationId: canonical?.publicationId,
            adExecutionId: canonical?.adExecutionId,
            occurredAt: event.createdAt,
            eventType: parsed.data.type,
            utm: touch,
            referrer: request.headers.get('referer'),
          })
        } catch {
          // The legacy event remains the intake source during additive rollout.
          logApiFailure('events:canonical-touchpoint')
        }
      }
      if (
        (parsed.data.type === 'call_click' || parsed.data.type === 'kakao_click')
        && process.env.TELEGRAM_BOT_TOKEN
        && process.env.TELEGRAM_CHAT_ID
      ) {
        const caseName = await incidentNameForTracking(db, firm.id, parsed.data.slug, request).catch(() => null)
        const notified = await notifyContactEvent({
          type: parsed.data.type,
          caseName: caseName ?? '사건명 확인 필요',
          utmSource: touch?.utm_source ?? touch?.source,
        })
        if (!notified) logApiFailure('events:telegram-notify')
      }
    } catch (error) {
      if (error instanceof UnrecognizedIntakeHostError) {
        logPublicApiSecurityEvent(request, { status: 403, eventType: 'forbidden', eventClass: 'attack', outcome: 'blocked', blockReason: 'host_mismatch', includeRawIp: true })
        return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
      }
      logApiFailure('events')
      logPublicApiSecurityEvent(request, { status: 500, eventType: 'api_request_error', outcome: 'observed' })
      return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } })
    }
  }
  logPublicApiSecurityEvent(request, { status: 204, eventType: 'api_request_complete' })
  return new Response(null, { status: 204 })
}
