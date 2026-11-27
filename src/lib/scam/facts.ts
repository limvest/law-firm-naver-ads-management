import { eq, and, ne, count, desc, sql, isNotNull, or } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { keywords, observations, events } from '@/lib/db/schema'
import type { ObsFacts } from '@/lib/db/schema'

/**
 * 02 FACTS 실측 데이터 — observations(수집일·수집처·형태·횟수) + events(페이지 방문).
 * BLUEPRINT §3-4: 단정 표현 금지 — 이 데이터는 "관측/수집" 언어로만 렌더한다.
 * 데이터가 없으면 null → 랜딩은 F-FALL(일반 통계) 폴백. 임의 수치 절대 금지.
 */
export type ScamFacts = {
  name: string
  firstSeenAt: string          // ISO — 최초 수집일
  lastSeenAt: string | null    // ISO — 최근 수집일
  daysSince: number            // 경과일
  observationCount: number     // 수집 횟수
  sourceBreakdown: { type: string; count: number }[]   // 수집 형태별
  recentObservations: { at: string; sourceType: string | null; title: string | null; origin: string | null }[]  // 최근 관측 원자료 (최대 8, 최신순)
  pageVisits: number | null    // 이 키워드 랜딩 방문 수 (events.page_view)
  factsAggregate: FactsAggregate | null   // 수법·인프라·금액 집계 (facts 보유 관측 없으면 null)
}

export async function getScamFacts(db: Db, slug: string): Promise<ScamFacts | null> {
  const kw = await db
    .select()
    .from(keywords)
    .where(and(eq(keywords.slug, slug), ne(keywords.status, 'blocked')))
    .limit(1)
  if (!kw.length) return null
  const k = kw[0]

  const [{ value: obsCount }] = await db
    .select({ value: count() })
    .from(observations)
    .where(eq(observations.keywordId, k.id))
  if (!k.firstSeenAt || Number(obsCount) === 0) return null   // 실측 없으면 FACTS 미표시 (F-FALL)

  const breakdown = await db
    .select({ type: sql<string>`coalesce(${observations.sourceType}, 'etc')`, count: count() })
    .from(observations)
    .where(eq(observations.keywordId, k.id))
    .groupBy(sql`coalesce(${observations.sourceType}, 'etc')`)

  const recent = await db
    .select({ at: observations.observedAt, sourceType: observations.sourceType, title: observations.title, origin: observations.origin })
    .from(observations)
    .where(eq(observations.keywordId, k.id))
    .orderBy(desc(observations.observedAt))
    .limit(8)

  let pageVisits: number | null = null
  try {
    const [{ value }] = await db
      .select({ value: count() })
      .from(events)
      // 구형 시네마는 f/{slug}, 최종 V3는 canonical case slug를 기록한다.
      // 전환 전후 방문 수를 한 통계로 유지한다.
      .where(and(eq(events.type, 'page_view'), or(eq(events.slug, slug), eq(events.slug, `f/${slug}`))))
    pageVisits = Number(value) || null
  } catch { /* events 집계 실패는 FACTS 자체를 막지 않는다 */ }

  const factRows = await db
    .select({ facts: observations.facts })
    .from(observations)
    .where(and(eq(observations.keywordId, k.id), isNotNull(observations.facts)))
    .orderBy(observations.observedAt)  // 첫 표기 유지 결정성 — 무순서 스캔 방지

  return {
    name: k.name,
    firstSeenAt: k.firstSeenAt.toISOString(),
    lastSeenAt: k.lastSeenAt ? k.lastSeenAt.toISOString() : null,
    daysSince: Math.max(0, Math.floor((Date.now() - k.firstSeenAt.getTime()) / 86400000)),
    observationCount: Number(obsCount),
    sourceBreakdown: breakdown.map((b) => ({ type: b.type, count: Number(b.count) })),
    recentObservations: recent.map((r) => ({ at: r.at.toISOString(), sourceType: r.sourceType, title: r.title, origin: r.origin })),
    pageVisits,
    factsAggregate: aggregateFacts(factRows.map((r) => r.facts)),
  }
}

/** 업체 단위 facts 집계 — 아티클 렌더러(article.ts)의 유일한 데이터 계약.
 *  BLUEPRINT §3-4: 원문 그대로·가공 통계 금지. 전화·계좌는 factlib이 원천 배제. */
export type FactsAggregate = {
  methodCounts: { tag: string; count: number }[]                 // 빈도 내림차순
  infraByType: { type: string; values: string[]; count: number }[] // 유형 고정 순서, 값 중복 제거(소문자 키)·첫 표기 유지, count=원 언급 횟수
  amounts: string[]                                              // 원문 문자열 그대로, 중복 제거, 등장 순서
  factCount: number                                              // 비어 있지 않은 facts 보유 관측 수
}

const INFRA_ORDER = ['telegram', 'kakao', 'site', 'app', 'bank', 'wallet', 'company']

export function aggregateFacts(list: (Partial<ObsFacts> | null | undefined)[]): FactsAggregate | null {
  const methods = new Map<string, number>()
  const infra = new Map<string, { values: string[]; seen: Set<string>; count: number }>()
  const amounts: string[] = []
  const amountSeen = new Set<string>()
  let factCount = 0

  for (const f of list) {
    if (!f) continue
    const m = f.method ?? [], i = f.infra ?? [], a = f.amounts ?? []
    if (!m.length && !i.length && !a.length) continue
    factCount++
    for (const tag of m) {
      if (typeof tag !== 'string' || !tag.trim()) continue
      methods.set(tag, (methods.get(tag) ?? 0) + 1)
    }
    for (const { type, value } of i) {
      if (!value || typeof value !== 'string') continue
      const vt = value.trim()
      if (!vt) continue
      const g = infra.get(type) ?? { values: [], seen: new Set<string>(), count: 0 }
      g.count++
      const key = vt.toLowerCase()
      if (!g.seen.has(key)) { g.seen.add(key); g.values.push(vt) }
      infra.set(type, g)
    }
    for (const amt of a) {
      if (typeof amt !== 'string') continue
      const key = amt.trim()
      if (key && !amountSeen.has(key)) { amountSeen.add(key); amounts.push(key) }
    }
  }
  if (factCount === 0) return null

  const order = (t: string) => { const i = INFRA_ORDER.indexOf(t); return i === -1 ? INFRA_ORDER.length : i }
  return {
    methodCounts: [...methods].map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    infraByType: [...infra].map(([type, g]) => ({ type, values: g.values, count: g.count }))
      .sort((a, b) => order(a.type) - order(b.type)),
    amounts,
    factCount,
  }
}
