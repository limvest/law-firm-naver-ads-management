import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getDb, type Db } from '@/lib/db/client'
import { firmKeywords } from '@/lib/db/schema'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import {
  EVIDENCE_ITEMS,
  updateLeadIntakeForFirm,
  updateLeadStatusForFirm,
  type LeadPriority,
  type LeadStatus,
} from '@/lib/dashboard/leads'
import { runConflictCheckForFirm } from '@/lib/leads/conflict'
import {
  setAdDesiredForFirm,
  saveAdConfigForFirm,
  saveCredentialsForFirm,
  type SaveAdConfigResult,
  type SaveCredentialsResult,
} from '@/lib/dashboard/ad-settings'
import type { Firm } from '@/lib/engine/firms'
import { saveSiteTemplateForFirm } from '@/lib/dashboard/site-settings'
import {
  bookConsultationForFirm,
  qualifyLeadForFirm,
  recordMatterOutcomeForFirm,
  transitionConsultationForFirm,
  type ConsultationStatus,
  type MatterOutcomeStatus,
  type QualificationStatus,
} from '@/domains/outcomes'
import { decideApprovalTask } from '@/domains/operations/approvals'
import {
  CustomerAdPolicyValidationError,
  saveFirmAdPolicy,
} from '@/domains/advertising/customer-policy'
import {
  addCaseResultForFirm,
  addLawyerForFirm,
  removeCaseResultForFirm,
  removeLawyerForFirm,
  saveFirmProfileForFirm,
  setCaseResultPublishedForFirm,
} from '@/lib/dashboard/firm-profile'

function revalidateFirmProfile(token: string): void {
  revalidatePath(`/d/${token}/profile`)
  revalidatePath('/lawyers')
  revalidatePath('/results')
}

export async function saveFirmProfile(token: string, formData: FormData): Promise<void> {
  'use server'
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  const ok = await saveFirmProfileForFirm(db, firm, {
    intro: String(formData.get('intro') ?? ''),
    history: String(formData.get('history') ?? ''),
  })
  revalidateFirmProfile(token)
  redirect(`/d/${token}/profile?${ok ? 'saved=office' : 'error=office'}`)
}

export async function addFirmLawyer(token: string, formData: FormData): Promise<void> {
  'use server'
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  const value = (name: string) => String(formData.get(name) ?? '')
  const ok = await addLawyerForFirm(db, firm, {
    name: value('name'), title: value('title'), photo: value('photo'), bio: value('bio'),
    badges: value('badges'), career: value('career'), education: value('education'),
    practiceAreas: value('practiceAreas'),
  })
  revalidateFirmProfile(token)
  redirect(`/d/${token}/profile?${ok ? 'saved=lawyer' : 'error=lawyer'}`)
}

export async function removeFirmLawyer(token: string, lawyerKey: string): Promise<void> {
  'use server'
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  await removeLawyerForFirm(db, firm, lawyerKey)
  revalidateFirmProfile(token)
}

export async function addFirmCaseResult(token: string, formData: FormData): Promise<void> {
  'use server'
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  const value = (name: string) => String(formData.get(name) ?? '')
  const ok = await addCaseResultForFirm(db, firm, {
    category: value('category'), title: value('title'), summary: value('summary'),
    outcome: value('outcome'), handledAt: value('handledAt'), published: formData.get('published') === 'on',
  })
  revalidateFirmProfile(token)
  redirect(`/d/${token}/profile?${ok ? 'saved=result' : 'error=result'}`)
}

export async function setFirmCaseResultPublished(
  token: string,
  resultId: string,
  formData: FormData,
): Promise<void> {
  'use server'
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  await setCaseResultPublishedForFirm(db, firm, resultId, formData.get('published') === 'true')
  revalidateFirmProfile(token)
}

export async function removeFirmCaseResult(token: string, resultId: string): Promise<void> {
  'use server'
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  await removeCaseResultForFirm(db, firm, resultId)
  revalidateFirmProfile(token)
}

// firm_keywords 상태 중 광고 파이프라인(등록·집행) 소유 상태 — CLI 전용. 대시보드에는 이
// 상태를 바꾸는 호출 경로가 없다(스펙 §B). keywords/page.tsx가 배지 라벨 분기에 재사용한다.
export const PIPELINE_OWNED = new Set(['ad_pending', 'ad_registered', 'live', 'rejected'])

export async function saveSiteTemplate(token: string, formData: FormData): Promise<void> {
  'use server'
  const template = formData.get('template')
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  const result = await saveSiteTemplateForFirm(db, firm, template)
  revalidatePath(`/d/${token}/site`)
  redirect(`/d/${token}/site?${result.ok ? 'saved=template' : 'error=template'}`)
}

/**
 * 운영(CLI) 전용 — 고객 대시보드에서 호출 경로 없음(스펙 2026-08-03 §C).
 * 미구독(행 없음) → subscribed 신규 생성 / subscribed↔paused 왕복 / 그 외(광고 파이프라인
 * 상태)는 무시. pglite로 직접 테스트하기 위해 'use server' 래퍼와 분리된 코어 함수였으나,
 * 래퍼는 제거되었다 — 이 함수는 이제 CLI/스크립트에서만 호출된다.
 */
export async function toggleSubscriptionForFirm(db: Db, firm: Firm, keywordId: string): Promise<void> {
  const existing = await db
    .select({ id: firmKeywords.id, status: firmKeywords.status })
    .from(firmKeywords)
    .where(and(eq(firmKeywords.firmId, firm.id), eq(firmKeywords.keywordId, keywordId)))
    .limit(1)

  if (!existing.length) {
    // 더블클릭·느린 네트워크 재시도로 같은 (firm, keyword)에 대해 거의 동시에 두 번 호출되면
    // 둘 다 이 select에서 "행 없음"을 볼 수 있다(select→insert 사이 락 없음) — 두 번째 insert는
    // firm_keywords_firm_keyword 유니크 제약과 충돌한다. onConflictDoNothing으로 그 경합을
    // 예외 없는 no-op으로 만든다(먼저 커밋된 쪽의 행이 그대로 남고, 값은 어느 쪽이든 동일하다).
    await db.insert(firmKeywords)
      .values({ firmId: firm.id, keywordId, status: 'subscribed' })
      .onConflictDoNothing({ target: [firmKeywords.firmId, firmKeywords.keywordId] })
    return
  }

  const row = existing[0]
  if (PIPELINE_OWNED.has(row.status)) return // 광고 파이프라인 상태 — CLI 소유, 조용히 무시

  const next = row.status === 'subscribed' ? 'paused' : 'subscribed'
  await db
    .update(firmKeywords)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(firmKeywords.id, row.id))
}

/**
 * server action — 리드 인박스의 `<form action={updateLeadStatus.bind(null, token, leadId)}>`에서 호출.
 * 단순 토글이 아니라 사용자가 <select name="status">로 고른 값이 필요하다 —
 * 바인딩된 인자(token, leadId) 뒤에 폼의 FormData가 자동으로 붙는 React/Next.js server action 관례를
 * 그대로 쓴다. 허용 상태 검증은 updateLeadStatusForFirm(단일 소스)에 위임 — 여기서는 값이 문자열인지만
 * 확인한다. firmId를 인자로 받지 않고 token을 매 호출마다 재검증한다(위조 방지 — 스펙 §B).
 */
export async function updateLeadStatus(token: string, leadId: string, formData: FormData): Promise<void> {
  'use server'
  const status = formData.get('status')
  if (typeof status !== 'string') return
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  await updateLeadStatusForFirm(db, firm, leadId, status as LeadStatus)
  revalidatePath(`/d/${token}/leads`)
}

function parseKoreaDateTime(value: FormDataEntryValue | null): Date | null | 'invalid' {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()
  const parsed = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}:00+09:00`)
  return Number.isNaN(parsed.getTime()) ? 'invalid' : parsed
}

/** 상담 브리프의 담당자·후속 연락·메모·증거 준비 상태를 한 번에 저장한다. */
export async function saveLeadIntake(token: string, leadId: string, formData: FormData): Promise<void> {
  'use server'
  const followUpAt = parseKoreaDateTime(formData.get('followUpAt'))
  if (followUpAt === 'invalid') redirect(`/d/${token}/leads/${leadId}?error=datetime`)
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  const ok = await updateLeadIntakeForFirm(db, firm, leadId, {
    status: String(formData.get('status') ?? '') as LeadStatus,
    priority: String(formData.get('priority') ?? '') as LeadPriority,
    assignedLawyer: String(formData.get('assignedLawyer') ?? '').trim() || null,
    followUpAt,
    note: String(formData.get('note') ?? ''),
    evidenceChecklist: Object.fromEntries(EVIDENCE_ITEMS.map((item) => [item.key, formData.get(item.key) === 'on'])),
    markContacted: formData.get('markContacted') === 'on',
  })
  revalidatePath(`/d/${token}/leads`)
  revalidatePath(`/d/${token}/leads/${leadId}`)
  redirect(`/d/${token}/leads/${leadId}?${ok ? 'saved=intake' : 'error=intake'}`)
}

const QUALIFICATION_DECISIONS = new Set<Exclude<QualificationStatus, 'pending'>>(['qualified', 'unqualified'])
const CONSULTATION_DECISIONS = new Set<Exclude<ConsultationStatus, 'booked'>>(['completed', 'cancelled', 'no_show'])
const MATTER_DECISIONS = new Set<MatterOutcomeStatus>(['retained', 'not_retained', 'closed'])

function leadBriefPath(token: string, leadId: string): string {
  return `/d/${encodeURIComponent(token)}/leads/${encodeURIComponent(leadId)}`
}

function revalidateLeadBrief(token: string, leadId: string): void {
  revalidatePath(`/d/${token}/leads`)
  revalidatePath(leadBriefPath(token, leadId))
}

function redirectLeadOutcome(token: string, leadId: string, query: string): never {
  redirect(`${leadBriefPath(token, leadId)}?${query}`)
}

function outcomeActor(firmId: number): string {
  return `firm-dashboard:${firmId}`
}

/** Read bounded text from a browser form without trusting its field shape or length. */
function outcomeText(formData: FormData, name: string, maxLength = 2000): string | null {
  const value = formData.get(name)
  if (value === null) return ''
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length <= maxLength ? normalized : null
}

function selectedOutcome<T extends string>(formData: FormData, name: string, allowed: ReadonlySet<T>): T | null {
  const value = formData.get(name)
  return typeof value === 'string' && allowed.has(value as T) ? value as T : null
}

/** Record an explicit qualified/unqualified decision; intake submission never calls this implicitly. */
export async function qualifyLead(token: string, leadId: string, formData: FormData): Promise<void> {
  'use server'
  const status = selectedOutcome(formData, 'status', QUALIFICATION_DECISIONS)
  const reason = outcomeText(formData, 'reason')
  if (!status || reason === null || !reason) redirectLeadOutcome(token, leadId, 'error=outcome-validation')

  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  try {
    await qualifyLeadForFirm(db, firm, leadId, { status, reason, actor: outcomeActor(firm.id) })
  } catch {
    redirectLeadOutcome(token, leadId, 'error=outcome-transition')
  }
  revalidateLeadBrief(token, leadId)
  redirectLeadOutcome(token, leadId, 'saved=qualification')
}

/** Book or re-book a consultation for the token-resolved firm and lead only. */
export async function bookConsultation(token: string, leadId: string, formData: FormData): Promise<void> {
  'use server'
  const scheduledAt = parseKoreaDateTime(formData.get('scheduledAt'))
  const reason = outcomeText(formData, 'reason')
  if (scheduledAt === 'invalid' || reason === null) redirectLeadOutcome(token, leadId, 'error=outcome-validation')

  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  try {
    await bookConsultationForFirm(db, firm, leadId, {
      scheduledAt,
      reason,
      actor: outcomeActor(firm.id),
    })
  } catch {
    redirectLeadOutcome(token, leadId, 'error=outcome-transition')
  }
  revalidateLeadBrief(token, leadId)
  redirectLeadOutcome(token, leadId, 'saved=consultation')
}

/** Record completion, cancellation, or no-show without rewriting the append-only history. */
export async function transitionConsultation(token: string, leadId: string, formData: FormData): Promise<void> {
  'use server'
  const status = selectedOutcome(formData, 'status', CONSULTATION_DECISIONS)
  const reason = outcomeText(formData, 'reason')
  if (!status || reason === null) redirectLeadOutcome(token, leadId, 'error=outcome-validation')

  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  try {
    await transitionConsultationForFirm(db, firm, leadId, { status, reason, actor: outcomeActor(firm.id) })
  } catch {
    redirectLeadOutcome(token, leadId, 'error=outcome-transition')
  }
  revalidateLeadBrief(token, leadId)
  redirectLeadOutcome(token, leadId, 'saved=consultation-status')
}

/** Record the terminal matter result; every dashboard result requires a reason, with an optional fee band. */
export async function recordMatterOutcome(token: string, leadId: string, formData: FormData): Promise<void> {
  'use server'
  const status = selectedOutcome(formData, 'status', MATTER_DECISIONS)
  const reason = outcomeText(formData, 'reason')
  const feeBand = outcomeText(formData, 'feeBand', 200)
  if (!status || reason === null || !reason || feeBand === null) redirectLeadOutcome(token, leadId, 'error=outcome-validation')

  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  try {
    await recordMatterOutcomeForFirm(db, firm, leadId, {
      status,
      reason,
      feeBand,
      actor: outcomeActor(firm.id),
    })
  } catch {
    redirectLeadOutcome(token, leadId, 'error=outcome-transition')
  }
  revalidateLeadBrief(token, leadId)
  redirectLeadOutcome(token, leadId, 'saved=matter-outcome')
}

/** Customer-owned content/brand approval. The token fixes the firm scope. */
export async function decideContentApproval(token: string, taskId: string, formData: FormData): Promise<void> {
  'use server'
  const rawDecision = String(formData.get('decision') ?? '')
  const decision = rawDecision === 'approve' || rawDecision === 'reject' ? rawDecision : null
  const reason = String(formData.get('reason') ?? '').trim()
  const target = `/d/${encodeURIComponent(token)}/ads`
  if (!decision || reason.length < 5) redirect(`${target}?error=approval`)
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  try {
    await decideApprovalTask(db, {
      taskId,
      firmId: firm.id,
      decision,
      actorType: 'lawyer',
      actorId: `firm-dashboard:${firm.id}`,
      reason,
    })
  } catch {
    redirect(`${target}?error=approval`)
  }
  revalidatePath(`/d/${token}`)
  revalidatePath(`/d/${token}/ads`)
  revalidatePath(`/d/${token}/keywords`)
  redirect(`${target}?saved=approval`)
}

/** 사무소 내부의 과거 상담 당사자와 이름 일치 가능성을 검색한다. 법률 판단은 하지 않는다. */
export async function runLeadConflictCheck(token: string, leadId: string, formData: FormData): Promise<void> {
  'use server'
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  const result = await runConflictCheckForFirm(db, firm, leadId, {
    prospective: String(formData.get('prospective') ?? ''),
    adverse: String(formData.get('adverse') ?? ''),
    related: String(formData.get('related') ?? ''),
  })
  revalidatePath(`/d/${token}/leads`)
  revalidatePath(`/d/${token}/leads/${leadId}`)
  redirect(`/d/${token}/leads/${leadId}?${result ? `conflict=${result.status}` : 'error=conflict'}`)
}

/**
 * server action — 사건명 테이블의 올리기/내리기 버튼(스펙 §A4·§C)에서 호출. formData의
 * 'desired' 문자열('true'|'false')로 firm_keywords.adDesired만 바꾼다 — 구독 자체(행 생성)는
 * CLI/엔진 소유라 여기서는 새 행을 만들지 않는다(setAdDesiredForFirm 계약, 행 없으면 무시).
 * updateLeadStatus와 동일 패턴: firmId 인자 없이 token을 매 호출 재검증(위조 방지).
 */
export async function setAdDesired(token: string, keywordId: string, formData: FormData): Promise<void> {
  'use server'
  const desired = formData.get('desired')
  if (typeof desired !== 'string') return
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  await setAdDesiredForFirm(db, firm, keywordId, desired === 'true')
  revalidatePath(`/d/${token}/keywords`)
  revalidatePath(`/d/${token}/ads`)
}

/**
 * buildAdConfigRedirectQuery — saveAdConfigForFirm 결과 → ads 페이지 리다이렉트 쿼리 문자열.
 * 순수 함수(redirect()·DB·네트워크 없음)로 뽑아 next/navigation을 모킹하지 않고 단위 테스트할
 * 수 있게 한다(리뷰 반영 Important — 이 분기 자체가 무테스트였다).
 */
export function buildAdConfigRedirectQuery(result: SaveAdConfigResult): string {
  return result.ok ? 'saved=config' : 'error=config-range'
}

/**
 * buildCredentialsRedirectQuery — saveCredentialsForFirm 결과 → ads 페이지 리다이렉트 쿼리
 * 문자열. **`result.ok`가 아니라 `result.verified`로 분기한다** — `ok`는
 * "자격증명 저장(암호화 upsert) 자체" 성공 여부라 검증 핑이 실패해도 거의 항상 true인
 * false-friend 필드다(saveCredentialsForFirm 계약 — src/lib/dashboard/ad-settings.ts).
 * 화면에 의미 있는 성공/실패 신호는 검증 핑 결과이므로 `verified`를 써야 하고, 이 분기를 순수
 * 함수로 뽑아 단위 테스트에 못박아 둔다 — 그렇지 않으면 향후 리팩터가 실수로 `.ok`를 쓸 때
 * 인증 실패(errorCategory 'auth' 등)에도 "저장되었습니다" 성공 배너가 뜨는 회귀가 무테스트로
 * 통과한다(리뷰 반영 Important).
 */
export function buildCredentialsRedirectQuery(result: SaveCredentialsResult): string {
  return result.verified ? 'saved=cred' : `error=cred-${result.errorCategory ?? 'unknown'}`
}

function positiveFormInteger(formData: FormData, name: string): number | null {
  const raw = formData.get(name)
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Save the customer's explicit case/action/spend approval boundary. */
export async function saveCustomerAdPolicy(token: string, formData: FormData): Promise<void> {
  'use server'
  const monthlyBudget = positiveFormInteger(formData, 'monthlyBudget')
  const dailyBudget = positiveFormInteger(formData, 'dailyBudget')
  const bidCeiling = positiveFormInteger(formData, 'bidCeiling')
  const approvedBy = String(formData.get('approvedBy') ?? '').trim()
  const reason = String(formData.get('reason') ?? '').trim()
  const scopeConfirmed = formData.get('scopeConfirmed') === 'yes'
  if (!monthlyBudget || !dailyBudget || !bidCeiling || !approvedBy || !scopeConfirmed) {
    redirect(`/d/${token}/ads?error=policy-invalid`)
  }

  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  try {
    await saveFirmAdPolicy(db, {
      firmId: firm.id,
      monthlyBudget,
      dailyBudget,
      bidCeiling,
      allowedCaseEntityIds: formData.getAll('caseEntityId').map(String),
      allowedActions: formData.getAll('allowedAction').map(String),
      autoSubmit: formData.get('autoSubmit') === 'yes',
      approvedBy,
      reason,
    })
  } catch (error) {
    if (error instanceof CustomerAdPolicyValidationError) {
      redirect(`/d/${token}/ads?error=policy-invalid`)
    }
    throw error
  }
  revalidatePath(`/d/${token}`)
  revalidatePath(`/d/${token}/ads`)
  redirect(`/d/${token}/ads?saved=policy`)
}

/**
 * server action — 광고 설정 카드(기본 입찰 기준액·일예산) 저장(스펙 §A2). 서버 검증(정수·범위)은
 * saveAdConfigForFirm 단일 소스. Task 2가 이 래퍼를 void 반환(updateLeadStatus 패턴 그대로)으로
 * 남겨 결과가 화면에 안 보이는 문제를 남겼다(Task 2 리포트 명시 인계) — Task 5 이관 결정으로
 * 해소: 코어 결과에 따라 ads 페이지로 쿼리 파람 리다이렉트해 페이지가 searchParams로 성공/실패
 * 배너를 렌더한다(서버 컴포넌트 호환 — 값을 직접 반환하는 대신 URL 상태로 옮긴다).
 * redirect()는 NEXT_REDIRECT를 던지는 게 정상 동작이라 try/catch로 감싸지 않는다.
 */
export async function saveAdConfig(token: string, formData: FormData): Promise<void> {
  'use server'
  const bidAmtRaw = formData.get('bidAmt')
  const dailyBudgetRaw = formData.get('dailyBudget')
  if (typeof bidAmtRaw !== 'string' || typeof dailyBudgetRaw !== 'string') return
  const bidAmt = Number(bidAmtRaw)
  const dailyBudget = Number(dailyBudgetRaw)
  if (!Number.isFinite(bidAmt) || !Number.isFinite(dailyBudget)) return
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  const result = await saveAdConfigForFirm(db, firm, { bidAmt, dailyBudget })
  revalidatePath(`/d/${token}/keywords`)
  revalidatePath(`/d/${token}/ads`)
  redirect(`/d/${token}/ads?${buildAdConfigRedirectQuery(result)}`)
}

/**
 * server action — 자격증명 카드 저장(스펙 §A1). 암호화·검증 핑(GET /ncc/campaigns)·채널 매칭
 * (GET /ncc/channels)은 saveCredentialsForFirm 단일 소스에 위임 — 이 래퍼는 makeClient를
 * 주입하지 않으므로 실제 NaverSearchAdClient가 쓰인다(대시보드는 어떤 경우에도 네이버 쓰기 API를
 * 호출하지 않는다 — 스펙 §F). Task 5 이관 결정 — saveAdConfig와 동일하게 결과에 따라 리다이렉트
 * (buildCredentialsRedirectQuery 단일 소스 — verified/ok 오용 방지 근거는 그 함수 주석 참조).
 * 에러 카테고리(auth/network/unknown)만 쿼리에 싣고 원문 에러는 절대 노출하지 않는다(스펙 §F).
 */
export async function saveCredentials(token: string, formData: FormData): Promise<void> {
  'use server'
  const customerId = formData.get('customerId')
  const apiKey = formData.get('apiKey')
  const secret = formData.get('secret')
  if (typeof customerId !== 'string' || typeof apiKey !== 'string' || typeof secret !== 'string') return
  if (!customerId || !apiKey || !secret) return
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return
  const result = await saveCredentialsForFirm(db, firm, { customerId, apiKey, secret })
  revalidatePath(`/d/${token}/keywords`)
  revalidatePath(`/d/${token}/ads`)
  redirect(`/d/${token}/ads?${buildCredentialsRedirectQuery(result)}`)
}
