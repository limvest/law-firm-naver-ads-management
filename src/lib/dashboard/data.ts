import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import type { Firm } from '@/lib/engine/firms'

export type OverviewData = {
  totalKeywords: number
  publishedKeywords: number
  newToday: number
  obsTotal: number
  weeklyObs: { week: string; n: number }[]
  sourceMix: { sourceType: string; n: number }[]
  adPending: number
}

/**
 * 대시보드 개요 데이터 어셈블러. 수집 지표(keywords/observations)는 스펙 §0에 따라
 * **전역 실데이터**(firm 무관) — "엔진의 힘"을 보여주는 목적이라 firm별로 나누지 않는다.
 * adPending만 firm 스코프 — coverage.ts의 pipeline.adPending과 정확히 같은 집합
 * (firm_keywords.status in subscribed|paused|ad_pending ∧ keywords.status='published', 단
 * subscribed∧ad_desired=false는 제외 — coverage.ts pipeline.excluded와 동일 조합)이다.
 * 두 화면이 "등록 진행 중"이라는 같은 배지 어휘로 같은 수를 보여줘야 하므로(리뷰 반영 —
 * 컨트롤러 지적: 라벨은 공유하면서 집계 기준이 다르면 firm이 탭 간 숫자 불일치를 보게 된다),
 * 여기서 "구독 수만" 세던 기존 계산을 coverage.ts와 동일한 3-상태 합산 + published 조인으로 바꿨다.
 * subscribed∧ad_desired=false 제외(2026-08-04 fix wave)도 coverage.ts와 짝을 맞춘 것 — 이 조합은
 * registration-plan.ts의 adDesired 필터로 영구 제외되므로 "등록 진행 중"에 넣으면 안 된다.
 */
export async function overviewData(db: Db, firm: Firm): Promise<OverviewData> {
  const kwRow = await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where created_at::date = current_date)::int as new_today
    from keywords
  `)
  const kw = kwRow.rows[0] as { total: number; published: number; new_today: number }

  const obsTotalRow = await db.execute(sql`select count(*)::int as n from observations`)
  const obsTotal = (obsTotalRow.rows[0] as { n: number }).n

  // 최근 12주 — 주 키는 ISO 주(연도 경계 넘는 주도 정확히 구분). AT TIME ZONE 'UTC'로 세션
  // TimeZone 설정과 무관하게 고정 — 렌더링측(page.tsx)의 UTC 기준 12주 축 채움과 키를 맞춘다.
  const weeklyRows = await db.execute(sql`
    select to_char(observed_at at time zone 'UTC', 'IYYY-IW') as week, count(*)::int as n
    from observations
    where observed_at >= now() - interval '12 weeks'
    group by 1
    order by 1
  `)
  const weeklyObs = (weeklyRows.rows as { week: string; n: number }[]).map((r) => ({ week: r.week, n: r.n }))

  const sourceRows = await db.execute(sql`
    select coalesce(source_type, 'etc') as source_type, count(*)::int as n
    from observations
    group by 1
    order by n desc
  `)
  const sourceMix = (sourceRows.rows as { source_type: string; n: number }[]).map((r) => ({
    sourceType: r.source_type, n: r.n,
  }))

  const adPendingRow = await db.execute(sql`
    select count(*)::int as n
    from firm_keywords fk
    join keywords k on k.id = fk.keyword_id
    where fk.firm_id = ${firm.id}
      and fk.status in ('subscribed', 'paused', 'ad_pending')
      and not (fk.status = 'subscribed' and fk.ad_desired = false)
      and k.status = 'published'
  `)
  const adPending = (adPendingRow.rows[0] as { n: number }).n

  return {
    totalKeywords: kw.total,
    publishedKeywords: kw.published,
    newToday: kw.new_today,
    obsTotal,
    weeklyObs,
    sourceMix,
    adPending,
  }
}
