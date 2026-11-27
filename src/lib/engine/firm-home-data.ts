import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'

export type FirmHomeSignal = {
  name: string
  slug: string
  scamType: string
  observationCount: number
}

export type FirmHomeSignals = {
  caseCount: number
  trackedCaseCount: number
  observationCount: number
  livePageCount: number
  recent: FirmHomeSignal[]
}

export const EMPTY_FIRM_HOME_SIGNALS: FirmHomeSignals = {
  caseCount: 0,
  trackedCaseCount: 0,
  observationCount: 0,
  livePageCount: 0,
  recent: [],
}

/** 피해자 센터 공개 수치의 정본: 중앙 DB 사건과 실제 관측 연결 여부를 그대로 센다. */
export async function centralCaseTrackingCounts(db: Db): Promise<Pick<FirmHomeSignals, 'caseCount' | 'trackedCaseCount'>> {
  const result = await db.execute(sql`
    select
      count(*) filter (where k.status <> 'blocked')::int as case_count,
      count(*) filter (
        where k.status <> 'blocked'
          and exists (select 1 from observations o where o.keyword_id = k.id)
      )::int as tracked_case_count
    from keywords k
  `)
  const row = result.rows[0] as { case_count?: number | string; tracked_case_count?: number | string } | undefined
  return {
    caseCount: Number(row?.case_count ?? 0),
    trackedCaseCount: Number(row?.tracked_case_count ?? 0),
  }
}

/** 고객에게 배정된 사건과 자체 관측 건수만 집계한다. 수집처 정보는 공개 홈으로 내리지 않는다. */
export async function firmHomeSignals(db: Db, firmId: number): Promise<FirmHomeSignals> {
  const result = await db.execute(sql`
    with scoped as (
      select
        k.id,
        k.name,
        k.slug,
        k.scam_type,
        k.status,
        count(o.id)::int as observation_count,
        max(o.observed_at) as last_observed_at
      from firm_keywords fk
      join keywords k on k.id = fk.keyword_id
      left join observations o on o.keyword_id = k.id
      where fk.firm_id = ${firmId}
        and fk.archived_at is null
      group by k.id, k.name, k.slug, k.scam_type, k.status
    ), totals as (
      select
        count(*)::int as case_count,
        count(*) filter (where observation_count > 0)::int as tracked_case_count,
        coalesce(sum(observation_count), 0)::int as observation_count,
        count(*) filter (
          where status in ('verified', 'generated', 'published', 'ad_registered', 'live')
        )::int as live_page_count
      from scoped
    ), recent as (
      select coalesce(json_agg(json_build_object(
        'name', name,
        'slug', slug,
        'scamType', scam_type,
        'observationCount', observation_count
      ) order by last_observed_at desc nulls last), '[]'::json) as rows
      from (
        select name, slug, scam_type, observation_count, last_observed_at
        from scoped
        where observation_count > 0
        order by last_observed_at desc nulls last
        limit 6
      ) latest
    )
    select totals.case_count, totals.tracked_case_count, totals.observation_count, totals.live_page_count, recent.rows
    from totals cross join recent
  `)

  const row = result.rows[0] as {
    case_count?: number | string
    tracked_case_count?: number | string
    observation_count?: number | string
    live_page_count?: number | string
    rows?: unknown
  } | undefined
  if (!row) return EMPTY_FIRM_HOME_SIGNALS

  const recent = Array.isArray(row.rows) ? row.rows : []
  return {
    caseCount: Number(row.case_count ?? 0),
    trackedCaseCount: Number(row.tracked_case_count ?? 0),
    observationCount: Number(row.observation_count ?? 0),
    livePageCount: Number(row.live_page_count ?? 0),
    recent: recent.flatMap((item): FirmHomeSignal[] => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      if (typeof value.name !== 'string' || typeof value.slug !== 'string') return []
      return [{
        name: value.name,
        slug: value.slug,
        scamType: typeof value.scamType === 'string' ? value.scamType : '사건정보',
        observationCount: Number(value.observationCount ?? 0),
      }]
    }),
  }
}
