import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/client'
import { firmPublicReadinessErrors, listProvisionedFirms } from '@/lib/engine/provision'
import { normalizeSiteTemplate, SITE_TEMPLATES } from '@/lib/site-templates'
import {
  decideAlertFromConsole,
  decideAgentActionProposalFromConsole,
  decideCaseApprovalFromConsole,
  createCollectorSourceFromConsole,
  grantCollectorSourceFromConsole,
  provisionFirmFromConsole,
  requeueJobFromConsole,
  reviewSourceRequestFromConsole,
  runDatabaseReviewFromConsole,
  runParserBuilderFromConsole,
  setFirmPublicReadyFromConsole,
  setFirmSourceGrantStatusFromConsole,
  toggleCollectorSourceFromConsole,
} from './actions'
import type { OperationsControlPlane } from '@/domains/operations/control-plane'
import { listSourceRequestsForOperator } from '@/lib/dashboard/source-requests'
import { listCollectorSources, type CollectorSourceRow } from '@/domains/intelligence/source-registry'
import { listFirmSourceGrants } from '@/lib/dashboard/firm-source-grants'
import { loadUnifiedSystemStats, type UnifiedSystemStats } from '@/lib/dashboard/unified-system-stats'
import { listAllFirmCollectionRuns } from '@/lib/dashboard/firm-collection-runs'
import { loadOperatorOverview, type OperatorOverview } from '@/lib/dashboard/operator-overview'
import { ADMIN_SESSION_COOKIE, validAdminSession } from '@/lib/admin-auth'
import { detectDatabaseReviewNeed, type DatabaseReviewDecision } from '@/domains/intelligence/database-review-agent'
import { listAgentExecutions, type AgentExecutionRow } from '@/lib/dashboard/agent-executions'
import { AgentActionButton } from '@/components/operator/agent-action-button'
import { listAgentActionProposals, type AgentActionProposalView } from '@/domains/intelligence/agent-action-approval'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '총운영자 콘솔',
  robots: { index: false, follow: false },
}

export default async function OperatorPage({
  searchParams,
}: {
    searchParams: Promise<{ token?: string; section?: string; created?: string; enrolled?: string; updated?: string; error?: string; action?: string; q?: string; status?: string; sort?: string; page?: string }>
}) {
  const query = await searchParams
  const section = ['overview', 'agents', 'cases', 'firms', 'sources', 'runs'].includes(query.section ?? '') ? query.section! : 'overview'
  const sectionMeta: Record<string, { eyebrow: string; title: string; description: string }> = {
    overview: { eyebrow: 'OVERVIEW', title: '통합 현황', description: '전체 운영 지표와 최근 수집 상태를 한 화면에서 확인합니다.' },
    agents: { eyebrow: 'AGENT CONTROL', title: '에이전트 제어', description: '세 에이전트의 역할·호출 조건·최근 상태를 확인하고 필요한 작업만 실행합니다.' },
    cases: { eyebrow: 'CASES', title: '사건·관측', description: '수집된 사건명, 관측 수와 최신 근거 원문을 확인합니다.' },
    firms: { eyebrow: 'FIRMS', title: '법률사무소', description: '고객 운영실 계정을 개설하고 공개 상태를 관리합니다.' },
    sources: { eyebrow: 'SOURCES', title: '수집소스', description: '수집 페이지와 법률사무소별 사용 승인을 관리합니다.' },
    runs: { eyebrow: 'RUNS', title: '수집 실행', description: '클릭 기반 수집 요청의 실행 상태와 결과를 확인합니다.' },
  }
  if (query.token) redirect(`/operator/auth?token=${encodeURIComponent(query.token)}`)
  const secret = process.env.ADMIN_TOKEN
  const session = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value
  if (!validAdminSession(session, secret)) redirect('/operator/login')

  if (!process.env.DATABASE_URL) {
    return <OperatorShell><div className="rounded-2xl border border-white/10 bg-white/[.04] p-8 text-white/65">데이터베이스 연결 후 신규 사무소 개설 기능이 활성화됩니다.</div></OperatorShell>
  }
  const db = getDb()
  const needsFirms = section === 'firms' || section === 'sources'
  const emptyStats: UnifiedSystemStats = {
    firms: 0, sources: 0, keywords: 0, observations: 0, pages: 0,
    assignments: 0, visitors: 0, inquiries: 0, collectionRuns: 0,
  }
  const emptyOverview: OperatorOverview = {
    totals: { keywords: 0, observations: 0, todayKeywords: 0, visitors: 0, inquiries: 0, liveAds: 0 },
    statusCounts: [], cases: [], casesTotal: 0, runs: [], keywordCoverage: null,
  }
  const emptyReviewDecision: DatabaseReviewDecision = { needed: false, checkedAt: new Date().toISOString(), findings: [] }
  const casePage = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1)
  const casePageSize = 50
  const [items, stats, overview, sourceRequests, collectorSources, sourceGrants, collectionRuns, reviewDecision, agentExecutions, agentActionProposals] = await Promise.all([
    needsFirms ? listProvisionedFirms(db) : Promise.resolve([]),
    section === 'overview' ? loadUnifiedSystemStats(db) : Promise.resolve(emptyStats),
    section === 'overview'
      ? loadOperatorOverview(db, { includeCases: true, caseLimit: 12 })
      : section === 'cases'
        ? loadOperatorOverview(db, { includeCases: true, caseLimit: casePageSize, caseOffset: (casePage - 1) * casePageSize, caseQuery: query.q, caseStatus: query.status, caseSort: query.sort })
        : Promise.resolve(emptyOverview),
    section === 'sources' ? listSourceRequestsForOperator(db) : Promise.resolve([]),
    section === 'sources' || section === 'overview' || section === 'agents' ? listCollectorSources(db) : Promise.resolve([]),
    section === 'sources' ? listFirmSourceGrants(db) : Promise.resolve([]),
    section === 'runs' ? listAllFirmCollectionRuns(db) : Promise.resolve([]),
    section === 'agents' ? detectDatabaseReviewNeed(db) : Promise.resolve(emptyReviewDecision),
    section === 'agents' ? listAgentExecutions(db, 30) : Promise.resolve([]),
    section === 'agents' ? listAgentActionProposals(db) : Promise.resolve([]),
  ])
  return (
    <OperatorShell>
      {query.created && <div className="mb-6 rounded-xl border border-[#70e3a1]/35 bg-[#70e3a1]/10 px-4 py-3 text-sm text-[#9df0bd]">{query.created} 사무소와 ID 로그인 계정이 개설되었습니다{/^\d+$/.test(query.enrolled ?? '') ? ` · 공용 사건명 ${Number(query.enrolled).toLocaleString('ko-KR')}건 편입` : ''}.</div>}
      {query.updated && <div className="mb-6 rounded-xl border border-[#70e3a1]/35 bg-[#70e3a1]/10 px-4 py-3 text-sm text-[#9df0bd]">{query.updated} 공개 상태가 변경되었습니다.</div>}
      {query.error && <OperatorErrorNotice error={query.error} />}
      {query.action && <OperatorActionNotice action={query.action} />}

      <nav aria-label="운영자 콘솔 메뉴" className="sticky top-2 z-20 mb-8 flex gap-2 overflow-x-auto rounded-2xl border border-white/10 bg-[#0d171f]/[.98] p-2 shadow-2xl backdrop-blur sm:grid sm:grid-cols-6 sm:overflow-visible">
        {[
          ['overview', '1. 통합 현황'],
          ['agents', '2. 에이전트 제어'],
          ['cases', '3. 사건·관측'],
          ['firms', '4. 법률사무소'],
          ['sources', '5. 수집소스'],
          ['runs', '6. 수집 실행'],
        ].map(([key, label]) => <a key={key} href={`/operator?section=${key}#operator-content`} aria-current={section === key ? 'page' : undefined} className={`min-w-[7.75rem] shrink-0 rounded-xl px-3 py-3 text-center text-sm font-black transition sm:min-w-0 ${section === key ? 'bg-[#70e3a1] text-[#091117]' : 'text-white/65 hover:bg-white/5 hover:text-white'}`}>{label}</a>)}
      </nav>

      <section id="operator-content" className="mb-6 scroll-mt-36 border-l-2 border-[#70e3a1] pl-4">
        <p className="text-[10px] font-black tracking-[.18em] text-[#70e3a1]">{sectionMeta[section].eyebrow}</p>
        <h2 className="mt-1 text-2xl font-black">{sectionMeta[section].title}</h2>
        <p className="mt-1 text-sm text-white/65">{sectionMeta[section].description}</p>
      </section>

      {section === 'overview' ? <OperatorOverviewPanel data={overview} stats={stats} sources={collectorSources} /> : null}
      {section === 'agents' ? <AgentControlPanel sources={collectorSources} review={reviewDecision} executions={agentExecutions} proposals={agentActionProposals} /> : null}
      {section === 'cases' ? <OperatorCasesPanel data={overview} query={query} page={casePage} pageSize={casePageSize} /> : null}

      {section === 'sources' ? <>
      <section className="mb-8 rounded-3xl border border-white/10 bg-white/[.035] p-6 md:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">COLLECTION SOURCES · AGENT REGISTRY</p><h2 className="mt-2 text-2xl font-black">현재 수집 중인 페이지</h2><p className="mt-2 text-sm text-white/65">URL을 등록하면 파서 생성 에이전트가 구조를 분석하고 검증된 파서만 등록합니다. 수집 에이전트는 최초 전체수집 뒤 소스별 체크포인트 이후 변경분만 처리합니다.</p></div>
          <div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full border border-white/10 px-3 py-1 text-white/45">전체 {collectorSources.length}개</span><span className="rounded-full border border-[#70e3a1]/25 px-3 py-1 text-[#9df0bd]">활성 {collectorSources.filter((source) => source.enabled).length}개</span><span className="rounded-full border border-amber-200/20 px-3 py-1 text-amber-100">분석 대기 {collectorSources.filter((source) => source.onboardingStatus === 'pending_analysis').length}개</span></div>
        </div>

        <details open className="mt-6 rounded-2xl border border-[#70e3a1]/25 bg-[#70e3a1]/[.06] p-5">
          <summary className="cursor-pointer list-none text-sm font-black text-[#9df0bd]"><span className="mr-2 inline-flex rounded-full bg-[#70e3a1]/15 px-2 py-1">＋</span>신규 수집 페이지 추가 <span className="ml-2 text-xs font-medium text-white/55">공개 HTTPS 링크를 등록해 에이전트 분석을 시작합니다</span></summary>
          <form action={createCollectorSourceFromConsole} className="mt-5 grid gap-4 md:grid-cols-[1fr_2fr_auto]">
            <Field name="name" label="소스 이름" placeholder="예: 법무법인 예시 사건 블로그" />
            <Field name="url" label="분석할 공개 HTTPS 링크" placeholder="https://example.com" />
            <button className="self-end rounded-xl bg-[#70e3a1] px-5 py-3 text-sm font-black text-[#091117]">에이전트 분석 요청</button>
          </form>
          <p className="mt-4 text-xs leading-5 text-white/65">공개 HTTPS 주소만 등록할 수 있습니다. 로그인·토큰이 포함된 비공개 링크와 사설망 주소는 금지됩니다. 분석 전에는 수집하지 않으며, 판별 실패 건은 ‘검토 필요’로 남습니다.</p>
        </details>

        <div className="mt-6 hidden overflow-x-auto md:block"><table className="w-full min-w-[820px] text-left text-sm"><thead className="text-xs text-white/55"><tr><th className="py-3 pr-4">소스</th><th className="py-3 pr-4">링크</th><th className="py-3 pr-4">에이전트 판별</th><th className="py-3 pr-4">최근 실행</th><th className="py-3 pr-4">상태</th><th className="py-3">운영</th></tr></thead><tbody>{collectorSources.map((source) => <tr key={source.sourceKey} className="border-t border-white/10"><td className="py-4 pr-4"><p className="font-bold">{source.name}</p><p className="mt-1 font-mono text-[10px] text-white/45">{source.origin === 'built-in' ? '기본 내재 소스' : '운영자 추가'} · {source.sourceKey}</p></td><td className="max-w-sm py-4 pr-4">{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="break-all text-xs text-[#70e3a1]">{source.url} ↗</a> : <span className="text-xs text-white/45">직접 URL 없음</span>}</td><td className="py-4 pr-4"><p className="font-mono text-xs text-white/75">{source.onboardingStatus === 'ready' ? statusLabel(source.collectorType) : '—'}</p><p className="mt-1 text-[10px] text-white/50">{source.onboardingStatus === 'pending_analysis' ? '구조 분석 대기' : source.onboardingStatus === 'needs_review' ? '자동 판별 실패' : `${statusLabel(source.sourceType)}${source.sourceFamily ? ` · ${statusLabel(source.sourceFamily)}` : ''}`}</p></td><td className="py-4 pr-4"><p className="text-xs text-white/70">{statusLabel(source.latestStatus) || '실행 기록 없음'}</p><p className="mt-1 text-[10px] text-white/50">{source.latestStartedAt ? formatOpsDate(source.latestStartedAt) : '—'}</p></td><td className="py-4 pr-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${source.onboardingStatus === 'pending_analysis' ? 'bg-amber-300/10 text-amber-200' : source.onboardingStatus === 'needs_review' ? 'bg-red-400/10 text-red-200' : source.enabled ? 'bg-[#70e3a1]/10 text-[#9df0bd]' : 'bg-white/5 text-white/55'}`}>{source.onboardingStatus === 'pending_analysis' ? '분석 대기' : source.onboardingStatus === 'needs_review' ? '검토 필요' : source.enabled ? '사용 가능' : '중지'}</span>{source.analysisError ? <p className="mt-2 max-w-xs text-[10px] leading-5 text-red-200/75">{source.analysisError}</p> : null}</td><td className="py-4">{source.onboardingStatus === 'ready' ? <form action={toggleCollectorSourceFromConsole}><input type="hidden" name="sourceKey" value={source.sourceKey} /><input type="hidden" name="enabled" value={source.enabled ? 'false' : 'true'} /><button className={`rounded-lg px-3 py-2 text-[10px] font-bold ${source.enabled ? 'border border-amber-200/25 text-amber-100' : 'bg-[#70e3a1] text-[#091117]'}`}>{source.enabled ? '사용 중지' : '다시 사용'}</button></form> : <span className="text-xs text-white/45">에이전트 처리 대기</span>}</td></tr>)}</tbody></table></div>
        <div className="mt-6 grid gap-3 md:hidden">
          {collectorSources.length ? collectorSources.map((source) => <article key={source.sourceKey} className="rounded-2xl border border-white/10 bg-black/10 p-4">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-black">{source.name}</h3><p className="mt-1 truncate font-mono text-[10px] text-white/50">{source.origin === 'built-in' ? '기본 내재 소스' : '운영자 추가'} · {source.sourceKey}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${source.onboardingStatus === 'pending_analysis' ? 'bg-amber-300/10 text-amber-200' : source.onboardingStatus === 'needs_review' ? 'bg-red-400/10 text-red-200' : source.enabled ? 'bg-[#70e3a1]/10 text-[#9df0bd]' : 'bg-white/5 text-white/55'}`}>{source.onboardingStatus === 'pending_analysis' ? '분석 대기' : source.onboardingStatus === 'needs_review' ? '검토 필요' : source.enabled ? '사용 가능' : '중지'}</span></div>
            {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="mt-3 block break-all text-xs leading-5 text-[#70e3a1]">{source.url} ↗</a> : <p className="mt-3 text-xs text-white/50">직접 URL 없음</p>}
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/10 pt-3 text-xs"><div><p className="text-[10px] font-bold text-white/50">에이전트 판별</p><p className="mt-1 text-white/75">{source.onboardingStatus === 'ready' ? statusLabel(source.collectorType) : '분석 대기'}</p></div><div><p className="text-[10px] font-bold text-white/50">최근 실행</p><p className="mt-1 text-white/70">{statusLabel(source.latestStatus) || '기록 없음'}</p><p className="mt-1 text-[10px] text-white/50">{source.latestStartedAt ? formatOpsDate(source.latestStartedAt) : '—'}</p></div></div>
            {source.analysisError ? <p className="mt-3 rounded-lg bg-red-400/10 p-2 text-xs leading-5 text-red-200/80">{source.analysisError}</p> : null}
            <div className="mt-4">{source.onboardingStatus === 'ready' ? <form action={toggleCollectorSourceFromConsole}><input type="hidden" name="sourceKey" value={source.sourceKey} /><input type="hidden" name="enabled" value={source.enabled ? 'false' : 'true'} /><button className={`w-full rounded-lg px-3 py-3 text-xs font-black ${source.enabled ? 'border border-amber-200/25 text-amber-100' : 'bg-[#70e3a1] text-[#091117]'}`}>{source.enabled ? '사용 중지' : '다시 사용'}</button></form> : <p className="text-center text-xs text-white/50">에이전트 처리 대기</p>}</div>
          </article>) : <p className="rounded-xl border border-dashed border-white/15 p-6 text-center text-sm text-white/55">등록된 수집소스가 없습니다. 위에서 공개 링크를 추가해 보세요.</p>}
        </div>
      </section>

      <section className="mb-8 rounded-3xl border border-white/10 bg-white/[.035] p-6 md:p-8">
        <div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">FIRM SOURCE ACCESS</p><h2 className="mt-2 text-2xl font-black">법률사무소별 추가 수집소스</h2><p className="mt-2 text-sm text-white/45">기본 내재 소스는 모든 사무소에 자동 포함됩니다. 여기서는 운영자가 추가한 소스만 사무소별로 승인합니다.</p></div>
        <form action={grantCollectorSourceFromConsole} className="mt-6 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <label><span className="mb-2 block text-xs font-bold text-white/55">법무법인</span><select name="firmId" required className="w-full rounded-xl border border-white/12 bg-[#131b24] px-4 py-3 text-sm text-white">{items.filter((firm) => firm.status !== 'internal').map((firm) => <option key={firm.id} value={firm.id}>{firm.name}</option>)}</select></label>
          <label><span className="mb-2 block text-xs font-bold text-white/55">수집소스</span><select name="sourceId" required className="w-full rounded-xl border border-white/12 bg-[#131b24] px-4 py-3 text-sm text-white">{collectorSources.filter((source) => source.sourceId).map((source) => <option key={source.sourceKey} value={source.sourceId!}>{source.name}</option>)}</select></label>
          <button className="self-end rounded-xl bg-[#70e3a1] px-5 py-3 text-sm font-black text-[#091117]">승인 추가</button>
        </form>
        {sourceGrants.length ? <div className="mt-6 overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="text-xs text-white/35"><tr><th className="py-3 pr-4">법무법인</th><th className="py-3 pr-4">승인 소스</th><th className="py-3 pr-4">상태</th><th className="py-3">운영</th></tr></thead><tbody>{sourceGrants.map((grant) => <tr key={grant.id} className="border-t border-white/10"><td className="py-4 pr-4 font-bold">{grant.firmName}</td><td className="py-4 pr-4"><p>{grant.sourceName}</p>{grant.sourceUrl ? <a href={grant.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 block break-all text-xs text-[#70e3a1]">{grant.sourceUrl} ↗</a> : null}</td><td className="py-4 pr-4">{grant.status === 'active' && grant.sourceEnabled ? '승인·활성' : grant.status === 'active' ? '소스 중지' : grant.status === 'paused' ? '승인 일시중지' : '승인 해제'}</td><td className="py-4"><form action={setFirmSourceGrantStatusFromConsole}><input type="hidden" name="firmId" value={grant.firmId} /><input type="hidden" name="sourceId" value={grant.sourceId} /><button name="status" value={grant.status === 'active' ? 'paused' : 'active'} className="rounded-lg border border-white/12 px-3 py-2 text-xs font-bold text-white/65">{grant.status === 'active' ? '일시중지' : '다시 승인'}</button></form></td></tr>)}</tbody></table></div> : <p className="mt-5 text-sm text-white/40">아직 승인된 법무법인별 수집소스가 없습니다.</p>}
      </section>

      <section className="mb-8 rounded-3xl border border-white/10 bg-white/[.035] p-6 md:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">SOURCE REQUESTS · REVIEW QUEUE</p><h2 className="mt-2 text-2xl font-black">법률사무소 추가 수집 요청</h2><p className="mt-2 text-sm text-white/45">요청 링크를 확인해 위 ‘신규 수집 페이지 추가’에 URL만 넣습니다. 다음 에이전트 런이 수집법을 판별하고 키워드 추출 파이프라인에 자동 편입합니다.</p></div><span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/45">검토 대기 {sourceRequests.filter((row) => row.status === 'pending').length}건</span></div>
        {sourceRequests.length ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm"><thead className="text-xs text-white/35"><tr><th className="py-3 pr-4">법률사무소</th><th className="py-3 pr-4">요청 링크</th><th className="py-3 pr-4">요청일</th><th className="py-3 pr-4">상태</th><th className="py-3">운영 처리</th></tr></thead><tbody>{sourceRequests.map((request) => <tr key={request.id} className="border-t border-white/10"><td className="py-4 pr-4"><p className="font-bold">{request.firmName}</p><p className="mt-1 font-mono text-[10px] text-white/30">firm #{request.firmId}</p></td><td className="max-w-xl py-4 pr-4"><a href={request.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-all text-[#70e3a1]">{request.sourceUrl} ↗</a></td><td className="py-4 pr-4 text-xs text-white/40">{formatOpsDate(request.createdAt)}</td><td className="py-4 pr-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${request.status === 'pending' ? 'bg-amber-300/10 text-amber-200' : request.status === 'registered' ? 'bg-[#70e3a1]/10 text-[#9df0bd]' : 'bg-white/5 text-white/45'}`}>{request.status === 'pending' ? '검토 대기' : request.status === 'registered' ? '수집 등록 완료' : '등록 보류'}</span>{request.operatorNote ? <p className="mt-2 text-xs text-white/40">{request.operatorNote}</p> : null}</td><td className="py-4">{request.status === 'pending' ? <form action={reviewSourceRequestFromConsole} className="grid min-w-[260px] gap-2"><input type="hidden" name="requestId" value={request.id} /><input name="operatorNote" maxLength={1000} placeholder="등록 위치 또는 보류 사유" className="rounded-lg border border-white/12 bg-black/20 px-3 py-2 text-xs text-white outline-none placeholder:text-white/25" /><div className="flex gap-2"><button name="status" value="registered" className="rounded-lg bg-[#70e3a1] px-3 py-2 text-[10px] font-bold text-[#091117]">수집 등록 완료</button><button name="status" value="rejected" className="rounded-lg border border-white/12 px-3 py-2 text-[10px] font-bold text-white/60">등록 보류</button></div></form> : <span className="text-xs text-white/30">처리 완료</span>}</td></tr>)}</tbody></table></div> : <p className="mt-5 text-sm text-white/40">접수된 추가 수집 요청이 없습니다.</p>}
      </section>
      </> : null}

      {section === 'firms' ?
      <div className="grid gap-8 xl:grid-cols-[.9fr_1.1fr]">
        <section className="rounded-3xl border border-white/10 bg-white/[.035] p-6 md:p-8">
          <p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">ONE-CLICK PROVISION</p>
          <h2 className="mt-3 text-2xl font-black">신규 법률사무소 개설</h2>
          <p className="mt-3 text-sm leading-7 text-white/65">저장 한 번으로 테넌트·고객 대시보드·사건명 전량 편입·사이트 형식을 준비합니다. 공개는 실자산 검수 뒤 별도로 엽니다.</p>
          <form action={provisionFirmFromConsole} className="mt-7 grid gap-4 sm:grid-cols-2">
            <FormStep number="1" title="기본 식별 정보" description="사무소와 로그인에 사용할 기본 정보를 입력하세요.">
              <Field name="name" label="사무소명" placeholder="법무법인 예시" />
              <Field name="slug" label="영문 식별자" placeholder="example-law" pattern="[a-z0-9-]+" />
              <Field name="adLawyerName" label="광고책임변호사" placeholder="김변호" />
              <Field name="wordmark" label="워드마크" placeholder="EXAMPLE LAW" />
              <Field name="loginId" label="고객 운영실 아이디" placeholder="example-law" pattern="[A-Za-z0-9._-]{3,60}" />
              <Field name="password" label="초기 비밀번호" placeholder="4자 이상" type="password" />
            </FormStep>
            <FormStep number="2" title="연락처·주소" description="고객이 확인할 대표 연락처와 사무소 위치입니다.">
              <Field name="phone" label="대표전화" placeholder="02-0000-0000" />
              <Field name="phoneIntl" label="국제 전화표기" placeholder="+82-2-0000-0000" />
              <Field name="domain" label="고객 도메인" placeholder="example-law.kr" />
              <Field name="kakaoUrl" label="카카오 상담 URL" placeholder="선택 입력" required={false} />
              <Field name="addressRegion" label="시·도" placeholder="서울특별시" />
              <Field name="addressLocality" label="시·군·구" placeholder="서초구" />
              <div className="sm:col-span-2"><Field name="address" label="상세 주소" placeholder="서초대로 00, 0층" /></div>
            </FormStep>
            <FormStep number="3" title="공개 프로필" description="랜딩 페이지에 노출될 사무소와 변호사 소개를 작성하세요.">
              <div className="sm:col-span-2"><TextAreaField name="profileIntro" label="사무소 소개" placeholder="피해 사건에서 어떤 검토와 대응을 제공하는지 입력" /></div>
              <Field name="lawyerName" label="대표변호사 이름" placeholder="김변호" />
              <Field name="lawyerTitle" label="직책" placeholder="대표변호사" />
              <div className="sm:col-span-2"><TextAreaField name="lawyerBio" label="변호사 소개" placeholder="사건을 직접 검토하는 방식과 전문 분야" /></div>
              <div className="sm:col-span-2"><TextAreaField name="lawyerCareer" label="주요 경력" placeholder={'경력 1\n경력 2'} /></div>
              <TextAreaField name="practiceAreas" label="업무 분야" placeholder="금융사기, 형사 고소" />
              <TextAreaField name="lawyerBadges" label="전문 자격·배지" placeholder="형사법 전문변호사" required={false} />
              <Field name="lawyerPhoto" label="변호사 사진 경로" placeholder="선택 입력" required={false} />
              <TextAreaField name="officeHistory" label="사무소 연혁" placeholder={'2024 사무소 설립\n2025 피해자 대응팀 신설'} required={false} />
            </FormStep>
            <FormStep number="4" title="사이트 형식 및 개설" description="형식을 선택하면 계정과 사건명이 함께 준비됩니다.">
              <label className="sm:col-span-2"><span className="mb-2 block text-xs font-bold text-white/65">피해자용 사이트 형식</span><select name="siteTemplate" className="w-full rounded-xl border border-white/12 bg-[#131b24] px-4 py-3 text-sm text-white">{SITE_TEMPLATES.map((item) => <option key={item.key} value={item.key}>{item.name} · {item.trustFocus}</option>)}</select></label>
              <button className="sm:col-span-2 mt-2 rounded-xl bg-[#70e3a1] px-5 py-4 text-sm font-black text-[#091117]">사무소 개설 및 사건명 편입</button>
            </FormStep>
          </form>
        </section>

        <section>
          <div className="flex items-end justify-between gap-4"><div><p className="text-[10px] font-bold tracking-[.16em] text-white/38">TENANTS</p><h2 className="mt-2 text-2xl font-black">운영 중인 사무소</h2></div><span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/45">{items.length}개</span></div>
          <div className="mt-5 space-y-3">
            {items.map((firm) => {
              const template = SITE_TEMPLATES.find((item) => item.key === normalizeSiteTemplate(firm.siteTemplate))!
              const readinessErrors = firmPublicReadinessErrors(firm)
              return (
                <article key={firm.id} className="rounded-2xl border border-white/10 bg-white/[.035] p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div><p className="text-xs text-white/35">#{firm.id} · {firm.slug}</p><h3 className="mt-1 font-black">{firm.name}</h3><p className="mt-2 text-xs text-white/42">{firm.domain ?? '도메인 연결 대기'} · {template.name}</p></div>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${firm.landingReady ? 'bg-[#70e3a1]/15 text-[#9df0bd]' : 'bg-amber-300/10 text-amber-200'}`}>{firm.landingReady ? '공개 중' : '검수 중'}</span>
                  </div>
                  {!firm.landingReady && readinessErrors.length ? <p className="mt-4 text-xs leading-6 text-amber-200/75">공개 전 필수 입력: {readinessErrors.join(' · ')}</p> : null}
                  <div className="mt-5 flex flex-wrap items-center gap-2 text-xs font-bold">
                    <Link href="/workspace" target="_blank" className="rounded-lg border border-white/10 px-3 py-2 text-white/70">ID 로그인 운영실 ↗</Link>
                    <Link href={`/f/mock-project-d?preview=1&firm=${encodeURIComponent(firm.slug)}`} target="_blank" className="rounded-lg border border-white/10 px-3 py-2 text-white/70">랜딩 검수 ↗</Link>
                    <form action={setFirmPublicReadyFromConsole}>
                      <input type="hidden" name="firmId" value={firm.id} />
                      <input type="hidden" name="ready" value={firm.landingReady ? 'false' : 'true'} />
                      <button disabled={!firm.landingReady && readinessErrors.length > 0} className={`rounded-lg px-3 py-2 ${firm.landingReady ? 'border border-red-300/20 text-red-200' : 'bg-[#70e3a1] text-[#091117] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/25'}`}>{firm.landingReady ? '공개 중지' : '공개'}</button>
                    </form>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      </div> : null}

      {section === 'runs' ? <section className="rounded-3xl border border-white/10 bg-white/[.035] p-6 md:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">COLLECTION EXECUTIONS</p><h2 className="mt-2 text-2xl font-black">법률사무소별 수집 실행</h2><p className="mt-2 text-sm text-white/45">버튼 클릭 1회가 실행 1회입니다. 재시도 없이 실행 중·완료·에러로 끝납니다.</p></div><span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/45">최근 {collectionRuns.length}건</span></div>
        <div className="mt-6 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="text-xs text-white/35"><tr><th className="py-3 pr-4">법률사무소</th><th className="py-3 pr-4">실행 시각</th><th className="py-3 pr-4">소스</th><th className="py-3 pr-4">상태</th><th className="py-3">결과</th></tr></thead><tbody>{collectionRuns.length ? collectionRuns.map((run) => <tr key={run.id} className="border-t border-white/10"><td className="py-4 pr-4"><p className="font-bold">{run.firmName}</p><p className="mt-1 font-mono text-[10px] text-white/30">firm #{run.firmId}</p></td><td className="py-4 pr-4 text-xs text-white/55">{formatOpsDate(run.requestedAt)}</td><td className="py-4 pr-4 text-xs text-white/55">요청 {run.requestedSourceCount}개 · 완료 {run.sourceRunCount}개</td><td className="py-4 pr-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${run.status === 'completed' ? 'bg-[#70e3a1]/10 text-[#9df0bd]' : run.status === 'error' ? 'bg-red-400/10 text-red-200' : 'bg-amber-300/10 text-amber-200'}`}>{run.status === 'completed' ? '완료' : run.status === 'error' ? '에러' : '실행 중'}</span></td><td className="py-4 text-xs text-white/45">{run.error ?? (run.finishedAt ? formatOpsDate(run.finishedAt) : '작업자 처리 중')}</td></tr>) : <tr><td colSpan={5} className="py-10 text-center text-white/35">아직 수집 실행 기록이 없습니다.</td></tr>}</tbody></table></div>
      </section> : null}
    </OperatorShell>
  )
}

function OperatorErrorNotice({ error }: { error: string }) {
  const messages: Record<string, string> = {
    template: '피해자용 사이트 형식을 다시 선택해 주세요. 사무소는 생성되지 않았습니다.',
    'provision-input': '입력값 형식을 확인해 주세요. 사무소는 생성되지 않았습니다.',
    'provision-conflict': '이미 사용 중인 영문 식별자 또는 도메인입니다. 기존 사무소 데이터는 변경되지 않았습니다.',
    'provision-failed': '사무소 개설 또는 사건명 편입에 실패했습니다. 전체 작업은 취소되었으며 운영 로그에서 원인을 확인할 수 있습니다.',
    publish: '공개 필수 정보와 변호사 이력을 모두 입력했는지 확인해 주세요. 기존 공개 상태는 변경되지 않았습니다.',
    'activation-incomplete': '도메인·광고계정·승인 사건·공개 자산·테스트 상담·고객 결과 중 아직 완료되지 않은 항목이 있습니다.',
    'activation-unavailable': '활성화 정본 데이터를 확인할 수 없어 공개를 중단했습니다. 마이그레이션과 데이터 연결 상태를 확인해 주세요.',
  }
  return <div className="mb-6 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{messages[error] ?? '입력값 또는 중복 도메인을 확인해 주세요. 기존 데이터는 변경되지 않았습니다.'}</div>
}

function productLeadDetail(detail: string | null): string {
  if (!detail) return '내용 미기재'
  try {
    const value = JSON.parse(detail) as { contactName?: unknown; note?: unknown }
    const rows = [
      typeof value.contactName === 'string' && value.contactName.trim() ? `담당자: ${value.contactName.trim()}` : null,
      typeof value.note === 'string' && value.note.trim() ? value.note.trim() : null,
    ].filter((item): item is string => Boolean(item))
    return rows.length ? rows.join('\n') : '내용 미기재'
  } catch {
    return detail
  }
}

function productLeadDetailFields(detail: string | null): { contactName: string | null; note: string | null } {
  if (!detail) return { contactName: null, note: null }
  try {
    const value = JSON.parse(detail) as { contactName?: unknown; note?: unknown }
    return {
      contactName: typeof value.contactName === 'string' && value.contactName.trim() ? value.contactName.trim() : null,
      note: typeof value.note === 'string' && value.note.trim() ? value.note.trim() : null,
    }
  } catch {
    return { contactName: null, note: detail }
  }
}

function OperatorOverviewPanel({ data, stats, sources }: { data: OperatorOverview; stats: UnifiedSystemStats; sources: CollectorSourceRow[] }) {
  const parserPending = sources.filter((source) => source.onboardingStatus === 'pending_analysis').length
  const parserReview = sources.filter((source) => source.onboardingStatus === 'needs_review').length
  const parserReady = sources.filter((source) => source.onboardingStatus === 'ready').length
  const metrics = [
    ['사건명', stats.keywords], ['관측', stats.observations], ['오늘 관측', data.totals.todayKeywords],
    ['공개 페이지', stats.pages], ['법무법인', stats.firms], ['수집소스', stats.sources],
    ['방문자', stats.visitors], ['문의', stats.inquiries], ['광고 운영', data.totals.liveAds],
  ] as const
  return <div className="space-y-4">
    <section className="rounded-2xl border border-white/10 bg-white/[.035] p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">LIVE DATA</p><h2 className="mt-1 text-lg font-black">핵심 운영 수치</h2></div><p className="text-xs text-white/45">실제 운영 DB · 중복 없는 현재값</p></div>
      <div className="mt-4 grid grid-cols-3 overflow-hidden rounded-xl border border-white/10 md:grid-cols-5 xl:grid-cols-9">
        {metrics.map(([label, value], index) => <div key={label} className={`min-w-0 px-3 py-3 ${index % 3 ? 'border-l border-white/10' : ''} md:border-l md:first:border-l-0`}><p className="truncate text-[10px] font-bold text-white/45">{label}</p><p className="mt-1 text-lg font-black tabular-nums md:text-xl">{value.toLocaleString('ko-KR')}</p></div>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {data.statusCounts.map((row) => <span key={row.status} className="rounded-full border border-white/10 bg-black/10 px-3 py-1.5 text-xs text-white/70">{statusLabel(row.status)} {row.count.toLocaleString('ko-KR')}</span>)}
      </div>
    </section>

    <KeywordSearchCoveragePanel coverage={data.keywordCoverage} />

    <section className="rounded-2xl border border-white/10 bg-white/[.035] p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">3-AGENT WORKFLOW</p><h2 className="mt-1 text-lg font-black">체크포인트 기반 에이전트 시스템</h2></div><p className="text-xs text-white/45">15분 에이전트 없음 · 매일/클릭은 같은 수집 파이프라인</p></div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <AgentRoleCard number="1" title="수집 에이전트" status={`${sources.filter((source) => source.enabled).length}개 소스 활성`} description="체크포인트 이후 신규·수정 문서만 전달합니다. 3호가 제안한 재수집은 총운영자 승인 뒤 다음 실행에서 주기 게이트를 한 번만 우회합니다." />
        <AgentRoleCard number="2" title="파서 생성 에이전트" status={`준비 ${parserReady} · 대기 ${parserPending}`} description="새 URL이 들어올 때만 구조를 분석·샘플 검증하고 통과한 파서를 수집 레지스트리에 등록합니다." />
        <AgentRoleCard number="3" title="DB 검토 에이전트" status={parserReview ? `호출 조건 ${parserReview}건` : '이상 감지 시 대기'} description="실패·누락·퇴행을 읽기 전용으로 진단하고 1호 재수집 또는 2호 재분석을 제안합니다. 승인 전에는 어떤 설정도 바꾸지 않습니다." warning={parserReview > 0} />
      </div>
    </section>

    <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
      <section className="rounded-2xl border border-white/10 bg-white/[.035] p-4 md:p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-black">최근 수집</h2><Link href="/operator?section=runs" className="text-xs font-bold text-[#9df0bd]">전체 보기 →</Link></div><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="text-white/45"><tr><th className="py-2 pr-3">기준일</th><th className="pr-3">상태</th><th className="pr-3">수집</th><th className="pr-3">신규 사건</th><th>신규 관측</th></tr></thead><tbody>{data.runs.length ? data.runs.slice(0, 6).map((run, index) => <tr key={`${run.day}-${index}`} className="border-t border-white/10"><td className="py-2.5 pr-3 font-bold">{run.day}</td><td className="pr-3">{statusLabel(run.status)}</td><td className="pr-3 tabular-nums">{metric(run.metrics, 'collected')}</td><td className="pr-3 tabular-nums">{metric(run.metrics, 'dbKw')}</td><td className="tabular-nums">{metric(run.metrics, 'dbObs')}</td></tr>) : <tr><td colSpan={5} className="py-8 text-center text-white/45">수집 기록 없음</td></tr>}</tbody></table></div></section>
      <section className="rounded-2xl border border-white/10 bg-white/[.035] p-4 md:p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-black">최근 관측 사건</h2><Link href="/operator?section=cases" className="text-xs font-bold text-[#9df0bd]">전체 보기 →</Link></div><div className="mt-3 divide-y divide-white/10">{data.cases.length ? data.cases.slice(0, 6).map((item) => <a key={item.id} href={`/f/${item.slug}?preview=1`} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 py-2.5"><div className="min-w-0"><p className="truncate text-sm font-bold">{item.name}</p><p className="truncate text-[10px] text-white/45">{item.latestTitle ?? statusLabel(item.status)}</p></div><span className="shrink-0 text-xs font-bold text-[#9df0bd]">{item.observationCount.toLocaleString('ko-KR')}건</span></a>) : <p className="py-8 text-center text-xs text-white/45">관측 사건 없음</p>}</div></section>
    </div>
  </div>
}

function KeywordSearchCoveragePanel({ coverage }: { coverage: OperatorOverview['keywordCoverage'] }) {
  if (!coverage) return null
  const percent = `${coverage.coveragePercent.toFixed(2)}%`
  return <section className="rounded-2xl border border-[#70e3a1]/20 bg-[#70e3a1]/[.035] p-4 md:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">KEYWORD SEARCH COVERAGE</p><h2 className="mt-1 text-lg font-black">전체 검색 커버리지 원장</h2><p className="mt-1 text-xs text-white/50">커서는 참고값이며, eligible 스냅샷과 멱등 배치 결과로 진행률을 계산합니다.</p></div>
      <span className={`rounded-full border px-3 py-1.5 text-xs font-bold ${coverage.status === 'completed' ? 'border-[#70e3a1]/30 text-[#9df0bd]' : coverage.status === 'warning' ? 'border-amber-200/25 text-amber-100' : 'border-blue-300/25 text-blue-100'}`}>{statusLabel(coverage.status)}</span>
    </div>
    <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
      <OpsMetric label="전체 eligible" value={coverage.totalEligible} />
      <OpsMetric label="처리 완료" value={coverage.processedCount} />
      <OpsMetric label="성공" value={coverage.succeededCount} />
      <OpsMetric label="최종 실패" value={coverage.failedCount} critical={coverage.failedCount > 0} />
      <OpsMetric label="재시도 대기" value={coverage.pendingRetryCount} critical={coverage.pendingRetryCount > 0} />
      <OpsMetric label="재시도 횟수" value={coverage.retryCount} />
      <OpsMetric label="잔여" value={coverage.remainingCount} />
      <div className="rounded-xl border border-white/10 bg-black/10 p-4"><p className="text-[10px] font-bold tracking-[.1em] text-white/35">진행률</p><p className="mt-3 text-2xl font-black text-white">{percent}</p></div>
    </div>
    <p className="mt-3 text-[10px] text-white/40">cycle {coverage.runKey} · 배치 {coverage.batchesCompleted}/{coverage.batchesTotal} 완료 · 마지막 갱신 {formatOpsDate(coverage.updatedAt)}</p>
    <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead className="text-white/45"><tr><th className="py-2 pr-3">배치</th><th className="pr-3">상태</th><th className="pr-3">seed IDs</th><th className="pr-3">성공</th><th className="pr-3">실패</th><th>잔여</th></tr></thead><tbody>{coverage.batches.slice(-8).reverse().map((batch) => <tr key={batch.id} className="border-t border-white/10"><td className="py-2.5 pr-3 font-bold">#{batch.batchNumber}</td><td className="pr-3">{statusLabel(batch.status)}</td><td className="max-w-[260px] pr-3 font-mono text-[10px] text-white/55" title={batch.seedIds.join(', ')}>{batch.seedIds.length.toLocaleString('ko-KR')}개 · {batch.seedIds.slice(0, 2).join(', ')}{batch.seedIds.length > 2 ? ' …' : ''}</td><td className="pr-3 tabular-nums">{batch.succeededSeedIds.length.toLocaleString('ko-KR')}</td><td className="pr-3 tabular-nums">{batch.failedSeedIds.length.toLocaleString('ko-KR')}</td><td className="tabular-nums">{batch.remainingCount.toLocaleString('ko-KR')}</td></tr>)}</tbody></table></div>
  </section>
}

function AgentControlPanel({ sources, review, executions, proposals }: { sources: CollectorSourceRow[]; review: DatabaseReviewDecision; executions: AgentExecutionRow[]; proposals: AgentActionProposalView[] }) {
  const active = sources.filter((source) => source.enabled).length
  const ready = sources.filter((source) => source.onboardingStatus === 'ready').length
  const pending = sources.filter((source) => source.onboardingStatus === 'pending_analysis').length
  const parserReview = sources.filter((source) => source.onboardingStatus === 'needs_review').length
  const latest = [...sources]
    .filter((source) => source.latestStartedAt)
    .sort((left, right) => right.latestStartedAt!.getTime() - left.latestStartedAt!.getTime())[0] ?? null
  const unhealthyRuns = sources.filter((source) => source.latestStatus === 'failed' || source.latestStatus === 'warning').length
  const criticalFindings = review.findings.filter((finding) => finding.severity === 'critical').length
  const reviewCount = review.findings.reduce((sum, finding) => sum + finding.count, 0)
  const approvalPending = proposals.filter((proposal) => proposal.status === 'pending').length

  return <div className="space-y-5">
    <section className="rounded-2xl border border-white/10 bg-white/[.035] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-[10px] font-black tracking-[.16em] text-[#70e3a1]">ONE PIPELINE · THREE ROLES</p><h2 className="mt-2 text-xl font-black">수집부터 운영 DB까지 한 흐름으로 제어</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-white/65">평소에는 수집 에이전트 하나만 움직입니다. 새 URL은 2호가 준비하고, 이상이 생기면 3호가 조치를 제안합니다. 1·2호 자동조치는 총운영자 승인 후에만 실행됩니다.</p></div>
        <span className={`rounded-full border px-3 py-1.5 text-xs font-bold ${criticalFindings ? 'border-red-300/30 bg-red-400/10 text-red-200' : review.needed ? 'border-amber-200/25 bg-amber-300/10 text-amber-100' : 'border-[#70e3a1]/25 bg-[#70e3a1]/10 text-[#9df0bd]'}`}>{criticalFindings ? `중요 이상 ${criticalFindings}종` : review.needed ? `검토 조건 ${review.findings.length}종` : '현재 흐름 정상'}</span>
      </div>
      <div className="mt-5 grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
        <AgentFlowStep number="2" title="파서 준비" description="새 URL일 때만 구조 분석" active={pending > 0} />
        <span aria-hidden="true" className="hidden text-center text-white/30 md:block">→</span>
        <AgentFlowStep number="1" title="증분 수집" description="최초 전체 · 이후 체크포인트" active={active > 0} />
        <span aria-hidden="true" className="hidden text-center text-white/30 md:block">→</span>
        <AgentFlowStep number="3" title="검토·조치 제안" description="승인 뒤 A1·A2에 전달" active={!review.needed} warning={review.needed} />
      </div>
      <div className="mt-3 rounded-xl border border-dashed border-white/15 px-4 py-3 text-xs leading-5 text-white/55"><b className="text-white/80">승인 게이트:</b> 3호는 진단과 조치 제안만 기록합니다. 총운영자가 승인한 재수집·재분석만 다음 파이프라인에서 실행되며, 거절·대기 제안은 소스와 체크포인트를 변경하지 않습니다.</div>
    </section>

    <div className="grid gap-4 xl:grid-cols-3">
      <AgentControlCard number="1" title="수집 에이전트" status={unhealthyRuns ? `최근 주의 ${unhealthyRuns}개` : `${active}개 소스 가동`} warning={unhealthyRuns > 0}>
        <p className="text-sm leading-6 text-white/65">매일 자동 실행과 고객의 ‘수집하기’ 클릭이 같은 DB 증분 파이프라인으로 들어갑니다. 3호의 재수집 제안은 인간이 승인한 경우에만 주기 게이트를 한 번 우회합니다.</p>
        <div className="mt-4 grid grid-cols-3 gap-2"><AgentMiniMetric label="활성 소스" value={active} /><AgentMiniMetric label="준비 완료" value={ready} /><AgentMiniMetric label="최근 주의" value={unhealthyRuns} warning={unhealthyRuns > 0} /></div>
        <div className="mt-4 rounded-xl bg-black/15 p-3 text-xs leading-5 text-white/55"><p><b className="text-white/80">트리거</b> · 매일 자동 / 고객 클릭</p><p className="mt-1"><b className="text-white/80">최근 실행</b> · {latest?.latestStartedAt ? `${latest.name} · ${formatOpsDate(latest.latestStartedAt)} · ${statusLabel(latest.latestStatus)}` : '기록 없음'}</p><p className="mt-1"><b className="text-white/80">최근 반영</b> · {latest?.latestItemsAccepted === null || latest?.latestItemsAccepted === undefined ? '—' : `${latest.latestItemsAccepted.toLocaleString('ko-KR')}건`}</p></div>
        <div className="mt-auto grid grid-cols-2 gap-2 pt-4"><Link href="/operator?section=runs#operator-content" className="rounded-xl bg-[#70e3a1] px-4 py-3 text-center text-xs font-black text-[#091117]">실행 기록 보기</Link><Link href="/operator?section=sources#operator-content" className="rounded-xl border border-white/15 px-4 py-3 text-center text-xs font-black text-white/75">수집소스 관리</Link></div>
      </AgentControlCard>

      <AgentControlCard number="2" title="파서 생성 에이전트" status={pending ? `분석 대기 ${pending}건` : '호출 대기'} warning={parserReview > 0}>
        <p className="text-sm leading-6 text-white/65">운영자가 추가한 새 URL만 분석해 반복 목록과 제목·링크·발행일 구조를 찾고, 샘플 검증을 통과한 파서만 활성화합니다.</p>
        <div className="mt-4 grid grid-cols-3 gap-2"><AgentMiniMetric label="준비 완료" value={ready} /><AgentMiniMetric label="분석 대기" value={pending} /><AgentMiniMetric label="검토 필요" value={parserReview} warning={parserReview > 0} /></div>
        <div className="mt-4 rounded-xl bg-black/15 p-3 text-xs leading-5 text-white/55">신규 URL이 없으면 실행하지 않습니다. 자동 판별 실패 소스는 활성화하지 않고 사람이 확인할 수 있게 남깁니다.</div>
        <form action={runParserBuilderFromConsole} className="mt-auto pt-4"><AgentActionButton disabled={pending === 0} idleLabel={pending ? `대기 중인 ${pending}건 지금 분석` : '분석 대기 URL 없음'} pendingLabel="파서 구조 분석 중…" /></form>
      </AgentControlCard>

      <AgentControlCard number="3" title="DB 검토 에이전트" status={review.needed ? `확인 필요 ${reviewCount}건` : '이상 감지 대기'} warning={review.needed}>
        <p className="text-sm leading-6 text-white/65">운영 DB를 수정하지 않고 이상과 대상 소스를 진단해 1호 재수집 또는 2호 재분석을 제안합니다. 승인 전에는 실행되지 않습니다.</p>
        <div className="mt-4 grid grid-cols-3 gap-2"><AgentMiniMetric label="이상 종류" value={review.findings.length} warning={review.needed} /><AgentMiniMetric label="중요 이상" value={criticalFindings} warning={criticalFindings > 0} /><AgentMiniMetric label="대상 건수" value={reviewCount} warning={review.needed} /></div>
        <div className="mt-4 rounded-xl bg-black/15 p-3 text-xs leading-5 text-white/55"><p className="font-bold text-white/75">최근 사전 점검 · {formatOpsDate(new Date(review.checkedAt))}</p>{review.findings.length ? <ul className="mt-2 space-y-1">{review.findings.slice(0, 4).map((finding) => <li key={finding.code} className={finding.severity === 'critical' ? 'text-red-200/80' : 'text-amber-100/80'}>• {finding.message}</li>)}</ul> : <p className="mt-2 text-[#9df0bd]">호출할 이상 조건이 없습니다.</p>}</div>
        <div className="mt-4 rounded-xl bg-black/15 p-3 text-xs text-white/60">인간 승인 대기 <b className="text-amber-100">{approvalPending}건</b></div>
        <form action={runDatabaseReviewFromConsole} className="mt-auto pt-4"><AgentActionButton idleLabel="읽기 전용 즉시 진단" pendingLabel="운영 DB 진단 중…" variant="secondary" /></form>
      </AgentControlCard>
    </div>

    <section className="rounded-2xl border border-amber-200/20 bg-amber-200/[.035] p-5 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-black tracking-[.16em] text-amber-200">HUMAN APPROVAL GATE</p><h2 className="mt-2 text-xl font-black">3호 조치 제안 승인</h2><p className="mt-2 text-sm text-white/60">대상·근거·조치를 확인한 뒤 승인하거나 거절합니다. 승인은 다음 에이전트 파이프라인에서 한 번만 실행됩니다.</p></div><span className="rounded-full border border-amber-200/20 px-3 py-1.5 text-xs text-amber-100">승인 대기 {approvalPending}건</span></div>
      <div className="mt-5 space-y-3">{proposals.length ? proposals.map((proposal) => {
        const actionLabel = proposal.actionType === 'retry_collection' ? 'A1 재수집' : 'A2 파서 재분석'
        const statusLabel = proposal.status === 'pending' ? '승인 대기' : proposal.status === 'approved' ? '승인됨·실행 대기' : proposal.status === 'running' ? '실행 중' : proposal.status === 'completed' ? '실행 완료' : proposal.status === 'rejected' ? '거절됨' : '실행 실패'
        return <article key={proposal.id} className="rounded-xl border border-white/10 bg-black/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap gap-2"><span className="rounded-full bg-[#70e3a1]/10 px-2.5 py-1 text-[10px] font-black text-[#9df0bd]">{actionLabel}</span><span className="rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-bold text-white/55">{statusLabel}</span></div><h3 className="mt-3 font-black">{proposal.sourceName}</h3><p className="mt-1 break-all text-[10px] text-white/40">{proposal.sourceUrl ?? proposal.sourceKey}</p><p className="mt-3 text-sm leading-6 text-white/70">{proposal.rationale}</p><p className="mt-2 text-[10px] text-white/40">판단 코드 · {proposal.findingCode}</p></div></div>
          {proposal.status === 'pending' ? <form action={decideAgentActionProposalFromConsole} className="mt-4 grid gap-3 border-t border-white/10 pt-4 md:grid-cols-[1fr_auto_auto]"><input type="hidden" name="proposalId" value={proposal.id} /><input name="note" required minLength={2} maxLength={500} placeholder="승인 또는 거절 사유를 입력하세요" className="rounded-lg border border-white/15 bg-[#101820] px-3 py-2 text-xs text-white" /><button name="decision" value="approve" className="rounded-lg bg-[#70e3a1] px-4 py-2 text-xs font-black text-[#091117]">승인</button><button name="decision" value="reject" className="rounded-lg border border-red-300/25 px-4 py-2 text-xs font-black text-red-200">거절</button></form> : proposal.executionError ? <p className="mt-3 rounded-lg bg-red-400/10 px-3 py-2 text-xs text-red-200">{proposal.executionError}</p> : null}
        </article>
      }) : <p className="rounded-xl border border-dashed border-white/15 py-10 text-center text-sm text-white/45">현재 검토할 조치 제안이 없습니다.</p>}</div>
    </section>

    <AgentExecutionHistory executions={executions} />

    <section className="grid gap-3 rounded-2xl border border-white/10 bg-white/[.025] p-5 sm:grid-cols-3">
      <AgentRule title="15분 반복 수집 없음" description="변경이 없어도 전체를 다시 훑는 별도 에이전트는 운영하지 않습니다." />
      <AgentRule title="체크포인트는 성공 뒤 확정" description="DB와 페이지 반영까지 성공해야 다음 증분 시작점을 저장합니다." />
      <AgentRule title="조치는 승인 후 실행" description="3호는 읽기 전용으로 제안하고, 총운영자 승인 전에는 A1·A2와 소스 설정을 바꾸지 않습니다." />
    </section>
  </div>
}

function AgentExecutionHistory({ executions }: { executions: AgentExecutionRow[] }) {
  return <section className="rounded-2xl border border-white/10 bg-white/[.035] p-5 md:p-6">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-black tracking-[.16em] text-[#70e3a1]">EXECUTION FEEDBACK</p><h2 className="mt-2 text-xl font-black">에이전트 실행 이력·피드백</h2><p className="mt-2 text-sm text-white/60">진행 상태부터 결과, 이상 내용, 권장 조치까지 실행별로 보관합니다.</p></div><span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/55">최근 {executions.length}건</span></div>
    <div className="mt-5 space-y-3">
      {executions.length ? executions.map((execution) => {
        const elapsed = execution.startedAt && execution.finishedAt
          ? Math.max(0, execution.finishedAt.getTime() - execution.startedAt.getTime())
          : null
        const tone = execution.status === 'failed' ? 'border-red-400/25 bg-red-400/[.04]'
          : execution.status === 'warning' ? 'border-amber-300/25 bg-amber-300/[.04]'
            : execution.status === 'running' ? 'border-blue-300/25 bg-blue-300/[.04]' : 'border-white/10 bg-black/10'
        return <article key={execution.id} className={`rounded-xl border p-4 ${tone}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-black">{agentTypeLabel(execution.agentType)}</h3><span className="rounded-full bg-white/[.06] px-2 py-1 text-[10px] font-bold text-white/60">{agentTriggerLabel(execution.trigger)}</span><span className={`rounded-full px-2 py-1 text-[10px] font-black ${agentStatusTone(execution.status)}`}>{agentExecutionStatusLabel(execution.status)}</span></div><p className="mt-2 text-sm leading-6 text-white/70">{execution.summary}</p></div>
            <div className="shrink-0 text-right text-[10px] leading-5 text-white/45"><p>{formatOpsDate(execution.startedAt ?? execution.createdAt)}</p><p>{execution.status === 'running' ? '작업 진행 중' : elapsed === null ? '소요시간 —' : `소요시간 ${formatDuration(elapsed)}`}</p></div>
          </div>
          <details className="mt-3 border-t border-white/10 pt-3">
            <summary className="cursor-pointer text-xs font-black text-[#9df0bd]">상세 결과와 권장 조치 보기</summary>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <h4 className="text-xs font-black text-white/75">처리 결과</h4>
                {execution.report && Object.keys(execution.report.counts).length ? <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">{Object.entries(execution.report.counts).map(([key, value]) => <div key={key} className="rounded-lg bg-white/[.04] p-3"><p className="text-[10px] text-white/45">{agentCountLabel(key)}</p><p className="mt-1 font-black tabular-nums">{value.toLocaleString('ko-KR')}</p></div>)}</div> : <p className="mt-2 text-xs text-white/45">집계된 처리 건수가 없습니다.</p>}
                {execution.report?.details.length ? <ul className="mt-3 space-y-1 text-xs leading-5 text-white/60">{execution.report.details.slice(0, 20).map((detail, index) => <li key={`${execution.id}-detail-${index}`}>• {detail}</li>)}</ul> : null}
              </div>
              <div>
                <h4 className="text-xs font-black text-white/75">권장 조치</h4>
                {execution.recommendations.length ? <ol className="mt-2 space-y-2 text-xs leading-5 text-white/65">{execution.recommendations.map((item, index) => <li key={`${execution.id}-recommendation-${index}`}><b className="mr-2 text-[#9df0bd]">{index + 1}.</b>{item}</li>)}</ol> : <p className="mt-2 text-xs text-white/45">추가 조치가 필요하지 않습니다.</p>}
                {execution.report?.findings.length ? <div className="mt-4"><h4 className="text-xs font-black text-white/75">감지된 이상</h4><ul className="mt-2 space-y-2">{execution.report.findings.map((finding, index) => <li key={`${execution.id}-finding-${index}`} className={`rounded-lg px-3 py-2 text-xs leading-5 ${finding.severity === 'critical' ? 'bg-red-400/10 text-red-200' : 'bg-amber-300/10 text-amber-100'}`}>{finding.message}</li>)}</ul></div> : null}
              </div>
            </div>
            {execution.logExcerpt ? <details className="mt-4 rounded-lg bg-black/20 p-3"><summary className="cursor-pointer text-[10px] font-bold text-white/50">실행 로그 발췌</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-5 text-white/50">{execution.logExcerpt}</pre></details> : null}
          </details>
        </article>
      }) : <p className="rounded-xl border border-dashed border-white/15 py-10 text-center text-sm text-white/45">아직 저장된 에이전트 실행 이력이 없습니다.</p>}
    </div>
  </section>
}

function agentTypeLabel(value: AgentExecutionRow['agentType']): string {
  return value === 'parser_builder' ? '파서 생성 에이전트' : value === 'database_review' ? 'DB 검토 에이전트' : '수집 에이전트'
}

function agentTriggerLabel(value: string): string {
  const labels: Record<string, string> = {
    'operator-console': '운영자 실행', 'operator-cli': '운영자 CLI',
    'customer-click': '고객 클릭', click: '고객 클릭',
    'parser-anomaly': '파서 이상 감지', 'anomaly-gate': '이상 감지', daily: '매일 자동',
  }
  return labels[value] ?? value.replaceAll('-', ' ')
}

function agentExecutionStatusLabel(value: AgentExecutionRow['status']): string {
  return value === 'running' ? '진행 중' : value === 'failed' ? '실패' : value === 'warning' ? '완료·확인 필요' : '완료'
}

function agentStatusTone(value: AgentExecutionRow['status']): string {
  return value === 'failed' ? 'bg-red-400/10 text-red-200' : value === 'warning' ? 'bg-amber-300/10 text-amber-100' : value === 'running' ? 'bg-blue-300/10 text-blue-100' : 'bg-[#70e3a1]/10 text-[#9df0bd]'
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}초`
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
}

function agentCountLabel(value: string): string {
  const labels: Record<string, string> = {
    analyzed: '분석', ready: '파서 등록', needsReview: '검토 필요', findingTypes: '이상 종류', affectedRows: '대상 건수',
    collected: '수집', harvested: '수확', candidates: '신규 후보', observationsAdded: '신규 관측', keywordsAdded: '신규 사건',
    databaseObservationsAdded: 'DB 관측', requestedSources: '요청 소스', completedSources: '완료 소스',
    documentsChecked: '확인 문서', documentsInserted: '신규 문서', documentsUpdated: '수정 문서',
    documentsUnchanged: '동일 문서', casesChanged: '재판정 사건', unmatchedDocuments: '미매칭 문서',
    sourceDiscoveryQueries: '검색 사건명', sourceDiscoveryCandidates: '소스 후보', sourcesDiscovered: '신규 소스',
  }
  return labels[value] ?? value.replaceAll('_', ' ')
}

function AgentFlowStep({ number, title, description, active, warning = false }: { number: string; title: string; description: string; active: boolean; warning?: boolean }) {
  return <div className={`rounded-xl border px-4 py-3 ${warning ? 'border-amber-300/25 bg-amber-300/[.06]' : active ? 'border-[#70e3a1]/25 bg-[#70e3a1]/[.06]' : 'border-white/10 bg-black/10'}`}><div className="flex items-center gap-2"><span className={`grid size-6 place-items-center rounded-full text-[10px] font-black ${warning ? 'bg-amber-200 text-[#091117]' : 'bg-[#70e3a1] text-[#091117]'}`}>{number}</span><b className="text-sm">{title}</b></div><p className="mt-2 text-xs text-white/55">{description}</p></div>
}

function AgentControlCard({ number, title, status, warning = false, children }: { number: string; title: string; status: string; warning?: boolean; children: React.ReactNode }) {
  return <article className={`flex flex-col rounded-2xl border p-5 ${warning ? 'border-amber-300/25 bg-amber-300/[.04]' : 'border-white/10 bg-white/[.035]'}`}><div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-full bg-[#70e3a1] text-xs font-black text-[#091117]">{number}</span><h3 className="font-black">{title}</h3></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${warning ? 'bg-amber-300/10 text-amber-100' : 'bg-[#70e3a1]/10 text-[#9df0bd]'}`}>{status}</span></div><div className="flex flex-1 flex-col">{children}</div></article>
}

function AgentMiniMetric({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) {
  return <div className={`rounded-xl border p-3 ${warning ? 'border-amber-300/20 bg-amber-300/[.05]' : 'border-white/10 bg-black/10'}`}><p className="truncate text-[10px] font-bold text-white/50">{label}</p><p className={`mt-1 text-xl font-black tabular-nums ${warning ? 'text-amber-100' : ''}`}>{value.toLocaleString('ko-KR')}</p></div>
}

function AgentRule({ title, description }: { title: string; description: string }) {
  return <div><p className="text-sm font-black text-white/85">✓ {title}</p><p className="mt-1 text-xs leading-5 text-white/50">{description}</p></div>
}

function AgentRoleCard({ number, title, status, description, warning = false }: { number: string; title: string; status: string; description: string; warning?: boolean }) {
  return <article className={`rounded-xl border p-4 ${warning ? 'border-amber-300/25 bg-amber-300/[.06]' : 'border-white/10 bg-black/10'}`}><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-full bg-[#70e3a1] text-xs font-black text-[#091117]">{number}</span><h3 className="font-black">{title}</h3></div><span className={`text-[10px] font-bold ${warning ? 'text-amber-100' : 'text-[#9df0bd]'}`}>{status}</span></div><p className="mt-3 text-xs leading-5 text-white/60">{description}</p></article>
}

function OperatorCasesPanel({ data, query, page, pageSize }: { data: OperatorOverview; query: { q?: string; status?: string; sort?: string }; page: number; pageSize: number }) {
  const pageCount = Math.max(1, Math.ceil(data.casesTotal / pageSize))
  const pageHref = (next: number) => `/operator?section=cases&q=${encodeURIComponent(query.q ?? '')}&status=${encodeURIComponent(query.status ?? '')}&sort=${encodeURIComponent(query.sort ?? 'latest')}&page=${next}#operator-content`
  return <section className="rounded-3xl border border-white/10 bg-white/[.035] p-6 md:p-8">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">KEYWORDS · PAGES · ADS</p><h2 className="mt-2 text-2xl font-black">키워드·페이지·광고</h2><p className="mt-2 text-sm text-white/65">고객 운영실과 동일한 사건 표를 전체 법무법인 범위로 표시합니다.</p></div><span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/70">{data.casesTotal.toLocaleString('ko-KR')}개 중 {data.cases.length ? ((page - 1) * pageSize + 1).toLocaleString('ko-KR') : 0}–{Math.min(page * pageSize, data.casesTotal).toLocaleString('ko-KR')}개 표시</span></div>
    <form method="get" className="mt-6 grid gap-3 rounded-2xl border border-white/10 bg-black/10 p-4 md:grid-cols-[2fr_1fr_1fr_auto]"><input type="hidden" name="section" value="cases" /><input name="q" defaultValue={query.q} placeholder="사건명 또는 URL 슬러그 검색" className="rounded-xl border border-white/15 bg-[#131b24] px-4 py-3 text-sm" /><select name="status" defaultValue={query.status ?? ''} className="rounded-xl border border-white/15 bg-[#131b24] px-4 py-3 text-sm"><option value="">모든 상태</option><option value="discovered">발견</option><option value="verified">검증</option><option value="published">공개</option><option value="live">라이브</option></select><select name="sort" defaultValue={query.sort ?? 'latest'} className="rounded-xl border border-white/15 bg-[#131b24] px-4 py-3 text-sm"><option value="latest">최근 관측순</option><option value="observations">누적 관측순</option><option value="recent">14일 관측순</option><option value="assignments">법무법인 배정순</option><option value="visitors">방문자순</option><option value="inquiries">문의순</option></select><button className="rounded-xl bg-[#70e3a1] px-5 py-3 text-sm font-black text-[#091117]">조회</button></form>
    <div className="mt-6 overflow-x-auto"><table className="w-full min-w-[1450px] text-left text-sm"><thead className="text-xs text-white/60"><tr><th className="py-3 pr-4">사건명</th><th className="py-3 pr-4">파이프라인</th><th className="py-3 pr-4">네이버 광고 O/X</th><th className="py-3 pr-4">페이지</th><th className="py-3 pr-4">관측 수·상세</th><th className="py-3 pr-4 text-right">방문자수</th><th className="py-3 pr-4 text-right">문의수</th><th className="py-3 pr-4 text-right">전환율</th><th className="py-3 pr-4">최근 방문</th><th className="py-3">링크</th></tr></thead><tbody>{data.cases.length ? data.cases.map((item) => <tr key={item.id} className="border-t border-white/10 align-top"><td className="py-4 pr-4"><p className="font-black">{item.name}</p><p className="mt-1 font-mono text-[10px] text-white/50">{item.slug} · {statusLabel(item.scamType)}</p></td><td className="py-4 pr-4"><span className="rounded-full border border-[#70e3a1]/25 bg-[#70e3a1]/5 px-2.5 py-1 text-xs text-[#9df0bd]">{statusLabel(item.status)}</span></td><td className="py-4 pr-4"><span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold ${item.advertisingFirmCount ? 'border-[#70e3a1]/30 text-[#9df0bd]' : 'border-white/15 text-white/55'}`}><b>{item.advertisingFirmCount ? 'O' : 'X'}</b><span>{item.advertisingFirmCount ? `${item.advertisingFirmCount}개 법무법인` : '광고 제외'}</span></span></td><td className="py-4 pr-4">{item.pagePublished ? '공개 중' : '미발행'}</td><td className="py-4 pr-4"><details className="group"><summary className="cursor-pointer list-none whitespace-nowrap text-xs font-bold text-[#9df0bd]">관측 {item.observationCount.toLocaleString('ko-KR')}건 · 자세히 보기</summary><div className="mt-3 w-[720px] max-w-[70vw] rounded-xl border border-white/10 bg-[#101820] p-4"><p className="mb-3 text-xs text-white/55">최근 관측 {item.recentObservations.length.toLocaleString('ko-KR')}건</p>{item.recentObservations.length ? <div className="space-y-3">{item.recentObservations.map((observation, index) => <div key={`${observation.observedAt}-${index}`} className="border-t border-white/10 pt-3 first:border-0 first:pt-0"><div className="flex justify-between gap-3"><b className="text-xs">{observation.title ?? item.name}</b><span className="shrink-0 text-[10px] text-white/45">{observation.observedAt ? formatOpsDate(new Date(observation.observedAt)) : '—'}</span></div><p className="mt-1 text-[10px] text-white/50">{statusLabel(observation.sourceType)}</p>{observation.sourceUrl ? <a href={observation.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 block truncate text-[10px] text-[#9df0bd]">수집 원문 ↗</a> : null}</div>)}</div> : <p className="text-xs text-white/50">관측 내용이 없습니다.</p>}</div></details></td><td className="py-4 pr-4 text-right font-bold">{item.visitors.toLocaleString('ko-KR')}</td><td className="py-4 pr-4 text-right font-bold">{item.inquiries.toLocaleString('ko-KR')}</td><td className="py-4 pr-4 text-right">{item.visitors ? `${(item.inquiries / item.visitors * 100).toFixed(1)}%` : '—'}</td><td className="py-4 pr-4 whitespace-nowrap text-xs text-white/60">{item.lastVisitedAt ? formatOpsDate(item.lastVisitedAt) : '—'}</td><td className="py-4"><a href={`/f/${item.slug}${item.pagePublished ? '' : '?preview=1'}`} target="_blank" rel="noreferrer" className="text-xs font-bold text-[#9df0bd]">페이지 ↗</a></td></tr>) : <tr><td colSpan={10} className="py-12 text-center text-white/60">조건에 맞는 사건이 없습니다.</td></tr>}</tbody></table></div>
    <div className="mt-5 flex items-center justify-between"><span className="text-xs text-white/50">{page.toLocaleString('ko-KR')} / {pageCount.toLocaleString('ko-KR')} 페이지</span><div className="flex gap-2">{page > 1 ? <a href={pageHref(page - 1)} className="rounded-lg border border-white/15 px-4 py-2 text-xs font-bold">← 이전</a> : null}{page < pageCount ? <a href={pageHref(page + 1)} className="rounded-lg bg-white/10 px-4 py-2 text-xs font-bold">다음 →</a> : null}</div></div>
  </section>
}

function metric(metrics: Record<string, unknown> | null, key: string): string {
  const value = metrics?.[key]
  return typeof value === 'number' ? value.toLocaleString('ko-KR') : '—'
}

function statusLabel(value: string | null | undefined): string {
  if (!value) return ''
  const labels: Record<string, string> = {
    active: '활성', acknowledged: '확인됨', approved: '승인', blocked: '차단',
    completed: '완료', dead: '영구 실패', disabled: '중지', discovered: '발견', draft: '초안',
    error: '오류', failed: '실패', in_progress: '진행 중', internal: '내부',
    needs_review: '검토 필요', ok: '정상', paused: '일시중지', pending: '대기',
    pending_analysis: '분석 대기', published: '공개', ready: '준비 완료',
    rejected: '반려', registered: '등록 완료', resolved: '해결', retry: '재시도',
    running: '실행 중', succeeded: '성공', verified: '검증', generated: '생성', ad_registered: '광고 등록', live: '라이브', warning: '주의', revoked: '해제',
    coin: '코인·가상자산', leading: '리딩방', stock: '주식', investment: '투자·부업', invest: '투자·부업', romance: '로맨스', used: '중고거래·쇼핑몰', other: '기타',
    'competitor-sitemap': '경쟁사 사이트맵', sitemap: '사이트맵', rss: 'RSS', blog: '블로그',
  }
  return labels[value] ?? value.replaceAll('_', ' ')
}

function UnifiedDataPanel({ data }: { data: UnifiedSystemStats }) {
  return (
    <section className="mb-8 rounded-3xl border border-white/10 bg-white/[.035] p-6 md:p-8">
      <div><p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">UNIFIED LIVE DATA</p><h2 className="mt-2 text-2xl font-black">현재 실제 운영 데이터</h2><p className="mt-2 text-sm text-white/45">사건·관측·페이지·법무법인 설정을 하나의 정본 흐름으로 집계합니다.</p></div>
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <OpsMetric label="법무법인" value={data.firms} />
        <OpsMetric label="수집소스" value={data.sources} />
        <OpsMetric label="사건명" value={data.keywords} />
        <OpsMetric label="관측정보" value={data.observations} />
        <OpsMetric label="랜딩페이지" value={data.pages} />
        <OpsMetric label="법무법인별 사건" value={data.assignments} />
        <OpsMetric label="방문자" value={data.visitors} />
        <OpsMetric label="문의" value={data.inquiries} />
        <OpsMetric label="수집 실행" value={data.collectionRuns} />
      </div>
    </section>
  )
}

function OperationsPanel({ data }: { data: OperationsControlPlane }) {
  const failedJobs = [...data.jobs.retryQueue, ...data.jobs.failedQueue, ...data.jobs.deadQueue]
  return (
    <section className="mb-8 rounded-3xl border border-white/10 bg-white/[.035] p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">LIVE OPERATIONS CONTROL PLANE</p>
          <h2 className="mt-2 text-2xl font-black">오늘 사람이 확인해야 하는 예외</h2>
          <p className="mt-2 text-sm text-white/45">정상 처리 수가 아니라 검토·재시도·차단·SLA 예외를 우선 표시합니다.</p>
        </div>
        <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/45">실제 운영 DB</span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <OpsMetric label="소스 실패" value={data.sourceHealth.failed + data.sourceHealth.warning} critical={data.sourceHealth.failed > 0} />
        <OpsMetric label="사건 검토" value={data.caseReview.count} />
        <OpsMetric label="승인 대기" value={data.approvals.count} />
        <OpsMetric label="발행 backlog" value={data.publicationBacklog.count} critical={data.publicationBacklog.failed + data.publicationBacklog.blocked > 0} />
        <OpsMetric label="재시도" value={data.jobs.retryable} />
        <OpsMetric label="dead-letter" value={data.jobs.dead} critical={data.jobs.dead > 0} />
        <OpsMetric label="활성 경보" value={data.alerts.count} critical={data.alerts.critical > 0} />
        <OpsMetric label="SLA 초과" value={data.alerts.sla.activeBreached} critical={data.alerts.sla.activeBreached > 0} />
      </div>

      <div className="mt-7 grid gap-5 xl:grid-cols-2">
        <OpsQueue title="활성 경보" empty="열린 운영 경보가 없습니다.">
          {data.alerts.queue.map((alert) => (
            <li key={alert.id} className="rounded-xl border border-white/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <strong className={alert.severity === 'critical' ? 'text-red-200' : 'text-amber-200'}>{alert.alertType}</strong>
                <span className="text-[10px] text-white/55">{alert.slaState === 'breached' ? 'SLA 초과' : statusLabel(alert.severity)}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-white/55">{alert.message}</p>
              <p className="mt-2 text-[10px] text-white/30">firm {alert.firmId ?? 'global'} · {formatOpsDate(alert.openedAt)}</p>
              <div className="mt-3 flex gap-2">
                <form action={decideAlertFromConsole}><input type="hidden" name="alertId" value={alert.id} /><input type="hidden" name="decision" value="acknowledged" /><button className="rounded-lg border border-white/12 px-2.5 py-1.5 text-[10px] font-bold text-white/65">확인함</button></form>
                <form action={decideAlertFromConsole}><input type="hidden" name="alertId" value={alert.id} /><input type="hidden" name="decision" value="resolved" /><button className="rounded-lg bg-[#70e3a1] px-2.5 py-1.5 text-[10px] font-bold text-[#091117]">해결</button></form>
              </div>
            </li>
          ))}
        </OpsQueue>

        <OpsQueue title="실패·재시도 job" empty="재시도 또는 실패 job이 없습니다.">
          {failedJobs.slice(0, 12).map((job) => (
            <li key={job.id} className="rounded-xl border border-white/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <strong>{job.jobType}</strong>
                <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${job.state === 'dead' || job.state === 'failed' ? 'bg-red-400/10 text-red-200' : 'bg-amber-300/10 text-amber-200'}`}>{statusLabel(job.state)}</span>
              </div>
              <p className="mt-2 text-xs text-white/45">시도 {job.attempts}/{job.maxAttempts} · firm {job.firmId ?? 'global'}</p>
              {job.lastError ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-red-200/70">{job.lastError}</p> : null}
              <form action={requeueJobFromConsole} className="mt-3"><input type="hidden" name="jobId" value={job.id} /><button className="rounded-lg border border-amber-200/25 px-2.5 py-1.5 text-[10px] font-bold text-amber-100">검토 후 재시도</button></form>
            </li>
          ))}
        </OpsQueue>

        <OpsQueue title="발행 예외" empty="대기·차단된 publication이 없습니다.">
          {data.publicationBacklog.queue.map((publication) => (
            <li key={publication.id} className="rounded-xl border border-white/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <strong className="truncate">{publication.domain}</strong>
                <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] font-bold text-white/55">{statusLabel(publication.status)}</span>
              </div>
              <p className="mt-2 truncate text-xs text-white/45">{publication.url}</p>
              <p className="mt-2 text-[10px] text-white/30">{publication.indexPolicy} · firm {publication.firmId}</p>
            </li>
          ))}
        </OpsQueue>

        <OpsQueue title="사건·승인 검토" empty="사건 또는 승인 검토 대기가 없습니다.">
          {data.caseReview.queue.slice(0, 6).map((item) => (
            <li key={item.id} className="rounded-xl border border-white/10 p-4">
              <div className="flex items-center justify-between gap-3"><strong>{item.canonicalName}</strong><span className="text-[10px] text-white/55">{statusLabel(item.status)}</span></div>
              <p className="mt-2 text-xs text-white/45">{item.category} · 신뢰도 {(item.confidence / 100).toFixed(0)}%</p>
            </li>
          ))}
          {data.approvals.queue.slice(0, 6).map((task) => (
            <li key={task.id} className="rounded-xl border border-[#70e3a1]/15 bg-[#70e3a1]/5 p-4">
              <div className="flex items-center justify-between gap-3"><strong>{task.taskType}</strong><span className="text-[10px] text-[#9df0bd]">{task.requiredActorType} 승인</span></div>
              <p className="mt-2 text-xs text-white/45">firm {task.firmId ?? 'global'} · {task.reason ?? '사유 미기재'}</p>
              {task.taskType === 'case_review' && task.firmId === null ? (
                <form action={decideCaseApprovalFromConsole} className="mt-3 grid gap-2">
                  <input type="hidden" name="taskId" value={task.id} />
                  <input name="reason" required minLength={5} placeholder="검토 근거 또는 보류 사유" className="rounded-lg border border-white/12 bg-black/20 px-3 py-2 text-xs text-white outline-none placeholder:text-white/25" />
                  <div className="flex flex-wrap gap-2">
                    <button name="decision" value="approve" className="rounded-lg bg-[#70e3a1] px-2.5 py-1.5 text-[10px] font-bold text-[#091117]">근거 확인·승인</button>
                    <button name="decision" value="reject" className="rounded-lg border border-amber-200/25 px-2.5 py-1.5 text-[10px] font-bold text-amber-100">보류</button>
                    <button name="decision" value="block" className="rounded-lg border border-red-300/25 px-2.5 py-1.5 text-[10px] font-bold text-red-200">차단</button>
                  </div>
                </form>
              ) : <p className="mt-3 text-[10px] text-white/35">고객 법률사무소 대시보드에서 승인해야 합니다.</p>}
            </li>
          ))}
        </OpsQueue>
      </div>
    </section>
  )
}

function OperatorActionNotice({ action }: { action: string }) {
  const messages: Record<string, string> = {
    'collector-created': '신규 링크를 에이전트 분석 대기열에 등록했습니다. 판별·검증에 성공하면 다음 수집 런부터 자동 활성화됩니다.',
    'collector-duplicate': '이미 등록된 수집 페이지입니다.',
    'collector-invalid': '소스 이름과 공개 HTTPS 링크를 확인해 주세요.',
    'collector-failed': '수집 페이지 변경에 실패했습니다. 운영 로그에서 원인을 확인해 주세요.',
    'collector-enabled': '선택한 수집 소스를 다시 활성화했습니다.',
    'collector-disabled': '선택한 수집 소스를 중지했습니다. 기존 수집 데이터는 보존됩니다.',
    'collector-not-found': '변경할 수집 소스를 찾지 못했습니다.',
    'job-requeued': '선택한 작업을 즉시 재시도 큐로 돌려보냈습니다.',
    'job-not-found': '재시도 가능한 작업을 찾지 못했습니다. 상태가 이미 변경됐을 수 있습니다.',
    'alert-acknowledged': '운영 경보를 확인 상태로 변경했습니다.',
    'alert-resolved': '운영 경보를 해결 상태로 종료했습니다.',
    'alert-not-found': '변경 가능한 운영 경보를 찾지 못했습니다.',
    'case-approved': '사건 근거 검토를 승인했습니다. 고객별 콘텐츠 승인 단계로 이동합니다.',
    'case-rejected': '사건을 보류하고 검토 task를 종료했습니다.',
    'case-blocked': '사건을 차단했습니다. 발행 경로가 열리지 않습니다.',
    'approval-invalid': '결정과 검토 사유를 모두 입력해 주세요.',
    'approval-blocked': '근거 게이트 또는 현재 상태 때문에 결정을 적용하지 못했습니다.',
    'gtm-created': '목표 사무소를 GTM 파이프라인에 추가했습니다.',
    'gtm-updated': '영업 단계를 갱신했습니다.',
    'gtm-followup-updated': '후속 연락 일정을 갱신했습니다.',
    'gtm-not-found': '해당 scope의 영업 대상을 찾지 못했습니다.',
    'gtm-invalid': '영업 대상 입력값을 확인해 주세요.',
    'gtm-invalid-transition': '중간 단계를 건너뛸 수 없으며 종료에는 사유가 필요합니다.',
    'gtm-failed': '영업 대상을 저장하지 못했습니다.',
    'source-request-registered': '수집소스를 등록하고 요청 법무법인에 승인했습니다. 에이전트 분석 완료 후 수집에 포함됩니다.',
    'source-request-rejected': '등록 보류로 처리했습니다.',
    'source-request-invalid': '수집 요청 처리값을 확인해 주세요.',
    'source-request-stale': '이미 처리됐거나 존재하지 않는 요청입니다.',
    'source-granted': '선택한 법무법인에 수집소스를 승인했습니다.',
    'source-grant-active': '수집소스 승인을 다시 활성화했습니다.',
    'source-grant-paused': '이 법무법인의 수집소스 승인을 일시중지했습니다.',
    'source-grant-revoked': '이 법무법인의 수집소스 승인을 해제했습니다.',
    'source-grant-invalid': '법무법인 또는 수집소스를 다시 선택해 주세요.',
    'parser-completed': '신규 URL 분석을 마쳤습니다. 처리 건수와 권장 조치를 실행 이력에 저장했습니다.',
    'parser-failed': '파서 생성 실행을 시작하지 못했습니다. 기존 파서와 수집 설정은 변경되지 않았습니다.',
    'review-completed': '운영 DB 읽기 전용 진단을 마쳤습니다. 이상 내용과 권장 조치를 실행 이력에 저장했습니다.',
    'review-failed': '운영 DB 진단을 완료하지 못했습니다. 데이터는 변경되지 않았습니다.',
    'agent-action-approved': '조치 제안을 승인했습니다. 다음 에이전트 파이프라인에서 A1 재수집 또는 A2 재분석을 한 번 실행합니다.',
    'agent-action-rejected': '조치 제안을 거절했습니다. 수집소스와 체크포인트는 변경되지 않습니다.',
    'agent-action-invalid': '조치 제안과 승인·거절 사유를 다시 확인해 주세요.',
    'agent-action-failed': '조치 제안 결정을 저장하지 못했습니다. 이미 처리된 제안인지 확인해 주세요.',
  }
  const ok = ['job-requeued', 'alert-acknowledged', 'alert-resolved', 'case-approved', 'gtm-created', 'gtm-updated', 'gtm-followup-updated', 'source-request-registered', 'source-granted', 'source-grant-active', 'source-grant-paused', 'parser-completed', 'review-completed', 'agent-action-approved', 'agent-action-rejected'].includes(action)
  return <div className={`mb-6 rounded-xl border px-4 py-3 text-sm ${ok ? 'border-[#70e3a1]/35 bg-[#70e3a1]/10 text-[#9df0bd]' : 'border-amber-300/25 bg-amber-300/10 text-amber-100'}`}>{messages[action] ?? '운영 작업 상태가 갱신되었습니다.'}</div>
}

function OpsMetric({ label, value, critical = false }: { label: string; value: number; critical?: boolean }) {
  return <div className={`rounded-xl border p-4 ${critical ? 'border-red-400/25 bg-red-400/8' : 'border-white/10 bg-black/10'}`}><p className="text-[10px] font-bold tracking-[.1em] text-white/35">{label}</p><p className={`mt-3 text-2xl font-black ${critical ? 'text-red-200' : 'text-white'}`}>{value.toLocaleString('ko-KR')}</p></div>
}

function OpsQueue({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const rows = Array.isArray(children) ? children.flat().filter(Boolean) : children ? [children] : []
  return <article className="rounded-2xl border border-white/10 bg-black/10 p-5"><h3 className="font-black">{title}</h3>{rows.length ? <ul className="mt-4 grid gap-3 sm:grid-cols-2">{children}</ul> : <p className="mt-4 text-sm text-white/35">{empty}</p>}</article>
}

function formatOpsDate(value: Date): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(value)
}

function OperatorShell({ children }: { children: React.ReactNode }) {
  return <main className="longtail-demo min-h-screen bg-[#091117] px-5 py-10 text-white md:px-8"><div className="mx-auto max-w-7xl"><header className="mb-10 flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-7"><div><p className="text-[10px] font-black tracking-[.18em] text-[#70e3a1]">CONTROL PLANE</p><h1 className="mt-3 text-3xl font-black tracking-[-.04em]">사건명 광고 엔진 · 총운영자</h1></div><Link href="/" className="text-sm font-bold text-white/55">제품 페이지 ↗</Link></header>{children}</div></main>
}

function Field({ name, label, placeholder, required = true, pattern, type = 'text' }: { name: string; label: string; placeholder: string; required?: boolean; pattern?: string; type?: string }) {
  return <label><span className="mb-2 block text-xs font-bold text-white/55">{label}</span><input name={name} type={type} required={required} pattern={pattern} placeholder={placeholder} className="w-full rounded-xl border border-white/12 bg-[#131b24] px-4 py-3 text-sm text-white outline-none placeholder:text-white/22 focus:border-[#70e3a1]" /></label>
}

function TextAreaField({ name, label, placeholder, required = true }: { name: string; label: string; placeholder: string; required?: boolean }) {
  return <label><span className="mb-2 block text-xs font-bold text-white/55">{label}</span><textarea name={name} required={required} rows={3} placeholder={placeholder} className="w-full rounded-xl border border-white/12 bg-[#131b24] px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-[#70e3a1]/60" /></label>
}

function FormStep({ number, title, description, children }: { number: string; title: string; description: string; children: React.ReactNode }) {
  return <fieldset className="sm:col-span-2 grid gap-4 rounded-2xl border border-white/10 bg-black/10 p-4 sm:grid-cols-2 sm:p-5">
    <legend className="px-2 text-sm font-black text-white"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#70e3a1] text-xs text-[#091117]">{number}</span>{title}</legend>
    <p className="-mt-2 text-xs leading-5 text-white/60 sm:col-span-2">{description}</p>
    {children}
  </fieldset>
}
