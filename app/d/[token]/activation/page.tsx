import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getFirmActivationChecklist, type ActivationCheckKey } from '@/domains/tenancy'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '활성화 체크리스트',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

type NextAction = { href: string; label: string }

const NEXT_ACTIONS: Record<ActivationCheckKey, NextAction> = {
  firm_profile: { href: '/profile', label: '프로필·상담 정보 열기' },
  domain_tls: { href: '/site', label: '사이트·도메인 상태 보기' },
  naver_connection: { href: '/ads', label: '네이버 연결 상태 보기' },
  budget_policy: { href: '/ads', label: '예산 정책 열기' },
  approved_cases: { href: '/keywords', label: '사건 커버리지 열기' },
  live_surfaces: { href: '/site', label: '공개 상태 보기' },
  canonical_lead: { href: '/leads', label: '상담 귀속 확인하기' },
  customer_outcome: { href: '/leads', label: '리드 outcome 열기' },
}

const STATUS_LABEL: Record<string, string> = {
  ready: '준비됨',
  pending: '대기',
  blocked: '차단',
}

/**
 * Customer-facing activation evidence. All rows are resolved from the
 * dashboard token and the checklist itself is read-only; no external check
 * is inferred or triggered by this page.
 */
export default async function FirmActivationPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  if (!process.env.DATABASE_URL) return null

  const { token } = await params
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()

  const checklist = await getFirmActivationChecklist(db, firm.id)
  if (!checklist) notFound()

  const dashboardPath = `/d/${encodeURIComponent(token)}`
  const firstIncomplete = checklist.checks.find((item) => item.status !== 'ready')
  const primaryAction = firstIncomplete
    ? NEXT_ACTIONS[firstIncomplete.key]
    : NEXT_ACTIONS.customer_outcome

  return (
    <div className="space-y-10" data-activation-status={checklist.status} data-activation-complete={String(checklist.complete)}>
      <section className="rounded-2xl border t-border t-surface p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="font-mono-label t-sub">FIRM ACTIVATION · DATABASE EVIDENCE</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight">활성화 체크리스트</h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 t-sub">
              {firm.name}의 필수 준비 상태를 기존 DB 정본으로 계산합니다. 외부 서비스나 공개 URL을 이 화면에서 다시 확인하지 않으며,
              저장된 검증 증거가 없으면 대기 상태로 표시합니다.
            </p>
          </div>
          <StatusBadge status={checklist.status} />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
          <span className="rounded-lg border t-border px-3 py-2">
            필수 조건 {checklist.checks.filter((item) => item.status === 'ready').length}/{checklist.checks.length} 준비됨
          </span>
          <span className="rounded-lg border t-border px-3 py-2">
            승인 사건 {checklist.approvedCases.count}건 · 최소 {checklist.approvedCases.minimum}건
          </span>
          <Link href={`${dashboardPath}${primaryAction.href}`} className="t-cta-primary rounded-lg px-4 py-2 font-semibold">
            {checklist.complete ? '상담 관리 열기' : primaryAction.label} →
          </Link>
        </div>
      </section>

      <section aria-labelledby="activation-checks-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono-label t-sub">REQUIRED GATES</p>
            <h3 id="activation-checks-heading" className="mt-1 text-xl font-bold">필수 조건별 현재 상태</h3>
          </div>
          <p className="text-xs t-sub">상태 값: ready · pending · blocked</p>
        </div>

        <ol className="mt-5 grid gap-4 lg:grid-cols-2">
          {checklist.checks.map((item) => {
            const action = NEXT_ACTIONS[item.key]
            return (
              <li
                key={item.key}
                data-activation-check={item.key}
                data-activation-status={item.status}
                className="rounded-xl border t-border t-surface p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-mono-label t-sub">{item.key}</p>
                    <h4 className="mt-2 text-base font-bold">{item.label}</h4>
                  </div>
                  <StatusBadge status={item.status} />
                </div>
                <p className="mt-4 text-sm font-semibold leading-6">{item.summary}</p>
                <p className="mt-2 text-xs leading-6 t-sub">{item.detail}</p>
                <Link
                  href={`${dashboardPath}${action.href}`}
                  data-next-action={item.key}
                  className="mt-4 inline-flex text-sm font-semibold t-accent"
                >
                  {item.status === 'ready' ? '관련 상태 다시 보기' : action.label} →
                </Link>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl border t-border t-surface p-5">
          <p className="font-mono-label t-sub">CASE TARGET</p>
          <h3 className="mt-2 font-bold">고신뢰 승인 사건 범위</h3>
          <p className="mt-2 text-sm leading-6 t-sub">
            현재 단계 최소 {checklist.approvedCases.minimum}건 · 파일럿 목표 {checklist.approvedCases.pilotTargetLabel}건
          </p>
          <p className="mt-3 text-xs leading-6 t-sub">
            현재 {checklist.approvedCases.count}건 · 범위 후보 {checklist.approvedCases.scopedCandidates}건 · 차단 후보 {checklist.approvedCases.blockedCandidates}건
          </p>
        </article>
        <article className="rounded-xl border t-border t-surface p-5">
          <p className="font-mono-label t-sub">CANONICAL LEADS</p>
          <h3 className="mt-2 font-bold">테스트·실 lead 귀속 증거</h3>
          <p className="mt-2 text-sm leading-6 t-sub">
            canonical {checklist.leads.canonicalLeads}건 · 테스트 {checklist.leads.testLeads}건 · 실 lead {checklist.leads.realLeads}건
          </p>
          <p className="mt-3 text-xs leading-6 t-sub">
            불완전 {checklist.leads.incompleteLeads}건 · 무결성 불일치 {checklist.leads.invalidLeads}건
          </p>
        </article>
      </section>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      data-status={status}
      className="inline-flex shrink-0 items-center gap-2 rounded-full border t-border px-3 py-1 text-xs font-semibold"
    >
      <span className="h-2 w-2 rounded-full" style={{ background: status === 'ready' ? 'var(--t-accent)' : status === 'blocked' ? '#dc2626' : 'var(--t-accent2)' }} aria-hidden="true" />
      {STATUS_LABEL[status] ?? status} <span className="font-mono-label">{status}</span>
    </span>
  )
}
