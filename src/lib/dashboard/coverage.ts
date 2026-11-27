import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import type { Firm } from '@/lib/engine/firms'
import type { ObsFacts } from '@/lib/db/schema'

export type CoverageData = {
  stages: {
    keywords: { discovered: number; verified: number; generated: number; published: number }
    pipeline: {
      pending: number; adPending: number; excluded: number
      adRegistered: number; live: number; rejected: number
    }
    // pending = published인데 이 firm의 firm_keywords 행이 없는 수("등록 예정")
    // adPending = 행 status가 subscribed|paused|ad_pending(광고 등록 전 단계 묶음)이면서
    //   subscribed∧ad_desired=false(아래 excluded)는 제외한 수 — Task 5 fix wave에서 같은 화면
    //   테이블 배지(keywords/page.tsx badgeLabel)가 이 조합을 "제외됨(내림)"으로 이미 분기했는데
    //   이 타일 집계만 남아 있으면 타일 합계와 배지 개수가 어긋난다(ads.ts statusCounts의
    //   'excluded' 분리와 동일 조합·동일 어휘 — 두 화면이 다른 말을 하면 안 된다).
    // excluded = subscribed∧ad_desired=false — registration-plan.ts의 adDesired 필터로 등록
    //   후보에서 영구 제외된 행(고객이 파이프라인 시작 전에 이미 "내리기"를 누른 경우)
  }
  entries: {
    id: string; slug: string; name: string; scamType: string; obsCount: number
    adStage: string | null // 이 firm의 firm_keywords.status 원값, 행 없으면 null
    naverAdgroupId: string | null // 이 firm의 firm_keywords.naver_adgroup_id 원값, 행 없으면 null
  }[] // published 전체(관측 0건 포함) — 유형 필터 파생·stages 집계용. order by name, scamType 필터는 opts
  weekly: { week: string; n: number }[] // 최근 12주 전역 관측(개요와 동일 계약)
  detailed: CoverageDetailedEntry[] // published ∧ obsCount>0만 — 어드민 "게시 중 테이블" 미러(스펙 B-2 보강)
}

// 관측 1건의 원형(그룹핑 이전) — groupObservations() 입력 행 형태를 어셈블 로직 안에서만 쓴다.
export type RawObservation = {
  observedAt: string // ISO
  sourceType: string | null
  title: string | null
  sourceUrl: string | null
  facts: ObsFacts | null
}

// 도배(동일 제보 반복 게시) 묶음 결과 — 관측 상세 표 1행 = 그룹 1개(스펙: 2026-08-04 도배 묶음).
// count===1이면 그 관측 그대로(오늘과 동일 렌더), count>1이면 원문 그대로의 대표 제목(최신)에
// "반복 ×N" 배지 + 기간(observedFirst~observedLast)을 페이지가 붙인다. facts는 그룹 내 최신
// non-null 값 — title/sourceUrl(단순 "최신")과 달리 종종 null이라 그렇게 하지 않으면 중간에
// 사실이 비어 있는 최신 관측이 대표가 될 때 사실이 조용히 사라진다.
export type CoverageObservationGroup = {
  sourceType: string | null
  title: string | null // 대표 = 그룹 내 최신 관측의 원문 제목 그대로(재가공 없음)
  sourceUrl: string | null // 대표 = 그룹 내 최신 관측의 원문 링크 그대로
  facts: ObsFacts | null // 그룹 내 최신 non-null facts(없으면 null)
  count: number
  observedFirst: string // ISO, 그룹 내 최소 observed_at
  observedLast: string // ISO, 그룹 내 최대 observed_at
}

// 업체 dossier 집계 — 어드민 dossier() 로직 포팅(수법 빈도·인프라 유니크·금액 유니크)
export type CoverageDossier = {
  methodCounts: { method: string; count: number }[] // count desc
  infra: { type: string; value: string }[] // type:value 유니크
  amounts: string[] // 유니크, 원문 그대로(집계·단정 금지)
}

export type CoverageDetailedEntry = {
  id: string; slug: string; name: string; scamType: string
  adStage: string | null
  // firm_keywords.naver_adgroup_id 원값(행 없으면 null) — 최종 리뷰 I4(b): keywords/page.tsx의
  // pendingBadgeLabel이 paused∧desired=true∧이 값 없음 조합을 "올림(반영 대기)" 오표시에서
  // 제외하려면 이 값이 필요하다(reconcileAds는 naverAdgroupId 없는 행을 영원히 skip하므로 —
  // src/lib/engine/reconcile-ads.ts).
  naverAdgroupId: string | null
  obsCount: number
  firstSeenAt: string // ISO, 관측 중 최소 observed_at
  lastSeenAt: string // ISO, 관측 중 최대 observed_at
  weekly: { week: string; n: number }[] // 고정 12버킷(스파스 아님, 0채움) — 스파크바용
  score: number // obsCount + recent14d*2 (어드민 동일 공식)
  momentum: { direction: 'up' | 'down' | 'flat'; recent: number } // recent = 최근14일 관측수
  funnel: { pv: number; call: number; kakao: number; form: number; cvr: number | null } // firm 스코프
  // 도배 묶음 결과, observedLast desc — obsCount(원본 관측 총량)와는 다르다:
  // observations.length = 고유 그룹 수("고유 M"), obsCount = 원본 총건수.
  observations: CoverageObservationGroup[]
  // dossier/score/momentum/weekly는 전부 원본(그룹핑 이전) 관측 기준 — 반복 자체가 신호(같은
  // 제보가 매일 재게시된다는 사실)이므로 묶지 않는다.
  dossier: CoverageDossier
}

const ENTRY_WEEK_WINDOW = 12
const DAY_MS = 86_400_000

// ISO 8601 주 키(연-주) — app/d/[token]/keywords/page.tsx isoWeekKey와 동일 알고리즘(UTC 기준),
// data.ts/coverage.ts의 SQL to_char(observed_at at time zone 'UTC', 'IYYY-IW')와도 정합. 여기서는
// per-entry 12버킷을 JS에서 조립해야 해서(단일 풀스캔 쿼리 결과 재사용, 성능 노트 참조) 세 번째
// 로컬 사본을 둔다 — 각 파일이 자기 계약(렌더링 vs 어셈블) 안에서 독립적으로 정확하면 충분하다.
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7 // 월=0 … 일=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // 이 주의 목요일(ISO 연도 판정 기준일)
  const isoYear = date.getUTCFullYear()
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const jan4Day = (jan4.getUTCDay() + 6) % 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day)
  const week = Math.floor((date.getTime() - week1Monday.getTime()) / 604_800_000) + 1
  return `${isoYear}-${String(week).padStart(2, '0')}`
}

// 고정 12주 축(오래된→최신)에 관측 ms 타임스탬프를 0채움 집계 — 어드민 spark()의 고정폭판.
function entryWeeklyBuckets(msList: number[], now: number): { week: string; n: number }[] {
  const counts = new Map<string, number>()
  for (const ms of msList) {
    if (now - ms <= ENTRY_WEEK_WINDOW * 7 * DAY_MS) {
      const w = isoWeekKey(new Date(ms))
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
  }
  const out: { week: string; n: number }[] = []
  for (let i = ENTRY_WEEK_WINDOW - 1; i >= 0; i--) {
    const key = isoWeekKey(new Date(now - i * 7 * DAY_MS))
    out.push({ week: key, n: counts.get(key) ?? 0 })
  }
  return out
}

// 어드민 momentum()/rows() 스코어 공식 포팅: recent = (0,14]일 관측수, prev = (14,28]일 관측수.
// score = 전체 관측수 + recent*2. direction은 recent vs prev 비교(경계값 == 이면 flat).
function momentumAndScore(msList: number[], now: number): { recent: number; direction: 'up' | 'down' | 'flat'; score: number } {
  let recent = 0
  let prev = 0
  for (const ms of msList) {
    const days = (now - ms) / DAY_MS
    if (days > 0 && days <= 14) recent++
    else if (days > 14 && days <= 28) prev++
  }
  const direction = recent > prev ? 'up' : recent < prev ? 'down' : 'flat'
  return { recent, direction, score: msList.length + recent * 2 }
}

// 어드민 dossier() 로직 포팅 — 수법 빈도(desc)·인프라 유니크(type:value)·금액 유니크.
function buildDossier(factsList: (ObsFacts | null)[]): CoverageDossier {
  const methodCounts = new Map<string, number>()
  const infraMap = new Map<string, { type: string; value: string }>()
  const amountsSet = new Set<string>()
  for (const f of factsList) {
    if (!f) continue
    for (const m of f.method ?? []) methodCounts.set(m, (methodCounts.get(m) ?? 0) + 1)
    for (const i of f.infra ?? []) infraMap.set(`${i.type}:${i.value}`, i)
    for (const a of f.amounts ?? []) amountsSet.add(a)
  }
  return {
    methodCounts: [...methodCounts.entries()].sort((a, b) => b[1] - a[1]).map(([method, count]) => ({ method, count })),
    infra: [...infraMap.values()],
    amounts: [...amountsSet],
  }
}

// 도배 그룹 키 정규화 — 실제 도메인/URL 형태의 토큰만 제거·공백 정리·소문자화. null/빈 제목은
// 일관되게 ''(distinct empty key)로 취급 — 그래야 "제목 없음" 관측끼리도 한 그룹으로 묶인다.
// "mock-index .com"처럼 스페이스가 도메인 접미사 앞에 끼어든 변형은 먼저 재결합해서 하나의
// 토큰으로 만든 다음 필터링한다. 단순히 점이 있다는 이유로 제거하면 `1.5억원`과 `2.5억원`처럼
// 서로 다른 사실까지 같은 제목으로 오병합되므로, ASCII 호스트+TLD 구조만 URL로 판정한다.
export function normalizeObservationTitle(title: string | null): string {
  if (!title) return ''
  const rejoined = title.replace(/(\S)\s+(\.[a-z]{2,10}(?:[\w./-]*)?)/gi, '$1$2')
  const domainToken = /^(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:[/:?#][^\s]*)?$/i
  const kept = rejoined.split(/\s+/).filter((token) => {
    if (!token) return false
    const candidate = token.replace(/^[([{<'"]+|[\])}>,;'".!?]+$/g, '')
    return !domainToken.test(candidate)
  })
  return kept.join(' ').trim().toLowerCase()
}

// 그룹 키 구분자 — sourceType(고정 enum: community|news|report|sns|etc|null)과 정규화 제목을
// 이어붙일 때 우연히 다른 (sourceType, title) 조합이 같은 문자열로 합쳐지는 걸 막는다. 제목에
// 실질적으로 등장하지 않을 구분자를 명시적으로 눈에 보이는 문자로 쓴다(비가시 제어문자 금지 —
// 소스에 섞이면 편집기·diff에서 안 보이는 바이트가 남는다).
const GROUP_KEY_SEP = '###'

// 도배(동일 제보 반복 게시) 묶음 — 그룹 키는 (sourceType, 정규화 제목). 입력은 keyword 1개의
// 관측 전량(순서 무관 — 함수 내부에서 desc로 재정렬해 "대표=최신" 규칙을 스스로 보장한다,
// 독립 테스트 용이성 때문). dossier/score/momentum/weekly 계산에는 쓰이지 않는다(원본 그대로 유지).
export function groupObservations(rows: RawObservation[]): CoverageObservationGroup[] {
  const sorted = [...rows].sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())
  const order: string[] = []
  const groups = new Map<string, {
    sourceType: string | null; title: string | null; sourceUrl: string | null
    facts: ObsFacts | null; count: number; firstMs: number; lastMs: number
  }>()
  for (const r of sorted) {
    const ms = new Date(r.observedAt).getTime()
    const key = `${r.sourceType ?? ''}${GROUP_KEY_SEP}${normalizeObservationTitle(r.title)}`
    let g = groups.get(key)
    if (!g) {
      // sorted가 desc이므로 이 그룹을 "처음 만나는" 시점의 행이 그룹 내 최신 — title/sourceUrl은
      // 이 값을 그대로 대표로 쓴다(재가공 없음 — 컴플라이언스: 원문 그대로 인용).
      g = { sourceType: r.sourceType, title: r.title, sourceUrl: r.sourceUrl, facts: r.facts, count: 0, firstMs: ms, lastMs: ms }
      groups.set(key, g)
      order.push(key)
    }
    g.count++
    if (ms < g.firstMs) g.firstMs = ms
    if (ms > g.lastMs) g.lastMs = ms
    if (!g.facts && r.facts) g.facts = r.facts // 그룹 내 "최신 non-null" facts — desc 순회라 먼저 찾는 쪽이 최신
  }
  return order
    .map((key) => groups.get(key)!)
    .map((g): CoverageObservationGroup => ({
      sourceType: g.sourceType,
      title: g.title,
      sourceUrl: g.sourceUrl,
      facts: g.facts,
      count: g.count,
      observedFirst: new Date(g.firstMs).toISOString(),
      observedLast: new Date(g.lastMs).toISOString(),
    }))
    .sort((a, b) => new Date(b.observedLast).getTime() - new Date(a.observedLast).getTime())
}

/**
 * 유형 필터 내비 파생 전용 경량 쿼리 — published 키워드의 scam_type distinct 목록만 가져온다.
 * 리뷰 반영: 이전에는 페이지가 이 목록을 얻으려고 무필터 coverageData() 전체(관측 풀스캔+조립
 * 포함, B-2 이후 무거워짐)를 매 로드 한 번 더 실행했다 — scamType 필터 유무와 무관하게
 * coverageData()가 1회만 돌도록 이 함수로 분리했다.
 */
export async function publishedScamTypes(db: Db): Promise<string[]> {
  const rows = await db.execute(sql`
    select distinct scam_type
    from keywords
    where status = 'published'
    order by 1
  `)
  return (rows.rows as { scam_type: string }[]).map((r) => r.scam_type)
}

/**
 * 어드민 미러 커버리지 어셈블러 — 사건명(키워드) 상태머신·게시 테이블(상세 dossier 포함)·주간 추이 3섹션.
 * stages.keywords는 keywords.status의 discovered/verified/generated/published 전역 집계
 * (blocked 등 그 외 상태는 어느 단계에도 집계 안 함). stages.pipeline은 published 키워드를
 * 이 firm의 firm_keywords 행에 firm 스코프 left join해 산출 — 타 firm 행은 새지 않는다.
 *
 * B-2 보강(2026-08-03): detailed는 어드민 "게시 중 URL" 테이블의 DB-라이브판(스펙 §B-2 보강).
 * 성능 계약 — 1,077개 키워드 규모에서 per-keyword 쿼리 금지:
 *   1) obsRows: published(+scamType 필터) 키워드의 관측 전체를 단일 풀스캔으로 가져와 keyword_id로
 *      그룹핑 — obsCount·first/lastSeenAt·주간버킷·모멘텀/스코어·관측 상세·dossier를 전부 이 결과
 *      하나로 JS에서 파생한다(추가 집계 쿼리 없음).
 *   2) events/leads는 firm_id로만 그룹핑해 slug별 맵으로 한 번에 가져오고, 각 항목에서
 *      `f/${slug}` 키로 조회한다(app/f/[slug] 랜딩 트래킹 스크립트가 이 slug 포맷으로 기록 —
 *      src/templates/fraud-cinema.ts의 track 호출부에서 확인).
 * 응답 크기(전체 관측 facts/title/url 포함)는 어드민과 동일하게 크다 — 후속 최적화로 이연(스펙 명시).
 *
 * 도배 묶음(2026-08-04): 관측 상세(observations)는 (sourceType, 정규화 제목) 그룹으로 묶어
 * 내려준다 — 동일 제보가 매일 재게시되며 관측 목록을 도배하는 사례(예: 132건이 사실상 같은
 * 제보의 URL 표기 변형) 대응. obsCount/score/momentum/weekly/dossier는 원본(그룹핑 이전) 관측
 * 기준으로 그대로 유지 — 반복 자체가 신호이므로 그쪽 집계는 묶지 않는다.
 */
export async function coverageData(
  db: Db,
  firm: Firm,
  opts?: { scamType?: string },
): Promise<CoverageData> {
  const kwStatusRows = await db.execute(sql`
    select status, count(*)::int as n
    from keywords
    group by status
  `)
  const kwStatusMap = new Map(
    (kwStatusRows.rows as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  )
  const stagesKeywords = {
    discovered: kwStatusMap.get('discovered') ?? 0,
    verified: kwStatusMap.get('verified') ?? 0,
    generated: kwStatusMap.get('generated') ?? 0,
    published: kwStatusMap.get('published') ?? 0,
  }

  const pipelineRow = await db.execute(sql`
    select
      count(*) filter (where fk.id is null)::int as pending,
      count(*) filter (
        where fk.status in ('subscribed', 'paused', 'ad_pending')
          and not (fk.status = 'subscribed' and fk.ad_desired = false)
      )::int as ad_pending,
      count(*) filter (where fk.status = 'subscribed' and fk.ad_desired = false)::int as excluded,
      count(*) filter (where fk.status = 'ad_registered')::int as ad_registered,
      count(*) filter (where fk.status = 'live')::int as live,
      count(*) filter (where fk.status = 'rejected')::int as rejected
    from keywords k
    left join firm_keywords fk on fk.keyword_id = k.id and fk.firm_id = ${firm.id}
    where k.status = 'published'
  `)
  const pipeline = pipelineRow.rows[0] as {
    pending: number; ad_pending: number; excluded: number
    ad_registered: number; live: number; rejected: number
  }

  const entryRows = await db.execute(sql`
    select
      k.id as id,
      k.slug as slug,
      k.name as name,
      k.scam_type as scam_type,
      count(o.id)::int as obs_count,
      fk.status as ad_stage,
      fk.naver_adgroup_id as naver_adgroup_id
    from keywords k
    left join observations o on o.keyword_id = k.id
    left join firm_keywords fk on fk.keyword_id = k.id and fk.firm_id = ${firm.id}
    where k.status = 'published'
      ${opts?.scamType ? sql`and k.scam_type = ${opts.scamType}` : sql``}
    group by k.id, k.slug, k.name, k.scam_type, fk.status, fk.naver_adgroup_id
    order by k.name
  `)
  const entries = (entryRows.rows as {
    id: string; slug: string; name: string; scam_type: string; obs_count: number
    ad_stage: string | null; naver_adgroup_id: string | null
  }[]).map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    scamType: r.scam_type,
    obsCount: r.obs_count,
    adStage: r.ad_stage,
    naverAdgroupId: r.naver_adgroup_id,
  }))

  // 최근 12주 — 주 키는 ISO 주. overviewData의 weeklyObs와 동일 계약(전역, firm 무관).
  const weeklyRows = await db.execute(sql`
    select to_char(observed_at at time zone 'UTC', 'IYYY-IW') as week, count(*)::int as n
    from observations
    where observed_at >= now() - interval '12 weeks'
    group by 1
    order by 1
  `)
  const weekly = (weeklyRows.rows as { week: string; n: number }[]).map((r) => ({ week: r.week, n: r.n }))

  // ── B-2 보강: published(+scamType 필터) 키워드의 관측 전체 — keyword_id로 그룹핑해
  // obsCount/first-last/주간버킷/모멘텀·스코어/관측상세/dossier를 전부 이 결과에서 파생한다.
  const obsRows = await db.execute(sql`
    select
      o.keyword_id as keyword_id,
      o.observed_at as observed_at,
      o.source_type as source_type,
      o.title as title,
      o.source_url as source_url,
      o.facts as facts
    from observations o
    join keywords k on k.id = o.keyword_id
    where k.status = 'published'
      ${opts?.scamType ? sql`and k.scam_type = ${opts.scamType}` : sql``}
    order by o.keyword_id, o.observed_at desc
  `)
  type ObsRow = {
    keyword_id: string; observed_at: string | Date; source_type: string | null
    title: string | null; source_url: string | null; facts: ObsFacts | null
  }
  const obsByKeyword = new Map<string, ObsRow[]>()
  for (const r of obsRows.rows as ObsRow[]) {
    const arr = obsByKeyword.get(r.keyword_id) ?? []
    arr.push(r)
    obsByKeyword.set(r.keyword_id, arr)
  }

  // firm 스코프 events/leads — slug별 그룹핑 1회 쿼리(퍼널 컬럼용). slug 포맷은 `f/${keywords.slug}`
  // (src/templates/fraud-cinema.ts 트래킹 스크립트 확인 — 어드민 route.ts의 `ev[`f/${slug}`]`와 동일 계약).
  const evRows = await db.execute(sql`
    select slug, type, count(*)::int as n
    from events
    where firm_id = ${firm.id} and slug is not null
    group by slug, type
  `)
  const evBySlug = new Map<string, Record<string, number>>()
  for (const r of evRows.rows as { slug: string; type: string; n: number }[]) {
    const m = evBySlug.get(r.slug) ?? {}
    m[r.type] = r.n
    evBySlug.set(r.slug, m)
  }
  const leadRows = await db.execute(sql`
    select slug, count(*)::int as n
    from leads
    where firm_id = ${firm.id} and slug is not null
    group by slug
  `)
  const formBySlug = new Map<string, number>()
  for (const r of leadRows.rows as { slug: string; n: number }[]) formBySlug.set(r.slug, r.n)

  const now = Date.now()
  const detailed: CoverageDetailedEntry[] = entries
    .filter((e) => e.obsCount > 0)
    .map((e): CoverageDetailedEntry => {
      const rows = obsByKeyword.get(e.id) ?? []
      const msList = rows.map((r) => new Date(r.observed_at).getTime())
      const { recent, direction, score } = momentumAndScore(msList, now)
      const weeklyBuckets = entryWeeklyBuckets(msList, now)
      const dossier = buildDossier(rows.map((r) => r.facts))
      const observations = groupObservations(rows.map((r): RawObservation => ({
        observedAt: new Date(r.observed_at).toISOString(),
        sourceType: r.source_type,
        title: r.title,
        sourceUrl: r.source_url,
        facts: r.facts,
      })))
      const funnelSlug = `f/${e.slug}`
      const ev = evBySlug.get(funnelSlug) ?? {}
      const pv = ev.page_view ?? 0
      // 어드민 funnel()과 동일 시맨틱 — prefixed(`f/{slug}`) + bare(`{slug}`) 키를 **합산**한다(폴백
      // 아님). fraud-cinema 리드 제출 스크립트는 pathname 매칭 실패 시 bare slug로도 저장할 수 있어
      // 과거 리드가 bare 포맷으로 남아 있을 수 있다 — 둘 다 세지 않으면 "문의"·전환율이 조용히 낮게 잡힌다.
      const form = (formBySlug.get(funnelSlug) ?? 0) + (formBySlug.get(e.slug) ?? 0)
      return {
        id: e.id,
        slug: e.slug,
        name: e.name,
        scamType: e.scamType,
        adStage: e.adStage,
        naverAdgroupId: e.naverAdgroupId,
        obsCount: e.obsCount,
        firstSeenAt: msList.length ? new Date(Math.min(...msList)).toISOString() : '',
        lastSeenAt: msList.length ? new Date(Math.max(...msList)).toISOString() : '',
        weekly: weeklyBuckets,
        score,
        momentum: { direction, recent },
        funnel: { pv, call: ev.call_click ?? 0, kakao: ev.kakao_click ?? 0, form, cvr: pv ? form / pv : null },
        observations,
        dossier,
      }
    })
    .sort((a, b) => b.obsCount - a.obsCount) // 정렬: 관측수 desc(어드민 동일)

  return {
    stages: {
      keywords: stagesKeywords,
      pipeline: {
        pending: pipeline.pending,
        adPending: pipeline.ad_pending,
        excluded: pipeline.excluded,
        adRegistered: pipeline.ad_registered,
        live: pipeline.live,
        rejected: pipeline.rejected,
      },
    },
    entries,
    weekly,
    detailed,
  }
}
