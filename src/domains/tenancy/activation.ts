import { eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  adAccounts,
  adExecutions,
  caseApprovals,
  caseEntities,
  contentAssets,
  firmCredentials,
  firmDomains,
  firmPolicies,
  firms,
  leadQualifications,
  leadStatusHistory,
  leads,
  publications,
  visitorSessions,
} from '@/lib/db/schema'

export const ACTIVATION_MINIMUM_APPROVED_CASES = 20
export const ACTIVATION_PILOT_TARGET_CASES = Object.freeze({ min: 50, max: 100 })

export const ACTIVATION_CHECK_KEYS = Object.freeze([
  'firm_profile',
  'domain_tls',
  'naver_connection',
  'budget_policy',
  'approved_cases',
  'live_surfaces',
  'canonical_lead',
  'customer_outcome',
] as const)

export type ActivationStatus = 'ready' | 'pending' | 'blocked'
export type ActivationCheckKey = (typeof ACTIVATION_CHECK_KEYS)[number]

export type ActivationCheck = {
  readonly key: ActivationCheckKey
  readonly label: string
  readonly status: ActivationStatus
  readonly required: true
  readonly summary: string
  readonly detail: string
  /** All evidence in this checklist is read from the local DB canonical rows. */
  readonly evidenceSource: 'database'
}

export type ActivationCaseSummary = {
  readonly count: number
  readonly minimum: number
  readonly pilotTarget: { readonly min: number; readonly max: number }
  readonly pilotTargetLabel: string
  readonly meetsMinimum: boolean
  readonly pilotTargetState: 'below' | 'within' | 'above'
  readonly scopedCandidates: number
  readonly blockedCandidates: number
}

export type ActivationLeadSummary = {
  readonly canonicalLeads: number
  readonly testLeads: number
  readonly realLeads: number
  readonly incompleteLeads: number
  readonly invalidLeads: number
}

export type FirmActivationChecklist = {
  readonly firmId: number
  readonly firmName: string
  readonly status: ActivationStatus
  /** This is true only when every required check is ready. */
  readonly complete: boolean
  readonly checks: readonly ActivationCheck[]
  readonly checksByKey: Readonly<Record<ActivationCheckKey, ActivationCheck>>
  readonly approvedCases: ActivationCaseSummary
  readonly leads: ActivationLeadSummary
  readonly evidenceSource: 'database'
}

type FirmRow = typeof firms.$inferSelect
type CaseRow = typeof caseEntities.$inferSelect
type ApprovalRow = typeof caseApprovals.$inferSelect
type AssetRow = typeof contentAssets.$inferSelect
type PublicationRow = typeof publications.$inferSelect
type LeadRow = typeof leads.$inferSelect

type ActivationCredentialRow = Pick<
  typeof firmCredentials.$inferSelect,
  'provider' | 'verifiedAt'
>
type ActivationAccountRow = Pick<
  typeof adAccounts.$inferSelect,
  'provider' | 'status' | 'verifiedAt'
>
type ActivationSessionRow = Pick<
  typeof visitorSessions.$inferSelect,
  'id' | 'firmId'
>
type ActivationHistoryRow = Pick<
  typeof leadStatusHistory.$inferSelect,
  'firmId' | 'leadId' | 'toStatus' | 'actor'
>
type ActivationQualificationRow = Pick<
  typeof leadQualifications.$inferSelect,
  'firmId' | 'leadId' | 'status' | 'actor'
>

const NAVER_PROVIDERS = new Set(['naver_searchad', 'naver'])
const READY_SEO_ASSET_STATUSES = new Set(['published', 'indexed'])
const READY_AD_ASSET_STATUSES = new Set(['published', 'experiment_live', 'winner'])
const BLOCKED_ASSET_STATUSES = new Set(['blocked', 'rejected', 'retired'])
const BLOCKED_PUBLICATION_STATUSES = new Set(['blocked', 'failed'])
const PAID_MEDIA = new Set(['cpc', 'ppc', 'paid', 'paid_search'])

function firmIdValue(value: number | { id: number }): number {
  const id = typeof value === 'number' ? value : value.id
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError('firmId must be a positive integer')
  }
  return id
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeHost(value: string | null | undefined): string | null {
  if (!hasText(value)) return null
  let candidate = value!.trim().toLowerCase()
  try {
    candidate = candidate.includes('://') ? new URL(candidate).hostname : candidate.split('/')[0]
  } catch {
    candidate = candidate.replace(/^https?:\/\//, '').split('/')[0]
  }
  candidate = candidate.replace(/:\d+$/, '').replace(/\.$/, '')
  if (candidate.startsWith('www.')) candidate = candidate.slice(4)
  return candidate || null
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    // The database column is UUID-shaped, but fixtures and imported canonical
    // IDs may use a non-RFC version/variant nibble. Shape validation keeps the
    // tenant policy scoped to canonical IDs without rejecting those rows.
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function rowDate(value: Date): number {
  return value.getTime()
}

function latestApproval(
  caseId: string,
  firmId: number,
  rows: readonly ApprovalRow[],
): ApprovalRow | null {
  const applicable = rows.filter((row) => (
    row.caseEntityId === caseId && (row.firmId === null || row.firmId === firmId)
  ))
  applicable.sort((left, right) => rowDate(left.createdAt) - rowDate(right.createdAt) || left.id.localeCompare(right.id))
  return applicable.at(-1) ?? null
}

function check(
  key: ActivationCheckKey,
  label: string,
  status: ActivationStatus,
  summary: string,
  detail: string,
): ActivationCheck {
  return {
    key,
    label,
    status,
    required: true,
    summary,
    detail,
    evidenceSource: 'database',
  }
}

function profileCheck(firm: FirmRow): ActivationCheck {
  const missing: string[] = []
  if (!hasText(firm.name) || !hasText(firm.wordmark)) missing.push('브랜드명·워드마크')
  if (!hasText(firm.adLawyerName)) missing.push('광고책임변호사')
  if (!hasText(firm.profileIntro)) missing.push('상담 안내')
  if (!hasText(firm.phone) || !hasText(firm.phoneIntl)) missing.push('대표 연락처')
  if (!hasText(firm.address) || !hasText(firm.addressRegion) || !hasText(firm.addressLocality)) missing.push('사무소 주소')

  const lawyers = firm.lawyers ?? []
  if (!lawyers.length) {
    missing.push('변호사 정보')
  } else if (lawyers.some((lawyer) => (
    !hasText(lawyer.name)
    || !hasText(lawyer.title)
    || !lawyer.career?.some((item) => hasText(item))
  ))) {
    missing.push('변호사 이력')
  }

  return check(
    'firm_profile',
    '브랜드·변호사·상담 정보',
    missing.length ? 'pending' : 'ready',
    missing.length ? '필수 고객 정보가 아직 완성되지 않았습니다.' : '브랜드, 변호사, 연락처와 상담 안내가 준비되었습니다.',
    missing.length ? `미완료: ${missing.join(', ')}` : 'DB의 firms 프로필과 공개 필수 정보가 모두 준비됨',
  )
}

function domainCheck(
  firm: FirmRow,
  domains: readonly (typeof firmDomains.$inferSelect)[],
): ActivationCheck {
  const configured = normalizeHost(firm.domain)
  const canonicalRows = domains.filter((row) => row.isCanonical)
  const matching = configured
    ? canonicalRows.filter((row) => normalizeHost(row.hostname) === configured)
    : []
  const failed = matching.some((row) => row.status === 'failed' || row.tlsStatus === 'invalid')
  const ready = matching.some((row) => (
    (row.status === 'verified' || row.status === 'active') && row.tlsStatus === 'valid'
  ))
  const mismatchedCanonical = Boolean(configured && canonicalRows.length && !matching.length)

  let status: ActivationStatus = 'pending'
  if (failed || mismatchedCanonical) status = 'blocked'
  else if (ready) status = 'ready'

  const detail = !configured
    ? 'firms.domain이 비어 있습니다.'
    : !canonicalRows.length
      ? `정본 도메인 ${configured}의 firm_domains 행이 없습니다.`
      : mismatchedCanonical
        ? `firm.domain=${configured}과 일치하는 isCanonical=true 행이 없습니다.`
        : failed
          ? '정본 도메인의 status 또는 TLS가 실패 상태입니다.'
          : ready
            ? `정본 ${configured}: domain status verified/active · TLS valid`
            : `정본 ${configured}은 있으나 status verified/active와 TLS valid를 모두 충족하지 않습니다.`

  return check(
    'domain_tls',
    '정본 도메인·TLS',
    status,
    ready ? '정본 도메인과 TLS가 검증된 상태입니다.' : status === 'blocked' ? '도메인 또는 TLS 검증이 차단 상태입니다.' : '정본 도메인/TLS 검증을 기다리고 있습니다.',
    detail,
  )
}

function naverCheck(
  firm: FirmRow,
  credentials: readonly ActivationCredentialRow[],
  accounts: readonly ActivationAccountRow[],
): ActivationCheck {
  const naverCredentials = credentials.filter((row) => NAVER_PROVIDERS.has(row.provider.toLowerCase()))
  const naverAccounts = accounts.filter((row) => NAVER_PROVIDERS.has(row.provider.toLowerCase()))
  const credentialReady = naverCredentials.some((row) => row.verifiedAt !== null)
  const accountReady = naverAccounts.some((row) => row.status === 'verified' || row.status === 'active')
  const accountBlocked = naverAccounts.some((row) => row.status === 'failed')
  const config = firm.adConfig
  const channelReady = config?.channelOk === true && hasText(config.pcChannelId) && hasText(config.mobileChannelId)
  const channelBlocked = config?.channelOk === false
  const ready = credentialReady && accountReady && channelReady
  const status: ActivationStatus = ready
    ? 'ready'
    : accountBlocked || channelBlocked
      ? 'blocked'
      : 'pending'
  const missing = [
    !credentialReady ? 'verified credential' : null,
    !accountReady ? 'verified/active ad account' : null,
    !channelReady ? 'verified business channel' : null,
  ].filter((item): item is string => Boolean(item))

  return check(
    'naver_connection',
    '네이버 credential·광고계정·비즈채널',
    status,
    ready ? '네이버 연결 증거가 모두 DB에 있습니다.' : status === 'blocked' ? '네이버 연결에 실패한 증거가 있습니다.' : '네이버 연결 검증을 기다리고 있습니다.',
    ready
      ? `credential ${naverCredentials.length}건 · account ${naverAccounts.length}건 · PC/mobile channel ID 저장됨`
      : `미완료: ${missing.join(', ')}`,
  )
}

function policyCheck(
  policy: typeof firmPolicies.$inferSelect | null,
): ActivationCheck {
  if (!policy) {
    return check('budget_policy', '승인된 예산 정책', 'pending', '고객 승인 예산 정책이 없습니다.', 'firm_policies 행이 없습니다.')
  }

  const approved = hasText(policy.approvedBy) && policy.approvedAt !== null
  const budgetValid = [policy.monthlyBudget, policy.dailyBudget, policy.bidCeiling].every((value) => (
    Number.isSafeInteger(value) && Number(value) > 0
  ))
  const dailyWithinMonthly = budgetValid && policy.dailyBudget! <= policy.monthlyBudget!
  const caseIdsValid = Array.isArray(policy.allowedCaseEntityIds)
    && policy.allowedCaseEntityIds.length > 0
    && policy.allowedCaseEntityIds.every(isUuid)
  const actions = Array.isArray(policy.allowedActions) ? policy.allowedActions : []
  const actionValid = actions.some((action) => action === 'register' || action === 'activate')
  const invalidApprovedPolicy = approved && (!budgetValid || !dailyWithinMonthly || !caseIdsValid || !actionValid)
  const ready = approved && budgetValid && dailyWithinMonthly && caseIdsValid && actionValid
  const status: ActivationStatus = ready ? 'ready' : invalidApprovedPolicy ? 'blocked' : 'pending'
  const missing = [
    !approved ? 'approvedBy/approvedAt' : null,
    !budgetValid || !dailyWithinMonthly ? '유효한 monthly/daily/bid 상한' : null,
    !caseIdsValid ? 'canonical allowed case IDs' : null,
    !actionValid ? 'register 또는 activate action' : null,
  ].filter((item): item is string => Boolean(item))

  return check(
    'budget_policy',
    '승인된 예산 정책',
    status,
    ready ? '고객 승인 예산·행동 범위가 저장되었습니다.' : status === 'blocked' ? '승인된 정책의 값이 유효하지 않습니다.' : '예산 정책 승인 기록을 기다리고 있습니다.',
    ready ? `policy ${policy.policyVersion} · monthly ${policy.monthlyBudget} · daily ${policy.dailyBudget}` : `미완료: ${missing.join(', ')}`,
  )
}

function scopedCaseIds(
  firmId: number,
  assets: readonly AssetRow[],
  policy: typeof firmPolicies.$inferSelect | null,
  approvals: readonly ApprovalRow[],
): Set<string> {
  const ids = new Set<string>()
  for (const asset of assets) ids.add(asset.caseEntityId)
  for (const id of policy?.allowedCaseEntityIds ?? []) {
    if (isUuid(id)) ids.add(id)
  }
  for (const approval of approvals) {
    if (approval.firmId === firmId) ids.add(approval.caseEntityId)
  }
  return ids
}

function caseCheck(
  firmId: number,
  cases: readonly CaseRow[],
  assets: readonly AssetRow[],
  policy: typeof firmPolicies.$inferSelect | null,
  approvals: readonly ApprovalRow[],
): { check: ActivationCheck; summary: ActivationCaseSummary } {
  const scoped = scopedCaseIds(firmId, assets, policy, approvals)
  const blockedCandidates = new Set<string>()
  const approved = new Set<string>()

  for (const caseRow of cases) {
    if (!scoped.has(caseRow.id)) continue
    const approval = latestApproval(caseRow.id, firmId, approvals)
    if (caseRow.status === 'blocked' || approval?.decision === 'blocked' || approval?.decision === 'rejected') {
      blockedCandidates.add(caseRow.id)
      continue
    }
    // case_entities.status is the canonical current state. The audit row is
    // preferred when present, while legacy/target rows without an audit
    // snapshot remain valid when their persisted state is already approved.
    if (caseRow.status === 'approved' && (!approval || approval.decision === 'approved')) approved.add(caseRow.id)
  }

  const count = approved.size
  const meetsMinimum = count >= ACTIVATION_MINIMUM_APPROVED_CASES
  const pilotTargetState = count < ACTIVATION_PILOT_TARGET_CASES.min
    ? 'below'
    : count > ACTIVATION_PILOT_TARGET_CASES.max
      ? 'above'
      : 'within'
  const summary: ActivationCaseSummary = {
    count,
    minimum: ACTIVATION_MINIMUM_APPROVED_CASES,
    pilotTarget: ACTIVATION_PILOT_TARGET_CASES,
    pilotTargetLabel: `${ACTIVATION_PILOT_TARGET_CASES.min}–${ACTIVATION_PILOT_TARGET_CASES.max}`,
    meetsMinimum,
    pilotTargetState,
    scopedCandidates: scoped.size,
    blockedCandidates: blockedCandidates.size,
  }
  const status: ActivationStatus = blockedCandidates.size > 0
    ? 'blocked'
    : meetsMinimum
      ? 'ready'
      : 'pending'
  const targetNote = pilotTargetState === 'within'
    ? `파일럿 목표 ${summary.pilotTargetLabel} 안` : pilotTargetState === 'above' ? `파일럿 목표 ${summary.pilotTargetLabel} 초과` : `파일럿 목표 ${summary.pilotTargetLabel} 미만`

  return {
    summary,
    check: check(
      'approved_cases',
      '고신뢰 승인 사건',
      status,
      meetsMinimum ? `승인 사건 ${count}건으로 현재 단계 최소 ${summary.minimum}건을 충족합니다.` : `승인 사건 ${count}건으로 현재 단계 최소 ${summary.minimum}건이 필요합니다.`,
      `${targetNote} · scoped ${scoped.size}건 · blocked ${blockedCandidates.size}건 · 승인 판정은 case_entities/case_approvals 정본 기준`,
    ),
  }
}

function urlHost(value: string): string | null {
  try {
    return normalizeHost(new URL(value).hostname)
  } catch {
    return null
  }
}

function publicationMatchesDomain(publication: PublicationRow, canonicalDomain: string | null): boolean {
  if (!canonicalDomain || normalizeHost(publication.domain) !== canonicalDomain) return false
  return urlHost(publication.canonicalUrl) === canonicalDomain
    && urlHost(publication.url) === canonicalDomain
}

function liveSurfacesCheck(
  assets: readonly AssetRow[],
  publications: readonly PublicationRow[],
  canonicalDomain: string | null,
): ActivationCheck {
  const publicationByAsset = new Map<string, PublicationRow[]>()
  for (const publication of publications) {
    const rows = publicationByAsset.get(publication.contentAssetId) ?? []
    rows.push(publication)
    publicationByAsset.set(publication.contentAssetId, rows)
  }

  const seoAssets = assets.filter((asset) => asset.assetType === 'seo_page')
  const adAssets = assets.filter((asset) => asset.assetType === 'ad_landing')
  const readyFor = (asset: AssetRow, allowedStatuses: ReadonlySet<string>, indexPolicy: string): boolean => (
    allowedStatuses.has(asset.status)
    && (publicationByAsset.get(asset.id) ?? []).some((publication) => (
      publication.status === 'live'
      && publication.indexPolicy === indexPolicy
      && publicationMatchesDomain(publication, canonicalDomain)
    ))
  )
  const seoReady = seoAssets.some((asset) => readyFor(asset, READY_SEO_ASSET_STATUSES, 'index'))
  const adReady = adAssets.some((asset) => readyFor(asset, READY_AD_ASSET_STATUSES, 'noindex'))
  const hasExplicitBlock = assets.some((asset) => BLOCKED_ASSET_STATUSES.has(asset.status))
    || publications.some((publication) => BLOCKED_PUBLICATION_STATUSES.has(publication.status))
    || publications.some((publication) => (
      publication.status === 'live'
      && canonicalDomain !== null
      && (!publicationMatchesDomain(publication, canonicalDomain)
        || (publication.indexPolicy !== 'index' && publication.indexPolicy !== 'noindex'))
    ))
  const status: ActivationStatus = seoReady && adReady ? 'ready' : hasExplicitBlock ? 'blocked' : 'pending'

  return check(
    'live_surfaces',
    'live SEO·광고 랜딩',
    status,
    seoReady && adReady ? 'SEO와 광고 랜딩이 실제 공개 상태입니다.' : status === 'blocked' ? '공개 자산 또는 publication에 차단 상태가 있습니다.' : 'SEO/광고 랜딩 공개를 기다리고 있습니다.',
    `SEO ${seoReady ? 'live' : '미충족'} · 광고 랜딩 ${adReady ? 'live' : '미충족'} · firm 소유 asset ${assets.length}건 · publication ${publications.length}건`,
  )
}

function isDemoLead(lead: LeadRow): boolean {
  const touch = lead.utm as Record<string, unknown> | null
  const source = typeof touch?.source === 'string' ? touch.source : touch?.utm_source
  return source === 'demo-seed'
}

function canonicalLeadSummary(
  firmId: number,
  leadsRows: readonly LeadRow[],
  sessions: readonly ActivationSessionRow[],
  cases: readonly CaseRow[],
  assets: readonly AssetRow[],
  publications: readonly PublicationRow[],
  executions: readonly (typeof adExecutions.$inferSelect)[],
): { check: ActivationCheck; summary: ActivationLeadSummary } {
  const sessionById = new Map(sessions.map((row) => [row.id, row]))
  const caseById = new Map(cases.map((row) => [row.id, row]))
  const assetById = new Map(assets.map((row) => [row.id, row]))
  const publicationById = new Map(publications.map((row) => [row.id, row]))
  const executionById = new Map(executions.map((row) => [row.id, row]))
  let canonicalLeads = 0
  let testLeads = 0
  let realLeads = 0
  let incompleteLeads = 0
  let invalidLeads = 0

  for (const lead of leadsRows) {
    const hasCoreIds = Boolean(lead.sessionId && lead.caseEntityId && lead.contentAssetId && lead.publicationId)
    if (!hasCoreIds) {
      incompleteLeads += 1
      continue
    }
    const session = sessionById.get(lead.sessionId!)
    const caseRow = caseById.get(lead.caseEntityId!)
    const asset = assetById.get(lead.contentAssetId!)
    const publication = publicationById.get(lead.publicationId!)
    const execution = lead.adExecutionId ? executionById.get(lead.adExecutionId) : null
    const touch = lead.utm as Record<string, unknown> | null
    const medium = typeof touch?.medium === 'string'
      ? touch.medium
      : typeof touch?.utm_medium === 'string'
        ? touch.utm_medium
        : null
    const paid = Boolean(lead.adExecutionId) || PAID_MEDIA.has(medium?.toLowerCase() ?? '')
    const valid = Boolean(
      session
      && session.firmId === firmId
      && caseRow
      && caseRow.status === 'approved'
      && asset
      && asset.firmId === firmId
      && asset.caseEntityId === caseRow.id
      && publication
      && publication.firmId === firmId
      && publication.contentAssetId === asset.id
      && (!paid || Boolean(execution))
      && (!execution || (
        execution.firmId === firmId
        && execution.caseEntityId === caseRow.id
        && execution.contentAssetId === asset.id
        && (!execution.publicationId || execution.publicationId === publication.id)
      ))
      && (!paid || asset.assetType === 'ad_landing')
    )
    if (!valid) {
      invalidLeads += 1
      continue
    }
    canonicalLeads += 1
    if (isDemoLead(lead)) testLeads += 1
    else realLeads += 1
  }

  const ready = canonicalLeads > 0
  const status: ActivationStatus = invalidLeads > 0 ? 'blocked' : ready ? 'ready' : 'pending'
  const summary: ActivationLeadSummary = { canonicalLeads, testLeads, realLeads, incompleteLeads, invalidLeads }
  return {
    summary,
    check: check(
      'canonical_lead',
      'canonical ID가 붙은 테스트·실 lead',
      status,
      ready ? `canonical attribution lead ${canonicalLeads}건이 firm 범위에서 확인됩니다.` : 'firm·사건·asset·publication에 연결된 lead가 없습니다.',
      `test ${testLeads}건 · real ${realLeads}건 · 불완전 ${incompleteLeads}건 · 무결성 불일치 ${invalidLeads}건`,
    ),
  }
}

function customerOutcomeCheck(
  firmId: number,
  leadsRows: readonly LeadRow[],
  historyRows: readonly ActivationHistoryRow[],
  qualificationRows: readonly ActivationQualificationRow[],
): ActivationCheck {
  const leadIds = new Set(leadsRows.filter((row) => row.firmId === firmId).map((row) => row.id))
  const customerActor = (actor: string): boolean => /^(firm-dashboard|customer|firm-user)(?::|$)/i.test(actor.trim())
  const historyEvidence = historyRows.filter((row) => (
    row.firmId === firmId && leadIds.has(row.leadId) && row.toStatus !== 'new' && customerActor(row.actor)
  ))
  const qualificationEvidence = qualificationRows.filter((row) => (
    row.firmId === firmId && leadIds.has(row.leadId) && row.status !== 'pending' && customerActor(row.actor)
  ))
  const evidenceCount = new Set([
    ...historyEvidence.map((row) => `${row.leadId}:${row.toStatus}`),
    ...qualificationEvidence.map((row) => `${row.leadId}:qualification:${row.status}`),
  ]).size
  const ready = evidenceCount > 0
  return check(
    'customer_outcome',
    '고객 outcome 갱신 증거',
    ready ? 'ready' : 'pending',
    ready ? `고객 actor의 outcome 갱신 ${evidenceCount}건이 기록되어 있습니다.` : '고객이 lead outcome을 갱신한 DB 기록이 없습니다.',
    ready ? 'lead_status_history/lead_qualifications의 고객 actor 기록 확인' : 'firm-dashboard/customer/firm-user actor의 qualification 또는 상태 이력 대기',
  )
}

/**
 * Calculate the activation checklist from tenant-scoped canonical rows.
 * This function is read-only and deliberately does not ping Naver, DNS, TLS,
 * search providers, or a public URL. Missing external evidence remains
 * pending; it is never guessed from a configured value.
 */
export async function getFirmActivationChecklist(
  db: Db,
  firm: number | { id: number },
): Promise<FirmActivationChecklist | null> {
  const firmId = firmIdValue(firm)
  const [firmRow] = await db.select().from(firms).where(eq(firms.id, firmId)).limit(1)
  if (!firmRow) return null

  const [
    domains,
    credentials,
    accounts,
    policyRows,
    caseRows,
    approvalRows,
    assetRows,
    publicationRows,
    executionRows,
    leadRows,
    sessionRows,
    historyRows,
    qualificationRows,
  ] = await Promise.all([
    db.select().from(firmDomains).where(eq(firmDomains.firmId, firmId)),
    db.select({ provider: firmCredentials.provider, verifiedAt: firmCredentials.verifiedAt })
      .from(firmCredentials).where(eq(firmCredentials.firmId, firmId)),
    db.select({ provider: adAccounts.provider, status: adAccounts.status, verifiedAt: adAccounts.verifiedAt })
      .from(adAccounts).where(eq(adAccounts.firmId, firmId)),
    db.select().from(firmPolicies).where(eq(firmPolicies.firmId, firmId)).limit(1),
    db.select().from(caseEntities),
    db.select().from(caseApprovals),
    db.select().from(contentAssets).where(eq(contentAssets.firmId, firmId)),
    db.select().from(publications).where(eq(publications.firmId, firmId)),
    db.select().from(adExecutions).where(eq(adExecutions.firmId, firmId)),
    db.select().from(leads).where(eq(leads.firmId, firmId)),
    db.select({ id: visitorSessions.id, firmId: visitorSessions.firmId })
      .from(visitorSessions).where(eq(visitorSessions.firmId, firmId)),
    db.select({
      firmId: leadStatusHistory.firmId,
      leadId: leadStatusHistory.leadId,
      toStatus: leadStatusHistory.toStatus,
      actor: leadStatusHistory.actor,
    }).from(leadStatusHistory).where(eq(leadStatusHistory.firmId, firmId)),
    db.select({
      firmId: leadQualifications.firmId,
      leadId: leadQualifications.leadId,
      status: leadQualifications.status,
      actor: leadQualifications.actor,
    }).from(leadQualifications).where(eq(leadQualifications.firmId, firmId)),
  ])

  const policy = policyRows[0] ?? null
  const profile = profileCheck(firmRow)
  const domain = domainCheck(firmRow, domains)
  const naver = naverCheck(firmRow, credentials, accounts)
  const budget = policyCheck(policy)
  const cases = caseCheck(firmId, caseRows, assetRows, policy, approvalRows)
  const surfaces = liveSurfacesCheck(assetRows, publicationRows, normalizeHost(firmRow.domain))
  const lead = canonicalLeadSummary(firmId, leadRows, sessionRows, caseRows, assetRows, publicationRows, executionRows)
  const outcome = customerOutcomeCheck(firmId, leadRows, historyRows, qualificationRows)
  const checks = [profile, domain, naver, budget, cases.check, surfaces, lead.check, outcome]
  const checksByKey = Object.fromEntries(checks.map((item) => [item.key, item])) as Record<ActivationCheckKey, ActivationCheck>
  const complete = checks.every((item) => !item.required || item.status === 'ready')
  const status: ActivationStatus = complete
    ? 'ready'
    : checks.some((item) => item.status === 'blocked')
      ? 'blocked'
      : 'pending'

  return {
    firmId,
    firmName: firmRow.name,
    status,
    complete,
    checks,
    checksByKey,
    approvedCases: cases.summary,
    leads: lead.summary,
    evidenceSource: 'database',
  }
}

// Explicit aliases make the read model convenient for route and operator callers.
export const calculateFirmActivation = getFirmActivationChecklist
export const evaluateFirmActivation = getFirmActivationChecklist
