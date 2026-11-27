import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import {
  LEAD_PRIORITY_LABEL,
  LEAD_STATUS_LABEL,
  LEAD_STATUS_OPTIONS,
  isLeadIntakeStatus,
  leadQueueSummary,
  leadsData,
  type LeadRow,
} from '@/lib/dashboard/leads'
import { updateLeadStatus } from '@/lib/dashboard/actions'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '상담 관리',
  robots: { index: false, follow: false },
}

export default async function DashboardLeadsPage(
  { params }: { params: Promise<{ token: string }> },
) {
  if (!process.env.DATABASE_URL) return null
  const { token } = await params
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()

  const rows = await leadsData(db, firm)
  const summary = leadQueueSummary(rows)
  const queue = [...rows]
    .filter((row) => !['수임', '종결'].includes(row.status))
    .sort(compareQueue)
    .slice(0, 8)

  return (
    <div className="space-y-10">
      <section>
        <p className="font-mono-label t-sub">CONSULTATION DESK</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">상담 누락 없이, 다음 행동이 보이는 접수함</h2>
        <p className="mt-2 max-w-3xl text-sm leading-7 t-sub">
          홈페이지 상담이 실시간으로 들어옵니다. 담당 변호사, 연락 예정 시각, 초기 메모와 증거 준비 상태를
          상담 브리프에 기록하고 사무소 내부의 이해충돌 가능성을 점검할 수 있습니다.
        </p>
        <p className="mt-3 max-w-3xl text-xs leading-6 t-sub">
          목록에서는 신규·연락완료·검토중 같은 접수 단계만 변경합니다. 적격 판단(qualification) → 상담 일정(consultation) → 수임·미수임·종결(matter_outcome)은 각 행의 상세 기록에서만 남깁니다.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          <QueueTile label="신규" value={summary.newCount} tone="accent" />
          <QueueTile label="연락 지연" value={summary.overdue} tone={summary.overdue ? 'danger' : undefined} />
          <QueueTile label="오늘 연락" value={summary.dueToday} />
          <QueueTile label="충돌 검토" value={summary.conflictReview} tone={summary.conflictReview ? 'warning' : undefined} />
          <QueueTile label="담당 미배정" value={summary.unassigned} />
        </div>
      </section>

      <section className="rounded-2xl border t-border t-surface p-6 md:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono-label t-sub">TODAY&apos;S QUEUE</p>
            <h3 className="mt-2 text-xl font-bold">먼저 연락할 상담</h3>
          </div>
          <span className="text-xs t-sub">긴급도와 연락 예정 시각을 함께 반영</span>
        </div>
        {queue.length ? (
          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            {queue.map((row) => (
              <Link key={row.id} href={`/d/${token}/leads/${row.id}`} className="rounded-xl border t-border p-4 transition hover:[border-color:var(--t-accent)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${priorityClass(row.priority)}`}>{LEAD_PRIORITY_LABEL[row.priority]}</span>
                      {row.conflictStatus === 'review' && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-bold text-amber-700">충돌 검토</span>}
                    </div>
                    <p className="mt-3 font-bold">{row.name}</p>
                    <p className="mt-1 line-clamp-1 text-xs t-sub">{row.detail ?? '상세 내용 미기재'}</p>
                  </div>
                  <div className="text-right text-xs t-sub">
                    <p>{row.assignedLawyer ?? '담당 미배정'}</p>
                    <p className={isOverdue(row) ? 'mt-1 font-bold text-red-600' : 'mt-1'}>{row.followUpAt ? formatShort(row.followUpAt) : '연락일 미지정'}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : <p className="mt-5 text-sm t-sub">진행 중인 상담이 없습니다.</p>}
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><p className="font-mono-label t-sub">ALL INTAKES</p><h3 className="mt-2 text-xl font-bold">전체 상담 {rows.length}건</h3></div>
          <span className="text-xs t-sub">상담 브리프에서 상세 기록과 충돌 점검 가능</span>
        </div>
        <div className="mt-5 overflow-x-auto rounded-xl border t-border t-surface">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead><tr className="border-b t-border">
              <th className="px-4 py-3 font-mono-label t-sub">우선순위</th>
              <th className="px-4 py-3 font-mono-label t-sub">상담자</th>
              <th className="px-4 py-3 font-mono-label t-sub">유입·내용</th>
              <th className="px-4 py-3 font-mono-label t-sub">담당·다음 연락</th>
              <th className="px-4 py-3 font-mono-label t-sub">접수</th>
              <th className="px-4 py-3 font-mono-label t-sub">상태</th>
              <th className="px-4 py-3 font-mono-label t-sub">브리프</th>
            </tr></thead>
            <tbody>{rows.map((row) => <LeadTableRow key={row.id} row={row} token={token} />)}</tbody>
          </table>
          {rows.length === 0 && <p className="p-6 text-sm t-sub">아직 접수된 상담이 없습니다.</p>}
        </div>
      </section>
    </div>
  )
}

function QueueTile({ label, value, tone }: { label: string; value: number; tone?: 'accent' | 'danger' | 'warning' }) {
  const toneClass = tone === 'danger' ? 'text-red-600' : tone === 'warning' ? 'text-amber-700' : tone === 'accent' ? 't-accent' : ''
  return <div className="rounded-xl border t-border t-surface p-4"><p className="font-mono-label t-sub">{label}</p><p className={`mt-2 text-2xl font-bold tabular-nums ${toneClass}`}>{value}</p></div>
}

function LeadTableRow({ row, token }: { row: LeadRow; token: string }) {
  return (
    <tr className="border-b t-border last:border-0">
      <td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${priorityClass(row.priority)}`}>{LEAD_PRIORITY_LABEL[row.priority]}</span></td>
      <td className="px-4 py-4">
        <p className="font-semibold">{row.name}{row.isDemo && <span className="ml-2 rounded-full px-2 py-0.5 text-[10px] t-sub" style={{ background: 'var(--t-line)' }}>데모</span>}</p>
        <a href={`tel:${row.phone.replace(/[^\d+]/g, '')}`} className="mt-1 block text-xs t-accent">{row.phone}</a>
        {row.conflictStatus === 'review' && <p className="mt-2 text-[10px] font-bold text-amber-700">충돌 가능성 검토 필요</p>}
      </td>
      <td className="max-w-[320px] px-4 py-4">
        <p className="text-[10px] font-semibold t-accent">{row.slug ?? (row.vertical === 'product' ? '제품 문의' : '직접 유입')}</p>
        <p className="mt-1 line-clamp-2 text-xs leading-5 t-sub">{row.detail ?? '상세 내용 미기재'}</p>
      </td>
      <td className="px-4 py-4 text-xs t-sub"><p>{row.assignedLawyer ?? '미배정'}</p><p className={isOverdue(row) ? 'mt-1 font-bold text-red-600' : 'mt-1'}>{row.followUpAt ? formatShort(row.followUpAt) : '예정 없음'}</p></td>
      <td className="px-4 py-4 text-xs t-sub">{formatDateTime(row.createdAt)}</td>
      <td className="px-4 py-4">
        {isLeadIntakeStatus(row.status) ? (
          <form action={updateLeadStatus.bind(null, token, row.id)} className="flex items-center gap-2">
            <select name="status" defaultValue={row.status} aria-label={`${row.name} 상담 상태 변경`} className="rounded-md border t-border t-surface px-2 py-1.5 text-xs">
              {LEAD_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{LEAD_STATUS_LABEL[status]}</option>)}
            </select>
            <button type="submit" className="rounded-lg border t-border px-2.5 py-1.5 text-xs font-semibold">저장</button>
          </form>
        ) : (
          <div>
            <span className="rounded-full border t-border px-2.5 py-1 text-xs font-semibold">{statusLabel(row.status)}</span>
            <p className="mt-2 text-[10px] leading-4 t-sub">상세 기록에서 결과를 관리합니다.</p>
          </div>
        )}
      </td>
      <td className="px-4 py-4"><Link href={`/d/${token}/leads/${row.id}`} className="t-cta-primary inline-flex rounded-lg px-3 py-2 text-xs font-semibold">상세 기록 →</Link></td>
    </tr>
  )
}

const PRIORITY_WEIGHT = { urgent: 0, high: 1, normal: 2, low: 3 }
function compareQueue(a: LeadRow, b: LeadRow): number {
  const followA = a.followUpAt?.getTime() ?? Number.MAX_SAFE_INTEGER
  const followB = b.followUpAt?.getTime() ?? Number.MAX_SAFE_INTEGER
  const overdueA = followA < Date.now() ? 0 : 1
  const overdueB = followB < Date.now() ? 0 : 1
  return overdueA - overdueB || PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] || followA - followB || b.createdAt.getTime() - a.createdAt.getTime()
}

function isOverdue(row: LeadRow): boolean { return Boolean(row.followUpAt && row.followUpAt.getTime() < Date.now() && !['수임', '종결'].includes(row.status)) }
function priorityClass(priority: LeadRow['priority']): string {
  if (priority === 'urgent') return 'bg-red-50 text-red-700'
  if (priority === 'high') return 'bg-amber-50 text-amber-700'
  if (priority === 'low') return 'bg-slate-100 text-slate-600'
  return 'bg-emerald-50 text-emerald-700'
}
function statusLabel(status: string): string { return LEAD_STATUS_LABEL[status as keyof typeof LEAD_STATUS_LABEL] ?? status }
function formatShort(d: Date): string { return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(d) }
function formatDateTime(d: Date): string { return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(d) }
