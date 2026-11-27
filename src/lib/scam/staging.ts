import store from '../../../data/keywords.json'
import type { ScamFacts } from './facts'
import { aggregateFacts } from './facts'

/**
 * 파일 스테이징(data/keywords.json) 기반 키워드·FACTS 해석 — DATABASE_URL 미연결 구간의 데이터 소스.
 * 데일리 에이전트(harvest→ingest)가 채우고, DB 연결 후에는 route가 DB를 우선하므로 자연 은퇴한다.
 * BLUEPRINT 상태머신 준수: blocked 차단, discovered 는 preview 요청에만 응답(게시 승인 게이트).
 */

type StagedObservation = { observedAt: string; sourceUrl: string; sourceType: string; title?: string; origin?: string; facts?: { method?: string[]; infra?: { type: string; value: string }[]; amounts?: string[] } | null }
type StagedKeyword = {
  name: string
  slug: string
  scamType: string
  aliases: string[]
  status: string
  firstSeenAt: string | null
  lastSeenAt: string | null
  observations: StagedObservation[]
}

const PUBLIC_STATUSES = new Set(['verified', 'generated', 'published', 'ad_registered', 'live'])

export function resolveStagingKeyword(
  slug: string,
  { preview = false }: { preview?: boolean } = {},
): { name: string; scamType: string; status: string; facts: ScamFacts | null } | null {
  const k = (store.keywords as StagedKeyword[]).find((x) => x.slug === slug)
  if (!k || k.status === 'blocked' || k.status === 'paused') return null
  if (!PUBLIC_STATUSES.has(k.status) && !preview) return null
  return { name: k.name, scamType: k.scamType, status: k.status, facts: computeFacts(k) }
}

function computeFacts(k: StagedKeyword): ScamFacts | null {
  if (!k.firstSeenAt || k.observations.length === 0) return null // 실측 없으면 F-FALL
  const byType = new Map<string, number>()
  for (const o of k.observations) {
    const t = o.sourceType || 'etc'
    byType.set(t, (byType.get(t) ?? 0) + 1)
  }
  const recent = [...k.observations]
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())
    .slice(0, 8)
  return {
    name: k.name,
    firstSeenAt: k.firstSeenAt,
    lastSeenAt: k.lastSeenAt,
    daysSince: Math.max(0, Math.floor((Date.now() - new Date(k.firstSeenAt).getTime()) / 86400000)),
    observationCount: k.observations.length,
    sourceBreakdown: [...byType].map(([type, count]) => ({ type, count })),
    recentObservations: recent.map((o) => ({ at: o.observedAt, sourceType: o.sourceType || null, title: o.title || null, origin: o.origin || null })),
    pageVisits: null, // events 는 DB 전용
    factsAggregate: aggregateFacts(k.observations.map((o) => o.facts)),
  }
}
