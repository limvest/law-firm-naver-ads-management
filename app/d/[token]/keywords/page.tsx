import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import { coverageData, publishedScamTypes, type CoverageDetailedEntry, type CoverageObservationGroup } from '@/lib/dashboard/coverage'
import { PIPELINE_OWNED, setAdDesired } from '@/lib/dashboard/actions'
import { adDesiredMap, credStatusForFirm } from '@/lib/dashboard/ads'
import type { ObsFacts } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '사건명',
  robots: { index: false, follow: false },
}

const WEEK_WINDOW = 12

// 운영자 화면과 같은 관측 형태·인프라 타입의 고객용 한글 라벨.
const TYPE_KO: Record<string, string> = { community: '커뮤니티', news: '뉴스', report: '제보/리포트', sns: 'SNS', etc: '기타' }
const INFRA_KO: Record<string, string> = { company: '업체', app: '앱', site: '사이트', telegram: '텔레그램', kakao: '카톡', bank: '은행', wallet: '지갑' }

// 고객 노출 배지 라벨(스펙 2026-08-03 §C) — 내부 firm_keywords.status(엔진 상태머신, null=행
// 없음)를 고객 어휘로 뭉친다. subscribed·paused·ad_pending은 "아직 확정 단계 전"으로 한
// 배지에 묶는다 — ad_pending은 PIPELINE_OWNED(actions.ts, CLI 소유 상태 집합)에 속하지만
// 고객에게는 ad_registered/live/rejected(확정 단계)와 구분해 보여준다.
const ADVANCED_LABEL: Record<string, string> = {
  ad_registered: '심사 중',
  live: '라이브',
  rejected: '보완 필요',
}

/**
 * badgeLabel — 최종 리뷰 I4(a): subscribed∧desired=false는 registration-plan.ts의 adDesired
 * 필터로 등록 후보에서 영구 제외된다(고객이 등록 파이프라인이 시작되기도 전에 "내리기"를 누른
 * 경우) — "등록 진행 중"이라고 계상하면 실제로는 절대 진행되지 않을 일을 진행 중이라 말하는
 * 셈이라 별도 라벨("제외됨(내림)")로 분기한다. ads/page.tsx buildStageEntries의 'excluded'
 * 버킷과 동일 어휘(같은 조합, 같은 이름 — 두 화면이 다른 말을 하면 안 된다).
 */
export function badgeLabel(adStage: string | null, desired: boolean | undefined): string {
  if (adStage === null) return '등록 예정'
  if (adStage === 'subscribed' && desired === false) return '제외됨(내림)'
  if (PIPELINE_OWNED.has(adStage) && adStage !== 'ad_pending') return ADVANCED_LABEL[adStage]
  return '등록 진행 중' // subscribed(desired=true) | paused | ad_pending
}

// 배지 색 — 등록 예정(중립) → 등록 진행 중(약한 강조) → 심사 중(강한 강조) → 라이브(단색 강조,
// 파이프라인의 완결 상태) 순으로 진행감을 주고, 보완 필요만 별도 경고색(ads/page.tsx의
// rejected 배색과 동일 어휘)을 쓴다. 제외됨(내림, I4(a))은 등록 예정과 동일한 중립색 —
// "진행 중"류 강조색을 주면 여전히 뭔가 진행되는 것처럼 보인다.
export function badgeStyle(adStage: string | null, desired: boolean | undefined): { background: string; color: string } {
  if (adStage === null) return { background: 'var(--t-line)', color: 'var(--t-sub)' }
  if (adStage === 'subscribed' && desired === false) return { background: 'var(--t-line)', color: 'var(--t-sub)' }
  if (adStage === 'live') return { background: 'var(--t-accent)', color: 'var(--t-bg)' }
  if (adStage === 'rejected') return { background: 'rgb(254 226 226)', color: 'rgb(220 38 38)' }
  if (adStage === 'ad_registered') {
    return { background: 'color-mix(in srgb, var(--t-accent) 18%, var(--t-surface))', color: 'var(--t-accent)' }
  }
  return { background: 'color-mix(in srgb, var(--t-accent) 10%, var(--t-surface))', color: 'var(--t-accent)' }
}

export default async function DashboardKeywordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ scamType?: string }>
}) {
  // 레이아웃과 동일 가드 — DB 미연결 시 조용히 빠진다(app/d/[token]/page.tsx와 동일 이유).
  if (!process.env.DATABASE_URL) return null

  const { token } = await params
  const { scamType } = await searchParams
  const db = getDb()
  // 레이아웃이 이미 토큰을 검증하지만 페이지는 firm 인스턴스를 독립적으로 필요로 한다(안전망 재검증).
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()

  // 리뷰 반영 — 유형 필터 내비는 무거운 coverageData() 재실행(B-2 이후 관측 풀스캔 포함) 대신
  // 경량 쿼리로 뽑는다. scamType 유무와 무관하게 coverageData()는 이 아래 1회만 실행된다.
  const types = (await publishedScamTypes(db)).sort((a, b) => a.localeCompare(b, 'ko'))
  const data = await coverageData(db, firm, scamType ? { scamType } : undefined)
  const weeks = fillWeeks(data.weekly)
  // task-5-brief §A4 — 행별 올리기/내리기 버튼·배지. coverageData(무거운 관측 풀스캔 포함)를
  // 건드리지 않고 경량 쿼리 2종(publishedScamTypes와 동일한 분리 이유)으로 따로 가져온다.
  const desiredMap = await adDesiredMap(db, firm)
  const credStatus = await credStatusForFirm(db, firm)
  const hasCred = credStatus.has
  const channelOk = Boolean(firm.adConfig?.channelOk)

  return (
    <div className="space-y-10">
      <section>
        <p className="font-mono-label t-sub">사건명 커버리지</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">게시된 사건명이 광고 파이프라인의 어느 단계에 있는지 확인하세요</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed t-sub">
          서비스 이용 중에는 게시된 전 사건명이 자동으로 커버됩니다. 광고 단계는 엔진이 관리합니다.
        </p>
      </section>

      <section aria-label="수집 파이프라인 단계">
        <h3 className="text-sm font-semibold t-ink">수집 파이프라인</h3>
        <div className="mt-3 grid grid-cols-3 gap-4">
          <StageTile label="수집" value={data.stages.keywords.discovered} />
          <StageTile label="검증" value={data.stages.keywords.verified} />
          <StageTile label="게시" value={data.stages.keywords.published} />
        </div>
      </section>

      <section aria-label="광고 등록 단계">
        <h3 className="text-sm font-semibold t-ink">광고 등록 단계</h3>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-6">
          <StageTile label="등록 예정" value={data.stages.pipeline.pending} />
          <StageTile label="등록 진행 중" value={data.stages.pipeline.adPending} />
          {/* 제외됨(내림) — subscribed∧desired=false. 같은 화면 테이블 배지(badgeLabel)와 동일
              어휘·동일 조합(Task 5 fix wave 이후 타일·배지 정합화). */}
          <StageTile label="제외됨(내림)" value={data.stages.pipeline.excluded} />
          <StageTile label="심사 중" value={data.stages.pipeline.adRegistered} />
          <StageTile label="라이브" value={data.stages.pipeline.live} />
          <StageTile label="보완 필요" value={data.stages.pipeline.rejected} />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold t-ink">게시된 사건명</h3>

        <nav className="mt-3 flex flex-wrap gap-2" aria-label="유형 필터">
          <TypeFilterLink token={token} label="전체" active={!scamType} />
          {types.map((t) => (
            <TypeFilterLink key={t} token={token} scamType={t} label={t} active={scamType === t} />
          ))}
        </nav>

        <p className="mt-3 max-w-2xl text-xs leading-relaxed t-sub">
          &lsquo;자세히&rsquo;를 열면 업체별 수집 근거 — 수법·확인된 인프라·원문 언급 금액 집계와 관측별 원문 링크입니다.
          원문 본문은 저장하지 않고 구조화된 사실만 보관합니다.
        </p>

        <div className="mt-3 overflow-x-auto rounded-xl border t-border t-surface">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead>
              <tr className="border-b t-border">
                <th className="px-4 py-3 font-mono-label t-sub">업체명</th>
                <th className="px-4 py-3 font-mono-label t-sub">12주 추이</th>
                <th className="px-4 py-3 text-right font-mono-label t-sub">스코어</th>
                <th className="px-4 py-3 font-mono-label t-sub">모멘텀</th>
                <th className="px-4 py-3 font-mono-label t-sub">최초·최근</th>
                <th className="px-4 py-3 font-mono-label t-sub">관측 상세</th>
                <th className="px-4 py-3 text-right font-mono-label t-sub">방문</th>
                <th className="px-4 py-3 text-right font-mono-label t-sub">전화</th>
                <th className="px-4 py-3 text-right font-mono-label t-sub">카톡</th>
                <th className="px-4 py-3 text-right font-mono-label t-sub">문의</th>
                <th className="px-4 py-3 text-right font-mono-label t-sub">전환율</th>
                <th className="px-4 py-3 font-mono-label t-sub">광고 단계</th>
                <th className="px-4 py-3 font-mono-label t-sub">올리기/내리기</th>
                <th className="px-4 py-3 font-mono-label t-sub">랜딩 링크</th>
              </tr>
            </thead>
            <tbody>
              {data.detailed.map((row) => (
                <DetailedRow
                  key={row.id} row={row} token={token}
                  desired={desiredMap.get(row.id)} hasCred={hasCred} channelOk={channelOk}
                />
              ))}
            </tbody>
          </table>
          {data.detailed.length === 0 && (
            <p className="p-6 text-sm t-sub">해당 유형에 관측된 사건명이 없습니다.</p>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold t-ink">주간 관측 추이 (최근 {WEEK_WINDOW}주)</h3>
        <div className="mt-3 overflow-x-auto rounded-xl border t-border t-surface p-4">
          {weeks.some((w) => w.n > 0) ? (
            <div className="dash-chart">
              {weeks.map((w) => {
                const mx = Math.max(1, ...weeks.map((x) => x.n))
                return (
                  <div key={w.week} className="dash-chart-item" title={`${w.week} 주: 관측 ${w.n}건`}>
                    <div className="dash-chart-value">{w.n.toLocaleString('ko-KR')}</div>
                    <div className="dash-chart-bar" style={{ height: `${Math.max(4, Math.round(120 * w.n / mx))}px` }} />
                    <div className="dash-chart-label">{w.week.slice(5).replace('-', '/')}</div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm t-sub">최근 {WEEK_WINDOW}주간 관측이 없습니다.</p>
          )}
        </div>
      </section>
    </div>
  )
}

function StageTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border t-border t-surface p-4">
      <p className="font-mono-label t-sub">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{value.toLocaleString('ko-KR')}</p>
    </div>
  )
}

function TypeFilterLink({
  token, scamType, label, active,
}: { token: string; scamType?: string; label: string; active: boolean }) {
  const href = scamType ? `/d/${token}/keywords?scamType=${encodeURIComponent(scamType)}` : `/d/${token}/keywords`
  return (
    <Link
      href={href}
      className="rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors"
      style={active
        ? { borderColor: 'var(--t-accent)', color: 'var(--t-accent)', background: 'color-mix(in srgb, var(--t-accent) 10%, var(--t-surface))' }
        : { borderColor: 'var(--t-line)', color: 'var(--t-sub)' }}
    >
      {label}
    </Link>
  )
}

// 어드민 게시 중 테이블 행 미러(스펙 B-2 보강) — 업체명/스파크/스코어/모멘텀/최초·최근/관측상세
// (dossier+원문 목록)/퍼널 4단+전환율/광고 단계/랜딩 링크.
function DetailedRow({ row, token, desired, hasCred, channelOk }: {
  row: CoverageDetailedEntry
  token: string
  desired: boolean | undefined // firm_keywords 행 없으면 undefined(등록 전 — 버튼 대상 아님)
  hasCred: boolean
  channelOk: boolean
}) {
  // row.observations는 도배 묶음 결과(고유 그룹) — "사실 N"은 대표 facts가 있는 고유 그룹 수.
  const factsCount = row.observations.filter((g) => g.facts).length
  const cvrLabel = row.funnel.cvr === null ? '—' : `${(row.funnel.cvr * 100).toFixed(1)}%`
  return (
    <tr className="border-b t-border last:border-0 align-top">
      <td className="px-4 py-3">
        <div className="font-medium">{row.name}</div>
        <div className="font-mono text-[11px] t-sub">{row.slug} · {row.scamType}</div>
      </td>
      <td className="px-4 py-3"><Spark weekly={row.weekly} /></td>
      <td className="px-4 py-3 text-right tabular-nums">{row.score.toLocaleString('ko-KR')}</td>
      <td className="px-4 py-3">
        <Momentum direction={row.momentum.direction} />
      </td>
      <td className="px-4 py-3 font-mono text-[11px] t-sub">
        {fmtDate(row.firstSeenAt)}<br />{fmtDate(row.lastSeenAt)}
      </td>
      <td className="px-4 py-3">
        <details className="dash-detail">
          <summary>
            {row.obsCount.toLocaleString('ko-KR')}건 · 고유 {row.observations.length.toLocaleString('ko-KR')}
            {factsCount ? ` · 사실 ${factsCount}` : ''} · 자세히
          </summary>
          <Dossier dossier={row.dossier} />
          <ObservationTable observations={row.observations} />
        </details>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{row.funnel.pv.toLocaleString('ko-KR')}</td>
      <td className="px-4 py-3 text-right tabular-nums">{row.funnel.call.toLocaleString('ko-KR')}</td>
      <td className="px-4 py-3 text-right tabular-nums">{row.funnel.kakao.toLocaleString('ko-KR')}</td>
      <td className="px-4 py-3 text-right tabular-nums">{row.funnel.form.toLocaleString('ko-KR')}</td>
      <td className="px-4 py-3 text-right tabular-nums">{cvrLabel}</td>
      <td className="px-4 py-3">
        <span className="rounded-full px-2.5 py-1 text-xs font-medium" style={badgeStyle(row.adStage, desired)}>
          {badgeLabel(row.adStage, desired)}
        </span>
      </td>
      <td className="px-4 py-3">
        <DesiredCell
          token={token} keywordId={row.id} adStage={row.adStage}
          desired={desired} hasCred={hasCred} channelOk={channelOk}
          hasAdgroupId={Boolean(row.naverAdgroupId)}
        />
      </td>
      <td className="px-4 py-3">
        <Link
          href={`/f/${row.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="t-accent text-sm font-medium underline underline-offset-2"
        >
          보기
        </Link>
      </td>
    </tr>
  )
}

// task-5-brief §A4 — 의사(adDesired)↔실제 엔진 상태(adStage) 불일치 배지. desired=false ∧
// status∈{ad_registered, live}는 아직 다음 reconcile-ads 실행 전(engine/reconcile-ads.ts)이라
// "내림(반영 대기)". status=paused ∧ desired=false는 이미 반영이 끝난 "내려짐". paused ∧
// desired=true ∧ naverAdgroupId 존재는 재게재 반영 대기 "올림(반영 대기)". 그 외 조합(정합 상태)은
// 배지 없이 버튼만.
//
// 최종 리뷰 I4(b) — paused∧desired=true∧naverAdgroupId 없음은 "올림(반영 대기)"에서 제외한다.
// reconcileAds(src/lib/engine/reconcile-ads.ts computeReconcileCandidates)는 naverAdgroupId 없는
// 행을 영구 skip한다 — 이 키워드는 등록 파이프라인을 한 번도 통과한 적이 없어(subscribed→
// ad_registered 경유 없이 paused로 전이) reconcile이 되살릴 대상 자체가 아니다. "반영 대기"
// 배지를 계속 띄우면 고객이 영원히 안 지켜질 약속을 보게 된다 — 배지를 억제한다(hasAdgroupId
// 인자로 판별, "내려짐" 계열 취급).
export function pendingBadgeLabel(adStage: string, desired: boolean, hasAdgroupId: boolean): string | null {
  if (!desired && (adStage === 'ad_registered' || adStage === 'live')) return '내림(반영 대기)'
  if (adStage === 'paused' && !desired) return '내려짐'
  if (adStage === 'paused' && desired && hasAdgroupId) return '올림(반영 대기)'
  return null
}

// 사건명 테이블 올리기/내리기 셀 — 1,000+행 규모라 폼은 행당 hidden input 1개 + 버튼 1개로
// 최소 마크업을 유지한다(task-5-brief 지시). 자격증명 미보유·채널 미연결이면 눌러도 실행될 수
// 없는 버튼을 두는 대신 원인이 드러나는 안내 배지만 보여준다(task-5-brief §A4).
function DesiredCell({ token, keywordId, adStage, desired, hasCred, channelOk, hasAdgroupId }: {
  token: string
  keywordId: string
  adStage: string | null
  desired: boolean | undefined
  hasCred: boolean
  channelOk: boolean
  hasAdgroupId: boolean
}) {
  if (adStage === null || desired === undefined) return <span className="t-sub">—</span>

  if (!hasCred || !channelOk) {
    return (
      <span
        className="rounded-full px-2.5 py-1 text-xs font-medium"
        style={{ background: 'color-mix(in srgb, var(--t-sub) 14%, var(--t-surface))', color: 'var(--t-sub)' }}
      >
        {!hasCred ? '자격증명 필요' : '채널 연결 필요'}
      </span>
    )
  }

  const pending = pendingBadgeLabel(adStage, desired, hasAdgroupId)
  return (
    <div className="flex flex-col items-start gap-1.5">
      {pending && (
        <span
          className="rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ background: 'color-mix(in srgb, var(--t-accent) 12%, var(--t-surface))', color: 'var(--t-accent)' }}
        >
          {pending}
        </span>
      )}
      <form action={setAdDesired.bind(null, token, keywordId)}>
        <input type="hidden" name="desired" value={String(!desired)} />
        <button type="submit" className="rounded-full border t-border px-2.5 py-1 text-xs font-medium">
          {desired ? '내리기' : '올리기'}
        </button>
      </form>
    </div>
  )
}

// 12주 고정 버킷 스파크바 — 행별 최대값 기준 상대 높이(어드민 spark() 포팅).
function Spark({ weekly }: { weekly: { week: string; n: number }[] }) {
  const mx = Math.max(1, ...weekly.map((w) => w.n))
  return (
    <span className="dash-spark">
      {weekly.map((w) => (
        <i
          key={w.week}
          style={{ height: `${Math.max(2, Math.round(16 * w.n / mx))}px` }}
          title={`${w.week.slice(5)} 주 ${w.n.toLocaleString('ko-KR')}건`}
        />
      ))}
    </span>
  )
}

function Momentum({ direction }: { direction: 'up' | 'down' | 'flat' }) {
  if (direction === 'up') return <span className="dash-momentum-up">▲ 증가</span>
  if (direction === 'down') return <span className="dash-momentum-down">▼ 감소</span>
  return <span className="t-sub">— 유지</span>
}

// 업체 dossier 집계 칩 블록 — 어드민 dossier() 포팅(수법 빈도·확인된 인프라·원문 언급 금액).
// 금액은 원문 문자열 그대로 인용 표시(집계·단정 재가공 금지 — 스펙 컴플라이언스 노트).
function Dossier({ dossier }: { dossier: CoverageDetailedEntry['dossier'] }) {
  if (!dossier.methodCounts.length && !dossier.infra.length && !dossier.amounts.length) return null
  return (
    <div className="dash-dossier">
      {dossier.methodCounts.length > 0 && (
        <div className="dash-dossier-block">
          <span className="dash-dossier-label">수법</span>
          {dossier.methodCounts.map((m) => (
            <span key={m.method} className="dash-chip dash-chip-method">{m.method} <b>{m.count}</b></span>
          ))}
        </div>
      )}
      {dossier.infra.length > 0 && (
        <div className="dash-dossier-block">
          <span className="dash-dossier-label">확인된 인프라</span>
          {dossier.infra.map((i) => (
            <span key={`${i.type}:${i.value}`} className="dash-chip dash-chip-infra">{INFRA_KO[i.type] ?? i.type}·{i.value}</span>
          ))}
        </div>
      )}
      {dossier.amounts.length > 0 && (
        <div className="dash-dossier-block">
          <span className="dash-dossier-label">원문 언급 금액</span>
          {dossier.amounts.map((a) => (
            <span key={a} className="dash-chip dash-chip-amount">{a}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// 관측 목록 표 — 도배(동일 제보 반복 게시) 묶음 1그룹 = 1행(어드민 detail() 포팅 + 2026-08-04
// 묶음 확장). count===1이면 관측 시각을 오늘과 동일하게(분 단위) 보여주고, count>1이면 그
// 자리에 "최초 ~ 최근" 기간(일 단위)을 보여주고 대표 제목 옆에 "반복 ×N" 배지를 붙인다 — 대표
// 제목/원문 링크는 그룹 내 최신 관측 그대로(재가공 없음).
function ObservationTable({ observations }: { observations: CoverageObservationGroup[] }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead>
          <tr className="border-b t-border">
            <th className="px-2 py-1.5 font-mono-label t-sub">관측 시각(원문 작성)</th>
            <th className="px-2 py-1.5 font-mono-label t-sub">형태</th>
            <th className="px-2 py-1.5 font-mono-label t-sub">제목</th>
            <th className="px-2 py-1.5 font-mono-label t-sub">수법·인프라·금액</th>
            <th className="px-2 py-1.5 font-mono-label t-sub">원문</th>
          </tr>
        </thead>
        <tbody>
          {observations.map((g, i) => (
            <tr key={i} className="border-b t-border last:border-0">
              <td className="px-2 py-1.5 font-mono t-sub">
                {g.count > 1
                  ? `${g.observedFirst.slice(0, 10)} ~ ${g.observedLast.slice(0, 10)}`
                  : g.observedLast.slice(0, 16).replace('T', ' ')}
              </td>
              <td className="px-2 py-1.5">{TYPE_KO[g.sourceType ?? ''] ?? g.sourceType ?? '—'}</td>
              <td className="px-2 py-1.5">
                {g.title || '(제목 없음)'}
                {g.count > 1 && <span className="dash-chip dash-chip-repeat">반복 ×{g.count}</span>}
              </td>
              <td className="px-2 py-1.5"><FactChips facts={g.facts} /></td>
              <td className="px-2 py-1.5">
                {g.sourceUrl
                  ? <a href={g.sourceUrl} target="_blank" rel="noreferrer" className="t-accent underline underline-offset-2">원문</a>
                  : <span className="t-sub">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 관측 1건의 구조화 사실 → 칩 렌더(어드민 factCell() 포팅).
function FactChips({ facts }: { facts: ObsFacts | null }) {
  if (!facts || (!facts.method.length && !facts.infra.length && !facts.amounts.length)) {
    return <span className="t-sub">—</span>
  }
  return (
    <>
      {facts.method.map((m, i) => <span key={`m${i}`} className="dash-chip dash-chip-method">{m}</span>)}
      {facts.infra.map((inf, i) => <span key={`i${i}`} className="dash-chip dash-chip-infra">{INFRA_KO[inf.type] ?? inf.type}·{inf.value}</span>)}
      {facts.amounts.map((a, i) => <span key={`a${i}`} className="dash-chip dash-chip-amount">{a}</span>)}
    </>
  )
}

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '—'
}

// ISO 8601 주 키(연-주) — src/lib/dashboard/data.ts·coverage.ts의
// to_char(observed_at at time zone 'UTC', 'IYYY-IW')와 동일 알고리즘(UTC 기준). app/d/[token]/page.tsx의
// 구현을 그대로 복제했다 — 두 페이지가 공유 모듈로 묶일 만큼 로직이 크지 않고, 각자 렌더링측
// 계약(스파스 주간 데이터를 고정 폭 축으로 채움)이라 로컬로 둔다.
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

// coverageData.weekly는 관측이 있었던 주만 포함(스파스) — 표는 빈 주를 0건으로 채운 고정
// WEEK_WINDOW행이 필요하므로 렌더링측(여기)에서만 채운다. 어셈블러는 "실측 그대로"를 유지.
function fillWeeks(weekly: { week: string; n: number }[]): { week: string; n: number }[] {
  const byWeek = new Map(weekly.map((w) => [w.week, w.n]))
  const now = Date.now()
  const out: { week: string; n: number }[] = []
  for (let i = WEEK_WINDOW - 1; i >= 0; i--) {
    const key = isoWeekKey(new Date(now - i * 7 * 86_400_000))
    out.push({ week: key, n: byWeek.get(key) ?? 0 })
  }
  return out
}
