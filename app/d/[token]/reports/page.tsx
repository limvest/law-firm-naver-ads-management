import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { dailyReports } from '@/lib/db/schema'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import type { ReportRecommendation } from '@/domains/operations/reporting'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '성과 리포트',
  robots: { index: false, follow: false },
}

export default async function DashboardReportsPage({ params }: { params: Promise<{ token: string }> }) {
  if (!process.env.DATABASE_URL) return null
  const { token } = await params
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()
  const reports = await db.select().from(dailyReports).where(eq(dailyReports.firmId, firm.id))
    .orderBy(desc(dailyReports.generatedAt)).limit(60)

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="font-mono-label t-sub">OUTCOME REPORTS</p><h2 className="mt-1 text-2xl font-bold tracking-tight">일일·주간 성과 리포트</h2><p className="mt-2 text-sm t-sub">광고비, 방문, 적격상담, 수임과 SLA 예외를 같은 기준으로 보관합니다.</p></div>
        <div className="flex gap-2"><Link href={`/d/${token}/reports/export?format=csv`} className="rounded-lg border t-border px-4 py-2 text-sm font-semibold">CSV 내보내기</Link><Link href={`/d/${token}/reports/export?format=json`} className="rounded-lg border t-border px-4 py-2 text-sm font-semibold">JSON 내보내기</Link></div>
      </section>
      {reports.length ? <div className="grid gap-4">{reports.map((report) => <ReportCard key={report.id} report={report} />)}</div> : <p className="rounded-xl border border-dashed t-border p-8 text-center text-sm t-sub">아직 생성된 리포트가 없습니다. 일일 파이프라인 완료 후 자동으로 표시됩니다.</p>}
    </div>
  )
}

function ReportCard({ report }: { report: typeof dailyReports.$inferSelect }) {
  const rawMetrics = report.metrics as Record<string, unknown>
  const metric = (key: string) => {
    const value = rawMetrics[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const metricWithFallback = (key: string, fallback: string) => (
    Object.prototype.hasOwnProperty.call(rawMetrics, key) ? metric(key) : metric(fallback)
  )
  const recommendations = reportRecommendations(report)
  const weekly = report.day.startsWith('week:')
  const adImpressions = metricWithFallback('adImpressions', 'impressions')
  const adClicks = metric('adClicks')
  const adSpend = metricWithFallback('adSpend', 'spend')
  const indexedUrls = metricWithFallback('searchIndexedUrls', 'indexedUrls')
  const indexRate = metricWithFallback('searchIndexRate', 'indexRate')
  const qualifiedAttributionRate = metricWithFallback('qualifiedAttributionRate', 'attributionRate')
  const retainedAttributionRate = metric('retainedAttributionRate')
  const costPerQualified = metricWithFallback('costPerAttributedQualified', 'costPerQualified')
  const costPerRetained = metricWithFallback('costPerAttributedRetained', 'costPerRetained')
  const pendingMetrics = [
    'searchImpressions', 'searchClicks', 'searchIndexedUrls', 'adImpressions', 'adClicks', 'adSpend',
    'visits', 'pageViews', 'costPerAttributedQualified', 'costPerAttributedRetained',
  ].filter((key) => metric(key) === null)
  return <article className="rounded-xl border t-border t-surface p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="font-mono-label t-sub">{weekly ? 'WEEKLY' : 'DAILY'} · {report.day.replace('week:', '')}</p><h3 className="mt-1 font-bold">{report.status === 'ready' ? '정상 완료' : report.status === 'warning' ? '확인 필요' : '생성 실패'}</h3></div>
      <time className="text-xs t-sub">{formatDateTime(report.generatedAt)}</time>
    </div>
    <ReportSection title="검색 유입">
      <ReportMetric label="검색 노출" value={count(metric('searchImpressions'))} />
      <ReportMetric label="검색 클릭" value={count(metric('searchClicks'))} />
      <ReportMetric label="색인 URL" value={urlCount(indexedUrls)} />
      <ReportMetric label="색인율" value={percent(indexRate)} />
    </ReportSection>
    <ReportSection title="광고">
      <ReportMetric label="광고 노출" value={count(adImpressions)} />
      <ReportMetric label="광고 클릭" value={count(adClicks)} />
      <ReportMetric label="광고비" value={won(adSpend)} />
      <ReportMetric label="광고 CPC" value={won(metric('adCpc'))} />
    </ReportSection>
    <ReportSection title="상담·수임 결과">
      <ReportMetric label="방문" value={count(metric('visits'))} />
      <ReportMetric label="페이지뷰" value={count(metric('pageViews'))} />
      <ReportMetric label="적격상담" value={count(metric('qualified'))} />
      <ReportMetric label="귀속 적격상담" value={count(metric('attributedQualified'))} />
      <ReportMetric label="적격 귀속률" value={percent(qualifiedAttributionRate)} />
      <ReportMetric label="귀속 적격당 비용" value={won(costPerQualified)} />
      <ReportMetric label="상담" value={count(metric('consultations'))} />
      <ReportMetric label="수임" value={count(metric('retained'))} />
      <ReportMetric label="귀속 수임" value={count(metric('attributedRetained'))} />
      <ReportMetric label="수임 귀속률" value={percent(retainedAttributionRate)} />
      <ReportMetric label="귀속 수임당 비용" value={won(costPerRetained)} />
      <ReportMetric label="미수임" value={count(metric('notRetained'))} />
      <ReportMetric label="종결" value={count(metric('closedMatters'))} />
      <ReportMetric label="결과 대기" value={count(metric('outcomePending'))} />
    </ReportSection>
    <ReportSection title="운영 신호">
      <ReportMetric label="WQRC" value={count(metricWithFallback('wqrc', 'qualifiedResponseCoverage'))} />
      <ReportMetric label="신규 기회" value={count(metric('newOpportunities'))} />
      <ReportMetric label="중지 추천" value={count(metric('pauseRecommendations'))} />
      <ReportMetric label="개선 추천" value={count(metric('improvementRecommendations'))} />
      <ReportMetric label="SLA 위반" value={count(metric('slaBreached'))} />
      <ReportMetric label="후속 지연" value={count(metric('overdueLeads'))} />
      <ReportMetric label="미배정" value={count(metric('unassignedLeads'))} />
    </ReportSection>
    {recommendations.length ? <div className="mt-5 rounded-lg border border-amber-200/60 bg-amber-50/60 px-4 py-3"><p className="text-xs font-semibold text-amber-900">중지·개선·후속 추천</p><ul className="mt-2 space-y-1 text-xs text-amber-900">{recommendations.map((item, index) => <li key={`${item.code}-${item.caseEntityId ?? item.adExecutionId ?? index}`}><span className="font-mono-label mr-2">{item.code}</span>{item.message}</li>)}</ul></div> : null}
    {report.exceptions.length ? <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-xs text-red-700">확인 항목: {report.exceptions.join(' · ')}</p> : <p className="mt-4 text-xs t-sub">기록된 SLA 예외가 없습니다.</p>}
    {pendingMetrics.length ? <p className="mt-2 text-xs t-sub">계산 대기: {pendingMetrics.join(' · ')}. 원천 데이터 동기화 후 채워집니다.</p> : null}
  </article>
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-5"><p className="font-mono-label t-sub">{title}</p><div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div></section>
}

function ReportMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border t-border px-3 py-3"><p className="text-[10px] t-sub">{label}</p><p className="mt-1 font-bold tabular-nums">{value}</p></div>
}

function reportRecommendations(report: typeof dailyReports.$inferSelect): ReportRecommendation[] {
  const value = (report.metrics as Record<string, unknown>).recommendations
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ReportRecommendation => Boolean(item && typeof item === 'object'
    && typeof (item as Record<string, unknown>).code === 'string'
    && typeof (item as Record<string, unknown>).message === 'string'))
}

function won(value: number | null): string { return value === null ? '계산 대기' : `${value.toLocaleString('ko-KR')}원` }
function count(value: number | null): string { return value === null ? '계산 대기' : `${value.toLocaleString('ko-KR')}건` }
function urlCount(value: number | null): string { return value === null ? '계산 대기' : `${value.toLocaleString('ko-KR')}개` }
function percent(value: number | null): string { return value === null ? '계산 대기' : `${(value * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%` }
function formatDateTime(value: Date): string { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(value) }
