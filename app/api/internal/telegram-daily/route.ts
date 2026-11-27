import { timingSafeEqual } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { firms } from '@/lib/db/schema'
import { notifyDailyPerformance } from '@/lib/telegram'
import { incidentNameMap } from '@/lib/tracking/incident-name'

export const dynamic = 'force-dynamic'
const DAY_MS = 86_400_000

function authorized(request: Request): boolean {
  const secret = process.env.TELEGRAM_DIGEST_SECRET
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!secret || !supplied) return false
  const expected = Buffer.from(secret)
  const actual = Buffer.from(supplied)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function kstDayStart(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value ?? ''
  return new Date(`${value('year')}-${value('month')}-${value('day')}T00:00:00+09:00`)
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 404 })
  const db = getDb()
  const firmSlug = process.env.TELEGRAM_FIRM_SLUG ?? 'sampleone'
  const firm = (await db.select({ id: firms.id, name: firms.name }).from(firms).where(eq(firms.slug, firmSlug)).limit(1))[0]
  if (!firm) return Response.json({ ok: false, error: 'firm_not_found' }, { status: 404 })

  const end = kstDayStart(new Date())
  const start = new Date(end.getTime() - DAY_MS)
  const trendStart = new Date(end.getTime() - 14 * DAY_MS)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(start)
  const [eventsResult, engagementResult, leadsResult, keywordsResult, keywordLeadsResult, credentialResult, adsResult] = await Promise.all([
    db.execute(sql`select count(*) filter (where type='page_view')::int as visits,
      count(distinct session_id) filter (where type='page_view' and session_id is not null)::int as visitors,
      count(*) filter (where type in ('call_click','kakao_click'))::int as contacts
      from events where firm_id=${firm.id} and created_at>=${start} and created_at<${end}`),
    db.execute(sql`select count(distinct session_id) filter (where active_seconds>=15)::int as engaged,
      count(distinct session_id) filter (where high_intent=true)::int as high_intent
      from engagement_sessions where firm_id=${firm.id} and last_seen_at>=${start} and last_seen_at<${end}`),
    db.execute(sql`select count(*)::int as inquiries from leads where firm_id=${firm.id} and created_at>=${start} and created_at<${end}`),
    db.execute(sql`select slug, count(distinct session_id)::int as sessions,
      count(distinct session_id) filter (where high_intent=true)::int as high_intent
      from engagement_sessions where firm_id=${firm.id} and last_seen_at>=${start} and last_seen_at<${end}
      group by slug order by high_intent desc, sessions desc limit 10`),
    db.execute(sql`select coalesce(nullif(slug,''),'직접 유입') as slug, count(*)::int as inquiries
      from leads where firm_id=${firm.id} and created_at>=${start} and created_at<${end} group by 1`),
    db.execute(sql`select count(*)::int as n from firm_credentials where firm_id=${firm.id} and provider='naver_searchad'`),
    db.execute(sql`select day, sum(cost)::int as cost, sum(clicks)::int as clicks from ad_daily_stats_v2
      where firm_id=${firm.id} and day>=${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(trendStart)} and day<${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(end)}
      group by day order by day`),
  ])
  const events = (eventsResult.rows[0] ?? {}) as Record<string, unknown>
  const engagement = (engagementResult.rows[0] ?? {}) as Record<string, unknown>
  const leads = (leadsResult.rows[0] ?? {}) as Record<string, unknown>
  const leadMap = new Map((keywordLeadsResult.rows as Array<Record<string, unknown>>).map((row) => [String(row.slug), Number(row.inquiries ?? 0)]))
  const keywordRows = keywordsResult.rows as Array<Record<string, unknown>>
  const nameMap = await incidentNameMap(db, firm.id, keywordRows.map((row) => String(row.slug)))
  const namedKeywords = new Map<string, { slug: string; sessions: number; highIntent: number; inquiries: number }>()
  for (const row of keywordRows) {
    const rawSlug = String(row.slug)
    const name = nameMap.get(rawSlug)
    if (!name) continue
    const current = namedKeywords.get(name) ?? { slug: name, sessions: 0, highIntent: 0, inquiries: 0 }
    current.sessions += Number(row.sessions ?? 0)
    current.highIntent += Number(row.high_intent ?? 0)
    current.inquiries += leadMap.get(rawSlug) ?? 0
    namedKeywords.set(name, current)
  }
  const spendTrend = (adsResult.rows as Array<Record<string, unknown>>).map((row) => ({ day: String(row.day), cost: Number(row.cost ?? 0), clicks: Number(row.clicks ?? 0) }))
  const yesterdaySpend = spendTrend.find((row) => row.day === day)

  const notified = await notifyDailyPerformance({
    day,
    visits: Number(events.visits ?? 0),
    visitors: Number(events.visitors ?? 0),
    engaged: Number(engagement.engaged ?? 0),
    highIntent: Number(engagement.high_intent ?? 0),
    contactActions: Number(events.contacts ?? 0),
    inquiries: Number(leads.inquiries ?? 0),
    keywords: [...namedKeywords.values()].sort((a, b) => b.highIntent - a.highIntent || b.sessions - a.sessions).slice(0, 10),
    adConnected: Number((credentialResult.rows[0] as Record<string, unknown> | undefined)?.n ?? 0) > 0,
    adSpend: yesterdaySpend?.cost ?? 0,
    adClicks: yesterdaySpend?.clicks ?? 0,
    spendTrend,
  })
  if (!notified) return Response.json({ ok: false, error: 'telegram_failed' }, { status: 502 })
  return Response.json({ ok: true })
}
