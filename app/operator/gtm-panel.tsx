import {
  canTransitionProductLeadStage,
  GTM_EVIDENCE_NOTE_MAX_LENGTH,
  PRODUCT_LEAD_STAGES,
  type GtmPipeline,
  type GtmPipelineStage,
} from '@/domains/gtm'

export type GtmPanelFormAction = (formData: FormData) => void | Promise<void>

export type GtmPanelProps = {
  pipeline: GtmPipeline
  contactByLeadId?: Readonly<Record<string, Readonly<{
    officeName: string
    contactName: string | null
    phone: string
    masked: boolean
  }>>>
  onCreate?: GtmPanelFormAction
  onTransition?: GtmPanelFormAction
  onFollowUp?: GtmPanelFormAction
  onLost?: GtmPanelFormAction
}

const STAGE_LABELS: Record<GtmPipelineStage, string> = {
  targeted: '타깃',
  contacted: '연락 완료',
  interview: '인터뷰',
  demo: '적격 데모',
  pilot: '유료 파일럿',
  active: '활성 고객',
  lost: '종료',
}

function nextStages(stage: string): GtmPipelineStage[] {
  return PRODUCT_LEAD_STAGES.filter((candidate) => (
    candidate !== stage && canTransitionProductLeadStage(stage, candidate)
  ))
}

function dateTimeLocal(value: Date | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}

function displayDate(value: Date | null): string {
  if (!value) return '미정'
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(value)
}

export function GtmPanel({ pipeline, contactByLeadId = {}, onCreate, onTransition, onFollowUp, onLost }: GtmPanelProps) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[.035] p-6 text-white md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold tracking-[.16em] text-[#70e3a1]">FOUNDER-LED GTM · FIRM {pipeline.firmId}</p>
          <h2 className="mt-2 text-2xl font-black">영업 파이프라인</h2>
          <p className="mt-2 text-sm text-white/45">append-only 단계 이력으로 실제 도달 milestone을 집계합니다. 인터뷰·데모·유료 파일럿은 간결한 근거 메모가 있어야 통과합니다.</p>
        </div>
        <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/45">실제 프로필 {pipeline.rows.length}건</span>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {pipeline.gates.map((gate) => (
          <article key={gate.key} className={`rounded-2xl border p-4 ${gate.complete ? 'border-[#70e3a1]/30 bg-[#70e3a1]/8' : 'border-white/10 bg-black/10'}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold text-white/55">{gate.label}</p>
              <span className="text-[10px] text-white/35">{gate.complete ? '통과' : `잔여 ${gate.remaining}`}</span>
            </div>
            <p className="mt-3 text-2xl font-black">{gate.current} <span className="text-sm font-medium text-white/35">/ {gate.target}</span></p>
          </article>
        ))}
      </div>

      {onCreate ? (
        <details className="mt-6 rounded-2xl border border-white/10 bg-black/10 p-5">
          <summary className="cursor-pointer text-sm font-bold text-[#9df0bd]">목표 사무소 추가</summary>
          <form action={onCreate} className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <OperatorField name="officeName" label="법률사무소명" required />
            <OperatorField name="contactName" label="담당자" />
            <OperatorField name="phone" label="대표 연락처" placeholder="02-0000-0000" required />
            <label className="text-xs text-white/55"><span className="mb-1.5 block font-bold">관심 상품</span><select name="packageInterest" defaultValue="founding_pilot" className={operatorInputClass}><option value="founding_pilot">Founding Pilot</option><option value="core">Core</option><option value="growth">Growth</option><option value="managed_ops">Managed Ops</option></select></label>
            <OperatorField name="budgetBand" label="예산 구간" />
            <OperatorField name="teamSize" label="팀 규모" />
            <OperatorField name="repeatFraudMatters" label="금융사기 반복 수임" />
            <OperatorField name="ownDomain" label="자체 도메인" />
            <OperatorField name="naverAccount" label="네이버 광고계정" />
            <OperatorField name="responseOwner" label="리드 응답 담당자" />
            <OperatorField name="outcomeTracking" label="결과 기록 가능" />
            <label className="text-xs text-white/55"><span className="mb-1.5 block font-bold">Managed Ops</span><select name="managedOps" defaultValue="false" className={operatorInputClass}><option value="false">미정/불필요</option><option value="true">관심</option></select></label>
            <label className="sm:col-span-2 xl:col-span-4 text-xs text-white/55"><span className="mb-1.5 block font-bold">타깃 선정 근거 <span className="text-[#9df0bd]">*</span></span><textarea name="evidenceNote" required maxLength={GTM_EVIDENCE_NOTE_MAX_LENGTH} rows={2} placeholder="예: 금융사기 반복 수임·자체 도메인·담당자 확인" className={operatorInputClass} /></label>
            <button className="rounded-xl bg-[#70e3a1] px-4 py-3 text-xs font-black text-[#091117] sm:col-span-2 xl:col-span-4">타깃 목록에 저장</button>
          </form>
        </details>
      ) : null}

      {pipeline.rows.length ? (
        <div className="mt-7 overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="text-xs text-white/35">
              <tr>
                <th className="py-3 pr-4">리드</th>
                <th className="py-3 pr-4">상품 / 예산</th>
                <th className="py-3 pr-4">ICP</th>
                <th className="py-3 pr-4">단계</th>
                <th className="py-3 pr-4">후속 연락</th>
                <th className="py-3 pr-4">이력 / 근거</th>
                <th className="py-3">운영</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.rows.map((row) => {
                const options = nextStages(row.stage)
                const contact = contactByLeadId[row.leadId]
                return (
                  <tr key={row.leadId} className="border-t border-white/10 align-top">
                    <td className="py-4 pr-4">
                      <p className="font-bold text-white">{contact?.officeName ?? '사무소 정보 복호화 대기'}</p>
                      <p className="mt-1 text-xs text-white/50">{contact?.contactName ?? '담당자 미기재'} · {contact?.phone ?? '연락처 확인 대기'}</p>
                      <p className="mt-1 font-mono text-[10px] text-white/30">{row.leadId}{contact?.masked ? ' · masked' : ''}</p>
                    </td>
                    <td className="py-4 pr-4">
                      <p className="font-bold">{row.packageInterest}</p>
                      <p className="mt-1 text-xs text-white/45">예산 {row.budgetBand ?? '미기재'} · {row.managedOps ? 'Managed Ops' : '셀프 운영'}</p>
                    </td>
                    <td className="max-w-[260px] py-4 pr-4 text-xs leading-5 text-white/55">
                      <p>팀 {row.teamSize ?? '미기재'} · 반복 수임 {row.repeatFraudMatters ?? '미기재'}</p>
                      <p>도메인 {row.ownDomain ?? '미기재'} · 네이버 {row.naverAccount ?? '미기재'}</p>
                      <p>응답 {row.responseOwner ?? '미기재'} · 결과 기록 {row.outcomeTracking ?? '미기재'}</p>
                    </td>
                    <td className="py-4 pr-4">
                      <span className="rounded-full bg-white/8 px-2.5 py-1 text-xs font-bold">{STAGE_LABELS[row.stage as GtmPipelineStage] ?? row.stage}</span>
                      {row.lostReason ? <p className="mt-2 max-w-[180px] text-xs text-amber-200/70">{row.lostReason}</p> : null}
                    </td>
                    <td className="py-4 pr-4 text-xs text-white/55">{displayDate(row.followUpAt)}</td>
                    <td className="py-4 pr-4">
                      {row.history?.length ? (
                        <details className="min-w-[230px] rounded-xl border border-white/10 bg-black/10 p-3">
                          <summary className="cursor-pointer text-xs font-bold text-[#9df0bd]">단계 이력 {row.history.length}건</summary>
                          <ol className="mt-3 space-y-3">
                            {row.history.map((event) => (
                              <li key={event.id} className="border-t border-white/8 pt-2 first:border-0 first:pt-0">
                                <p className="text-[11px] font-bold text-white/75">{event.fromStage ? `${STAGE_LABELS[event.fromStage as GtmPipelineStage] ?? event.fromStage} → ` : ''}{STAGE_LABELS[event.toStage as GtmPipelineStage] ?? event.toStage}</p>
                                <p className="mt-1 text-[10px] text-white/35">{displayDate(event.createdAt)} · {event.actor}</p>
                                <p className="mt-1 text-[11px] leading-5 text-white/55">{event.evidenceNote ?? '근거 메모 없음'}</p>
                              </li>
                            ))}
                          </ol>
                        </details>
                      ) : <span className="text-xs text-amber-100/65">단계 이력 없음 · 게이트 미집계</span>}
                    </td>
                    <td className="py-4">
                      <div className="grid gap-2">
                        {onTransition && options.length ? (
                          <form action={onTransition} className="flex flex-wrap gap-2">
                            <input type="hidden" name="leadId" value={row.leadId} />
                            <select name="toStage" defaultValue={row.stage} className="rounded-lg border border-white/10 bg-[#131b24] px-2 py-1.5 text-xs text-white">
                              {options.map((stage) => <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>)}
                            </select>
                            <input name="lostReason" placeholder="종료 사유(종료 시)" className="min-w-[150px] rounded-lg border border-white/10 bg-[#131b24] px-2 py-1.5 text-xs text-white placeholder:text-white/25" />
                            <input name="evidenceNote" required maxLength={GTM_EVIDENCE_NOTE_MAX_LENGTH} placeholder="단계 도달 근거" className="min-w-[180px] rounded-lg border border-white/10 bg-[#131b24] px-2 py-1.5 text-xs text-white placeholder:text-white/25" />
                            <button className="rounded-lg bg-[#70e3a1] px-2.5 py-1.5 text-[10px] font-bold text-[#091117]">단계 저장</button>
                          </form>
                        ) : null}
                        {onFollowUp ? (
                          <form action={onFollowUp} className="flex flex-wrap gap-2">
                            <input type="hidden" name="leadId" value={row.leadId} />
                            <input type="datetime-local" name="followUpAt" defaultValue={dateTimeLocal(row.followUpAt)} className="rounded-lg border border-white/10 bg-[#131b24] px-2 py-1.5 text-xs text-white" />
                            <button className="rounded-lg border border-white/15 px-2.5 py-1.5 text-[10px] font-bold text-white/70">후속일 저장</button>
                          </form>
                        ) : null}
                        {onLost && row.stage !== 'lost' ? (
                          <form action={onLost} className="flex flex-wrap gap-2">
                            <input type="hidden" name="leadId" value={row.leadId} />
                            <input type="hidden" name="toStage" value="lost" />
                            <input name="lostReason" required placeholder="종료 사유" className="min-w-[150px] rounded-lg border border-amber-200/20 bg-[#131b24] px-2 py-1.5 text-xs text-white placeholder:text-white/25" />
                            <input name="evidenceNote" required maxLength={GTM_EVIDENCE_NOTE_MAX_LENGTH} placeholder="종료 근거" className="min-w-[180px] rounded-lg border border-amber-200/20 bg-[#131b24] px-2 py-1.5 text-xs text-white placeholder:text-white/25" />
                            <button className="rounded-lg border border-amber-200/25 px-2.5 py-1.5 text-[10px] font-bold text-amber-100">종료 처리</button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-7 rounded-2xl border border-white/10 bg-black/10 p-6 text-sm text-white/40">이 firm scope에 저장된 제품 리드가 없습니다.</p>
      )}
    </section>
  )
}

const operatorInputClass = 'w-full rounded-lg border border-white/10 bg-[#131b24] px-3 py-2.5 text-xs text-white outline-none placeholder:text-white/25'

function OperatorField({ name, label, placeholder, required = false }: { name: string; label: string; placeholder?: string; required?: boolean }) {
  return <label className="text-xs text-white/55"><span className="mb-1.5 block font-bold">{label}</span><input name={name} required={required} placeholder={placeholder} className={operatorInputClass} /></label>
}

export default GtmPanel
