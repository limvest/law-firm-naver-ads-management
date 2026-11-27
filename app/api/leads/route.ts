import { z } from 'zod'
import { getDb } from '@/lib/db/client'
import { leads, events } from '@/lib/db/schema'
import { encryptPII } from '@/lib/crypto'
import { notifyLead } from '@/lib/telegram'
import { SESSION_COOKIE, FIRST_TOUCH_COOKIE, LAST_TOUCH_COOKIE } from '@/lib/tracking/utm'
import { resolveFirmForSubmission, resolvePlatformLeadFirm, UnrecognizedIntakeHostError } from '@/lib/engine/public-firm'
import { consumeLeadRateLimit } from '@/lib/leads/rate-limit'
import { recordLeadParty } from '@/lib/leads/conflict'
import { inferLeadPriority } from '@/lib/dashboard/leads'
import { attachLeadAttribution, recordTouchpoint, resolveAttributionIds } from '@/domains/acquisition'
import { initializeLeadOutcome } from '@/domains/outcomes'
import { isAdditiveSchemaUnavailable } from '@/lib/db/schema-compat'
import { leadCaseNotificationContext } from '@/lib/leads/notification-context'
import { leadEngagementContext } from '@/lib/leads/engagement-context'
import { API_BODY_LIMITS, logApiFailure, logPublicApiSecurityEvent, readJsonBody, validatePublicApiRequest } from '@/lib/api-security'

export const runtime = 'nodejs'

const leadInputSchema = z.object({
  vertical: z.enum(['scam', 'rehab', 'bankruptcy', 'product']),
  // fraud v2(2026-07-06)부터 성함 미수집(발주자 지시 — 심리 부담 제거·PII 최소화). 미제공 시 센티널 저장.
  name: z.string().trim().min(1).max(50).optional(),
  phone: z.string().regex(/^0\d{1,2}-?\d{3,4}-?\d{4}$/),
  detail: z.string().max(2000).optional(),
  damageType: z.string().max(40).optional(),
  amountBand: z.string().max(20).optional(),
  slug: z.string().max(200).optional(),
  firmId: z.number().int().positive().optional(),
  routeToken: z.string().max(100).optional(),
  website: z.string().max(200).optional(), // 사람에게 보이지 않는 봇 허니팟
  consent: z.literal(true), // 개인정보 수집·이용 동의 필수 (스펙 §7 PII 규율)
})

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie') ?? ''
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return m ? m[1] : undefined
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

export async function POST(request: Request) {
  const rejected = validatePublicApiRequest(request)
  if (rejected) return rejected

  const body = await readJsonBody(request, { maxBytes: API_BODY_LIMITS.leads })
  if (!body.ok) return body.response

  const parsed = leadInputSchema.safeParse(body.value)
  if (!parsed.success) {
    logPublicApiSecurityEvent(request, { status: 400, eventType: 'invalid_request', eventClass: 'attack', outcome: 'blocked', blockReason: 'invalid_request' })
    return Response.json({ ok: false, error: 'invalid_input' }, { status: 400 })
  }
  const input = parsed.data
  if (input.website) {
    logPublicApiSecurityEvent(request, { status: 200, eventType: 'bot_block', eventClass: 'attack', outcome: 'blocked', blockReason: 'bot_detected', includeRawIp: true })
    return Response.json({ ok: true })
  }
  try {
    const firstTouch = readTouch(request, FIRST_TOUCH_COOKIE)
    const lastTouch = readTouch(request, LAST_TOUCH_COOKIE)
    const db = getDb()
    const firm = input.vertical === 'product'
      ? await resolvePlatformLeadFirm(db)
      : await resolveFirmForSubmission(db, request, input)
    const sessionId = readCookie(request, SESSION_COOKIE)
    let canonical: Awaited<ReturnType<typeof resolveAttributionIds>> = null
    if (input.vertical !== 'product') {
      try {
        canonical = await resolveAttributionIds(db, { firmId: firm.id, slug: input.slug, touch: lastTouch })
      } catch {
        logApiFailure('leads:canonical-attribution')
      }
    }

    if (!await consumeLeadRateLimit(db, request, firm.id)) {
      logPublicApiSecurityEvent(request, { status: 429, eventType: 'rate_limit_exceeded', eventClass: 'attack', outcome: 'blocked', blockReason: 'rate_limited', includeRawIp: true })
      return Response.json({ ok: false, error: 'rate_limited' }, {
        status: 429,
        headers: { 'Retry-After': '900' },
      })
    }

    const legacyLead = {
      firmId: firm.id,
      vertical: input.vertical,
      slug: input.slug,
      nameEnc: encryptPII(input.name ?? '미기재'),
      phoneEnc: encryptPII(input.phone),
      detailEnc: input.detail ? encryptPII(input.detail) : null,
      damageType: input.damageType,
      amountBand: input.amountBand,
      priority: inferLeadPriority(input),
      utm: lastTouch,
      firstTouch,
    }
    let lead: { id: string } | undefined
    try {
      ;[lead] = await db.insert(leads).values({
        ...legacyLead,
        lastTouch,
        sessionId: canonical ? sessionId : undefined,
        caseEntityId: canonical?.caseEntityId,
        contentAssetId: canonical?.contentAssetId,
        publicationId: canonical?.publicationId,
        adExecutionId: canonical?.adExecutionId,
      }).returning({ id: leads.id })
    } catch (error) {
      if (!isAdditiveSchemaUnavailable(error)) throw error
      // Migration 0018 전 DB에서는 기존 상담 intake를 보존하되 canonical
      // attribution은 꾸며내지 않는다. Daily preflight는 별도로 실패한다.
      ;[lead] = await db.insert(leads).values(legacyLead).returning({ id: leads.id })
    }

    // Additive target-model write: every accepted lead starts an append-only outcome chain.
    // During a migration-first rollout the legacy intake must remain available, so a missing
    // target table is reported without turning a successfully stored consultation into a 5xx.
    if (lead) {
      try {
        await initializeLeadOutcome(db, { firmId: firm.id, leadId: lead.id })
      } catch {
        logApiFailure('leads:outcome-lifecycle')
      }
    }

    // 성함을 받은 상담만 같은 사무소의 향후 이해충돌 보조 검색에 포함한다. 원문은 암호화,
    // 비교값은 키 기반 HMAC으로 저장하며 이 보조 인덱스 실패가 상담 접수 자체를 막지는 않는다.
    if (input.name && lead) {
      try {
        await recordLeadParty(db, firm.id, lead.id, 'prospective', input.name)
      } catch {
        logApiFailure('leads:prospective-party-index')
      }
    }

    try {
      const legacyEvent = {
        firmId: firm.id,
        type: 'form_submit',
        slug: input.slug,
        sessionId,
        utm: lastTouch,
      }
      let event: { id: string; createdAt: Date } | undefined
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
        ;[event] = await db.insert(events).values(legacyEvent)
          .returning({ id: events.id, createdAt: events.createdAt })
      }
      if (canonical && sessionId && lead && event) {
        await recordTouchpoint(db, {
          touchpointId: event.id,
          sessionId,
          firmId: firm.id,
          caseEntityId: canonical.caseEntityId,
          contentAssetId: canonical.contentAssetId,
          publicationId: canonical.publicationId,
          adExecutionId: canonical.adExecutionId,
          occurredAt: event.createdAt,
          eventType: 'form_submit',
          utm: lastTouch,
          referrer: request.headers.get('referer'),
        })
        await attachLeadAttribution(db, { leadId: lead.id, firmId: firm.id, sessionId })
      }
    } catch {
      logApiFailure('leads:event-attribution')
    }

    // 알림 실패가 접수 실패가 되면 안 됨 — 결과만 로깅
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const [caseContext, engagement] = await Promise.all([
        leadCaseNotificationContext(db, input.slug).catch(() => null),
        leadEngagementContext(db, firm.id, sessionId, input.slug).catch(() => null),
      ])
      const notified = await notifyLead({
        phone: input.phone,
        caseName: caseContext?.caseName ?? input.slug ?? '사건명 확인 필요',
        damageType: input.damageType ?? '미입력',
        amountBand: input.amountBand ?? '미입력',
        situation: input.detail?.trim() || '미입력',
        recordCount: caseContext?.recordCount,
        methods: caseContext?.methods,
        titles: caseContext?.titles,
        lastSeenAt: caseContext?.lastSeenAt,
        utmSource: lastTouch?.utm_source,
        engagement,
      })
      if (!notified) logApiFailure('leads:telegram-notify')
    }

    logPublicApiSecurityEvent(request, { status: 200, eventType: 'api_request_complete' })
    return Response.json({ ok: true })
  } catch (error) {
    if (error instanceof UnrecognizedIntakeHostError) {
      logPublicApiSecurityEvent(request, { status: 403, eventType: 'forbidden', eventClass: 'attack', outcome: 'blocked', blockReason: 'host_mismatch', includeRawIp: true })
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403, headers: { 'cache-control': 'no-store' } })
    }
    logApiFailure('leads')
    logPublicApiSecurityEvent(request, { status: 500, eventType: 'api_request_error', outcome: 'observed' })
    return Response.json({ ok: false, error: 'request_failed' }, {
      status: 500,
      headers: { 'cache-control': 'no-store' },
    })
  }
}
