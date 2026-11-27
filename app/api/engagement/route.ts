import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { engagementSessions } from '@/lib/db/schema'
import { resolveFirmForSubmission, UnrecognizedIntakeHostError } from '@/lib/engine/public-firm'
import { calculateInterestScore } from '@/lib/tracking/engagement'
import { isBotUA } from '@/lib/tracking/bots'
import { LAST_TOUCH_COOKIE, SESSION_COOKIE } from '@/lib/tracking/utm'
import { API_BODY_LIMITS, logApiFailure, logPublicApiSecurityEvent, readJsonBody, trustedClientIp, validatePublicApiRequest } from '@/lib/api-security'
import { consumeApiRateLimit, PUBLIC_ENGAGEMENT_RATE_LIMIT } from '@/lib/leads/rate-limit'

export const runtime = 'nodejs'

const inputSchema = z.object({
  slug: z.string().trim().min(1).max(200).optional(),
  firmId: z.number().int().positive().optional(),
  routeToken: z.string().max(100).optional(),
  activeSeconds: z.number().int().min(0).max(86_400),
  maxScroll: z.number().int().min(0).max(100),
  pageView: z.boolean().optional().default(false),
  lawyerViewed: z.boolean().optional().default(false),
  processViewed: z.boolean().optional().default(false),
  contactViewed: z.boolean().optional().default(false),
  formStarted: z.boolean().optional().default(false),
  referrer: z.string().trim().max(1000).optional(),
})

function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get('cookie') ?? ''
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1]
}

function readTouch(request: Request): Record<string, string> | undefined {
  const value = readCookie(request, LAST_TOUCH_COOKIE)
  if (!value) return undefined
  try { return JSON.parse(decodeURIComponent(value)) } catch { return undefined }
}

function requestMetadata(request: Request, clientReferrer?: string) {
  return {
    ipAddress: trustedClientIp(request)?.slice(0, 64) ?? null,
    userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
    referrer: clientReferrer || request.headers.get('referer')?.slice(0, 1000) || null,
  }
}

export async function POST(request: Request) {
  const rejected = validatePublicApiRequest(request)
  if (rejected) return rejected

  const body = await readJsonBody(request, { maxBytes: API_BODY_LIMITS.engagement })
  if (!body.ok) return body.response

  const parsed = inputSchema.safeParse(body.value)
  if (!parsed.success) {
    logPublicApiSecurityEvent(request, { status: 400, eventType: 'invalid_request', eventClass: 'attack', outcome: 'blocked', blockReason: 'invalid_request' })
    return new Response(null, { status: 400 })
  }
  if (isBotUA(request.headers.get('user-agent'))) {
    logPublicApiSecurityEvent(request, { status: 204, eventType: 'bot_block', eventClass: 'attack', outcome: 'blocked', blockReason: 'bot_detected', includeRawIp: true })
    return new Response(null, { status: 204 })
  }

  const sessionId = readCookie(request, SESSION_COOKIE)
  if (!sessionId) {
    logPublicApiSecurityEvent(request, { status: 204, eventType: 'api_missing_session', outcome: 'observed' })
    return new Response(null, { status: 204 })
  }
  try {
    const input = parsed.data
    const db = getDb()
    const firm = await resolveFirmForSubmission(db, request, input)
    if (!await consumeApiRateLimit(db, request, PUBLIC_ENGAGEMENT_RATE_LIMIT)) {
      logPublicApiSecurityEvent(request, { status: 429, eventType: 'rate_limit_exceeded', eventClass: 'attack', outcome: 'blocked', blockReason: 'rate_limited', includeRawIp: true })
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': '300', 'Cache-Control': 'no-store' },
      })
    }
    const slug = input.slug ?? '직접 유입'
    const touch = readTouch(request)
    const metadata = requestMetadata(request, input.referrer)

  const merged = await db.execute(sql`
    insert into engagement_sessions (
      firm_id, session_id, slug, active_seconds, max_scroll, page_views,
      lawyer_viewed, process_viewed, contact_viewed, form_started, utm,
      ip_address, user_agent, referrer, last_seen_at
    ) values (
      ${firm.id}, ${sessionId}, ${slug}, ${input.activeSeconds}, ${input.maxScroll}, ${input.pageView ? 1 : 0},
      ${input.lawyerViewed}, ${input.processViewed}, ${input.contactViewed}, ${input.formStarted}, ${touch ?? null},
      ${metadata.ipAddress}, ${metadata.userAgent}, ${metadata.referrer}, now()
    )
    on conflict (firm_id, session_id, slug) do update set
      active_seconds = greatest(engagement_sessions.active_seconds, excluded.active_seconds),
      max_scroll = greatest(engagement_sessions.max_scroll, excluded.max_scroll),
      page_views = engagement_sessions.page_views + excluded.page_views,
      lawyer_viewed = engagement_sessions.lawyer_viewed or excluded.lawyer_viewed,
      process_viewed = engagement_sessions.process_viewed or excluded.process_viewed,
      contact_viewed = engagement_sessions.contact_viewed or excluded.contact_viewed,
      form_started = engagement_sessions.form_started or excluded.form_started,
      utm = coalesce(engagement_sessions.utm, excluded.utm),
      ip_address = coalesce(excluded.ip_address, engagement_sessions.ip_address),
      user_agent = coalesce(excluded.user_agent, engagement_sessions.user_agent),
      referrer = coalesce(engagement_sessions.referrer, excluded.referrer),
      last_seen_at = now()
    returning id, active_seconds, max_scroll, page_views, lawyer_viewed, process_viewed, contact_viewed, form_started
  `)
  const row = merged.rows[0] as Record<string, unknown>
  const interestScore = calculateInterestScore({
    activeSeconds: Number(row.active_seconds),
    maxScroll: Number(row.max_scroll),
    pageViews: Number(row.page_views),
    lawyerViewed: Boolean(row.lawyer_viewed),
    processViewed: Boolean(row.process_viewed),
    contactViewed: Boolean(row.contact_viewed),
    formStarted: Boolean(row.form_started),
  })
  await db.update(engagementSessions).set({
    interestScore: sql`greatest(${engagementSessions.interestScore}, ${interestScore})`,
    highIntent: sql`${engagementSessions.highIntent} or ${interestScore >= 60}`,
  }).where(eq(engagementSessions.id, String(row.id)))

  // 방문 행태정보는 상담 접수정보와 분리해 30일까지만 보관한다.
  await db.execute(sql`delete from engagement_sessions where last_seen_at < now() - interval '30 days'`)

    logPublicApiSecurityEvent(request, { status: 204, eventType: 'api_request_complete' })
    return new Response(null, { status: 204 })
  } catch (error) {
    if (error instanceof UnrecognizedIntakeHostError) {
      logPublicApiSecurityEvent(request, { status: 403, eventType: 'forbidden', eventClass: 'attack', outcome: 'blocked', blockReason: 'host_mismatch', includeRawIp: true })
      return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    }
    logApiFailure('engagement')
    logPublicApiSecurityEvent(request, { status: 500, eventType: 'api_request_error', outcome: 'observed' })
    return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
