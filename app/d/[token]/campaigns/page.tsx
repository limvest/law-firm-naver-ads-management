import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import { getSearchCampaignSummary } from '@/lib/dashboard/search-campaign'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: '검색광고 현황', robots: { index: false, follow: false } }

const REASON_LABEL: Record<string, string> = {
  url_fragment: 'URL 조각',
  too_long: '25자 초과',
  boilerplate: 'SEO 문장',
  generic: '일반명사',
  domain_debris: '도메인 찌꺼기',
  random_ascii: '난수 문자열',
  symbol_heavy: '깨진 문자',
  too_short: '너무 짧음',
  no_word: '유효 문자 없음',
  repetition: '반복 문자',
}

export default async function SearchCampaignPage({ params }: { params: Promise<{ token: string }> }) {
  if (!process.env.DATABASE_URL) return null
  const { token } = await params
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()
  const data = await getSearchCampaignSummary(db, firm)
  const progress = data.selectedCount ? Math.min(100, data.registeredKeywords / data.selectedCount * 100) : 0

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono-label t-sub">NAVER EXACT SEARCH</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">사건명 검색광고 현황</h2>
          <p className="mt-2 text-sm t-sub">실제 사건명만 등록하고 각 사건의 전용 서브도메인으로 연결합니다.</p>
        </div>
        <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800">
          {data.registeredKeywords >= data.selectedCount && data.selectedCount > 0 ? '등록 완료 · 집행 정지' : '등록 준비 중'}
        </span>
      </section>

      <section className="rounded-2xl border t-border t-surface p-6">
        <div className="flex items-center justify-between gap-4 text-sm">
          <strong>네이버 등록 진행률</strong>
          <span className="tabular-nums t-sub">{data.registeredKeywords.toLocaleString('ko-KR')} / {data.selectedCount.toLocaleString('ko-KR')}</span>
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-[#e7ebef]">
          <div className="h-full rounded-full bg-[#03c75a] transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-2 text-xs t-sub">{progress.toFixed(1)}% · {data.shardCount}개 광고그룹 · 그룹당 {data.shardMin}–{data.shardMax}개</p>
      </section>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Metric label="원본 사건 페이지" value={data.sourceCount} suffix="개" />
        <Metric label="실제 등록 키워드" value={data.selectedCount} suffix="개" accent />
        <Metric label="자기경쟁 중복 제거" value={data.duplicateCount} suffix="개" />
        <Metric label="쓰레기·규격 제외" value={data.rejectedCount} suffix="개" />
      </section>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MoneyMetric label="30일 광고비" value={data.stats.cost} />
        <Metric label="30일 클릭" value={data.stats.clicks} suffix="회" />
        <Metric label="30일 방문" value={data.traffic.visits} suffix="명" />
        <Metric label="30일 문의" value={data.traffic.leads} suffix="건" accent />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Panel title="심사·오류">
          <div className="grid grid-cols-3 gap-3">
            <SmallMetric label="심사 대기" value={data.reviewCounts.pending ?? 0} />
            <SmallMetric label="승인" value={data.reviewCounts.approved ?? 0} />
            <SmallMetric label="반려·오류" value={(data.reviewCounts.rejected ?? 0) + data.failedKeywords} critical />
          </div>
          <p className="mt-4 text-xs leading-5 t-sub">엔티티: 캠페인 {data.entityCounts.campaign ?? 0} · 광고그룹 {data.entityCounts.adgroup ?? 0} · 키워드 {data.entityCounts.keyword ?? 0} · 소재 {data.entityCounts.ad ?? 0}</p>
        </Panel>
        <Panel title="필터 제외 근거">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {data.rejectionReasons.map((row) => (
              <li key={row.reason} className="flex items-center justify-between border-b t-border py-2">
                <span className="t-sub">{REASON_LABEL[row.reason] ?? row.reason}</span>
                <strong className="tabular-nums">{row.count.toLocaleString('ko-KR')}</strong>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Panel title="관심도·문의">
          <div className="grid grid-cols-3 gap-3">
            <SmallMetric label="고관심 방문" value={data.traffic.highIntent} />
            <SmallMetric label="전화·카톡·폼" value={data.traffic.contactActions} />
            <SmallMetric label="신규 문의" value={data.traffic.leads} />
          </div>
        </Panel>
        <Panel title="비용 상위 키워드">
          {data.topKeywords.length ? (
            <ol className="divide-y t-border text-sm">
              {data.topKeywords.map((row, index) => (
                <li key={row.name} className="flex items-center justify-between gap-4 py-2.5">
                  <span className="min-w-0 truncate"><b className="mr-2 t-sub">{index + 1}</b>{row.name}</span>
                  <span className="shrink-0 tabular-nums t-sub">{row.clicks}클릭 · {won(row.cost)}</span>
                </li>
              ))}
            </ol>
          ) : <p className="text-sm t-sub">아직 집행 데이터가 없습니다.</p>}
        </Panel>
      </section>
    </div>
  )
}

function Metric({ label, value, suffix, accent = false }: { label: string; value: number; suffix: string; accent?: boolean }) {
  return <article className="rounded-xl border t-border t-surface p-5"><p className="text-xs t-sub">{label}</p><p className={`mt-2 text-3xl font-bold tabular-nums ${accent ? 'text-[#03a94f]' : ''}`}>{value.toLocaleString('ko-KR')}<small className="ml-1 text-sm font-medium t-sub">{suffix}</small></p></article>
}
function MoneyMetric({ label, value }: { label: string; value: number }) { return <article className="rounded-xl border t-border t-surface p-5"><p className="text-xs t-sub">{label}</p><p className="mt-2 text-3xl font-bold tabular-nums">{won(value)}</p></article> }
function SmallMetric({ label, value, critical = false }: { label: string; value: number; critical?: boolean }) { return <div className="rounded-lg border t-border p-3"><p className="text-[10px] t-sub">{label}</p><p className={`mt-1 text-xl font-bold tabular-nums ${critical && value ? 'text-red-600' : ''}`}>{value.toLocaleString('ko-KR')}</p></div> }
function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <article className="rounded-xl border t-border t-surface p-6"><h3 className="font-bold">{title}</h3><div className="mt-4">{children}</div></article> }
function won(value: number) { return `${Math.max(0, value).toLocaleString('ko-KR')}원` }
