import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import {
  EVIDENCE_ITEMS,
  LEAD_PRIORITY_LABEL,
  LEAD_PRIORITY_OPTIONS,
  LEAD_STATUS_LABEL,
  LEAD_STATUS_OPTIONS,
  leadDetailData,
  type LeadRow,
} from '@/lib/dashboard/leads'
import { conflictHistoryForLead } from '@/lib/leads/conflict'
import {
  bookConsultation,
  qualifyLead,
  recordMatterOutcome,
  runLeadConflictCheck,
  saveLeadIntake,
  transitionConsultation,
} from '@/lib/dashboard/actions'
import { getLeadOutcome } from '@/domains/outcomes'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: '상담 브리프', robots: { index: false, follow: false } }

export default async function LeadBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; leadId: string }>
  searchParams: Promise<{ saved?: string; error?: string; conflict?: string }>
}) {
  if (!process.env.DATABASE_URL) return null
  const { token, leadId } = await params
  const query = await searchParams
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()
  const [lead, history, outcome] = await Promise.all([
    leadDetailData(db, firm, leadId),
    conflictHistoryForLead(db, firm, leadId),
    getLeadOutcome(db, firm, leadId),
  ])
  if (!lead || !outcome) notFound()
  const qualificationPending = !outcome.qualification
  const canBookConsultation = outcome.qualification?.status === 'qualified'
    && !outcome.matterOutcome
    && (!outcome.consultation || ['cancelled', 'no_show'].includes(outcome.consultation.status))
  const canTransitionConsultation = outcome.consultation?.status === 'booked' && !outcome.matterOutcome
  const canRecordMatterOutcome = Boolean(
    !outcome.matterOutcome
    && outcome.consultation
    && ['booked', 'completed'].includes(outcome.consultation.status),
  )

  return (
    <div className="space-y-8">
      <section>
        <Link href={`/d/${token}/leads`} className="text-xs font-semibold t-sub">← 상담 관리로</Link>
        <div className="mt-5 flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${priorityClass(lead.priority)}`}>{LEAD_PRIORITY_LABEL[lead.priority]}</span>
              <ConflictBadge status={lead.conflictStatus} />
            </div>
            <p className="mt-4 font-mono-label t-sub">CONSULTATION BRIEF</p>
            <h2 className="mt-1 text-3xl font-bold tracking-tight">{lead.name}</h2>
            <p className="mt-2 text-sm t-sub">{formatDateTime(lead.createdAt)} 접수 · {LEAD_STATUS_LABEL[lead.status as keyof typeof LEAD_STATUS_LABEL] ?? lead.status}</p>
          </div>
          <a href={`tel:${lead.phone.replace(/[^\d+]/g, '')}`} className="t-cta-accent rounded-xl px-5 py-3 text-sm font-bold">{lead.phone} 전화하기</a>
        </div>
      </section>

      {(query.saved || query.error || query.conflict) && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${query.error ? 'border-red-300 bg-red-50 text-red-700' : query.conflict === 'review' ? 'border-amber-300 bg-amber-50 text-amber-800' : 't-border t-surface t-accent'}`}>
          {query.error === 'outcome-transition' ? '현재 상담 상태에서는 이 결과를 기록할 수 없습니다. 기존 기록은 변경되지 않았습니다.' : query.error === 'outcome-validation' ? '결과 기록의 입력값을 확인해 주세요. 기존 기록은 변경되지 않았습니다.' : query.error ? '입력값을 확인해 주세요. 기존 기록은 변경되지 않았습니다.' : query.saved === 'qualification' ? '수임 검토 결과가 추가되었습니다.' : query.saved === 'consultation' ? '상담 예약이 추가되었습니다.' : query.saved === 'consultation-status' ? '상담 진행 결과가 추가되었습니다.' : query.saved === 'matter-outcome' ? '사건 결과가 추가되었습니다.' : query.conflict === 'review' ? '같은 사무소의 과거 상담과 이름이 일치하는 항목이 있습니다. 수임 전 변호사가 직접 확인해 주세요.' : query.conflict === 'clear' ? '현재 입력한 이름과 일치하는 과거 상담 기록은 찾지 못했습니다.' : '상담 브리프가 저장되었습니다.'}
        </div>
      )}

      <section className="grid gap-5 lg:grid-cols-[1.3fr_.7fr]">
        <article className="rounded-2xl border t-border t-surface p-6 md:p-8">
          <p className="font-mono-label t-sub">INTAKE SUMMARY</p>
          <h3 className="mt-2 text-xl font-bold">접수 내용</h3>
          <p className="mt-5 whitespace-pre-wrap text-sm leading-7">{lead.detail ?? '상세 내용이 입력되지 않았습니다.'}</p>
          <dl className="mt-6 grid gap-4 border-t t-border pt-5 sm:grid-cols-2">
            <BriefItem label="피해 유형" value={lead.damageType ?? '미기재'} />
            <BriefItem label="피해 금액 구간" value={lead.amountBand ?? '미기재'} />
            <BriefItem label="유입 페이지" value={lead.slug ?? '직접 유입'} />
            <BriefItem label="구분" value={lead.vertical === 'scam' ? '사기 피해 상담' : lead.vertical === 'product' ? '제품 도입 문의' : lead.vertical} />
          </dl>
        </article>
        <article className="rounded-2xl border t-border t-surface p-6 md:p-8">
          <p className="font-mono-label t-sub">ATTRIBUTION</p>
          <h3 className="mt-2 text-xl font-bold">상담 유입 경로</h3>
          <TouchList label="최초 유입" data={lead.firstTouch} />
          <TouchList label="최종 유입" data={lead.utm} />
        </article>
      </section>

      <form action={saveLeadIntake.bind(null, token, lead.id)} className="rounded-2xl border t-border t-surface p-6 md:p-8">
        <p className="font-mono-label t-sub">CASE INTAKE</p>
        <h3 className="mt-2 text-xl font-bold">진행 관리와 초기 메모</h3>
        <p className="mt-2 text-sm leading-6 t-sub">상담 후 바로 기록하면 다음 담당자가 통화 맥락과 준비 자료를 이어받을 수 있습니다.</p>
        <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          <SelectField label="진행 상태" name="status" defaultValue={lead.status} options={LEAD_STATUS_OPTIONS.map((value) => ({ value, label: LEAD_STATUS_LABEL[value] }))} />
          <SelectField label="우선순위" name="priority" defaultValue={lead.priority} options={LEAD_PRIORITY_OPTIONS.map((value) => ({ value, label: LEAD_PRIORITY_LABEL[value] }))} />
          <SelectField label="담당 변호사" name="assignedLawyer" defaultValue={lead.assignedLawyer ?? ''} options={[{ value: '', label: '미배정' }, ...(firm.lawyers ?? []).map((lawyer) => ({ value: lawyer.name, label: `${lawyer.name} · ${lawyer.title}` }))]} />
          <label><span className="mb-2 block text-xs font-semibold t-sub">다음 연락 예정</span><input type="datetime-local" name="followUpAt" defaultValue={lead.followUpAt ? formatDateTimeInput(lead.followUpAt) : ''} className={inputClass} /></label>
        </div>
        <label className="mt-5 block"><span className="mb-2 block text-xs font-semibold t-sub">사무소 내부 메모</span><textarea name="note" rows={6} maxLength={5000} defaultValue={lead.intakeNote ?? ''} placeholder="통화 요지, 상대방 정보, 의뢰인의 우선 요청, 다음 확인 사항을 기록하세요." className={inputClass} /></label>

        <fieldset className="mt-6 rounded-xl border t-border p-5">
          <legend className="px-2 text-sm font-bold">초기 증거 준비 체크</legend>
          <p className="mb-4 text-xs leading-5 t-sub">의뢰인이 보유했는지 확인한 항목만 체크합니다. 실제 파일은 이 화면에 업로드하지 않습니다.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {EVIDENCE_ITEMS.map((item) => <label key={item.key} className="flex items-start gap-3 text-sm"><input type="checkbox" name={item.key} defaultChecked={lead.evidenceChecklist[item.key] === true} className="mt-1" /><span>{item.label}</span></label>)}
          </div>
        </fieldset>
        <label className="mt-5 flex items-start gap-3 text-sm"><input type="checkbox" name="markContacted" className="mt-1" /><span><strong>이번 저장을 연락 이력으로 기록</strong><span className="mt-1 block text-xs t-sub">현재 시각을 마지막 연락 시각으로 저장합니다{lead.lastContactAt ? ` · 기존 ${formatDateTime(lead.lastContactAt)}` : ''}.</span></span></label>
        <button className="mt-6 rounded-xl t-cta-accent px-6 py-3 text-sm font-bold">상담 브리프 저장</button>
      </form>

      <section id="outcome" className="rounded-2xl border t-border t-surface p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="font-mono-label t-sub">OUTCOME REPOSITORY</p>
            <h3 className="mt-2 text-xl font-bold">상담 결과와 수임 전환</h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 t-sub">접수·전화 클릭과 실제 자격 판단, 상담 일정, 사건 결과를 분리해 기록합니다. 아래 결정은 기존 이력을 덮어쓰지 않고 추가합니다.</p>
          </div>
          <span className="rounded-full border t-border px-3 py-1 text-xs font-bold">{OUTCOME_STATUS_LABEL[outcome.status] ?? outcome.status}</span>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <OutcomeMetric label="자격 판단" value={outcome.qualification ? outcome.qualification.status === 'qualified' ? '적합' : '부적합' : '대기 중'} />
          <OutcomeMetric label="상담 일정" value={outcome.consultation ? consultationStatusLabel(outcome.consultation.status) : '미예약'} />
          <OutcomeMetric label="사건 결과" value={outcome.matterOutcome ? matterOutcomeLabel(outcome.matterOutcome.status) : '미기록'} />
        </div>

        {qualificationPending && (
          <article className="mt-6 rounded-xl border border-amber-200 bg-amber-50/60 p-5">
            <p className="text-xs font-bold tracking-[.08em] text-amber-700">PENDING QUALIFICATION</p>
            <h4 className="mt-2 text-lg font-bold">수임 검토 결과를 기록하세요</h4>
            <p className="mt-2 text-sm leading-6 text-amber-900/80">아직 명시적인 적합·부적합 판단이 없습니다. 접수나 연락 이력만으로 자격을 추정하지 않습니다.</p>
            <form action={qualifyLead.bind(null, token, lead.id)} className="mt-5 grid gap-4 md:grid-cols-[.4fr_1fr_auto] md:items-end">
              <SelectField label="검토 결과" name="status" defaultValue="qualified" options={[{ value: 'qualified', label: '수임 검토 적합' }, { value: 'unqualified', label: '수임 검토 부적합' }]} />
              <label><span className="mb-2 block text-xs font-semibold t-sub">판단 사유 <span className="text-red-600">*</span></span><textarea name="reason" rows={2} required maxLength={2000} placeholder="관할·업무 적합성, 증거 상태, 이해충돌 확인 등 판단 근거" className={inputClass} /></label>
              <button className="rounded-xl t-cta-primary px-5 py-3 text-sm font-bold">검토 결과 기록</button>
            </form>
          </article>
        )}

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          {outcome.qualification && (
            <article className="rounded-xl border t-border p-5">
              <p className="text-xs font-bold tracking-[.08em] t-sub">QUALIFICATION</p>
              <h4 className="mt-2 text-lg font-bold">수임 검토 {outcome.qualification.status === 'qualified' ? '적합' : '부적합'}</h4>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 t-sub">{outcome.qualification.reason ?? '판단 사유가 기록되지 않았습니다.'}</p>
              <p className="mt-4 text-xs t-sub">{formatDateTime(outcome.qualification.decidedAt)} · {outcome.qualification.actor}</p>
            </article>
          )}

          {canBookConsultation && (
            <article className="rounded-xl border t-border p-5">
              <p className="text-xs font-bold tracking-[.08em] t-sub">BOOK CONSULTATION</p>
              <h4 className="mt-2 text-lg font-bold">상담 예약·일정 기록</h4>
              <p className="mt-2 text-sm leading-6 t-sub">일정이 정해지지 않았다면 비워 둔 채 예약할 수 있습니다. 취소·노쇼 뒤 재예약도 이 폼으로 남깁니다.</p>
              <form action={bookConsultation.bind(null, token, lead.id)} className="mt-5 grid gap-4">
                <label><span className="mb-2 block text-xs font-semibold t-sub">상담 예정 시각</span><input type="datetime-local" name="scheduledAt" defaultValue={outcome.consultation?.scheduledAt ? formatDateTimeInput(outcome.consultation.scheduledAt) : ''} className={inputClass} /></label>
                <label><span className="mb-2 block text-xs font-semibold t-sub">예약 메모</span><textarea name="reason" rows={2} maxLength={2000} placeholder="대면·전화·화상, 준비 자료, 예약 경위 등" className={inputClass} /></label>
                <button className="w-fit rounded-xl t-cta-accent px-5 py-3 text-sm font-bold">상담 예약 기록</button>
              </form>
            </article>
          )}

          {outcome.consultation && (
            <article className="rounded-xl border t-border p-5">
              <p className="text-xs font-bold tracking-[.08em] t-sub">CONSULTATION STATUS</p>
              <h4 className="mt-2 text-lg font-bold">상담 진행 결과</h4>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <BriefItem label="현재 상태" value={consultationStatusLabel(outcome.consultation.status)} />
                <BriefItem label="예정 시각" value={outcome.consultation.scheduledAt ? formatDateTime(outcome.consultation.scheduledAt) : '미정'} />
              </dl>
              {canTransitionConsultation && (
                <form action={transitionConsultation.bind(null, token, lead.id)} className="mt-5 grid gap-4">
                  <SelectField label="상담 결과" name="status" defaultValue="completed" options={[{ value: 'completed', label: '상담 완료' }, { value: 'cancelled', label: '취소' }, { value: 'no_show', label: '노쇼' }]} />
                  <label><span className="mb-2 block text-xs font-semibold t-sub">결과 메모</span><textarea name="reason" rows={2} maxLength={2000} placeholder="상담 요약, 취소 사유, 노쇼 확인 등" className={inputClass} /></label>
                  <button className="w-fit rounded-xl t-cta-primary px-5 py-3 text-sm font-bold">상담 결과 기록</button>
                </form>
              )}
              {!canTransitionConsultation && <p className="mt-4 text-sm t-sub">이 상담은 {consultationStatusLabel(outcome.consultation.status)} 상태입니다. 기존 상태는 변경하지 않고 이력에 추가된 전환만 표시합니다.</p>}
            </article>
          )}

          {canRecordMatterOutcome && (
            <article className="rounded-xl border t-border p-5">
              <p className="text-xs font-bold tracking-[.08em] t-sub">MATTER OUTCOME</p>
              <h4 className="mt-2 text-lg font-bold">사건 결과 기록</h4>
              <p className="mt-2 text-sm leading-6 t-sub">수임·미수임·종결 중 하나를 선택합니다. 판단 사유는 필수이고 수임료 구간은 선택 사항입니다.</p>
              <form action={recordMatterOutcome.bind(null, token, lead.id)} className="mt-5 grid gap-4">
                <SelectField label="사건 결과" name="status" defaultValue="retained" options={[{ value: 'retained', label: '수임' }, { value: 'not_retained', label: '미수임' }, { value: 'closed', label: '종결' }]} />
                <label><span className="mb-2 block text-xs font-semibold t-sub">판단 사유 <span className="text-red-600">*</span></span><textarea name="reason" rows={2} required maxLength={2000} placeholder="수임 여부 또는 종결 판단의 근거" className={inputClass} /></label>
                <label><span className="mb-2 block text-xs font-semibold t-sub">수임료 구간 (선택)</span><input name="feeBand" maxLength={200} placeholder="예: 500만~1,000만원" className={inputClass} /></label>
                <button className="w-fit rounded-xl t-cta-accent px-5 py-3 text-sm font-bold">사건 결과 저장</button>
              </form>
            </article>
          )}

          {outcome.matterOutcome && (
            <article className="rounded-xl border t-border p-5">
              <p className="text-xs font-bold tracking-[.08em] t-sub">RECORDED MATTER OUTCOME</p>
              <h4 className="mt-2 text-lg font-bold">{matterOutcomeLabel(outcome.matterOutcome.status)}</h4>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 t-sub">{outcome.matterOutcome.reason ?? '판단 사유 없음'}</p>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <BriefItem label="수임료 구간" value={outcome.matterOutcome.feeBand ?? '미기재'} />
                <BriefItem label="기록 시각" value={formatDateTime(outcome.matterOutcome.decidedAt)} />
              </dl>
            </article>
          )}
        </div>

        <article className="mt-6 rounded-xl border t-border p-5">
          <p className="text-xs font-bold tracking-[.08em] t-sub">APPEND-ONLY HISTORY</p>
          <h4 className="mt-2 text-lg font-bold">결과 변경 이력</h4>
          {outcome.history.length ? <ol className="mt-5 space-y-3">{outcome.history.map((event) => (
            <li key={event.id} className="grid gap-3 rounded-lg border t-border p-4 text-sm sm:grid-cols-[auto_1fr_auto] sm:items-start">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold">{outcomeHistoryLabel(event.toStatus)}</span>
              <div>
                <p className="font-semibold">{event.fromStatus ? `${outcomeHistoryLabel(event.fromStatus)} → ${outcomeHistoryLabel(event.toStatus)}` : '상담 접수'}</p>
                {event.reason && <p className="mt-1 whitespace-pre-wrap leading-6 t-sub">{event.reason}</p>}
                <p className="mt-2 text-xs t-sub">기록자 · {event.actor}</p>
              </div>
              <time className="text-xs t-sub">{formatDateTime(event.createdAt)}</time>
            </li>
          ))}</ol> : <p className="mt-4 text-sm t-sub">아직 명시적인 결과 이력이 없습니다. 첫 결정을 기록하면 접수 이벤트부터 이곳에 추가됩니다.</p>}
        </article>
      </section>

      <section id="conflict" className="rounded-2xl border t-border p-6 md:p-8">
        <div className="grid gap-8 lg:grid-cols-[1fr_.9fr]">
          <div>
            <p className="font-mono-label t-sub">CONFLICT ASSIST</p>
            <h3 className="mt-2 text-xl font-bold">사무소 내부 이해충돌 가능성 점검</h3>
            <p className="mt-3 text-sm leading-7 t-sub">
              현재 사무소의 과거 상담에 기록된 의뢰인·상대방·관련인 이름과 일치하는 항목을 찾습니다.
              동명이인과 표기 차이가 있을 수 있으므로 결과는 보조 신호이며, 최종 수임 가능 여부는 변호사가 사실관계를 확인해 판단해야 합니다.
            </p>
            <form action={runLeadConflictCheck.bind(null, token, lead.id)} className="mt-6 grid gap-4">
              <TextField label="상담 의뢰인" name="prospective" defaultValue={lead.name === '암호화됨' || lead.name === '미기재' ? '' : lead.name} placeholder="여러 명이면 쉼표 또는 줄바꿈으로 구분" />
              <TextField label="상대방·피고소인" name="adverse" placeholder="성명 또는 법인명" />
              <TextField label="기타 관련인·회사" name="related" placeholder="소개자, 플랫폼·업체 관계자 등" />
              <button className="w-fit rounded-xl t-cta-primary px-6 py-3 text-sm font-bold">일치 가능성 점검</button>
            </form>
          </div>
          <div className="rounded-xl t-surface p-5">
            <h4 className="text-sm font-bold">최근 점검 이력</h4>
            {history.length ? <ul className="mt-4 space-y-3">{history.map((check) => (
              <li key={check.id} className="rounded-lg border t-border p-4 text-xs">
                <div className="flex items-center justify-between gap-3"><ConflictBadge status={check.status} /><time className="t-sub">{formatDateTime(check.checkedAt)}</time></div>
                <p className="mt-3 leading-5 t-sub">검색어 · {summarizeTerms(check.terms)}</p>
                {check.matchedLeadIds.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{check.matchedLeadIds.map((id) => <Link key={id} href={`/d/${token}/leads/${id}`} className="rounded-md border t-border px-2 py-1 font-semibold">일치 상담 열기 →</Link>)}</div>}
              </li>
            ))}</ul> : <p className="mt-4 text-sm t-sub">아직 점검 이력이 없습니다.</p>}
          </div>
        </div>
      </section>
    </div>
  )
}

const inputClass = 'w-full rounded-xl border t-border bg-transparent px-4 py-3 text-sm outline-none focus:[border-color:var(--t-accent)]'
function BriefItem({ label, value }: { label: string; value: string }) { return <div><dt className="text-[10px] font-bold tracking-[.08em] t-sub">{label}</dt><dd className="mt-1 text-sm font-semibold">{value}</dd></div> }
function OutcomeMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border t-border p-4"><p className="text-xs font-semibold t-sub">{label}</p><p className="mt-2 text-lg font-bold">{value}</p></div> }
function SelectField({ label, name, defaultValue, options }: { label: string; name: string; defaultValue: string; options: { value: string; label: string }[] }) { return <label><span className="mb-2 block text-xs font-semibold t-sub">{label}</span><select name={name} defaultValue={defaultValue} className={inputClass}>{options.map((option) => <option key={`${name}-${option.value}`} value={option.value}>{option.label}</option>)}</select></label> }
function TextField({ label, name, placeholder, defaultValue }: { label: string; name: string; placeholder: string; defaultValue?: string }) { return <label><span className="mb-2 block text-xs font-semibold t-sub">{label}</span><textarea name={name} rows={2} maxLength={1000} defaultValue={defaultValue} placeholder={placeholder} className={inputClass} /></label> }
function TouchList({ label, data }: { label: string; data: Record<string, string> | null }) { const entries = Object.entries(data ?? {}).filter(([, value]) => value); return <div className="mt-5"><p className="text-xs font-bold t-sub">{label}</p>{entries.length ? <dl className="mt-2 space-y-2">{entries.map(([key, value]) => <div key={key} className="flex justify-between gap-3 text-xs"><dt className="t-sub">{key.replace(/^utm_/, '')}</dt><dd className="max-w-[65%] break-words text-right font-semibold">{value}</dd></div>)}</dl> : <p className="mt-2 text-xs t-sub">기록 없음</p>}</div> }
function ConflictBadge({ status }: { status: 'unchecked' | 'clear' | 'review' }) { if (status === 'review') return <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700">일치 항목 있음 · 검토 필요</span>; if (status === 'clear') return <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">일치 항목 없음</span>; return <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">충돌 점검 전</span> }
function priorityClass(priority: LeadRow['priority']): string { if (priority === 'urgent') return 'bg-red-50 text-red-700'; if (priority === 'high') return 'bg-amber-50 text-amber-700'; if (priority === 'low') return 'bg-slate-100 text-slate-600'; return 'bg-emerald-50 text-emerald-700' }
const OUTCOME_STATUS_LABEL: Record<string, string> = {
  new: '자격 판단 대기',
  qualified: '수임 검토 적합',
  unqualified: '수임 검토 부적합',
  consultation_booked: '상담 예약',
  consultation_completed: '상담 완료',
  consultation_cancelled: '상담 취소',
  consultation_no_show: '상담 노쇼',
  matter_retained: '수임',
  matter_not_retained: '미수임',
  matter_closed: '종결',
}
function consultationStatusLabel(status: string): string { return ({ booked: '예약됨', completed: '완료', cancelled: '취소', no_show: '노쇼' } as Record<string, string>)[status] ?? status }
function matterOutcomeLabel(status: string): string { return ({ retained: '수임', not_retained: '미수임', closed: '종결' } as Record<string, string>)[status] ?? status }
function outcomeHistoryLabel(status: string): string { return OUTCOME_STATUS_LABEL[status] ?? status }
function formatDateTime(d: Date): string { return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(d) }
function formatDateTimeInput(d: Date): string { const parts = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).formatToParts(d); const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''; return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}` }
function summarizeTerms(terms: { prospective: string[]; adverse: string[]; related: string[] } | null): string { if (!terms) return '암호화된 검색어'; return [terms.prospective, terms.adverse, terms.related].flat().filter(Boolean).join(' · ') || '기록 없음' }
