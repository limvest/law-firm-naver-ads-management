import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import { adsData, isDomainMissingError, type AdEntityRow, type CredStatus } from '@/lib/dashboard/ads'
import {
  decideContentApproval,
  saveAdConfig,
  saveCredentials,
  saveCustomerAdPolicy,
} from '@/lib/dashboard/actions'
import type { PlanItem } from '@/lib/engine/registration-plan'
import { listPendingFirmApprovals, type PendingFirmApproval } from '@/domains/operations/approvals'
import {
  CUSTOMER_AD_POLICY_ACTIONS,
  getFirmAdPolicyView,
  type FirmAdPolicyView,
} from '@/domains/advertising/customer-policy'
import {
  getAdvertisingDashboardMetrics,
  type AdvertisingDashboardMetrics,
} from '@/domains/advertising/repository'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '광고',
  robots: { index: false, follow: false },
}

// firm_keywords.status(src/lib/engine/state.ts 전이표) → 고객 배지 라벨 — keywords/page.tsx의
// badgeLabel()과 동일 어휘(스펙 2026-08-03 §C, 커버리지 개편 이후 두 페이지가 공유하는 계약).
// subscribed·paused·ad_pending은 "아직 확정 단계 전"으로 한 라벨에 묶이므로, 아래 집계에서도
// 세 상태의 카운트를 합산해 중복 라벨 타일이 뜨지 않게 한다. 'excluded'는 실제 status 값이
// 아니라 adsData가 subscribed∧adDesired=false 조합에 붙이는 합성 키(최종 리뷰 I4(a),
// src/lib/dashboard/ads.ts adsData 참조) — registration-plan.ts adDesired 필터로 영구
// 제외되므로 "등록 진행 중"이 아니라 별도 라벨로 보여준다(keywords/page.tsx badgeLabel의
// '제외됨(내림)'과 동일 어휘).
const FK_STAGE_LABEL: Record<string, string> = {
  subscribed: '등록 진행 중', paused: '등록 진행 중', ad_pending: '등록 진행 중',
  ad_registered: '심사 중', live: '라이브', rejected: '보완 필요',
  excluded: '제외됨(내림)',
}

// FK_STAGE_LABEL이 여러 상태를 같은 라벨로 묶으므로, 화면에는 정해진 순서(진행 중 → 제외됨 →
// 심사 중 → 라이브 → 보완 필요)로 라벨별 합산 타일만 보여준다.
const STAGE_ORDER = ['등록 진행 중', '제외됨(내림)', '심사 중', '라이브', '보완 필요']

function buildStageEntries(statusCounts: Record<string, number>): [string, number][] {
  const byLabel = new Map<string, number>()
  for (const [status, n] of Object.entries(statusCounts)) {
    const label = FK_STAGE_LABEL[status] ?? status
    byLabel.set(label, (byLabel.get(label) ?? 0) + n)
  }
  return STAGE_ORDER.filter((label) => byLabel.has(label)).map((label) => [label, byLabel.get(label)!])
}

const REVIEW_STATUS_LABEL: Record<string, string> = {
  pending: '심사 대기', approved: '승인', rejected: '반려',
}

const ENTITY_TYPE_LABEL: Record<string, string> = {
  campaign: '캠페인', adgroup: '광고그룹', keyword: '키워드', ad: '소재',
}

// task-5 이관 결정(actions.ts saveAdConfig/saveCredentials 리다이렉트) — 성공 배너 문구.
// 래퍼가 void를 반환해 결과가 화면에 안 보이던 문제(Task 2 인계)를 URL 쿼리 파람으로 해소한다.
export const SAVED_LABEL: Record<string, string> = {
  config: '광고 설정이 저장되었습니다.',
  cred: '자격증명이 저장되고 확인되었습니다.',
  approval: '콘텐츠 승인 결정이 저장되었습니다.',
  policy: '광고 대상·자동 처리 범위·비용 상한 승인이 저장되었습니다.',
}

// 원문 에러(NaverApiError.body 등)는 절대 노출하지 않는다(스펙 §F) — 카테고리별 중립 안내만.
export const ERROR_LABEL: Record<string, string> = {
  'config-range': '입력하신 값이 허용 범위를 벗어나 저장되지 않았습니다. 기준 금액은 70원 이상 정수, 일예산은 0 이상 정수로 다시 입력해 주세요.',
  'cred-auth': '자격증명 확인에 실패했습니다. CUSTOMER_ID·API 키·시크릿을 다시 확인해 주세요.',
  'cred-network': '일시적인 통신 오류로 자격증명을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'cred-unknown': '자격증명을 확인하지 못했습니다. 입력하신 값을 다시 확인해 주세요.',
  approval: '승인 가능한 상태와 검토 사유를 확인해 주세요. 기존 공개 상태는 변경되지 않았습니다.',
  'policy-invalid': '광고 정책을 저장하지 못했습니다. 사건과 허용 동작을 하나 이상 선택하고, 월·일·클릭당 상한과 승인 정보를 확인해 주세요.',
}

// ad-settings.ts DEFAULT_BID_AMT(70)과 동일 값 — 그쪽은 export하지 않아 표시용으로 로컬 상수를
// 둔다(설정 미저장 firm의 기준값 안내 문구·입력 min 힌트 공용).
const DEFAULT_BID_DISPLAY = 70

/**
 * 광고 현황 뷰 — 실시간 dry-run 미리보기. 이 태스크는 읽기 전용이라 실행 버튼을 두지 않는다
 * (스펙: 등록 실행은 운영 CLI 전용). 도메인 미설정 firm은 adsData가 buildRegistrationPlan의
 * throw를 캐치해 planError로 넘겨준다 — isDomainMissingError로 그 메시지가 실제 "도메인
 * 미설정" 케이스인지 판별해 맞으면 "도메인 연결 후 활성화" 안내를, 그 외(일시적 오류 등)에는
 * 원문을 노출하지 않는 중립 안내를 보여준다(리뷰 반영 F2 — 모든 실패를 도메인 안내로 뭉개면
 * 진짜 일시 오류를 겪는 고객에게 엉뚱한 조치를 안내하게 된다).
 *
 * task-5 — 자격증명 카드·설정 카드·채널 상태·올림/내림 집계 추가. searchParams(saved/error)는
 * saveAdConfig/saveCredentials 리다이렉트가 실어 보내는 1회성 배너 신호 — 다음 내비게이션(탭
 * 이동·이 배너의 "닫기" 링크)에서 자연히 사라진다(서버에 저장하지 않음).
 */
export default async function DashboardAdsPage(
  { params, searchParams }: {
    params: Promise<{ token: string }>
    searchParams: Promise<{ saved?: string; error?: string }>
  },
) {
  // 레이아웃과 동일 가드 — DB 미연결 시 조용히 빠진다(overview/keywords 페이지와 동일 이유).
  if (!process.env.DATABASE_URL) return null

  const { token } = await params
  const { saved, error } = await searchParams
  const db = getDb()
  // 레이아웃이 이미 토큰을 검증하지만 페이지는 firm 인스턴스를 독립적으로 필요로 한다(안전망 재검증).
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())
  const periodStart = new Date(`${today}T00:00:00.000Z`)
  periodStart.setUTCDate(periodStart.getUTCDate() - 29)
  const [data, pendingApprovals, adPolicy, adMetrics] = await Promise.all([
    adsData(db, firm),
    listPendingFirmApprovals(db, firm),
    getFirmAdPolicyView(db, firm.id),
    getAdvertisingDashboardMetrics(db, {
      firmId: firm.id,
      from: periodStart.toISOString().slice(0, 10),
      to: today,
      asOf: today,
    }),
  ])
  const stageEntries = buildStageEntries(data.statusCounts)

  return (
    <div className="space-y-10">
      <section>
        <p className="font-mono-label t-sub">광고 현황</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">광고 등록 파이프라인과 심사 현황을 확인하세요</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed t-sub">
          아래 배지는 광고 대상 사건명이 등록 파이프라인의 어느 단계에 있는지 보여주고, 심사 현황
          표는 네이버 심사 결과를 정리합니다. 등록 예정 미리보기는 아직 실행되지 않은 dry-run
          결과입니다.
        </p>
      </section>

      {(saved || error) && (
        <SaveBanner token={token} saved={saved} error={error} />
      )}

      <FirmApprovalPanel token={token} items={pendingApprovals} />

      <CustomerAdPolicyCard token={token} view={adPolicy} />

      <AdvertisingPerformancePanel metrics={adMetrics} />

      <section aria-label="자격증명·설정·채널" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CredentialsCard token={token} credStatus={data.credStatus} />
        <AdConfigCard token={token} bidAmt={data.adConfig?.bidAmt ?? null} dailyBudget={data.adConfig?.dailyBudget ?? null} />
        <ChannelStatusCard channelOk={data.adConfig?.channelOk ?? false} />
      </section>

      <section aria-label="올리기/내리기 집계" className="flex flex-wrap gap-3">
        <div className="rounded-xl border t-border t-surface px-4 py-3">
          <p className="font-mono-label t-sub">올림 대상</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data.desiredCounts.on.toLocaleString('ko-KR')}</p>
        </div>
        <div className="rounded-xl border t-border t-surface px-4 py-3">
          <p className="font-mono-label t-sub">내림 대상</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data.desiredCounts.off.toLocaleString('ko-KR')}</p>
        </div>
      </section>

      <section aria-label="파이프라인 상태 집계" className="flex flex-wrap gap-3">
        {stageEntries.length === 0 ? (
          <p className="text-sm t-sub">아직 광고 파이프라인에 편입된 사건명이 없습니다.</p>
        ) : (
          stageEntries.map(([label, n]) => (
            <div key={label} className="rounded-xl border t-border t-surface px-4 py-3">
              <p className="font-mono-label t-sub">{label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{n.toLocaleString('ko-KR')}</p>
            </div>
          ))
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold t-ink">심사 현황</h3>
        <div className="mt-3 overflow-x-auto rounded-xl border t-border t-surface">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b t-border">
                <th className="px-4 py-3 font-mono-label t-sub">구분</th>
                <th className="px-4 py-3 font-mono-label t-sub">업체</th>
                <th className="px-4 py-3 font-mono-label t-sub">심사 상태</th>
                <th className="px-4 py-3 font-mono-label t-sub">반려 사유</th>
              </tr>
            </thead>
            <tbody>
              {data.entities.map((e, i) => (
                <EntityRow key={i} entity={e} />
              ))}
            </tbody>
          </table>
          {data.entities.length === 0 && (
            <p className="p-6 text-sm t-sub">아직 심사 대상으로 등록된 항목이 없습니다.</p>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold t-ink">등록 예정 미리보기</h3>
        <p className="mt-1 max-w-2xl text-sm t-sub">
          광고 대상 사건명이 등록될 경우 생성될 소재와 변형을 미리 보여줍니다(dry-run — 아직
          네이버에 등록되지 않았습니다).
        </p>

        {data.planError ? (
          <div className="mt-4 rounded-xl border t-border p-6" style={{ background: 'color-mix(in srgb, var(--t-accent) 6%, var(--t-surface))' }}>
            <p className="text-sm leading-relaxed t-sub">
              {isDomainMissingError(data.planError)
                ? '도메인이 아직 연결되지 않아 등록 예정 미리보기를 준비할 수 없습니다. 도메인 연결 후 이 화면이 자동으로 활성화됩니다.'
                : '일시적인 오류로 미리보기를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'}
            </p>
          </div>
        ) : data.plan && data.plan.items.length > 0 ? (
          <>
            {data.plan.items.length < data.planEligibleCount && (
              <p className="mt-3 text-xs t-sub">
                전체 {data.planEligibleCount.toLocaleString('ko-KR')}건 중 {data.plan.items.length.toLocaleString('ko-KR')}건 표시
              </p>
            )}
            <ul className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              {data.plan.items.map((item) => (
                <PlanItemCard key={item.keywordId} item={item} />
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-4 text-sm t-sub">현재 등록 예정으로 표시할 사건명이 없습니다.</p>
        )}
      </section>

      <section className="rounded-xl border t-border p-6">
        <p className="text-sm t-sub">등록 실행은 운영 CLI에서 진행됩니다. 이 화면에서는 실행할 수 없습니다.</p>
      </section>
    </div>
  )
}

function AdvertisingPerformancePanel({ metrics }: { metrics: AdvertisingDashboardMetrics }) {
  const totals = metrics.totals
  return (
    <section aria-label="최근 광고 성과" className="rounded-xl border t-border t-surface p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono-label t-sub">OBSERVED PERFORMANCE</p>
          <h3 className="mt-1 text-lg font-bold">최근 30일 실제 동기화 성과</h3>
        </div>
        <span className="text-xs t-sub">{metrics.period.from}–{metrics.period.to}</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <PerformanceMetric label="노출" value={totals.impressions.toLocaleString('ko-KR')} />
        <PerformanceMetric label="클릭" value={totals.clicks.toLocaleString('ko-KR')} />
        <PerformanceMetric label="비용" value={`${totals.spend.toLocaleString('ko-KR')}원`} />
        <PerformanceMetric label="클릭당 비용" value={totals.cpc === null ? '관측 없음' : `${Math.round(totals.cpc).toLocaleString('ko-KR')}원`} />
        <PerformanceMetric label="적격 상담" value={totals.qualifiedLeads.toLocaleString('ko-KR')} />
        <PerformanceMetric label="수임" value={totals.retainedMatters.toLocaleString('ko-KR')} />
      </div>
      {metrics.cases.length ? (
        <div className="mt-5 overflow-x-auto rounded-xl border t-border">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead><tr className="border-b t-border text-xs t-sub"><th className="px-4 py-3">사건</th><th className="px-4 py-3">실행 상태</th><th className="px-4 py-3">심사</th><th className="px-4 py-3">노출/클릭</th><th className="px-4 py-3">비용</th><th className="px-4 py-3">적격/수임</th><th className="px-4 py-3">운영 판단</th></tr></thead>
            <tbody>{metrics.cases.map((item) => (
              <tr key={item.caseEntityId} className="border-b t-border last:border-0">
                <td className="px-4 py-3 font-medium">{item.canonicalName}</td>
                <td className="px-4 py-3 t-sub">{item.status}</td>
                <td className="px-4 py-3 t-sub">{item.reviewStatus}{item.reviewReason ? ` · ${item.reviewReason}` : ''}</td>
                <td className="px-4 py-3 tabular-nums">{item.impressions.toLocaleString('ko-KR')} / {item.clicks.toLocaleString('ko-KR')}</td>
                <td className="px-4 py-3 tabular-nums">{item.spend.toLocaleString('ko-KR')}원</td>
                <td className="px-4 py-3 tabular-nums">{item.qualifiedLeads.toLocaleString('ko-KR')} / {item.retainedMatters.toLocaleString('ko-KR')}</td>
                <td className="px-4 py-3 t-sub">{item.pacingStatus}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="mt-5 rounded-lg border border-dashed t-border px-4 py-6 text-center text-sm t-sub">아직 동기화된 광고 실행 성과가 없습니다. 관측되지 않은 비용은 0원으로 단정하지 않습니다.</p>}
    </section>
  )
}

function PerformanceMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border t-border px-4 py-3"><p className="text-xs t-sub">{label}</p><p className="mt-1 text-lg font-bold tabular-nums">{value}</p></div>
}

const ACTION_LABEL: Record<(typeof CUSTOMER_AD_POLICY_ACTIONS)[number], string> = {
  register: '신규 광고 등록',
  activate: '심사 통과 광고 활성화',
  pause: '광고 중지',
  decrease_bid: '클릭당 기준 금액 하향',
  increase_bid: '클릭당 기준 금액 상향',
  recommend_pause: '중지 제안 생성',
}

function CustomerAdPolicyCard({ token, view }: { token: string; view: FirmAdPolicyView }) {
  const selectedCases = new Set(view.policy?.allowedCaseEntityIds ?? [])
  const selectedActions = new Set(view.policy?.allowedActions ?? ['register', 'activate', 'pause', 'recommend_pause'])
  const disabled = view.cases.length === 0
  return (
    <section aria-label="고객 승인 광고 정책" className="rounded-xl border t-border t-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono-label t-sub">SPEND &amp; SCOPE APPROVAL</p>
          <h3 className="mt-1 text-lg font-bold">광고 대상과 비용 경계를 직접 승인하세요</h3>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed t-sub">
            선택한 사건·동작·상한 밖의 광고 변경은 차단됩니다. 저장은 내부 실행 계획만 갱신하며,
            실제 외부 등록이나 비용 발생을 즉시 실행하지 않습니다.
          </p>
        </div>
        <span className="rounded-full border t-border px-3 py-1 text-xs t-sub">
          {view.approved && view.policy ? `승인됨 · ${view.policy.policyVersion}` : '승인 필요'}
        </span>
      </div>

      {disabled ? (
        <p className="mt-5 rounded-lg border border-dashed t-border px-4 py-6 text-center text-sm t-sub">
          먼저 운영자 검토와 고객 콘텐츠 승인을 마친 광고 랜딩이 필요합니다.
        </p>
      ) : (
        <form action={saveCustomerAdPolicy.bind(null, token)} className="mt-6 grid gap-6">
          <div className="grid gap-4 md:grid-cols-3">
            <PolicyNumberField name="monthlyBudget" label="월 비용 상한(원)" value={view.policy?.monthlyBudget ?? 1_000_000} />
            <PolicyNumberField name="dailyBudget" label="일 비용 상한(원)" value={view.policy?.dailyBudget ?? 50_000} />
            <PolicyNumberField name="bidCeiling" label="클릭당 기준 금액 상한(원)" value={view.policy?.bidCeiling ?? 1_500} min={70} />
          </div>

          <fieldset>
            <legend className="text-sm font-semibold">허용 사건</legend>
            <p className="mt-1 text-xs t-sub">승인된 광고 랜딩이 있는 사건만 선택할 수 있습니다.</p>
            <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto rounded-lg border t-border p-3 sm:grid-cols-2 lg:grid-cols-3">
              {view.cases.map((caseOption) => (
                <label key={caseOption.id} className="flex items-start gap-2 rounded-md px-2 py-2 text-sm hover:bg-black/[0.03]">
                  <input
                    name="caseEntityId"
                    value={caseOption.id}
                    type="checkbox"
                    defaultChecked={selectedCases.size ? selectedCases.has(caseOption.id) : true}
                    className="mt-0.5"
                  />
                  <span><strong className="font-medium">{caseOption.canonicalName}</strong><span className="mt-0.5 block text-[11px] t-sub">{caseOption.assetStatus}</span></span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold">허용 동작</legend>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {CUSTOMER_AD_POLICY_ACTIONS.map((action) => (
                <label key={action} className="flex items-center gap-2 rounded-lg border t-border px-3 py-2 text-sm">
                  <input name="allowedAction" value={action} type="checkbox" defaultChecked={selectedActions.has(action)} />
                  {ACTION_LABEL[action]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs t-sub">승인자 성명
              <input name="approvedBy" required defaultValue={view.policy?.approvedBy ?? ''} className="mt-1 block w-full rounded-md border t-border t-surface px-3 py-2 text-sm" />
            </label>
            <label className="text-xs t-sub">승인 사유
              <input name="reason" required minLength={5} placeholder="예: 90일 파일럿 범위와 상한 확인" className="mt-1 block w-full rounded-md border t-border t-surface px-3 py-2 text-sm" />
            </label>
          </div>

          <div className="grid gap-2 rounded-lg border t-border p-4 text-sm">
            <label className="flex items-start gap-2">
              <input name="autoSubmit" value="yes" type="checkbox" defaultChecked={view.policy?.adAutoSubmit ?? false} className="mt-0.5" />
              <span>위 범위 안에서 등록 준비와 제출 자동화를 허용합니다. 외부 실행 기능이 비활성 상태이면 계획만 생성됩니다.</span>
            </label>
            <label className="flex items-start gap-2 font-medium">
              <input name="scopeConfirmed" value="yes" type="checkbox" required className="mt-0.5" />
              <span>선택한 사건·동작과 월·일·클릭당 상한을 확인했습니다.</span>
            </label>
          </div>
          <button type="submit" className="t-cta-primary w-fit rounded-full px-5 py-2.5 text-sm font-semibold">정책 승인·저장</button>
        </form>
      )}
    </section>
  )
}

function PolicyNumberField({ name, label, value, min = 1 }: { name: string; label: string; value: number; min?: number }) {
  return (
    <label className="text-xs t-sub">{label}
      <input name={name} type="number" min={min} step={1} required defaultValue={value} className="mt-1 block w-full rounded-md border t-border t-surface px-3 py-2 text-sm" />
    </label>
  )
}

function FirmApprovalPanel({ token, items }: { token: string; items: PendingFirmApproval[] }) {
  return (
    <section aria-label="콘텐츠 승인 대기" className="rounded-xl border t-border t-surface p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono-label t-sub">CUSTOMER APPROVAL</p>
          <h3 className="mt-1 text-lg font-bold">공개 전 고객 승인</h3>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed t-sub">자동 품질검사를 통과한 자산만 표시됩니다. 사건 페이지와 광고 랜딩은 각각 검토한 뒤 승인해야 배포 큐로 이동합니다.</p>
        </div>
        <span className="rounded-full border t-border px-3 py-1 text-xs t-sub">{items.length}건 대기</span>
      </div>
      {items.length ? (
        <ul className="mt-5 grid gap-4 lg:grid-cols-2">
          {items.map(({ task, contentAsset, caseEntity }) => (
            <li key={task.id} className="rounded-xl border t-border p-5">
              <div className="flex items-start justify-between gap-3">
                <div><strong>{caseEntity.canonicalName}</strong><p className="mt-1 text-xs t-sub">{contentAsset.assetType === 'seo_page' ? 'SEO 사건 페이지' : '광고 전용 랜딩'} · v{contentAsset.contentVersion}</p></div>
                <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold" style={{ background: 'color-mix(in srgb, var(--t-accent) 10%, var(--t-surface))', color: 'var(--t-accent)' }}>{task.taskType === 'brand_review' ? '브랜드 검토' : '내용 검토'}</span>
              </div>
              {contentAsset.qualityReport?.issues?.length ? <p className="mt-3 text-xs leading-5 text-red-600">자동검사: {contentAsset.qualityReport.issues.join(' · ')}</p> : <p className="mt-3 text-xs t-sub">자동 근거·브랜드·placeholder 검사를 통과했습니다.</p>}
              <form action={decideContentApproval.bind(null, token, task.id)} className="mt-4 grid gap-2">
                <input name="reason" required minLength={5} placeholder="승인 근거 또는 수정 요청 사유" className="rounded-lg border t-border t-surface px-3 py-2 text-xs outline-none" />
                <div className="flex gap-2">
                  <button name="decision" value="approve" className="t-cta-primary rounded-full px-4 py-2 text-xs font-semibold">검토 완료·승인</button>
                  <button name="decision" value="reject" className="rounded-full border t-border px-4 py-2 text-xs font-semibold text-red-600">수정 요청</button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      ) : <p className="mt-5 rounded-lg border border-dashed t-border px-4 py-6 text-center text-sm t-sub">현재 고객 승인을 기다리는 자산이 없습니다.</p>}
    </section>
  )
}

function EntityRow({ entity }: { entity: AdEntityRow }) {
  const rejected = entity.reviewStatus === 'rejected'
  return (
    <tr className="border-b t-border last:border-0">
      <td className="px-4 py-3">{ENTITY_TYPE_LABEL[entity.entityType] ?? entity.entityType}</td>
      <td className="px-4 py-3 t-sub">{entity.keywordSlug ?? '—'}</td>
      <td className="px-4 py-3">
        <span
          className="rounded-full px-2.5 py-1 text-xs font-medium"
          style={rejected
            ? { background: 'rgb(254 226 226)', color: 'rgb(220 38 38)' }
            : { background: 'color-mix(in srgb, var(--t-accent) 10%, var(--t-surface))', color: 'var(--t-accent)' }}
        >
          {REVIEW_STATUS_LABEL[entity.reviewStatus] ?? entity.reviewStatus}
        </span>
      </td>
      <td className={`px-4 py-3 text-sm ${rejected ? 'font-semibold text-red-600' : 't-sub'}`}>
        {entity.rejectReason ?? '—'}
      </td>
    </tr>
  )
}

// task-5 이관 결정 — saveAdConfig/saveCredentials 리다이렉트 쿼리 파람(saved/error)을 읽어 그리는
// 1회성 배너. 서버에 표시 여부를 저장하지 않는다 — "닫기" 링크로 쿼리 없는 URL로 돌아가거나,
// 다른 탭으로 이동하면 자연히 사라진다(스펙: self-clean).
function SaveBanner({ token, saved, error }: { token: string; saved?: string; error?: string }) {
  const message = error
    ? (ERROR_LABEL[error] ?? '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    : (SAVED_LABEL[saved!] ?? '저장되었습니다.')
  return (
    <div
      className="rounded-xl border t-border p-4 text-sm"
      style={error
        ? { background: 'rgb(254 226 226)', color: 'rgb(220 38 38)' }
        : { background: 'color-mix(in srgb, var(--t-accent) 8%, var(--t-surface))', color: 'var(--t-accent)' }}
    >
      <div className="flex items-center justify-between gap-4">
        <p>{message}</p>
        <Link href={`/d/${token}/ads`} className="shrink-0 text-xs underline underline-offset-2">닫기</Link>
      </div>
    </div>
  )
}

// task-5-brief §A1 — 자격증명 카드. 미보유 시 입력 폼, 보유 시 마스킹된 상태(끝 4자리·검증
// 시각)만 표시하고 값 자체는 절대 다시 노출하지 않는다(원문은 저장 경로 밖 어디에도 없음, 스펙 §F).
// 교체 폼은 <details>로 접어 기본 화면을 조용히 유지한다.
function CredentialsCard({ token, credStatus }: { token: string; credStatus: CredStatus }) {
  return (
    <div className="rounded-xl border t-border t-surface p-5">
      <h3 className="text-sm font-semibold t-ink">네이버 광고 계정 연결</h3>
      {credStatus.has ? (
        <>
          <p className="mt-2 text-sm t-sub">
            연결됨 · CUSTOMER_ID ****{credStatus.customerIdTail} · 검증{' '}
            {credStatus.verifiedAt ? formatDateTime(credStatus.verifiedAt) : '대기 중'}
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs t-accent">자격증명 교체</summary>
            <CredentialsForm token={token} />
          </details>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed t-sub">
            네이버 검색광고 CUSTOMER_ID·API 키·시크릿을 입력하면 연결 상태를 확인합니다.
          </p>
          <CredentialsForm token={token} />
        </>
      )}
    </div>
  )
}

function CredentialsForm({ token }: { token: string }) {
  return (
    <form action={saveCredentials.bind(null, token)} className="mt-3 grid gap-2">
      <input
        name="customerId" placeholder="CUSTOMER_ID" required autoComplete="off"
        className="rounded-md border t-border t-surface px-2 py-1.5 text-xs"
      />
      <input
        name="apiKey" type="password" placeholder="API 키" required autoComplete="off"
        className="rounded-md border t-border t-surface px-2 py-1.5 text-xs"
      />
      <input
        name="secret" type="password" placeholder="시크릿" required autoComplete="off"
        className="rounded-md border t-border t-surface px-2 py-1.5 text-xs"
      />
      <button type="submit" className="t-cta-primary mt-1 w-fit rounded-full px-4 py-1.5 text-xs font-semibold">
        저장
      </button>
    </form>
  )
}

// task-5-brief §A2 — 설정 카드. 현재값 표시 + 수정 폼(min=70 클라이언트 힌트, 서버 검증은
// ad-settings.ts saveAdConfigForFirm 단일 소스). '입찰'은 lexicon.ts 금지어라 "기준 금액" 어휘로
// 통일한다(ad-settings.ts가 이미 세운 관행 — task-5-brief 지시).
function AdConfigCard({ token, bidAmt, dailyBudget }: { token: string; bidAmt: number | null; dailyBudget: number | null }) {
  return (
    <div className="rounded-xl border t-border t-surface p-5">
      <h3 className="text-sm font-semibold t-ink">광고 설정</h3>
      <p className="mt-2 text-sm t-sub">
        현재 기준 금액 {(bidAmt ?? DEFAULT_BID_DISPLAY).toLocaleString('ko-KR')}원 · 일예산{' '}
        {dailyBudget ? `${dailyBudget.toLocaleString('ko-KR')}원` : '미사용'}
      </p>
      <form action={saveAdConfig.bind(null, token)} className="mt-3 grid gap-2">
        <label className="text-xs t-sub">
          기준 금액(원)
          <input
            name="bidAmt" type="number" min={DEFAULT_BID_DISPLAY} step={1} required
            defaultValue={bidAmt ?? DEFAULT_BID_DISPLAY}
            className="mt-1 block w-full rounded-md border t-border t-surface px-2 py-1.5 text-xs"
          />
        </label>
        <label className="text-xs t-sub">
          일예산(원, 0=미사용)
          <input
            name="dailyBudget" type="number" min={0} step={1} required
            defaultValue={dailyBudget ?? 0}
            className="mt-1 block w-full rounded-md border t-border t-surface px-2 py-1.5 text-xs"
          />
        </label>
        <button type="submit" className="t-cta-primary mt-1 w-fit rounded-full px-4 py-1.5 text-xs font-semibold">
          저장
        </button>
      </form>
    </div>
  )
}

// task-5-brief §A3 — 채널 상태는 표시 전용(등록은 네이버 광고시스템 UI에서만 가능). channelOk는
// saveCredentialsForFirm이 자격증명 검증 시 함께 캐시한 값(firm.adConfig.channelOk)을 그대로 읽는다.
function ChannelStatusCard({ channelOk }: { channelOk: boolean }) {
  return (
    <div className="rounded-xl border t-border t-surface p-5">
      <h3 className="text-sm font-semibold t-ink">비즈채널 상태</h3>
      <p className="mt-2 text-sm t-sub">
        {channelOk ? '연결됨' : '미연결(네이버 광고시스템에서 비즈채널 등록 필요)'}
      </p>
    </div>
  )
}

function PlanItemCard({ item }: { item: PlanItem }) {
  return (
    <li className="rounded-xl border t-border t-surface p-5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold">{item.name}</p>
        <p className="font-mono-label t-sub">{item.slug}</p>
      </div>

      {item.skipped ? (
        <p className="mt-3 text-sm font-medium text-red-600">{skipReasonLabel(item.skipped)}</p>
      ) : (
        <>
          {item.creative && (
            <div className="mt-3 space-y-1">
              <p className="text-sm font-medium">{item.creative.title}</p>
              <p className="text-sm t-sub">{item.creative.description}</p>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {item.variants.map((v) => (
              <span
                key={v.text}
                className="rounded-full px-2.5 py-1 text-xs"
                style={{ background: 'var(--t-line)', color: 'var(--t-sub)' }}
              >
                {v.text}
              </span>
            ))}
          </div>
          {item.droppedVariants.length > 0 && (
            <p className="mt-2 text-xs t-sub">변형 {item.droppedVariants.length}건은 표현 검토로 이번 등록에서 제외됩니다.</p>
          )}
        </>
      )}
    </li>
  )
}

// item.skipped는 CLI/내부 분석용 원시 사유 문자열(lint:banned:… 등)이다. 그대로 노출하면 금칙어
// 자체가 화면에 그대로 찍힐 수 있어(예: lint:banned:환불) 고객 화면에는 원인 범주만 안내한다.
function skipReasonLabel(skipped: string): string {
  if (skipped.startsWith('lint:')) return '소재 문구 표현 검토로 이 항목은 이번 등록에서 제외됩니다.'
  if (skipped.includes('variants:all-dropped')) return '등록 가능한 키워드 변형이 없어 이 항목은 이번 등록에서 제외됩니다.'
  return '이 항목은 이번 등록에서 제외됩니다.'
}

// leads/page.tsx formatDateTime과 동일 구현 — 각 페이지가 자기 렌더링 계약 안에서 독립적으로
// 정확하면 충분한 소규모 로컬 사본(keywords/page.tsx isoWeekKey 중복 관행과 동일 이유).
function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(d)
}
