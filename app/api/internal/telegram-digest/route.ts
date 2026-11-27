import { timingSafeEqual } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { firms } from '@/lib/db/schema'
import { notifyActivityDigest } from '@/lib/telegram'
import { incidentNameMap } from '@/lib/tracking/incident-name'

export const dynamic = 'force-dynamic'
const HOUR_MS = 3_600_000

function authorized(request: Request): boolean {
  const secret = process.env.TELEGRAM_DIGEST_SECRET
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!secret || !supplied) return false
  const expectedBuffer = Buffer.from(secret)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

export function scheduledDigestWindow(now: Date): { start: Date; end: Date } {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  const dayStart = new Date(`${day}T00:00:00+09:00`)
  const nine = new Date(dayStart.getTime() + 9 * HOUR_MS)
  const eighteen = new Date(dayStart.getTime() + 18 * HOUR_MS)
  if (now >= eighteen) return { start: nine, end: eighteen }
  if (now >= nine) return { start: new Date(dayStart.getTime() - 6 * HOUR_MS), end: nine }
  return {
    start: new Date(dayStart.getTime() - 15 * HOUR_MS),
    end: new Date(dayStart.getTime() - 6 * HOUR_MS),
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 404 })

  const db = getDb()
  const firmSlug = process.env.TELEGRAM_FIRM_SLUG ?? 'sampleone'
  const firm = (await db.select({ id: firms.id, name: firms.name }).from(firms).where(eq(firms.slug, firmSlug)).limit(1))[0]
  if (!firm) return Response.json({ ok: false, error: 'firm_not_found' }, { status: 404 })

  const { start, end } = scheduledDigestWindow(new Date())
  const [eventResult, leadResult, pageResult, engagementResult, interestResult] = await Promise.all([
    db.execute(sql`select
      count(*) filter (where type = 'page_view')::int as visits,
      count(distinct session_id) filter (where type = 'page_view' and session_id is not null)::int as visitors,
      count(*) filter (where type = 'call_click')::int as calls,
      count(*) filter (where type = 'kakao_click')::int as kakao
      from events where firm_id = ${firm.id} and created_at >= ${start} and created_at < ${end}`),
    db.execute(sql`select count(*)::int as inquiries from leads
      where firm_id = ${firm.id} and created_at >= ${start} and created_at < ${end}`),
    db.execute(sql`select coalesce(nullif(slug, ''), '직접 유입') as slug, count(*)::int as visits
      from events where firm_id = ${firm.id} and type = 'page_view' and created_at >= ${start} and created_at < ${end}
      group by 1 order by visits desc limit 3`),
    db.execute(sql`select
      count(distinct session_id) filter (where active_seconds >= 15)::int as engaged,
      count(distinct session_id) filter (where high_intent = true)::int as high_intent
      from engagement_sessions where firm_id = ${firm.id} and last_seen_at >= ${start} and last_seen_at < ${end}`),
    db.execute(sql`select slug, count(distinct session_id)::int as high_intent
      from engagement_sessions where firm_id = ${firm.id} and high_intent = true and last_seen_at >= ${start} and last_seen_at < ${end}
      group by slug order by high_intent desc limit 3`),
  ])

  const event = (eventResult.rows[0] ?? {}) as Record<string, unknown>
  const lead = (leadResult.rows[0] ?? {}) as Record<string, unknown>
  const engagement = (engagementResult.rows[0] ?? {}) as Record<string, unknown>
  const pageRows = pageResult.rows as Array<Record<string, unknown>>
  const interestRows = interestResult.rows as Array<Record<string, unknown>>
  const nameMap = await incidentNameMap(db, firm.id, [...pageRows, ...interestRows].map((row) => String(row.slug)))
  const namedPages = new Map<string, number>()
  const namedInterest = new Map<string, number>()
  for (const row of pageRows) {
    const name = nameMap.get(String(row.slug))
    if (name) namedPages.set(name, (namedPages.get(name) ?? 0) + Number(row.visits ?? 0))
  }
  for (const row of interestRows) {
    const name = nameMap.get(String(row.slug))
    if (name) namedInterest.set(name, (namedInterest.get(name) ?? 0) + Number(row.high_intent ?? 0))
  }
  const metrics = {
    visits: Number(event.visits ?? 0),
    visitors: Number(event.visitors ?? 0),
    engagedSessions: Number(engagement.engaged ?? 0),
    highIntentSessions: Number(engagement.high_intent ?? 0),
    calls: Number(event.calls ?? 0),
    kakao: Number(event.kakao ?? 0),
    inquiries: Number(lead.inquiries ?? 0),
  }
  const notified = await notifyActivityDigest({
    start,
    end,
    ...metrics,
    topPages: [...namedPages].map(([slug, visits]) => ({ slug, visits })).sort((a, b) => b.visits - a.visits).slice(0, 3),
    topInterest: [...namedInterest].map(([slug, highIntent]) => ({ slug, highIntent })).sort((a, b) => b.highIntent - a.highIntent).slice(0, 3),
  })
  if (!notified) return Response.json({ ok: false, error: 'telegram_failed' }, { status: 502 })
  return Response.json({ ok: true })
}
