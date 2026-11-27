import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import { customerOverviewForFirm } from '@/domains/tenancy/customer-overview'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '결과 개요',
  robots: { index: false, follow: false },
}

export default async function DashboardOverviewPage(
  { params }: { params: Promise<{ token: string }> },
) {
  if (!process.env.DATABASE_URL) return null

  const { token } = await params
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()
  const overview = await customerOverviewForFirm(db, firm)
  const { metrics, leadQueue, search, publications, responseCoverage } = overview
  const periodLabel = `${formatDate(overview.period.since)}–${formatDate(overview.period.until)}`

  return (
    <div className="space-y-10">
      <section>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono-label t-sub">CUSTOMER OUTCOMES · LAST {overview.period.days} DAYS</p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight">광고비가 상담과 수임으로 이어진 흐름</h2>
            <p className="mt-2 text-sm t-sub">{periodLabel} · {firm.name} 데이터만 집계했습니다.</p>
          </div>
          <Link href={`/d/${token}/funnel`} className="rounded-lg border t-border px-4 py-2 text-sm font-semibold hover:t-surface">
            사건별 퍼널 보기
          </Link>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard label="광고비" value={formatWon(metrics.spend)} sub={`${metrics.impressions.toLocaleString('ko-KR')}회 노출 · ${metrics.adClicks.toLocaleString('ko-KR')}회 클릭`} />
          <MetricCard label="방문 세션" value={`${metrics.visits.toLocaleString('ko-KR')}건`} sub={`상담 신청 ${metrics.leads.toLocaleString('ko-KR')}건`} />
          <MetricCard label="적격 상담" value={`${metrics.qualified.toLocaleString('ko-KR')}건`} sub={metrics.costPerQualified === null ? '비용당 적격상담 계산 대기' : `건당 ${formatWon(Math.round(metrics.costPerQualified))}`} />
          <MetricCard label="수임" value={`${metrics.retained.toLocaleString('ko-KR')}건`} sub={metrics.costPerRetained === null ? '수임 결과 입력 대기' : `건당 ${formatWon(Math.round(metrics.costPerRetained))}`} accent />
        </div>

        <div className="mt-4 grid gap-4 rounded-xl border border-[#245bff]/20 bg-[#245bff]/[.045] px-5 py-4 sm:grid-cols-[auto_1fr] sm:items-center">
          <div>
            <p className="font-mono-label text-[#245bff]">WQRC · WEEKLY QUALIFIED RESPONSE COVERAGE</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-[#245bff]">{metrics.wqrc.toLocaleString('ko-KR')}건</p>
          </div>
          <div className="text-sm leading-6 t-sub">
            <p>이번 기간에 처음으로 근거·브랜드·canonical·상담 CTA 검증을 통과하고 SEO 또는 승인 광고 경로가 준비된 사건입니다.</p>
            <p className="mt-1 text-xs">SEO {responseCoverage.seo.toLocaleString('ko-KR')} · 승인 광고 {responseCoverage.approvedAd.toLocaleString('ko-KR')} · 두 경로 모두 {responseCoverage.both.toLocaleString('ko-KR')}</p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border t-border t-surface px-5 py-4 text-sm">
          <strong>귀속 가능한 적격 상담 {metrics.attributedQualified.toLocaleString('ko-KR')}건</strong>
          <span className="mx-2 t-sub">·</span>
          <span className="t-sub">귀속률 {formatPercent(metrics.attributionRate)}</span>
          <span className="mx-2 t-sub">·</span>
          <span className="t-sub">귀속 가능한 수임 {metrics.attributedRetained.toLocaleString('ko-KR')}건</span>
          <p className="mt-2 text-xs t-sub">전화 클릭이나 폼 제출을 수임으로 간주하지 않습니다. 담당자가 적격 여부와 수임 결과를 기록한 건만 표시합니다.</p>
        </div>
      </section>

      <section>
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-mono-label t-sub">TODAY&apos;S WORK</p>
            <h3 className="mt-1 text-xl font-bold">오늘 먼저 처리할 항목</h3>
          </div>
          <Link href={`/d/${token}/leads`} className="text-sm font-semibold t-accent">상담 관리 열기 →</Link>
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <DashboardPanel title="신규·지연 리드" badge={`${leadQueue.items.length}건 표시`}>
            <div className="grid grid-cols-4 gap-2">
              <MiniMetric label="신규" value={leadQueue.newCount} />
              <MiniMetric label="후속 지연" value={leadQueue.overdue} critical={leadQueue.overdue > 0} />
              <MiniMetric label="SLA 초과" value={leadQueue.slaBreached} critical={leadQueue.slaBreached > 0} />
              <MiniMetric label="미배정" value={leadQueue.unassigned} />
            </div>
            {leadQueue.items.length ? (
              <ul className="mt-4 divide-y t-border">
                {leadQueue.items.map((lead) => (
                  <li key={lead.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{lead.slug ?? '사건명 미지정'} · {lead.status === 'new' ? '신규' : lead.status}</p>
                      <p className="mt-1 text-xs t-sub">{lead.assignedLawyer ?? '담당자 미배정'} · {lead.slaBreached ? '최초 응답 SLA 초과' : lead.overdue ? '후속 연락 지연' : lead.priority}</p>
                    </div>
                    <Link href={`/d/${token}/leads/${lead.id}`} className="shrink-0 rounded-lg border t-border px-3 py-2 text-xs font-semibold">처리</Link>
                  </li>
                ))}
              </ul>
            ) : <EmptyState>지금 처리할 신규·지연 리드가 없습니다.</EmptyState>}
          </DashboardPanel>

          <DashboardPanel title="새 대응 추천" badge={`${overview.opportunities.length}건`}>
            {overview.opportunities.length ? (
              <ul className="divide-y t-border">
                {overview.opportunities.map((item) => (
                  <li key={item.caseEntityId} className="py-3">
                    <div className="flex items-center justify-between gap-3">
                      <strong className="truncate text-sm">{item.canonicalName}</strong>
                      <span className="font-mono-label t-accent">{(item.score / 100).toFixed(0)}점</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 t-sub">{item.reasons.join(' · ') || '기회점수 입력값을 검토하세요.'}</p>
                  </li>
                ))}
              </ul>
            ) : <EmptyState>승인된 고신호 사건 추천이 아직 없습니다.</EmptyState>}
            <Link href={`/d/${token}/keywords`} className="mt-4 inline-flex text-sm font-semibold t-accent">전체 사건명 커버리지 →</Link>
          </DashboardPanel>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <DashboardPanel title="광고 운영 예외" badge={`${overview.adAttention.length}건`}>
          {overview.adAttention.length ? (
            <ul className="divide-y t-border">
              {overview.adAttention.slice(0, 6).map((item) => (
                <li key={item.adExecutionId} className="py-3">
                  <div className="flex items-center justify-between gap-3 text-sm"><strong>{item.canonicalName}</strong><span className="text-xs t-sub">{formatWon(item.cost)}</span></div>
                  <p className="mt-1 text-xs leading-5 t-sub">{item.reason}</p>
                </li>
              ))}
            </ul>
          ) : <EmptyState>심사 또는 성과 기준으로 확인할 광고가 없습니다.</EmptyState>}
          <Link href={`/d/${token}/ads`} className="mt-4 inline-flex text-sm font-semibold t-accent">광고 상태와 승인 범위 →</Link>
        </DashboardPanel>

        <DashboardPanel title="검색 노출·발행 상태" badge={`${search.providers.length}개 연동`}>
          <div className="grid grid-cols-3 gap-2">
            <MiniMetric label="공개" value={publications.live} />
            <MiniMetric label="발행 대기" value={publications.pending} />
            <MiniMetric label="차단·실패" value={publications.blockedOrFailed} critical={publications.blockedOrFailed > 0} />
          </div>
          {search.providers.length ? (
            <ul className="mt-4 divide-y t-border">
              {search.providers.map((provider) => (
                <li key={provider.provider} className="py-3 text-sm">
                  <div className="flex items-center justify-between gap-3"><strong>{provider.providerName === 'naver' ? '네이버' : 'Google'}</strong><span>{provider.indexedUrls}/{provider.indexableUrls} 색인</span></div>
                  <p className="mt-1 text-xs t-sub">노출 {provider.impressions?.toLocaleString('ko-KR') ?? '—'} · 클릭 {provider.clicks?.toLocaleString('ko-KR') ?? '—'} · 갱신 추천 {provider.actionableRefreshRecommendations.length}건</p>
                </li>
              ))}
            </ul>
          ) : <EmptyState>서치어드바이저 또는 Search Console 연동 데이터가 아직 없습니다.</EmptyState>}
        </DashboardPanel>
      </section>
    </div>
  )
}

function MetricCard({ label, value, sub, accent = false }: { label: string; value: string; sub: string; accent?: boolean }) {
  return <article className="rounded-xl border t-border t-surface p-5"><p className="font-mono-label t-sub">{label}</p><p className={`mt-2 text-3xl font-bold tabular-nums tracking-tight ${accent ? 't-accent' : ''}`}>{value}</p><p className="mt-2 text-xs t-sub">{sub}</p></article>
}

function MiniMetric({ label, value, critical = false }: { label: string; value: number; critical?: boolean }) {
  return <div className="rounded-lg border t-border p-3"><p className="text-[10px] t-sub">{label}</p><p className={`mt-1 text-xl font-bold tabular-nums ${critical ? 'text-red-600' : ''}`}>{value.toLocaleString('ko-KR')}</p></div>
}

function DashboardPanel({ title, badge, children }: { title: string; badge: string; children: React.ReactNode }) {
  return <article className="rounded-xl border t-border t-surface p-6"><div className="flex items-center justify-between gap-3"><h3 className="font-bold">{title}</h3><span className="rounded-full border t-border px-2.5 py-1 text-[10px] t-sub">{badge}</span></div><div className="mt-4">{children}</div></article>
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 rounded-lg border border-dashed t-border px-4 py-6 text-center text-sm t-sub">{children}</p>
}

function formatWon(value: number): string {
  return `${Math.max(0, value).toLocaleString('ko-KR')}원`
}

function formatPercent(value: number | null): string {
  return value === null ? '계산 대기' : `${(value * 100).toFixed(1)}%`
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' }).format(value)
}
