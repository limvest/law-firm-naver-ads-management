import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { leads } from '@/lib/db/schema'
import { decryptPII, encryptPII } from '@/lib/crypto'
import type { Firm } from '@/lib/engine/firms'
import { isAdditiveSchemaUnavailable } from '@/lib/db/schema-compat'

export type LeadStatus = 'new' | '연락완료' | '상담' | '상담예약' | '검토중' | '수임' | '종결'
export type LeadPriority = 'urgent' | 'high' | 'normal' | 'low'

// Legacy outcome values stay in the type and label map so historical rows can
// be read, but they are deliberately absent from direct intake controls.
export const LEAD_STATUS_OPTIONS: LeadStatus[] = ['new', '연락완료', '검토중']
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: '신규', 연락완료: '연락 완료', 상담: '상담(기존)', 상담예약: '상담 예약', 검토중: '수임 검토', 수임: '수임', 종결: '종결',
}
export const LEAD_PRIORITY_OPTIONS: LeadPriority[] = ['urgent', 'high', 'normal', 'low']
export const LEAD_PRIORITY_LABEL: Record<LeadPriority, string> = { urgent: '즉시 확인', high: '우선', normal: '보통', low: '낮음' }

export const EVIDENCE_ITEMS = [
  { key: 'messages', label: '대화방·문자·통화 기록' },
  { key: 'transfers', label: '송금내역·입금 계좌정보' },
  { key: 'app_site', label: '앱 이름·설치경로·사이트 주소' },
  { key: 'withdrawal', label: '출금거절·추가입금 요구 화면' },
  { key: 'identity_access', label: '신분증 전송·원격제어 여부' },
] as const
export type EvidenceKey = typeof EVIDENCE_ITEMS[number]['key']

export type LeadRow = {
  id: string
  name: string
  phone: string
  vertical: string
  detail: string | null
  damageType: string | null
  amountBand: string | null
  slug: string | null
  status: string
  priority: LeadPriority
  assignedLawyer: string | null
  followUpAt: Date | null
  lastContactAt: Date | null
  intakeNote: string | null
  conflictStatus: 'unchecked' | 'clear' | 'review'
  conflictCheckedAt: Date | null
  evidenceChecklist: Record<string, boolean>
  utm: Record<string, string> | null
  firstTouch: Record<string, string> | null
  createdAt: Date
  masked: boolean
  // 브리프 인터페이스(id/name/phone/slug/status/createdAt/masked)에 없는 필드 — Task 9와의
  // 데모 배지 계약(utm.source==='demo-seed')을 화면이 판단하려면 이 어셈블러가 utm을 읽어
  // 판별한 결과를 내려줘야 한다(leads에 컬럼 추가는 금지되어 있어 utm에서 파생). 대시보드
  // 어셈블러 전반의 관례 — 브리프 인터페이스는 그대로 두고 노출 계약에 필요한 필드만 확장한다.
  isDemo: boolean
}

const LEAD_INTAKE_STATUSES = new Set<LeadStatus>(LEAD_STATUS_OPTIONS)
const LEAD_PRIORITIES = new Set<LeadPriority>(LEAD_PRIORITY_OPTIONS)

export function isLeadIntakeStatus(status: string): status is LeadStatus {
  return LEAD_INTAKE_STATUSES.has(status as LeadStatus)
}

export function inferLeadPriority(input: { detail?: string | null; damageType?: string | null; amountBand?: string | null }): LeadPriority {
  const text = `${input.damageType ?? ''} ${input.amountBand ?? ''} ${input.detail ?? ''}`.normalize('NFKC')
  if (/(지금|오늘|추가\s*입금|송금\s*중|원격\s*제어|협박|대출\s*요구|출금\s*해제|접속\s*중)/i.test(text)) return 'urgent'
  if (/(송금|입금|출금|계좌|앱\s*설치|피해|신분증|가상자산|코인)/i.test(text)) return 'high'
  return 'normal'
}

function normalizePriority(value: string): LeadPriority {
  return LEAD_PRIORITIES.has(value as LeadPriority) ? value as LeadPriority : 'normal'
}

function decryptOptional(payload: string | null): string | null {
  if (!payload) return null
  try { return decryptPII(payload) } catch { return '암호화된 상담 메모' }
}

/**
 * PII 복호화 — LEAD_ENC_KEY 미설정이거나 복호화 실패(변조·키 불일치 등) 시 절대 throw하지 않고
 * 마스킹된 값으로 대체한다(브리프 마스킹 계약). decryptPII/encryptPII(src/lib/crypto)는 키가 없거나
 * payload가 손상되면 throw하므로, 그 예외를 여기서 흡수하는 것이 유일한 방어선이다.
 */
function decryptLead(nameEnc: string, phoneEnc: string, detailEnc: string | null): { name: string; phone: string; detail: string | null; masked: boolean } {
  try {
    return {
      name: decryptPII(nameEnc),
      phone: decryptPII(phoneEnc),
      detail: detailEnc ? decryptPII(detailEnc) : null,
      masked: false,
    }
  } catch {
    return { name: '암호화됨', phone: '***', detail: detailEnc ? '암호화된 상담 내용' : null, masked: true }
  }
}

/**
 * 대시보드 리드 인박스 어셈블러 — firm 스코프(leads.firm_id) 리드만 노출, 최신순.
 */
export async function leadsData(db: Db, firm: Firm, opts: { vertical?: string; limit?: number; id?: string } = {}): Promise<LeadRow[]> {
  const conditions = [eq(leads.firmId, firm.id)]
  if (opts.vertical) conditions.push(eq(leads.vertical, opts.vertical))
  if (opts.id) conditions.push(eq(leads.id, opts.id))
  const rows = await db
    .select({
      id: leads.id,
      nameEnc: leads.nameEnc,
      phoneEnc: leads.phoneEnc,
      vertical: leads.vertical,
      detailEnc: leads.detailEnc,
      damageType: leads.damageType,
      amountBand: leads.amountBand,
      slug: leads.slug,
      status: leads.status,
      priority: leads.priority,
      assignedLawyer: leads.assignedLawyer,
      followUpAt: leads.followUpAt,
      lastContactAt: leads.lastContactAt,
      intakeNoteEnc: leads.intakeNoteEnc,
      conflictStatus: leads.conflictStatus,
      conflictCheckedAt: leads.conflictCheckedAt,
      evidenceChecklist: leads.evidenceChecklist,
      createdAt: leads.createdAt,
      utm: leads.utm,
      firstTouch: leads.firstTouch,
    })
    .from(leads)
    .where(and(...conditions))
    .orderBy(desc(leads.createdAt))
    .limit(opts.limit ?? 500)

  return rows.map((r) => {
    const { name, phone, detail, masked } = decryptLead(r.nameEnc, r.phoneEnc, r.detailEnc)
    return {
      id: r.id,
      name,
      phone,
      vertical: r.vertical,
      detail,
      damageType: r.damageType,
      amountBand: r.amountBand,
      slug: r.slug,
      status: r.status,
      priority: normalizePriority(r.priority),
      assignedLawyer: r.assignedLawyer,
      followUpAt: r.followUpAt,
      lastContactAt: r.lastContactAt,
      intakeNote: decryptOptional(r.intakeNoteEnc),
      conflictStatus: r.conflictStatus === 'review' ? 'review' : r.conflictStatus === 'clear' ? 'clear' : 'unchecked',
      conflictCheckedAt: r.conflictCheckedAt,
      evidenceChecklist: r.evidenceChecklist ?? {},
      utm: r.utm,
      firstTouch: r.firstTouch,
      createdAt: r.createdAt,
      masked,
      isDemo: r.utm?.source === 'demo-seed',
    }
  })
}

export async function leadDetailData(db: Db, firm: Firm, leadId: string): Promise<LeadRow | null> {
  return (await leadsData(db, firm, { id: leadId, limit: 1 }))[0] ?? null
}

export type LeadIntakeInput = {
  status: LeadStatus
  priority: LeadPriority
  assignedLawyer: string | null
  followUpAt: Date | null
  note: string
  evidenceChecklist: Record<string, boolean>
  markContacted: boolean
}

export async function updateLeadIntakeForFirm(
  db: Db,
  firm: Firm,
  leadId: string,
  input: LeadIntakeInput,
): Promise<boolean> {
  if (!LEAD_INTAKE_STATUSES.has(input.status) || !LEAD_PRIORITIES.has(input.priority)) return false
  const allowedLawyers = new Set((firm.lawyers ?? []).flatMap((lawyer) => [lawyer.id, lawyer.name].filter(Boolean) as string[]))
  if (input.assignedLawyer && !allowedLawyers.has(input.assignedLawyer)) return false
  const note = input.note.trim().slice(0, 5000)
  const evidenceChecklist = Object.fromEntries(EVIDENCE_ITEMS.map((item) => [item.key, input.evidenceChecklist[item.key] === true]))
  const updated = await db.update(leads).set({
    status: input.status,
    priority: input.priority,
    assignedLawyer: input.assignedLawyer,
    followUpAt: input.followUpAt,
    intakeNoteEnc: note ? encryptPII(note) : null,
    evidenceChecklist,
    ...(input.markContacted ? { lastContactAt: new Date() } : {}),
  }).where(and(eq(leads.id, leadId), eq(leads.firmId, firm.id))).returning({ id: leads.id })
  return updated.length === 1
}

export type LeadQueueSummary = { newCount: number; overdue: number; dueToday: number; conflictReview: number; unassigned: number }

export function leadQueueSummary(rows: LeadRow[], now = new Date()): LeadQueueSummary {
  // Vercel 런타임의 기본 시간대(UTC)에 흔들리지 않도록 사무소 운영 기준인 한국 날짜의
  // 자정 경계를 명시적으로 계산한다.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value ?? ''
  const start = new Date(`${value('year')}-${value('month')}-${value('day')}T00:00:00+09:00`)
  const end = new Date(start.getTime() + 86_400_000)
  return {
    newCount: rows.filter((row) => row.status === 'new').length,
    overdue: rows.filter((row) => row.followUpAt && row.followUpAt < now && !['수임', '종결'].includes(row.status)).length,
    dueToday: rows.filter((row) => row.followUpAt && row.followUpAt >= start && row.followUpAt < end && !['수임', '종결'].includes(row.status)).length,
    conflictReview: rows.filter((row) => row.conflictStatus === 'review').length,
    unassigned: rows.filter((row) => !row.assignedLawyer && !['수임', '종결'].includes(row.status)).length,
  }
}

/**
 * 리드 상태 갱신 코어 — 목록/legacy 경로는 intake 상태만 반영한다. 상담·수임·종결 같은
 * outcome 상태는 상세 브리프의 qualification → consultation → matter_outcome action에서만
 * 기록해야 하며, 여기서도 거부한다. where에 firmId를 포함해 타 firm 소유 리드는 조용히 무시한다
 * (0행 매치, 예외 없음). pglite로 직접 테스트하기 위해
 * 'use server' 래퍼(updateLeadStatus, src/lib/dashboard/actions.ts)와 분리했다(toggleSubscriptionForFirm과
 * 동일한 분리 패턴).
 */
export async function updateLeadStatusForFirm(
  db: Db,
  firm: Firm,
  leadId: string,
  status: LeadStatus,
): Promise<void> {
  if (!LEAD_INTAKE_STATUSES.has(status)) return
  await db
    .update(leads)
    .set({ status })
    .where(and(eq(leads.id, leadId), eq(leads.firmId, firm.id)))
}

export type FunnelData = {
  pv: number
  call: number
  kakao: number
  form: number
  bySlug: { slug: string; pv: number; form: number }[]
  byCase: { caseEntityId: string | null; label: string; slug: string | null; pv: number; form: number }[]
  // 최종 리뷰 F5 — 퍼널 페이지가 데모 시드(utm.source='demo-seed') 이벤트 위에서도 "실측·추정
  // 없음"을 단정하던 표기 계약 불일치를 고치기 위한 필드. leadsData.isDemo(utm 파생 판별)와
  // 동일 계약 — events에 컬럼을 추가하지 않고 utm에서 파생한다. 0이면 데모 데이터가 전혀
  // 섞이지 않았다는 뜻이라 페이지가 배지를 숨긴다.
  demoSeedCount: number
}

// events.type 값(src/lib/tracking/track.ts EventType) → 퍼널 4단 매핑.
// form은 form_submit만 센다 — form_step은 다단계 폼의 중간 단계일 뿐 완료(리드 전환)가 아니다.
const EVENT_PV = 'page_view'
const EVENT_CALL = 'call_click'
const EVENT_KAKAO = 'kakao_click'
const EVENT_FORM = 'form_submit'

/**
 * 대시보드 성과 퍼널 어셈블러 — firm 스코프(events.firm_id) 이벤트만 집계한다.
 * pv/call/kakao/form은 firm 전체 합계, bySlug는 유입 slug(널 제외)별 pv·form 분해.
 */
export async function funnelData(db: Db, firm: Firm): Promise<FunnelData> {
  const totalsRows = await db.execute(sql`
    select type, count(*)::int as n
    from events
    where firm_id = ${firm.id}
    group by type
  `)
  const totals: Record<string, number> = {}
  for (const r of totalsRows.rows as { type: string; n: number }[]) {
    totals[r.type] = r.n
  }

  let byCase: FunnelData['byCase']
  try {
    const rows = await db.execute(sql`
      select
        e.case_entity_id,
        c.canonical_name,
        min(e.slug) as slug,
        count(*) filter (where e.type = ${EVENT_PV})::int as pv,
        count(*) filter (where e.type = ${EVENT_FORM})::int as form
      from events e
      left join case_entities c on c.id = e.case_entity_id
      where e.firm_id = ${firm.id} and (e.case_entity_id is not null or e.slug is not null)
      group by e.case_entity_id, c.canonical_name, coalesce(e.case_entity_id::text, e.slug)
      order by pv desc, c.canonical_name asc, min(e.slug) asc
    `)
    byCase = (rows.rows as {
      case_entity_id: string | null
      canonical_name: string | null
      slug: string | null
      pv: number
      form: number
    }[]).map((row) => ({
      caseEntityId: row.case_entity_id,
      label: row.canonical_name ?? row.slug ?? '사건 미지정',
      slug: row.slug,
      pv: row.pv,
      form: row.form,
    }))
  } catch (error) {
    if (!isAdditiveSchemaUnavailable(error)) throw error
    const legacyRows = await db.execute(sql`
      select
        slug,
        count(*) filter (where type = ${EVENT_PV})::int as pv,
        count(*) filter (where type = ${EVENT_FORM})::int as form
      from events
      where firm_id = ${firm.id} and slug is not null
      group by slug
      order by pv desc, slug asc
    `)
    byCase = (legacyRows.rows as { slug: string; pv: number; form: number }[]).map((row) => ({
      caseEntityId: null,
      label: row.slug,
      slug: row.slug,
      pv: row.pv,
      form: row.form,
    }))
  }
  const bySlug = byCase.map((row) => ({ slug: row.slug ?? row.label, pv: row.pv, form: row.form }))

  // 최종 리뷰 F5 — utm->>'source' = 'demo-seed'인 이벤트 건수(firm 스코프 전체, 4단 합산 아님).
  // leads.isDemo와 동일하게 utm에서 파생 — events에 별도 컬럼을 추가하지 않는다.
  const demoRows = await db.execute(sql`
    select count(*)::int as n
    from events
    where firm_id = ${firm.id} and utm ->> 'source' = 'demo-seed'
  `)
  const demoSeedCount = (demoRows.rows as { n: number }[])[0]?.n ?? 0

  return {
    pv: totals[EVENT_PV] ?? 0,
    call: totals[EVENT_CALL] ?? 0,
    kakao: totals[EVENT_KAKAO] ?? 0,
    form: totals[EVENT_FORM] ?? 0,
    bySlug,
    byCase,
    demoSeedCount,
  }
}
