import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import type { Firm } from '@/lib/engine/firms'
import { buildRegistrationPlan, type RegistrationPlan } from '@/lib/engine/registration-plan'
import { firmCredentials, firmKeywords, type FirmAdConfig } from '@/lib/db/schema'

export type AdEntityRow = {
  entityType: string
  reviewStatus: string
  rejectReason: string | null
  keywordSlug: string | null
}

// 네이버 광고 통합(task-5) — 자격증명 보유 상태. api_key_enc·secret_enc는 이 타입에도, 이 타입을
// 만드는 쿼리(credStatusForFirm)의 select 목록에도 절대 없다(브리프 보안 불변식 — 시크릿 관련
// 컬럼은 select 자체에서 제외).
export type CredStatus = {
  has: boolean
  customerIdTail: string | null // customerId 끝 4자리만(원문 전체 미노출)
  verifiedAt: Date | null
}

export type AdsData = {
  // firm_keywords.status별 집계 — 단, subscribed∧adDesired=false 조합은 실제 status 값
  // 'subscribed' 대신 합성 키 'excluded'로 센다(최종 리뷰 I4(a), adsData 본문 주석 참조). 그 외
  // 키는 firm_keywords.status 원값 그대로.
  statusCounts: Record<string, number>
  entities: AdEntityRow[]
  plan: RegistrationPlan | null
  planError: string | null
  // 리뷰 반영(F1) — plan.items는 PLAN_PREVIEW_LIMIT로 잘려 있어 "몇 건 중 몇 건을 보여주는지"를
  // 화면이 판단할 근거가 없으면 자르기가 조용히 일어난다. buildRegistrationPlan과 동일한 선별
  // 조건(firm_keywords.status='subscribed' ∧ keywords.status='published')으로 한도 없이 센
  // 전체 후보 수 — plan이 null(도메인 미설정 등)이어도 0으로 채워 항상 존재한다.
  planEligibleCount: number
  // 네이버 광고 통합(task-5-brief §A1·A3) — 자격증명 카드가 그리는 상태.
  credStatus: CredStatus
  // firm.adConfig는 firm row(resolveFirmByToken)에 이미 로드돼 있으므로 재조회 없이 그대로
  // 통과한다 — 설정 카드(현재값) + 채널 상태(channelOk) 렌더 소스.
  adConfig: FirmAdConfig | null
  // 사건명별 올리기/내리기 의사(adDesired) 집계 — statusCounts와 동일 조인 스코프
  // (firm_keywords ⋈ keywords.status='published')라야 탭 간 집계가 어긋나지 않는다(F3 관행 계승).
  desiredCounts: { on: number; off: number }
}

// "등록 예정 미리보기" 카드 개수 상한 — buildRegistrationPlan 기본 limit(20, 실행기 배치 크기)과
// 무관한 화면 전용 값이다. 미리보기는 전량을 보여줄 필요가 없고(스크롤 폭주 방지), 실제 등록
// 한도를 여기서 재정의하지도 않는다. 대신 planEligibleCount로 실제 후보 수를 함께 내려 화면이
// "전체 N건 중 X건 표시" 캡션을 붙일 수 있게 한다(리뷰 반영 F1 — 자르기가 조용히 일어나면 안 됨).
const PLAN_PREVIEW_LIMIT = 10

// 리뷰 반영(F2) — buildRegistrationPlan은 domain 미설정 firm에 한해 이 메시지 패턴으로 throw한다
// (src/lib/engine/registration-plan.ts). 그 계약 자체는 건드리지 않고, 여기서는 메시지만으로
// "도메인 미설정" 케이스와 그 외 예외(예: 일시적 DB 오류)를 구분한다 — 화면이 모든 실패를 "도메인
// 연결" 안내로 뭉개면, 진짜 일시 오류를 겪는 고객에게 엉뚱한 조치를 안내하게 된다.
const DOMAIN_MISSING_PATTERN = /domain 미설정/

export function isDomainMissingError(message: string): boolean {
  return DOMAIN_MISSING_PATTERN.test(message)
}

// ad-settings.ts의 PROVIDER 상수와 동일 값(리터럴 중복 — 그쪽은 export하지 않고, 여기는 이 파일
// 스코프의 Task 5 전용 조회라 별도 상수로 둔다).
const PROVIDER = 'naver_searchad' as const

/**
 * credStatusForFirm — 자격증명 보유 상태만 조회(브리프 보안 불변식: api_key_enc·secret_enc는
 * select 목록 자체에 없다 — 조회 자체가 불가능하니 응답에 실릴 수도 없다). adsData의 credStatus
 * 필드와 keywords/page.tsx의 올리기/내리기 버튼 게이팅(자격증명 미보유 시 버튼 대신 안내 배지)이
 * 공유하는 단일 소스.
 */
export async function credStatusForFirm(db: Db, firm: Firm): Promise<CredStatus> {
  const rows = await db
    .select({ customerId: firmCredentials.customerId, verifiedAt: firmCredentials.verifiedAt })
    .from(firmCredentials)
    .where(and(eq(firmCredentials.firmId, firm.id), eq(firmCredentials.provider, PROVIDER)))
    .limit(1)
  if (!rows.length) return { has: false, customerIdTail: null, verifiedAt: null }
  return { has: true, customerIdTail: rows[0].customerId.slice(-4), verifiedAt: rows[0].verifiedAt }
}

/**
 * adDesiredMap — firm 스코프 firm_keywords 전체의 keywordId→adDesired 맵. keywords/page.tsx가
 * 행마다 개별 쿼리를 던지지 않고(1,000+행 규모) 사건명별 올리기/내리기 배지·버튼 상태를
 * 판단하도록 단일 쿼리로 내려준다 — publishedScamTypes(coverage.ts)와 같은 이유로 무거운
 * coverageData()를 건드리지 않고 경량 쿼리를 별도로 둔다.
 */
export async function adDesiredMap(db: Db, firm: Firm): Promise<Map<string, boolean>> {
  const rows = await db
    .select({ keywordId: firmKeywords.keywordId, adDesired: firmKeywords.adDesired })
    .from(firmKeywords)
    .where(eq(firmKeywords.firmId, firm.id))
  return new Map(rows.map((r) => [r.keywordId, r.adDesired]))
}

/**
 * 대시보드 광고 현황 어셈블러 — firm_keywords 파이프라인 상태 집계(statusCounts),
 * firm_ad_entities 심사 현황(entities), 그리고 buildRegistrationPlan의 dry-run 미리보기(plan)를
 * 한 화면에 모은다. 이 태스크는 읽기 전용 뷰라 여기서도 조회만 하고 아무것도 쓰지 않는다.
 *
 * statusCounts는 keywords.status='published' 조인 스코프 — 사건명 탭 파이프라인(coverage.ts)·
 * 개요 adPending(data.ts)과 동일 스코프여야 한다(리뷰 반영, 최종 전수검토 F3). 등록된 키워드가
 * 이후 중앙 blocklist로 blocked 처리되면(scripts/agent/sync-db.ts) 그 firm_keywords 행은 이 조인이
 * 없으면 광고 탭에만 계속 잡혀 탭 간 집계가 어긋난다.
 *
 * domain 없는 firm은 buildRegistrationPlan이 계획 생성 자체를 거부(throw)한다(등록 계획 F4 —
 * firm N의 광고비가 샘플투 도메인으로 새는 사고 경로 차단). 화면은 그 예외를 시스템 오류로 노출하는
 * 대신 "도메인 연결 후 활성화" 안내로 흡수해야 하므로 여기서 캐치해 plan: null + planError로 변환한다.
 */
export async function adsData(db: Db, firm: Firm): Promise<AdsData> {
  // subscribed∧adDesired=false는 registration-plan.ts의 adDesired 필터로 등록 후보에서 영구
  // 제외된다(고객이 파이프라인 시작 전에 이미 "내리기"를 누른 경우) — 다른 subscribed 행과
  // 같은 status 버킷('subscribed')에 묶으면 "등록 진행 중" 타일이 절대 진행되지 않을 행까지
  // 진행 중이라 말하게 된다(최종 리뷰 I4(a)). 그래서 이 조합만 status 대신 합성 키
  // 'excluded'로 분리해서 센다 — keywords/page.tsx badgeLabel의 '제외됨(내림)' 배지와
  // 동일 조합·동일 어휘(두 화면이 같은 사실에 다른 말을 하면 안 된다).
  const statusRows = await db.execute(sql`
    select
      (case when fk.status = 'subscribed' and fk.ad_desired = false then 'excluded' else fk.status end) as status,
      count(*)::int as n
    from firm_keywords fk
    join keywords k on k.id = fk.keyword_id and k.status = 'published'
    where fk.firm_id = ${firm.id}
    group by 1
  `)
  const statusCounts: Record<string, number> = {}
  for (const r of statusRows.rows as { status: string; n: number }[]) {
    statusCounts[r.status] = r.n
  }

  const entityRows = await db.execute(sql`
    select fae.entity_type as entity_type, fae.review_status as review_status,
           fae.reject_reason as reject_reason, k.slug as keyword_slug
    from firm_ad_entities fae
    left join keywords k on k.id = fae.keyword_id
    where fae.firm_id = ${firm.id}
    order by fae.created_at asc
  `)
  const entities = (entityRows.rows as {
    entity_type: string; review_status: string; reject_reason: string | null; keyword_slug: string | null
  }[]).map((r) => ({
    entityType: r.entity_type,
    reviewStatus: r.review_status,
    rejectReason: r.reject_reason,
    keywordSlug: r.keyword_slug,
  }))

  const eligibleRow = await db.execute(sql`
    select count(*)::int as n
    from firm_keywords fk
    join keywords k on k.id = fk.keyword_id
    where fk.firm_id = ${firm.id} and fk.status = 'subscribed' and k.status = 'published'
  `)
  const planEligibleCount = (eligibleRow.rows[0] as { n: number }).n

  let plan: RegistrationPlan | null = null
  let planError: string | null = null
  try {
    plan = await buildRegistrationPlan(db, firm, { limit: PLAN_PREVIEW_LIMIT })
  } catch (err) {
    planError = err instanceof Error ? err.message : String(err)
  }

  const credStatus = await credStatusForFirm(db, firm)

  // desiredCounts — statusCounts와 동일 조인 스코프(published 키워드만) 아니면 blocked 처리된
  // 키워드가 여기서만 계속 잡혀 탭 간 집계가 어긋난다(F3 관행 계승, 위 statusCounts 주석 참조).
  const desiredRows = await db.execute(sql`
    select fk.ad_desired as ad_desired, count(*)::int as n
    from firm_keywords fk
    join keywords k on k.id = fk.keyword_id and k.status = 'published'
    where fk.firm_id = ${firm.id}
    group by fk.ad_desired
  `)
  let desiredOn = 0
  let desiredOff = 0
  for (const r of desiredRows.rows as { ad_desired: boolean; n: number }[]) {
    if (r.ad_desired) desiredOn = r.n
    else desiredOff = r.n
  }

  return {
    statusCounts, entities, plan, planError, planEligibleCount,
    credStatus,
    adConfig: firm.adConfig, // firm row에 이미 로드된 값 — 재조회 없음
    desiredCounts: { on: desiredOn, off: desiredOff },
  }
}
