import { timingSafeEqual } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { firms } from '@/lib/db/schema'
import { formatAdPerformancePulse, formatVisitorStatus, sendTelegramText, type VisitorStatusRow } from '@/lib/telegram'
import { incidentNameMap } from '@/lib/tracking/incident-name'
import { syncExactKeywordReviews, type ExactReviewSyncResult } from '@/lib/engine/naver/exact-review-sync'

export const dynamic = 'force-dynamic'

const VISITOR_COMMAND = /^\/(?:v|방문자현황|visitors)(?:@\w+)?(?:\s|$)/u
const PERFORMANCE_COMMAND = /^\/(?:p|광고현황|성과|performance)(?:@\w+)?(?:\s|$)/u

function secureEqual(left?: string | null, right?: string): boolean {
  if (!left || !right) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function kstDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

async function sendPerformancePulse(firmId: number, replyToMessageId?: number, reviewSync?: ExactReviewSyncResult | null): Promise<boolean> {
  const db = getDb()
  const now = new Date()
  const today = kstDay(now)
  const monthStart = `${today.slice(0, 7)}-01`
  const dayStart = new Date(`${today}T00:00:00+09:00`)
  const [keywordsResult, performanceResult, outcomesResult, inquiriesResult] = await Promise.all([
    db.execute(sql`select
      count(*)::int as registered,
      count(*) filter (where upper(coalesce(raw->>'inspectStatus', '')) in ('APPROVED', 'ELIGIBLE')
        and lower(coalesce(raw->>'userLock', 'true')) <> 'true')::int as active,
      count(*) filter (where upper(coalesce(raw->>'inspectStatus', '')) in ('UNDER_REVIEW', 'PENDING')
        and upper(coalesce(raw->>'statusReason', '')) <> 'KEYWORD_DISAPPROVED')::int as under_review,
      count(*) filter (where upper(coalesce(raw->>'inspectStatus', '')) in ('APPROVED', 'ELIGIBLE')
        and lower(coalesce(raw->>'userLock', 'true')) = 'true')::int as approved_paused,
      count(*) filter (where upper(coalesce(raw->>'inspectStatus', '')) in ('DENIED', 'INELIGIBLE', 'REJECTED')
        or upper(coalesce(raw->>'statusReason', '')) = 'KEYWORD_DISAPPROVED'
        or review_status = 'rejected')::int as rejected
      from firm_ad_entities where firm_id=${firmId} and entity_type='keyword'`),
    db.execute(sql`with v2 as (
        select day, impressions, clicks, cost, synced_at
        from ad_daily_stats_v2 where firm_id=${firmId}
      ), legacy as (
        select stats.day, sum(stats.impressions)::int as impressions, sum(stats.clicks)::int as clicks,
          sum(stats.cost)::int as cost, null::timestamptz as synced_at
        from ad_stats stats
        join firm_ad_entities entity on entity.id = stats.entity_id
        where entity.firm_id=${firmId} and entity.entity_type='adgroup'
        group by stats.day
      ), scoped as (
        select * from v2
        union all
        select * from legacy where not exists (select 1 from v2)
      ), latest as (select max(day) as day from scoped)
      select latest.day as latest_day,
        coalesce((select sum(cost)::int from scoped where day = latest.day), 0)::int as latest_spend,
        coalesce(sum(scoped.cost) filter (where scoped.day >= ${monthStart}), 0)::int as month_spend,
        coalesce(sum(scoped.impressions) filter (where scoped.day >= ${monthStart}), 0)::int as month_impressions,
        coalesce(sum(scoped.clicks) filter (where scoped.day >= ${monthStart}), 0)::int as month_clicks,
        max(scoped.synced_at) as last_synced_at
      from latest left join scoped on true group by latest.day`),
    db.execute(sql`select
      count(*) filter (where type='call_click')::int as calls,
      count(*) filter (where type='kakao_click')::int as kakao
      from events where firm_id=${firmId} and created_at>=${dayStart}`),
    db.execute(sql`select count(*)::int as inquiries
      from leads where firm_id=${firmId} and created_at>=${dayStart}`),
  ])
  const keywordRows = keywordsResult.rows[0] as Record<string, unknown> | undefined
  const performanceRows = performanceResult.rows[0] as Record<string, unknown> | undefined
  const outcomeRows = outcomesResult.rows[0] as Record<string, unknown> | undefined
  const inquiryRows = inquiriesResult.rows[0] as Record<string, unknown> | undefined
  const asDate = (value: unknown): Date | null => value ? new Date(String(value)) : null
  return sendTelegramText(formatAdPerformancePulse({
    generatedAt: now,
    keywords: {
      registered: Number(keywordRows?.registered ?? 0),
      active: Number(keywordRows?.active ?? 0),
      underReview: Number(keywordRows?.under_review ?? 0),
      approvedPaused: Number(keywordRows?.approved_paused ?? 0),
      rejected: Number(keywordRows?.rejected ?? 0),
    },
    performance: {
      latestDay: performanceRows?.latest_day ? String(performanceRows.latest_day) : null,
      latestSpend: Number(performanceRows?.latest_spend ?? 0),
      monthSpend: Number(performanceRows?.month_spend ?? 0),
      monthImpressions: Number(performanceRows?.month_impressions ?? 0),
      monthClicks: Number(performanceRows?.month_clicks ?? 0),
      lastSyncedAt: asDate(performanceRows?.last_synced_at),
    },
    outcomes: {
      calls: Number(outcomeRows?.calls ?? 0),
      kakao: Number(outcomeRows?.kakao ?? 0),
      inquiries: Number(inquiryRows?.inquiries ?? 0),
    },
    reviewSync,
  }), replyToMessageId)
}

export async function POST(request: Request) {
  if (!secureEqual(request.headers.get('x-telegram-bot-api-secret-token'), process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response(null, { status: 404 })
  }
  const update = await request.json().catch(() => null) as {
    message?: { message_id?: number; text?: string; chat?: { id?: number | string } }
  } | null
  const message = update?.message
  if (!message?.text || String(message.chat?.id ?? '') !== process.env.TELEGRAM_CHAT_ID) {
    return new Response(null, { status: 204 })
  }
  const command = message.text.trim()
  const isVisitorCommand = VISITOR_COMMAND.test(command)
  const isPerformanceCommand = PERFORMANCE_COMMAND.test(command)
  if (!isVisitorCommand && !isPerformanceCommand) {
    return new Response(null, { status: 204 })
  }

  const db = getDb()
  const firmSlug = process.env.TELEGRAM_FIRM_SLUG ?? 'sampleone'
  const [firm] = await db.select({ id: firms.id }).from(firms).where(eq(firms.slug, firmSlug)).limit(1)
  if (!firm) return new Response(null, { status: 204 })
  if (isPerformanceCommand) {
    let reviewSync: ExactReviewSyncResult | null = null
    try {
      reviewSync = await syncExactKeywordReviews(db, firm.id)
    } catch {
      // A command must still return the latest local mirror if Naver is briefly unavailable.
      reviewSync = { groups: 0, failedGroups: 1, matchedKeywords: 0, updatedKeywords: 0 }
    }
    const sent = await sendPerformancePulse(firm.id, message.message_id, reviewSync)
    return new Response(null, { status: sent ? 204 : 502 })
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const rowsResult = await db.execute(sql`select session_id, slug, active_seconds, max_scroll, page_views, lawyer_viewed,
    process_viewed, contact_viewed, form_started, interest_score, high_intent, ip_address, user_agent, referrer, utm, last_seen_at
    from engagement_sessions where firm_id=${firm.id} and last_seen_at>=${since}
    order by high_intent desc, interest_score desc, last_seen_at desc limit 50`)
  const rawRows = rowsResult.rows as Array<Record<string, unknown>>
  const nameMap = await incidentNameMap(db, firm.id, rawRows.map((row) => String(row.slug)))
  const visibleRawRows = rawRows.filter((row) => nameMap.has(String(row.slug)))
  const rows = rawRows.flatMap((row): VisitorStatusRow[] => {
    const caseName = nameMap.get(String(row.slug))
    if (!caseName) return []
    return [{
    slug: caseName,
    activeSeconds: Number(row.active_seconds ?? 0),
    maxScroll: Number(row.max_scroll ?? 0),
    pageViews: Number(row.page_views ?? 0),
    lawyerViewed: Boolean(row.lawyer_viewed),
    processViewed: Boolean(row.process_viewed),
    contactViewed: Boolean(row.contact_viewed),
    formStarted: Boolean(row.form_started),
    interestScore: Number(row.interest_score ?? 0),
    highIntent: Boolean(row.high_intent),
    ipAddress: row.ip_address ? String(row.ip_address) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
    referrer: row.referrer ? String(row.referrer) : null,
    utm: row.utm && typeof row.utm === 'object' ? row.utm as Record<string, string> : null,
    lastSeenAt: new Date(String(row.last_seen_at)),
    }]
  })
  const sent = await sendTelegramText(
    formatVisitorStatus(
      rows,
      new Set(visibleRawRows.map((row) => String(row.session_id))).size,
      visibleRawRows.filter((row) => Boolean(row.high_intent)).length,
    ),
    message.message_id,
  )
  return new Response(null, { status: sent ? 204 : 502 })
}
