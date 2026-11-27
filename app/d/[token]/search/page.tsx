import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import {
  getSearchDetailForFirm,
  type SearchDetail,
  type SearchDetailIndexStatus,
  type SearchDetailMetrics,
} from '@/domains/search'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '검색 인텔리전스',
  robots: { index: false, follow: false },
}

export default async function DashboardSearchDetailPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  if (!process.env.DATABASE_URL) return <SearchDetailEmpty title="검색 인텔리전스 연결 대기" />

  const { token } = await params
  let firm
  try {
    firm = await resolveFirmByToken(getDb(), token)
  } catch {
    return <SearchDetailError />
  }
  if (!firm) notFound()

  let detail: SearchDetail
  try {
    detail = await getSearchDetailForFirm(getDb(), firm, { asOf: new Date() })
  } catch {
    return <SearchDetailError />
  }

  return <SearchDetailView detail={detail} firmName={firm.name} />
}

function SearchDetailView({ detail, firmName }: { detail: SearchDetail; firmName: string }) {
  return (
    <div className="space-y-10">
      <section>
        <p className="font-mono-label t-sub">SEARCH INTELLIGENCE · CUSTOMER DATA</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">검색 노출과 콘텐츠 상태</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 t-sub">
          {firmName}에 연결된 검색 제공자 관측과 이 사무소 소유 publication만 표시합니다.
          실제로 저장된 기간·지표·확인 시각이 없는 값은 계산하지 않습니다.
        </p>
      </section>

      <section aria-label="검색 제공자 연동" className="space-y-4">
        <SectionHeading eyebrow="PROVIDER CONNECTIONS" title="검색 제공자 연동" />
        {detail.integrations.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {detail.integrations.map((integration) => (
              <article key={integration.id} className="rounded-xl border t-border t-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono-label t-accent">{providerLabel(integration.providerName)}</p>
                    <h3 className="mt-1 font-semibold break-all">{integration.siteUrl}</h3>
                  </div>
                  <StatusBadge value={integration.status} />
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <SmallMetric label="색인 대상" value={countLabel(integration.indexableUrls)} />
                  <SmallMetric label="색인됨" value={countLabel(integration.indexedUrls)} />
                  <SmallMetric label="노출" value={metricLabel(integration.metrics.impressions)} />
                  <SmallMetric label="클릭" value={metricLabel(integration.metrics.clicks)} />
                </div>
                <p className="mt-4 text-xs t-sub">
                  마지막 동기화 {formatDateTime(integration.lastSyncedAt)} · 마지막 확인 {formatDateTime(integration.checkedAt)}
                </p>
                {integration.lastError && (
                  <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    연동 오류: {integration.lastError}
                  </p>
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState>연결된 검색 제공자가 없습니다. 실제 연동 후 관측 데이터가 표시됩니다.</EmptyState>
        )}
      </section>

      <section aria-label="publication 색인 상태" className="space-y-4">
        <SectionHeading eyebrow="PUBLICATION INDEX" title="publication별 색인 상태" />
        <div className="overflow-x-auto rounded-xl border t-border t-surface">
          {detail.publications.length ? (
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead>
                <tr className="border-b t-border">
                  <th className="px-4 py-3 font-mono-label t-sub">URL · 사건명</th>
                  <th className="px-4 py-3 font-mono-label t-sub">콘텐츠</th>
                  <th className="px-4 py-3 font-mono-label t-sub">제공자</th>
                  <th className="px-4 py-3 font-mono-label t-sub">색인 상태</th>
                  <th className="px-4 py-3 font-mono-label t-sub">제외 이유 · 확인</th>
                </tr>
              </thead>
              <tbody>
                {detail.publications.map((publication) => publication.indexStatuses.length
                  ? publication.indexStatuses.map((status) => (
                    <PublicationStatusRow key={`${status.integrationId}:${status.publicationId}`} publication={publication} status={status} />
                  ))
                  : (
                    <tr key={publication.publicationId} className="border-b t-border last:border-0 align-top">
                      <td className="px-4 py-4" colSpan={5}>
                        <PublicationIdentity publication={publication} />
                        <p className="mt-2 text-xs t-sub">연결된 제공자의 색인 관측이 아직 없습니다.</p>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <EmptyState>색인 대상 SEO publication이 없습니다. 실제 publication과 제공자 관측이 준비되면 표시됩니다.</EmptyState>
          )}
        </div>
      </section>

      <section aria-label="검색어 성과" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionHeading eyebrow="QUERY PERFORMANCE" title="검색어별 기간 성과" />
          <p className="text-xs t-sub">기간 {formatPeriod(detail.period)}</p>
        </div>
        <div className="overflow-x-auto rounded-xl border t-border t-surface">
          {detail.queryMetrics.length ? (
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead>
                <tr className="border-b t-border">
                  <th className="px-4 py-3 font-mono-label t-sub">검색어</th>
                  <th className="px-4 py-3 font-mono-label t-sub">대상 URL · 사건명</th>
                  <th className="px-4 py-3 text-right font-mono-label t-sub">기간</th>
                  <th className="px-4 py-3 text-right font-mono-label t-sub">노출</th>
                  <th className="px-4 py-3 text-right font-mono-label t-sub">클릭</th>
                  <th className="px-4 py-3 text-right font-mono-label t-sub">CTR</th>
                  <th className="px-4 py-3 text-right font-mono-label t-sub">평균순위</th>
                </tr>
              </thead>
              <tbody>
                {detail.queryMetrics.map((row) => (
                  <tr key={`${row.integrationId}:${row.publicationId ?? 'site'}:${row.query}`} className="border-b t-border last:border-0 align-top">
                    <td className="px-4 py-4">
                      <strong>{row.query}</strong>
                      <p className="mt-1 text-[11px] t-sub">{providerLabel(row.providerName)}</p>
                    </td>
                    <td className="max-w-[360px] px-4 py-4">
                      {row.url ? <a href={row.url} target="_blank" rel="noreferrer" className="break-all font-medium t-accent">{row.url}</a> : <span className="t-sub">사이트 전체 · URL 미지정</span>}
                      <p className="mt-1 text-xs t-sub">{row.caseName ?? (row.publicationId ? '사건명 미확인' : 'publication 미지정')}</p>
                    </td>
                    <td className="px-4 py-4 text-right text-xs t-sub">{formatPeriod(row.period)}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{row.impressions.toLocaleString('ko-KR')}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{row.clicks.toLocaleString('ko-KR')}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{formatPercent(row.ctr)}</td>
                    <td className="px-4 py-4 text-right tabular-nums">{formatPosition(row.averagePosition)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState>저장된 검색어 성과가 없습니다. 제공자 동기화 후 실제 노출·클릭·순위가 표시됩니다.</EmptyState>
          )}
        </div>
      </section>

      <section aria-label="refresh 추천" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionHeading eyebrow="CONTENT REFRESH" title="콘텐츠 refresh 추천" />
          <p className="text-xs t-sub">최근 확인 {formatDateTime(detail.latestCheckedAt)}</p>
        </div>
        {detail.actionableRefreshRecommendations.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {detail.actionableRefreshRecommendations.map((recommendation) => (
              <article key={`${recommendation.integrationId}:${recommendation.publicationId}`} className="rounded-xl border t-border t-surface p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono-label t-accent">{recommendationLabel(recommendation.recommendation)}</p>
                    <h3 className="mt-1 truncate font-semibold">{recommendation.caseName ?? '사건명 미확인'}</h3>
                  </div>
                  <span className="shrink-0 rounded-full border t-border px-2 py-1 text-[11px]">{priorityLabel(recommendation.priority)}</span>
                </div>
                <p className="mt-3 break-all text-xs t-sub">{recommendation.url}</p>
                <p className="mt-3 text-sm">사유 {recommendation.reasons.map(refreshReasonLabel).join(' · ') || '기록된 사유 없음'}</p>
                <p className="mt-3 text-xs t-sub">
                  콘텐츠 v{recommendation.contentVersion}
                  {recommendation.latestContentVersion !== null && recommendation.latestContentVersion !== recommendation.contentVersion ? ` · 최신 v${recommendation.latestContentVersion}` : ''}
                  {' · '}확인 {formatDateTime(recommendation.checkedAt)}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState>현재 저장된 관측에서 처리할 refresh 추천이 없습니다. 관측이 없다는 뜻은 아니며, 추가 데이터가 쌓이면 다시 계산합니다.</EmptyState>
        )}
      </section>
    </div>
  )
}

function PublicationStatusRow({
  publication,
  status,
}: {
  publication: SearchDetail['publications'][number]
  status: SearchDetailIndexStatus
}) {
  return (
    <tr className="border-b t-border last:border-0 align-top">
      <td className="px-4 py-4"><PublicationIdentity publication={publication} /></td>
      <td className="px-4 py-4 text-xs t-sub">
        <p>v{publication.contentVersion} · {publication.templateVersion}</p>
        <p className="mt-1">최신 {publication.latestContentVersion === null ? '확인 불가' : `v${publication.latestContentVersion}`}</p>
        <p className="mt-1">콘텐츠 수정 {formatDateTime(publication.contentUpdatedAt)}</p>
      </td>
      <td className="px-4 py-4 text-xs">
        <p className="font-semibold">{providerLabel(status.providerName)}</p>
        <p className="mt-1 break-all t-sub">integration {status.integrationId}</p>
      </td>
      <td className="px-4 py-4"><StatusBadge value={statusLabel(status.status)} positive={status.indexed} /></td>
      <td className="px-4 py-4 text-xs t-sub">
        <p>{status.exclusionReason ?? (status.status === 'excluded' ? '제외 이유 기록 없음' : '제외 아님')}</p>
        <p className="mt-1">확인 {formatDateTime(status.checkedAt)}</p>
      </td>
    </tr>
  )
}

function PublicationIdentity({ publication }: { publication: SearchDetail['publications'][number] }) {
  return (
    <div className="min-w-[300px]">
      <a href={publication.url} target="_blank" rel="noreferrer" className="break-all font-medium t-accent">{publication.url}</a>
      <p className="mt-1 text-xs t-sub">{publication.caseName ?? '사건명 미확인'}</p>
      <p className="mt-1 text-[11px] t-sub">publication {publication.publicationId} · asset {publication.contentAssetId}</p>
    </div>
  )
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div><p className="font-mono-label t-sub">{eyebrow}</p><h3 className="mt-1 text-xl font-bold">{title}</h3></div>
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border t-border p-3"><p className="text-[10px] t-sub">{label}</p><p className="mt-1 font-bold tabular-nums">{value}</p></div>
}

function StatusBadge({ value, positive = false }: { value: string; positive?: boolean }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${positive ? 'border-emerald-300 text-emerald-700' : 't-border t-sub'}`}>{value}</span>
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed t-border p-8 text-center text-sm t-sub">{children}</p>
}

function SearchDetailEmpty({ title }: { title: string }) {
  return <div className="rounded-xl border border-dashed t-border p-8 text-center text-sm t-sub">{title} · 실제 데이터 연결 후 표시됩니다.</div>
}

function SearchDetailError() {
  return <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-sm text-red-700">검색 인텔리전스 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>
}

function providerLabel(provider: string): string {
  return provider === 'google' ? 'Google Search Console' : '네이버 서치어드바이저'
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    unknown: '관측 없음',
    discovered: '발견됨',
    crawled: '크롤링됨',
    indexed: '색인됨',
    excluded: '제외됨',
    error: '오류',
  }
  return labels[status] ?? status
}

function recommendationLabel(value: string): string {
  return value === 'investigate_index' ? '색인 원인 확인' : value === 'refresh' ? '콘텐츠 refresh' : '모니터링'
}

function priorityLabel(value: string): string {
  return value === 'high' ? '높음' : value === 'medium' ? '중간' : '낮음'
}

function refreshReasonLabel(value: string): string {
  return value === 'stale_evidence' ? '확인 데이터 오래됨' : value === 'content_decline' ? '성과 하락' : '색인 오류'
}

function countLabel(value: number): string { return value.toLocaleString('ko-KR') }
function metricLabel(value: number | null): string { return value === null ? '—' : value.toLocaleString('ko-KR') }
function formatPercent(value: number | null): string { return value === null ? '—' : `${(value * 100).toFixed(1)}%` }
function formatPosition(value: number | null): string { return value === null ? '—' : value.toFixed(2) }
function formatDateTime(value: string | null): string {
  if (!value) return '기록 없음'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(date)
    : '기록 없음'
}
function formatPeriod(period: { since: string | null; until: string | null }): string {
  if (!period.since && !period.until) return '확인 가능한 기간 없음'
  if (period.since === period.until) return period.since ?? '확인 가능한 기간 없음'
  return `${period.since ?? '시작일 없음'}–${period.until ?? '종료일 없음'}`
}
