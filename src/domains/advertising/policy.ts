/**
 * Pure customer-approved policy and pacing rules for Naver Search Ads.
 *
 * This module deliberately has no database, network, or Naver-client
 * dependency.  A caller can use the result to build a dry-run plan, but the
 * result never performs an ad operation.  Missing approval bounds fail
 * closed for spend-causing actions.
 */

export const NAVER_AD_ACTIONS = [
  'register',
  'activate',
  'pause',
  'decrease_bid',
  'increase_bid',
  'recommend_pause',
] as const

export type NaverAdAction = (typeof NAVER_AD_ACTIONS)[number]

export const SPEND_CAUSING_NAVER_AD_ACTIONS = [
  'register',
  'activate',
  'increase_bid',
] as const

export type SpendCausingNaverAdAction =
  (typeof SPEND_CAUSING_NAVER_AD_ACTIONS)[number]

export type NaverAdReviewStatus =
  | 'not_submitted'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'unknown'

export type NaverAdPerformanceStatus =
  | 'healthy'
  | 'poor'
  | 'insufficient_data'
  | 'unknown'

export interface NaverAdPerformanceThresholds {
  /** CTR is a fraction (0.01 = 1%). Percent values are accepted as input. */
  readonly minCtr?: number
  readonly minClicks?: number
  readonly minConversions?: number
  readonly maxCpc?: number
  readonly maxCpa?: number
}

/** The canonical, normalized customer policy shape. */
export interface NaverAdPolicy {
  readonly monthlyCeiling: number | null
  readonly dailyCeiling: number | null
  readonly bidCeiling: number | null
  readonly allowedCaseIds: readonly string[]
  readonly allowedActions: readonly NaverAdAction[]
  /** Safe default is true.  Only an explicit false can enable execution. */
  readonly dryRun: boolean
  readonly performance?: NaverAdPerformanceThresholds
}

/**
 * Input accepts both the domain names and the existing schema names.  The
 * aliases are useful while the target domain is introduced beside legacy
 * ad tables; they do not weaken the fail-closed behavior.
 */
export interface NaverAdPolicyInput {
  readonly monthlyCeiling?: number | null
  readonly dailyCeiling?: number | null
  readonly bidCeiling?: number | null
  readonly monthlyBudget?: number | null
  readonly dailyBudget?: number | null
  readonly bidLimit?: number | null
  readonly allowedCaseIds?: readonly string[] | null
  readonly allowedCaseEntityIds?: readonly string[] | null
  readonly allowedActions?: readonly string[] | null
  readonly dryRun?: boolean
  readonly mode?: 'dry-run' | 'live'
  /** If present, false is a hard denial even when bounds are otherwise valid. */
  readonly customerApproved?: boolean
  readonly approved?: boolean
  readonly performance?: NaverAdPerformanceThresholds
  /** Flat threshold aliases keep policy construction concise for callers. */
  readonly minCtr?: number
  readonly minClicks?: number
  readonly minConversions?: number
  readonly maxCpc?: number
  readonly maxCpa?: number
}

export type NaverAdPolicyReasonCode =
  | 'policy_not_approved'
  | 'missing_monthly_ceiling'
  | 'invalid_monthly_ceiling'
  | 'missing_daily_ceiling'
  | 'invalid_daily_ceiling'
  | 'missing_bid_ceiling'
  | 'invalid_bid_ceiling'
  | 'daily_ceiling_exceeds_monthly'
  | 'no_allowed_cases'
  | 'invalid_allowed_cases'
  | 'no_allowed_actions'
  | 'invalid_allowed_actions'
  | 'unknown_policy_action'
  | 'unsupported_action'
  | 'action_not_allowed'
  | 'case_id_missing'
  | 'case_not_allowed'
  | 'missing_monthly_spend'
  | 'invalid_monthly_spend'
  | 'monthly_ceiling_exceeded'
  | 'missing_daily_spend'
  | 'invalid_daily_spend'
  | 'daily_ceiling_exceeded'
  | 'invalid_additional_spend'
  | 'projected_monthly_ceiling_exceeded'
  | 'projected_daily_ceiling_exceeded'
  | 'missing_requested_bid'
  | 'invalid_requested_bid'
  | 'bid_ceiling_exceeded'
  | 'current_bid_missing'
  | 'current_bid_invalid'
  | 'current_bid_above_ceiling'
  | 'bid_not_increased'
  | 'bid_not_decreased'
  | 'missing_requested_monthly_budget'
  | 'invalid_requested_monthly_budget'
  | 'requested_monthly_budget_exceeded'
  | 'missing_requested_daily_budget'
  | 'invalid_requested_daily_budget'
  | 'requested_daily_budget_exceeded'
  | 'dry_run'

export interface NormalizedNaverAdPolicy extends NaverAdPolicy {
  readonly validationErrors: readonly NaverAdPolicyReasonCode[]
  readonly performanceErrors: readonly string[]
}

export interface NaverAdActionRequest {
  readonly action: string
  readonly caseId?: string | null
  /** `caseEntityId` is accepted as an explicit-domain alias. */
  readonly caseEntityId?: string | null
  readonly currentBid?: number | null
  readonly requestedBid?: number | null
  readonly bid?: number | null
  readonly bidAmount?: number | null
  readonly monthlySpend?: number | null
  readonly currentMonthlySpend?: number | null
  readonly spendThisMonth?: number | null
  readonly dailySpend?: number | null
  readonly currentDailySpend?: number | null
  readonly spendToday?: number | null
  readonly additionalSpend?: number | null
  readonly incrementalSpend?: number | null
  readonly expectedSpend?: number | null
  readonly requestedMonthlyBudget?: number | null
  readonly monthlyBudget?: number | null
  readonly requestedDailyBudget?: number | null
  readonly dailyBudget?: number | null
}

export type NaverAdActionDecisionKind = 'allow' | 'dry_run' | 'deny'

export interface NaverAdActionDecision {
  readonly action: NaverAdAction | null
  readonly caseId: string | null
  readonly spendCausing: boolean
  /** Bounds/action/case checks passed; dry-run does not make this false. */
  readonly approved: boolean
  readonly policyApproved: boolean
  /** True only when an external caller may execute the requested action. */
  readonly allowed: boolean
  readonly executable: boolean
  readonly wouldExecute: boolean
  readonly dryRun: boolean
  readonly decision: NaverAdActionDecisionKind
  readonly reasonCodes: readonly NaverAdPolicyReasonCode[]
  readonly reasons: readonly string[]
}

export interface NaverAdPerformanceInput extends NaverAdPerformanceThresholds {
  readonly status?: NaverAdPerformanceStatus | string | null
  readonly impressions?: number | null
  readonly clicks?: number | null
  readonly conversions?: number | null
  readonly cost?: number | null
  readonly cpc?: number | null
  readonly cpa?: number | null
  readonly ctr?: number | null
}

export interface NaverAdPacingInput {
  readonly caseId?: string | null
  readonly caseEntityId?: string | null
  readonly reviewStatus?: NaverAdReviewStatus | string | null
  readonly monthlySpend?: number | null
  readonly currentMonthlySpend?: number | null
  readonly spendThisMonth?: number | null
  readonly dailySpend?: number | null
  readonly currentDailySpend?: number | null
  readonly spendToday?: number | null
  readonly additionalSpend?: number | null
  readonly incrementalSpend?: number | null
  readonly expectedSpend?: number | null
  readonly performance?: NaverAdPerformanceInput | null
  readonly performanceStatus?: NaverAdPerformanceStatus | string | null
  readonly ctr?: number | null
  readonly clicks?: number | null
  readonly conversions?: number | null
  readonly cost?: number | null
  readonly cpc?: number | null
  readonly cpa?: number | null
}

export type NaverAdPacingDecisionKind =
  | 'pause'
  | 'recommend_pause'
  | 'hold'
  | 'continue'

export type NaverAdPacingReasonCode =
  | NaverAdPolicyReasonCode
  | 'review_rejected'
  | 'review_pending'
  | 'review_not_submitted'
  | 'review_unknown'
  | 'performance_poor'
  | 'performance_insufficient_data'
  | 'performance_unknown'
  | 'invalid_performance'
  | 'performance_ctr_below_minimum'
  | 'performance_clicks_below_minimum'
  | 'performance_conversions_below_minimum'
  | 'performance_cpc_above_maximum'
  | 'performance_cpa_above_maximum'

export interface NaverAdPacingDecision {
  readonly caseId: string | null
  readonly decision: NaverAdPacingDecisionKind
  /** Alias suitable for consumers that call every non-continue result a recommendation. */
  readonly recommendation: NaverAdPacingDecisionKind
  readonly shouldPause: boolean
  readonly shouldRecommendPause: boolean
  readonly performanceStatus: NaverAdPerformanceStatus
  readonly reviewStatus: NaverAdReviewStatus
  readonly reasonCodes: readonly NaverAdPacingReasonCode[]
  readonly reasons: readonly string[]
  /** No mutation is performed; this only reports whether policy permits a pause. */
  readonly pauseAuthorization: NaverAdActionDecision
  readonly pauseExecutable: boolean
}

const ACTION_ALIASES: Readonly<Record<string, NaverAdAction>> = {
  register: 'register',
  registration: 'register',
  register_ad: 'register',
  submit: 'register',
  activate: 'activate',
  activation: 'activate',
  activate_ad: 'activate',
  enable: 'activate',
  pause: 'pause',
  stop: 'pause',
  deactivate: 'pause',
  decrease_bid: 'decrease_bid',
  bid_decrease: 'decrease_bid',
  lower_bid: 'decrease_bid',
  increase_bid: 'increase_bid',
  bid_increase: 'increase_bid',
  raise_bid: 'increase_bid',
  raise: 'increase_bid',
  recommend_pause: 'recommend_pause',
  pause_recommendation: 'recommend_pause',
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  policy_not_approved: 'customer approval is not present',
  missing_monthly_ceiling: 'monthly ceiling is required',
  invalid_monthly_ceiling: 'monthly ceiling is invalid',
  missing_daily_ceiling: 'daily ceiling is required',
  invalid_daily_ceiling: 'daily ceiling is invalid',
  missing_bid_ceiling: 'bid ceiling is required',
  invalid_bid_ceiling: 'bid ceiling is invalid',
  daily_ceiling_exceeds_monthly: 'daily ceiling exceeds monthly ceiling',
  no_allowed_cases: 'no case IDs are approved',
  invalid_allowed_cases: 'allowed case IDs are invalid',
  no_allowed_actions: 'no actions are approved',
  invalid_allowed_actions: 'allowed actions are invalid',
  unknown_policy_action: 'policy contains an unknown action',
  unsupported_action: 'action is not supported',
  action_not_allowed: 'action is not approved',
  case_id_missing: 'case ID is required',
  case_not_allowed: 'case ID is not approved',
  missing_monthly_spend: 'monthly spend is unknown',
  invalid_monthly_spend: 'monthly spend is invalid',
  monthly_ceiling_exceeded: 'monthly ceiling is reached or exceeded',
  missing_daily_spend: 'daily spend is unknown',
  invalid_daily_spend: 'daily spend is invalid',
  daily_ceiling_exceeded: 'daily ceiling is reached or exceeded',
  invalid_additional_spend: 'additional spend is invalid',
  projected_monthly_ceiling_exceeded: 'projected monthly spend exceeds the ceiling',
  projected_daily_ceiling_exceeded: 'projected daily spend exceeds the ceiling',
  missing_requested_bid: 'requested bid is required',
  invalid_requested_bid: 'requested bid is invalid',
  bid_ceiling_exceeded: 'requested bid exceeds the ceiling',
  current_bid_missing: 'current bid is required',
  current_bid_invalid: 'current bid is invalid',
  current_bid_above_ceiling: 'current bid already exceeds the ceiling',
  bid_not_increased: 'requested bid is not an increase',
  bid_not_decreased: 'requested bid is not a decrease',
  missing_requested_monthly_budget: 'requested monthly budget is required',
  invalid_requested_monthly_budget: 'requested monthly budget is invalid',
  requested_monthly_budget_exceeded: 'requested monthly budget exceeds the ceiling',
  missing_requested_daily_budget: 'requested daily budget is required',
  invalid_requested_daily_budget: 'requested daily budget is invalid',
  requested_daily_budget_exceeded: 'requested daily budget exceeds the ceiling',
  dry_run: 'dry-run is enabled; no external action is executable',
  review_rejected: 'review is rejected',
  review_pending: 'review is pending',
  review_not_submitted: 'review has not been submitted',
  review_unknown: 'review status is unknown',
  performance_poor: 'performance is below the approved threshold',
  performance_insufficient_data: 'performance data is insufficient',
  performance_unknown: 'performance status is unknown',
  invalid_performance: 'performance data is invalid',
  performance_ctr_below_minimum: 'CTR is below the approved minimum',
  performance_clicks_below_minimum: 'clicks are below the approved minimum',
  performance_conversions_below_minimum: 'conversions are below the approved minimum',
  performance_cpc_above_maximum: 'CPC exceeds the approved maximum',
  performance_cpa_above_maximum: 'CPA exceeds the approved maximum',
}

const CEILING_REASON_CODES: ReadonlySet<NaverAdPolicyReasonCode> = new Set([
  'missing_monthly_ceiling',
  'invalid_monthly_ceiling',
  'missing_daily_ceiling',
  'invalid_daily_ceiling',
  'missing_bid_ceiling',
  'invalid_bid_ceiling',
  'daily_ceiling_exceeds_monthly',
])

const SPEND_CAUSING_ACTION_SET: ReadonlySet<NaverAdAction> = new Set(
  SPEND_CAUSING_NAVER_AD_ACTIONS,
)

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function firstDefined<T>(...values: readonly (T | null | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== null && value !== undefined)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function normalizeCeiling(
  value: number | null | undefined,
  missing: NaverAdPolicyReasonCode,
  invalid: NaverAdPolicyReasonCode,
  errors: NaverAdPolicyReasonCode[],
): number | null {
  if (value === null || value === undefined) {
    errors.push(missing)
    return null
  }
  if (!isNonNegativeInteger(value)) {
    errors.push(invalid)
    return null
  }
  return value
}

function normalizeAction(value: string): NaverAdAction | null {
  const key = value.trim().toLocaleLowerCase('en-US')
  return ACTION_ALIASES[key] ?? null
}

export function normalizeNaverAdAction(value: string): NaverAdAction | null {
  return typeof value === 'string' ? normalizeAction(value) : null
}

/** Normalize a policy without ever turning an omitted bound into unlimited spend. */
export function normalizeNaverAdPolicy(
  input: NaverAdPolicyInput = {},
): NormalizedNaverAdPolicy {
  const validationErrors: NaverAdPolicyReasonCode[] = []
  const monthlyCeiling = normalizeCeiling(
    firstDefined(input.monthlyCeiling, input.monthlyBudget),
    'missing_monthly_ceiling',
    'invalid_monthly_ceiling',
    validationErrors,
  )
  const dailyCeiling = normalizeCeiling(
    firstDefined(input.dailyCeiling, input.dailyBudget),
    'missing_daily_ceiling',
    'invalid_daily_ceiling',
    validationErrors,
  )
  const bidCeiling = normalizeCeiling(
    firstDefined(input.bidCeiling, input.bidLimit),
    'missing_bid_ceiling',
    'invalid_bid_ceiling',
    validationErrors,
  )

  if (monthlyCeiling !== null && dailyCeiling !== null && dailyCeiling > monthlyCeiling) {
    validationErrors.push('daily_ceiling_exceeds_monthly')
  }

  const rawCaseIds = firstDefined(input.allowedCaseIds, input.allowedCaseEntityIds)
  if (rawCaseIds !== undefined && !Array.isArray(rawCaseIds)) {
    validationErrors.push('invalid_allowed_cases')
  }
  const allowedCaseIds = Array.isArray(rawCaseIds)
    ? unique(rawCaseIds.filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim()).filter(Boolean))
    : []
  if (allowedCaseIds.length === 0) validationErrors.push('no_allowed_cases')
  if (Array.isArray(rawCaseIds) && rawCaseIds.some((value) => typeof value !== 'string')) {
    validationErrors.push('invalid_allowed_cases')
  }

  const rawActions = input.allowedActions
  if (rawActions !== undefined && rawActions !== null && !Array.isArray(rawActions)) {
    validationErrors.push('invalid_allowed_actions')
  }
  const allowedActions: NaverAdAction[] = []
  if (Array.isArray(rawActions)) {
    for (const value of rawActions) {
      if (typeof value !== 'string') {
        validationErrors.push('invalid_allowed_actions')
        continue
      }
      const action = normalizeAction(value)
      if (!action) {
        validationErrors.push('unknown_policy_action')
        continue
      }
      allowedActions.push(action)
    }
  }
  if (allowedActions.length === 0) validationErrors.push('no_allowed_actions')

  if (input.customerApproved === false || input.approved === false) {
    validationErrors.push('policy_not_approved')
  }

  const performanceErrors: string[] = []
  const flatPerformance: NaverAdPerformanceThresholds = {
    minCtr: input.minCtr,
    minClicks: input.minClicks,
    minConversions: input.minConversions,
    maxCpc: input.maxCpc,
    maxCpa: input.maxCpa,
  }
  const hasFlatPerformance = Object.values(flatPerformance).some((value) => value !== undefined)
  const performance = input.performance ?? (hasFlatPerformance ? flatPerformance : undefined)
  if (performance) {
    const numericThresholds: readonly (keyof NaverAdPerformanceThresholds)[] = [
      'minCtr', 'minClicks', 'minConversions', 'maxCpc', 'maxCpa',
    ]
    for (const key of numericThresholds) {
      const value = performance[key]
      if (value !== undefined && !isNonNegativeNumber(value)) {
        performanceErrors.push(`invalid_${key}`)
      }
    }
  }

  const dryRun = input.dryRun === true
    || input.mode === 'dry-run'
    || (input.mode !== 'live' && input.dryRun !== false)
  return {
    monthlyCeiling,
    dailyCeiling,
    bidCeiling,
    allowedCaseIds,
    allowedActions: unique(allowedActions),
    dryRun,
    performance,
    validationErrors: unique(validationErrors),
    performanceErrors: unique(performanceErrors),
  }
}

export function validateNaverAdPolicy(input: NaverAdPolicyInput = {}): readonly NaverAdPolicyReasonCode[] {
  return normalizeNaverAdPolicy(input).validationErrors
}

export function isNaverAdCaseAllowed(
  policy: NaverAdPolicyInput,
  caseId: string | null | undefined,
): boolean {
  const normalized = normalizeNaverAdPolicy(policy)
  return typeof caseId === 'string' && caseId.trim().length > 0
    && normalized.allowedCaseIds.includes(caseId.trim())
}

export const isCaseAllowed = isNaverAdCaseAllowed

export function isNaverAdActionAllowed(
  policy: NaverAdPolicyInput,
  action: string,
  caseId?: string | null,
): boolean {
  const normalized = normalizeNaverAdPolicy(policy)
  const canonicalAction = normalizeAction(action)
  const spendCausing = canonicalAction !== null && SPEND_CAUSING_ACTION_SET.has(canonicalAction)
  const globalErrors = normalized.validationErrors.filter((code) => (
    spendCausing || !CEILING_REASON_CODES.has(code)
  ))
  if (globalErrors.length > 0 || !canonicalAction) return false
  if (!normalized.allowedActions.includes(canonicalAction)) return false
  return caseId === undefined ? true : isNaverAdCaseAllowed(policy, caseId)
}

export const isActionAllowed = isNaverAdActionAllowed

function requestCaseId(request: NaverAdActionRequest): string | null {
  const value = firstDefined(request.caseId, request.caseEntityId)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requestNumber(
  ...values: readonly (number | null | undefined)[]
): number | undefined {
  return firstDefined(...values)
}

function addReason<T extends string>(reasons: T[], code: T): void {
  if (!reasons.includes(code)) reasons.push(code)
}

function addNumberCheck<T extends string>(
  reasons: T[],
  value: number | undefined,
  missing: T,
  invalid: T,
): value is number {
  if (value === undefined) {
    addReason(reasons, missing)
    return false
  }
  if (!isNonNegativeNumber(value)) {
    addReason(reasons, invalid)
    return false
  }
  return true
}

function actionPolicyErrors(
  policy: NormalizedNaverAdPolicy,
  spendCausing: boolean,
): NaverAdPolicyReasonCode[] {
  return policy.validationErrors.filter((code) => spendCausing || !CEILING_REASON_CODES.has(code))
}

/**
 * Check one action against customer scope and spend bounds.
 *
 * `approved` means the requested action is inside the customer policy.  The
 * separate `allowed`/`executable` fields additionally require `dryRun=false`.
 * This distinction lets a caller display a useful dry-run plan without
 * accidentally treating it as authorization to spend.
 */
export function evaluateNaverAdAction(
  policyInput: NaverAdPolicyInput,
  request: NaverAdActionRequest,
): NaverAdActionDecision
export function evaluateNaverAdAction(
  request: NaverAdActionRequest,
  policyInput: NaverAdPolicyInput,
): NaverAdActionDecision
export function evaluateNaverAdAction(
  first: NaverAdPolicyInput | NaverAdActionRequest,
  second: NaverAdActionRequest | NaverAdPolicyInput,
): NaverAdActionDecision {
  const firstLooksLikeRequest = 'action' in first
  const request = (firstLooksLikeRequest ? first : second) as NaverAdActionRequest
  const policyInput = (firstLooksLikeRequest ? second : first) as NaverAdPolicyInput
  const policy = normalizeNaverAdPolicy(policyInput)
  const canonicalAction = typeof request.action === 'string' ? normalizeAction(request.action) : null
  const caseId = requestCaseId(request)
  const spendCausing = canonicalAction !== null && SPEND_CAUSING_ACTION_SET.has(canonicalAction)
  const reasonCodes = actionPolicyErrors(policy, spendCausing)

  if (!canonicalAction) addReason(reasonCodes, 'unsupported_action')
  else if (!policy.allowedActions.includes(canonicalAction)) addReason(reasonCodes, 'action_not_allowed')

  if (!caseId) addReason(reasonCodes, 'case_id_missing')
  else if (!policy.allowedCaseIds.includes(caseId)) addReason(reasonCodes, 'case_not_allowed')

  const currentBid = requestNumber(request.currentBid)
  const requestedBid = requestNumber(request.requestedBid, request.bid, request.bidAmount)

  if (spendCausing) {
    const monthlySpend = requestNumber(
      request.monthlySpend, request.currentMonthlySpend, request.spendThisMonth,
    )
    const dailySpend = requestNumber(
      request.dailySpend, request.currentDailySpend, request.spendToday,
    )
    const requestedMonthlyBudget = requestNumber(
      request.requestedMonthlyBudget, request.monthlyBudget,
    )
    const requestedDailyBudget = requestNumber(
      request.requestedDailyBudget, request.dailyBudget,
    )
    const suppliedAdditionalSpend = requestNumber(
      request.additionalSpend, request.incrementalSpend, request.expectedSpend,
    )
    // A registration/activation can spend up to its first-day budget even
    // when the caller did not provide a separate projection.  Use that
    // budget as the conservative projection; an explicit projection wins.
    const additionalSpend = suppliedAdditionalSpend
      ?? ((canonicalAction === 'register' || canonicalAction === 'activate')
        ? requestedDailyBudget ?? 0
        : 0)

    const hasMonthlySpend = addNumberCheck(
      reasonCodes, monthlySpend, 'missing_monthly_spend', 'invalid_monthly_spend',
    )
    const hasDailySpend = addNumberCheck(
      reasonCodes, dailySpend, 'missing_daily_spend', 'invalid_daily_spend',
    )
    if (!isNonNegativeNumber(additionalSpend)) {
      addReason(reasonCodes, 'invalid_additional_spend')
    }
    if (hasMonthlySpend && policy.monthlyCeiling !== null) {
      if (monthlySpend >= policy.monthlyCeiling) addReason(reasonCodes, 'monthly_ceiling_exceeded')
      if (monthlySpend + additionalSpend > policy.monthlyCeiling) {
        addReason(reasonCodes, 'projected_monthly_ceiling_exceeded')
      }
    }
    if (hasDailySpend && policy.dailyCeiling !== null) {
      if (dailySpend >= policy.dailyCeiling) addReason(reasonCodes, 'daily_ceiling_exceeded')
      if (dailySpend + additionalSpend > policy.dailyCeiling) {
        addReason(reasonCodes, 'projected_daily_ceiling_exceeded')
      }
    }

    if (canonicalAction === 'register' || canonicalAction === 'activate') {
      if (requestedMonthlyBudget === undefined) addReason(reasonCodes, 'missing_requested_monthly_budget')
      else if (!isNonNegativeInteger(requestedMonthlyBudget)) addReason(reasonCodes, 'invalid_requested_monthly_budget')
      else if (policy.monthlyCeiling !== null && requestedMonthlyBudget > policy.monthlyCeiling) {
        addReason(reasonCodes, 'requested_monthly_budget_exceeded')
      }
      if (requestedDailyBudget === undefined) addReason(reasonCodes, 'missing_requested_daily_budget')
      else if (!isNonNegativeInteger(requestedDailyBudget)) addReason(reasonCodes, 'invalid_requested_daily_budget')
      else if (policy.dailyCeiling !== null && requestedDailyBudget > policy.dailyCeiling) {
        addReason(reasonCodes, 'requested_daily_budget_exceeded')
      }
    }

    if (requestedBid === undefined) addReason(reasonCodes, 'missing_requested_bid')
    else if (!isNonNegativeInteger(requestedBid) || requestedBid <= 0) addReason(reasonCodes, 'invalid_requested_bid')
    else if (policy.bidCeiling !== null && requestedBid > policy.bidCeiling) addReason(reasonCodes, 'bid_ceiling_exceeded')

    if (canonicalAction === 'increase_bid') {
      if (currentBid === undefined) addReason(reasonCodes, 'current_bid_missing')
      else if (!isNonNegativeInteger(currentBid) || currentBid <= 0) addReason(reasonCodes, 'current_bid_invalid')
      else {
        if (policy.bidCeiling !== null && currentBid > policy.bidCeiling) addReason(reasonCodes, 'current_bid_above_ceiling')
        if (requestedBid !== undefined && requestedBid <= currentBid) addReason(reasonCodes, 'bid_not_increased')
      }
    }
  } else if (canonicalAction === 'decrease_bid') {
    if (currentBid === undefined) addReason(reasonCodes, 'current_bid_missing')
    else if (!isNonNegativeInteger(currentBid) || currentBid <= 0) addReason(reasonCodes, 'current_bid_invalid')
    if (requestedBid === undefined) addReason(reasonCodes, 'missing_requested_bid')
    else if (!isNonNegativeInteger(requestedBid) || requestedBid <= 0) addReason(reasonCodes, 'invalid_requested_bid')
    else if (currentBid !== undefined && requestedBid >= currentBid) addReason(reasonCodes, 'bid_not_decreased')
  }

  const approved = reasonCodes.length === 0
  const dryRun = policy.dryRun
  const decision: NaverAdActionDecisionKind = !approved ? 'deny' : dryRun ? 'dry_run' : 'allow'
  const executable = approved && !dryRun
  const allReasonCodes = dryRun && approved ? [...reasonCodes, 'dry_run' as const] : reasonCodes
  return {
    action: canonicalAction,
    caseId,
    spendCausing,
    approved,
    policyApproved: approved,
    allowed: executable,
    executable,
    wouldExecute: executable,
    dryRun,
    decision,
    reasonCodes: unique(allReasonCodes),
    reasons: unique(allReasonCodes.map((code) => REASON_TEXT[code] ?? code)),
  }
}

export const authorizeNaverAdAction = evaluateNaverAdAction
export const checkNaverAdAction = evaluateNaverAdAction

export function canExecuteNaverAdAction(
  policy: NaverAdPolicyInput,
  request: NaverAdActionRequest,
): boolean {
  return evaluateNaverAdAction(policy, request).allowed
}

function normalizeReviewStatus(value: string | null | undefined): NaverAdReviewStatus {
  switch (value?.trim().toLocaleLowerCase('en-US')) {
    case 'approved':
    case 'accepted':
    case 'live':
      return 'approved'
    case 'pending':
    case 'under_review':
    case 'reviewing':
      return 'pending'
    case 'not_submitted':
    case 'draft':
      return 'not_submitted'
    case 'rejected':
    case 'denied':
    case 'disapproved':
      return 'rejected'
    default:
      return 'unknown'
  }
}

function normalizePerformanceStatus(value: string | null | undefined): NaverAdPerformanceStatus {
  switch (value?.trim().toLocaleLowerCase('en-US')) {
    case 'healthy':
    case 'good':
    case 'pass':
      return 'healthy'
    case 'poor':
    case 'bad':
    case 'fail':
      return 'poor'
    case 'insufficient_data':
    case 'insufficient':
      return 'insufficient_data'
    default:
      return 'unknown'
  }
}

function fraction(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null
  if (value <= 1) return value
  if (value <= 100) return value / 100
  return null
}

function performanceStatus(
  policy: NormalizedNaverAdPolicy,
  input: NaverAdPacingInput,
): { status: NaverAdPerformanceStatus; reasonCodes: NaverAdPacingReasonCode[] } {
  const performance: NaverAdPerformanceInput = {
    ...(input.performance ?? {}),
    status: input.performance?.status ?? input.performanceStatus,
    ctr: input.performance?.ctr ?? input.ctr,
    clicks: input.performance?.clicks ?? input.clicks,
    conversions: input.performance?.conversions ?? input.conversions,
    cost: input.performance?.cost ?? input.cost,
    cpc: input.performance?.cpc ?? input.cpc,
    cpa: input.performance?.cpa ?? input.cpa,
  }
  const explicit = normalizePerformanceStatus(performance.status)
  if (explicit !== 'unknown') {
    return {
      status: explicit,
      reasonCodes: explicit === 'poor'
        ? ['performance_poor']
        : explicit === 'insufficient_data'
          ? ['performance_insufficient_data']
          : [],
    }
  }

  const thresholds = policy.performance
  if (!thresholds || policy.performanceErrors.length > 0) {
    return {
      status: 'unknown',
      reasonCodes: [policy.performanceErrors.length > 0 ? 'invalid_performance' : 'performance_unknown'],
    }
  }

  const reasons: NaverAdPacingReasonCode[] = []
  const clicks = performance.clicks
  if (thresholds.minClicks !== undefined) {
    if (!isNonNegativeNumber(clicks)) return { status: 'insufficient_data', reasonCodes: ['performance_insufficient_data'] }
    if (clicks < thresholds.minClicks) reasons.push('performance_clicks_below_minimum')
  }
  if (thresholds.minCtr !== undefined) {
    const ctr = performance.ctr === null || performance.ctr === undefined
      ? null
      : fraction(performance.ctr)
    if (ctr === null) return { status: 'insufficient_data', reasonCodes: ['performance_insufficient_data'] }
    if (ctr < (fraction(thresholds.minCtr) ?? Number.POSITIVE_INFINITY)) reasons.push('performance_ctr_below_minimum')
  }
  if (thresholds.minConversions !== undefined) {
    if (!isNonNegativeNumber(performance.conversions)) return { status: 'insufficient_data', reasonCodes: ['performance_insufficient_data'] }
    if (performance.conversions < thresholds.minConversions) reasons.push('performance_conversions_below_minimum')
  }
  const cpc = performance.cpc ?? (
    isNonNegativeNumber(performance.cost) && isNonNegativeNumber(performance.clicks) && performance.clicks > 0
      ? performance.cost / performance.clicks
      : undefined
  )
  if (thresholds.maxCpc !== undefined) {
    if (!isNonNegativeNumber(cpc)) return { status: 'insufficient_data', reasonCodes: ['performance_insufficient_data'] }
    if (cpc > thresholds.maxCpc) reasons.push('performance_cpc_above_maximum')
  }
  const cpa = performance.cpa ?? (
    isNonNegativeNumber(performance.cost) && isNonNegativeNumber(performance.conversions) && performance.conversions > 0
      ? performance.cost / performance.conversions
      : undefined
  )
  if (thresholds.maxCpa !== undefined) {
    if (!isNonNegativeNumber(cpa)) return { status: 'insufficient_data', reasonCodes: ['performance_insufficient_data'] }
    if (cpa > thresholds.maxCpa) reasons.push('performance_cpa_above_maximum')
  }
  if (reasons.length > 0) return { status: 'poor', reasonCodes: ['performance_poor', ...reasons] }
  return { status: 'healthy', reasonCodes: [] }
}

function pacingNumber(
  input: NaverAdPacingInput,
  keys: readonly (keyof NaverAdPacingInput)[],
): number | undefined {
  return firstDefined(...keys.map((key) => input[key] as number | null | undefined))
}

/**
 * Produce a deterministic pacing decision from observed spend, performance,
 * and review status.  `pause` is a safety decision, not a network call.
 */
export function decideNaverAdPacing(
  policyInput: NaverAdPolicyInput,
  input: NaverAdPacingInput,
): NaverAdPacingDecision
export function decideNaverAdPacing(
  input: NaverAdPacingInput,
  policyInput: NaverAdPolicyInput,
): NaverAdPacingDecision
export function decideNaverAdPacing(
  first: NaverAdPolicyInput | NaverAdPacingInput,
  second: NaverAdPacingInput | NaverAdPolicyInput,
): NaverAdPacingDecision {
  const firstLooksLikeInput = !('allowedActions' in first
    || 'allowedCaseIds' in first
    || 'allowedCaseEntityIds' in first
    || 'monthlyCeiling' in first
    || 'monthlyBudget' in first
    || 'dailyCeiling' in first
    || 'dailyBudget' in first
    || 'bidCeiling' in first
    || 'bidLimit' in first)
    && ('caseId' in first
      || 'caseEntityId' in first
      || 'reviewStatus' in first
      || 'monthlySpend' in first
      || 'currentMonthlySpend' in first
      || 'spendThisMonth' in first
      || 'dailySpend' in first
      || 'currentDailySpend' in first
      || 'spendToday' in first
      || 'performanceStatus' in first
      || 'performance' in first)
  const input = (firstLooksLikeInput ? first : second) as NaverAdPacingInput
  const policyInput = (firstLooksLikeInput ? second : first) as NaverAdPolicyInput
  const policy = normalizeNaverAdPolicy(policyInput)
  const caseIdValue = firstDefined(input.caseId, input.caseEntityId)
  const caseId = typeof caseIdValue === 'string' && caseIdValue.trim() ? caseIdValue.trim() : null
  const reasonCodes: NaverAdPacingReasonCode[] = []

  for (const code of policy.validationErrors) addReason(reasonCodes, code)
  if (!caseId) addReason(reasonCodes, 'case_id_missing')
  else if (!policy.allowedCaseIds.includes(caseId)) addReason(reasonCodes, 'case_not_allowed')
  if (policy.monthlyCeiling === null) {
    for (const code of policy.validationErrors) {
      if (code === 'missing_monthly_ceiling' || code === 'invalid_monthly_ceiling') addReason(reasonCodes, code)
    }
  }
  if (policy.dailyCeiling === null) {
    for (const code of policy.validationErrors) {
      if (code === 'missing_daily_ceiling' || code === 'invalid_daily_ceiling') addReason(reasonCodes, code)
    }
  }

  const monthlySpend = pacingNumber(input, ['monthlySpend', 'currentMonthlySpend', 'spendThisMonth'])
  const dailySpend = pacingNumber(input, ['dailySpend', 'currentDailySpend', 'spendToday'])
  const additionalSpend = pacingNumber(input, ['additionalSpend', 'incrementalSpend', 'expectedSpend']) ?? 0
  const monthlyKnown = addNumberCheck(reasonCodes, monthlySpend, 'missing_monthly_spend', 'invalid_monthly_spend')
  const dailyKnown = addNumberCheck(reasonCodes, dailySpend, 'missing_daily_spend', 'invalid_daily_spend')
  if (!isNonNegativeNumber(additionalSpend)) addReason(reasonCodes, 'invalid_additional_spend')
  if (monthlyKnown && policy.monthlyCeiling !== null) {
    if (monthlySpend >= policy.monthlyCeiling) addReason(reasonCodes, 'monthly_ceiling_exceeded')
    if (monthlySpend + additionalSpend > policy.monthlyCeiling) addReason(reasonCodes, 'projected_monthly_ceiling_exceeded')
  }
  if (dailyKnown && policy.dailyCeiling !== null) {
    if (dailySpend >= policy.dailyCeiling) addReason(reasonCodes, 'daily_ceiling_exceeded')
    if (dailySpend + additionalSpend > policy.dailyCeiling) addReason(reasonCodes, 'projected_daily_ceiling_exceeded')
  }

  const reviewStatus = normalizeReviewStatus(input.reviewStatus)
  if (reviewStatus === 'rejected') addReason(reasonCodes, 'review_rejected')
  else if (reviewStatus === 'pending') addReason(reasonCodes, 'review_pending')
  else if (reviewStatus === 'not_submitted') addReason(reasonCodes, 'review_not_submitted')
  else if (reviewStatus === 'unknown') addReason(reasonCodes, 'review_unknown')

  const performance = performanceStatus(policy, input)
  for (const code of performance.reasonCodes) addReason(reasonCodes, code)

  const hardPauseReasons = new Set<NaverAdPacingReasonCode>([
    'policy_not_approved',
    'missing_bid_ceiling',
    'invalid_bid_ceiling',
    'daily_ceiling_exceeds_monthly',
    'no_allowed_cases',
    'invalid_allowed_cases',
    'no_allowed_actions',
    'invalid_allowed_actions',
    'unknown_policy_action',
    'case_id_missing',
    'case_not_allowed',
    'missing_monthly_ceiling',
    'invalid_monthly_ceiling',
    'missing_daily_ceiling',
    'invalid_daily_ceiling',
    'missing_monthly_spend',
    'invalid_monthly_spend',
    'monthly_ceiling_exceeded',
    'projected_monthly_ceiling_exceeded',
    'missing_daily_spend',
    'invalid_daily_spend',
    'daily_ceiling_exceeded',
    'projected_daily_ceiling_exceeded',
    'invalid_additional_spend',
    'review_rejected',
  ])
  const hasHardPause = reasonCodes.some((code) => hardPauseReasons.has(code))
  const hasSoftPauseRecommendation = reasonCodes.some((code) => [
    'review_pending',
    'review_not_submitted',
    'performance_poor',
    'performance_ctr_below_minimum',
    'performance_clicks_below_minimum',
    'performance_conversions_below_minimum',
    'performance_cpc_above_maximum',
    'performance_cpa_above_maximum',
  ].includes(code))
  const hasHoldReason = reasonCodes.some((code) => [
    'review_unknown',
    'performance_unknown',
    'performance_insufficient_data',
    'invalid_performance',
  ].includes(code))
  const decision: NaverAdPacingDecisionKind = hasHardPause
    ? 'pause'
    : hasSoftPauseRecommendation
      ? 'recommend_pause'
      : hasHoldReason
        ? 'hold'
        : 'continue'

  const pauseAuthorization = evaluateNaverAdAction(policyInput, {
    action: 'pause',
    caseId,
  })
  const allReasonCodes = unique(reasonCodes)
  return {
    caseId,
    decision,
    recommendation: decision,
    shouldPause: decision === 'pause',
    shouldRecommendPause: decision === 'recommend_pause',
    performanceStatus: performance.status,
    reviewStatus,
    reasonCodes: allReasonCodes,
    reasons: unique(allReasonCodes.map((code) => REASON_TEXT[code] ?? code)),
    pauseAuthorization,
    pauseExecutable: decision === 'pause' && pauseAuthorization.allowed,
  }
}

export const evaluateNaverAdPacing = decideNaverAdPacing
export const determineNaverAdPacing = decideNaverAdPacing
export const decideBudgetPacing = decideNaverAdPacing
export const evaluateBudgetPacing = decideNaverAdPacing
