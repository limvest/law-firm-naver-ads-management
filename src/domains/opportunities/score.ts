import type {
  OpportunityContextSnapshot,
  OpportunityFactorKey,
  OpportunityFactorSnapshot,
  OpportunityFirmContext,
  OpportunityGlobalContext,
  OpportunityMetricStatus,
  OpportunityRecommendation,
  OpportunityReasonSnapshot,
  OpportunityScoreInput,
  OpportunityScoreResult,
} from './types'

/** Weights are points out of the final 100-point score. */
export const OPPORTUNITY_SCORE_WEIGHTS = {
  confidence: 18,
  sourceIndependence: 14,
  recencyVelocity: 14,
  searchDemand: 10,
  competition: 8,
  cpc: 8,
  reviewProbability: 8,
  qualifiedConsultationRate: 8,
  retainedRate: 6,
  preference: 3,
  capacity: 3,
} as const

export const OPPORTUNITY_SCORE_THRESHOLDS = {
  publish: 75,
  watch: 50,
  block: 25,
  reviewBlock: 0.25,
  holdCapacity: 0.2,
  holdPreference: 0.2,
} as const

const GLOBAL_KEYS: readonly OpportunityFactorKey[] = [
  'confidence',
  'sourceIndependence',
  'recencyVelocity',
  'searchDemand',
  'competition',
  'cpc',
  'reviewProbability',
]

const FIRM_KEYS: readonly OpportunityFactorKey[] = [
  'qualifiedConsultationRate',
  'retainedRate',
  'preference',
  'capacity',
]

const GLOBAL_WEIGHT = GLOBAL_KEYS.reduce((sum, key) => sum + OPPORTUNITY_SCORE_WEIGHTS[key], 0)
const FIRM_WEIGHT = FIRM_KEYS.reduce((sum, key) => sum + OPPORTUNITY_SCORE_WEIGHTS[key], 0)
const TOTAL_WEIGHT = GLOBAL_WEIGHT + FIRM_WEIGHT
const SEARCH_DEMAND_REFERENCE = 10_000
const CPC_REFERENCE = 50_000
const RECENCY_HALF_LIFE_DAYS = 90

const LABELS: Record<OpportunityFactorKey, string> = {
  confidence: 'confidence',
  sourceIndependence: 'source independence',
  recencyVelocity: 'recency / velocity',
  searchDemand: 'search demand',
  competition: 'competition',
  cpc: 'CPC',
  reviewProbability: 'review probability',
  qualifiedConsultationRate: 'qualified consultation rate',
  retainedRate: 'retained rate',
  preference: 'firm preference',
  capacity: 'firm capacity',
}

type Metric = {
  value: number
  rawValue: number | null
  status: OpportunityMetricStatus
}

type RecencyMetric = Metric & { detail: string }

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const result = finite(value)
    if (result !== null) return result
  }
  return null
}

function percentMetric(raw: unknown): Metric {
  const value = finite(raw)
  if (value === null) return { value: 0, rawValue: null, status: 'missing' }
  if (value > 1) return { value: clamp01(value / 100), rawValue: value, status: 'derived' }
  return { value: clamp01(value), rawValue: value, status: 'observed' }
}

function directMetric(raw: unknown): Metric {
  const value = finite(raw)
  if (value === null) return { value: 0, rawValue: null, status: 'missing' }
  return { value: clamp01(value), rawValue: value, status: 'observed' }
}

function rawMetric(raw: unknown, reference: number): Metric {
  const value = finite(raw)
  if (value === null) return { value: 0, rawValue: null, status: 'missing' }
  if (value <= 1) return { value: clamp01(value), rawValue: value, status: 'observed' }
  const normalized = Math.log1p(Math.max(0, value)) / Math.log1p(reference)
  return { value: clamp01(normalized), rawValue: value, status: 'derived' }
}

function parseDate(value: string | Date | undefined): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function sourceMetric(global: OpportunityGlobalContext): Metric {
  const direct = firstFinite(global.sourceIndependenceScore, global.sourceIndependence)
  const total = firstFinite(global.sourceCount, global.totalSourceCount)

  if (direct !== null) {
    if (direct >= 0 && direct <= 1) return directMetric(direct)
    if (total !== null && total > 0) {
      return {
        value: clamp01(direct / total),
        rawValue: direct,
        status: 'derived',
      }
    }
    // A count without a denominator still gets diminishing, bounded credit.
    return {
      value: clamp01(1 - Math.exp(-Math.max(0, direct) / 3)),
      rawValue: direct,
      status: 'derived',
    }
  }

  const independent = firstFinite(global.independentSourceCount, global.independentSources)
  if (independent === null) return { value: 0, rawValue: null, status: 'missing' }
  if (total !== null && total > 0) {
    return {
      value: clamp01(independent / total),
      rawValue: independent,
      status: 'derived',
    }
  }
  return {
    value: clamp01(1 - Math.exp(-Math.max(0, independent) / 3)),
    rawValue: independent,
    status: 'derived',
  }
}

function recencyVelocityMetric(
  global: OpportunityGlobalContext,
  input: OpportunityScoreInput,
): RecencyMetric {
  const directRecency = firstFinite(global.recencyScore, global.freshness)
  let recency: Metric
  let recencyDetail: string

  if (directRecency !== null) {
    recency = directMetric(directRecency)
    recencyDetail = `freshness ${formatPercent(recency.value)}`
  } else {
    let days = firstFinite(global.recencyDays)
    let dateStatus: OpportunityMetricStatus = 'missing'

    if (days === null) {
      const observedAt = parseDate(global.observedAt ?? input.observedAt)
      const asOf = parseDate(global.asOf ?? input.asOf)
      if (observedAt !== null && asOf !== null) {
        days = Math.max(0, (asOf - observedAt) / 86_400_000)
        dateStatus = 'derived'
      }
    } else {
      dateStatus = 'observed'
    }

    if (days === null || !Number.isFinite(days)) {
      recency = { value: 0, rawValue: null, status: 'missing' }
      recencyDetail = 'freshness unavailable'
    } else {
      const freshness = Math.exp(-Math.max(0, days) / RECENCY_HALF_LIFE_DAYS)
      recency = { value: clamp01(freshness), rawValue: days, status: dateStatus }
      recencyDetail = `freshness ${formatPercent(recency.value)} (${round(Math.max(0, days), 1)}d)`
    }
  }

  const directVelocity = firstFinite(global.velocityScore)
  const velocityRaw = firstFinite(global.velocity)
  let velocity: Metric
  if (directVelocity !== null) {
    velocity = directMetric(directVelocity)
  } else if (velocityRaw === null) {
    velocity = { value: 0, rawValue: null, status: 'missing' }
  } else if (velocityRaw >= -1 && velocityRaw <= 1) {
    velocity = {
      value: clamp01((velocityRaw + 1) / 2),
      rawValue: velocityRaw,
      status: 'derived',
    }
  } else {
    // Percent-style trend input, retained as a bounded score.
    velocity = {
      value: clamp01((velocityRaw + 100) / 200),
      rawValue: velocityRaw,
      status: 'derived',
    }
  }

  const value = 0.6 * recency.value + 0.4 * velocity.value
  const status: OpportunityMetricStatus =
    recency.status === 'missing' && velocity.status === 'missing'
      ? 'missing'
      : recency.status === 'observed' || velocity.status === 'observed'
        ? 'observed'
        : 'derived'
  const velocityDetail = velocity.status === 'missing'
    ? 'velocity unavailable'
    : `velocity ${formatPercent(velocity.value)}`

  return {
    value,
    rawValue: recency.rawValue ?? velocity.rawValue,
    status,
    detail: `${recencyDetail}; ${velocityDetail}`,
  }
}

function searchDemandMetric(global: OpportunityGlobalContext): Metric {
  const score = firstFinite(global.searchDemandScore)
  if (score !== null) return directMetric(score)
  return rawMetric(
    firstFinite(global.searchDemand, global.monthlySearches, global.searchVolume),
    SEARCH_DEMAND_REFERENCE,
  )
}

function competitionMetric(global: OpportunityGlobalContext): Metric {
  const score = firstFinite(global.competitionScore)
  if (score !== null) return directMetric(score)
  const raw = firstFinite(global.competition, global.competitionRate)
  if (raw === null) return { value: 0, rawValue: null, status: 'missing' }
  const crowding = percentMetric(raw)
  return {
    value: 1 - crowding.value,
    rawValue: raw,
    status: crowding.status,
  }
}

function cpcMetric(global: OpportunityGlobalContext): Metric {
  const score = firstFinite(global.cpcScore)
  if (score !== null) return directMetric(score)
  return rawMetric(firstFinite(global.cpc, global.averageCpc, global.cpcWon), CPC_REFERENCE)
}

function reviewMetric(global: OpportunityGlobalContext): Metric {
  return percentMetric(firstFinite(
    global.reviewProbability,
    global.reviewRate,
    global.approvalProbability,
  ))
}

function firmCapacityMetric(firm: OpportunityFirmContext): Metric {
  const direct = firstFinite(firm.capacityScore)
  if (direct !== null) return directMetric(direct)

  const total = firstFinite(firm.capacityTotal)
  const remaining = firstFinite(firm.capacityRemaining, firm.capacity)
  if (remaining !== null && total !== null && total > 0) {
    return {
      value: clamp01(remaining / total),
      rawValue: remaining,
      status: 'derived',
    }
  }
  return percentMetric(firm.capacity)
}

function firmMetric(...values: unknown[]): Metric {
  return percentMetric(firstFinite(...values))
}

function formatPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`
}

function formatPoints(value: number, weight: number): string {
  return `+${round(value, 2)}/${weight}`
}

function makeFactor(
  key: OpportunityFactorKey,
  context: 'global' | 'firm',
  metric: Metric,
  detail?: string,
): OpportunityFactorSnapshot {
  const weight = OPPORTUNITY_SCORE_WEIGHTS[key]
  const contribution = metric.value * weight
  const valueText = metric.status === 'missing'
    ? 'unavailable'
    : formatPercent(metric.value)
  const suffix = detail ? `; ${detail}` : ''
  const reason = `${LABELS[key]} ${valueText}${suffix} (${formatPoints(contribution, weight)})`

  return {
    key,
    context,
    label: LABELS[key],
    rawValue: metric.rawValue,
    normalizedValue: round(metric.value, 4),
    weight,
    contribution: round(contribution),
    status: metric.status,
    reason,
  }
}

function contextSnapshot(
  factors: OpportunityFactorSnapshot[],
  weight: number,
  provided: boolean,
): OpportunityContextSnapshot {
  const points = factors.reduce((sum, factor) => sum + factor.normalizedValue * factor.weight, 0)
  return {
    provided,
    score: round((points / weight) * 100),
    points: round(points),
    weight,
    factors,
  }
}

function asGlobal(input: OpportunityScoreInput): OpportunityGlobalContext {
  return input.global ?? input.globalContext ?? input
}

function asFirm(
  input: OpportunityScoreInput,
  secondArgument: OpportunityFirmContext | null | undefined,
): OpportunityFirmContext | null {
  if (secondArgument !== undefined) return secondArgument
  return input.firm ?? input.firmContext ?? null
}

function decide(
  score: number,
  globalFactors: OpportunityFactorSnapshot[],
  firmFactors: OpportunityFactorSnapshot[] | null,
  explicitBlock: boolean,
): { recommendation: OpportunityRecommendation; blockers: string[]; holdReasons: string[] } {
  const blockers: string[] = []
  const holdReasons: string[] = []
  const review = globalFactors.find((factor) => factor.key === 'reviewProbability')

  if (explicitBlock) blockers.push('explicit compliance/operator block')
  if (review?.status === 'observed' && review.normalizedValue < OPPORTUNITY_SCORE_THRESHOLDS.reviewBlock) {
    blockers.push(`review probability below ${formatPercent(OPPORTUNITY_SCORE_THRESHOLDS.reviewBlock)}`)
  }
  if (score < OPPORTUNITY_SCORE_THRESHOLDS.block) {
    blockers.push(`score below ${OPPORTUNITY_SCORE_THRESHOLDS.block}`)
  }
  if (blockers.length > 0) return { recommendation: 'block', blockers, holdReasons }

  if (firmFactors !== null) {
    const capacity = firmFactors.find((factor) => factor.key === 'capacity')
    const preference = firmFactors.find((factor) => factor.key === 'preference')
    if (!capacity || capacity.status === 'missing' || capacity.normalizedValue < OPPORTUNITY_SCORE_THRESHOLDS.holdCapacity) {
      holdReasons.push('firm capacity is unavailable or below the operating floor')
    }
    if (!preference || preference.status === 'missing' || preference.normalizedValue < OPPORTUNITY_SCORE_THRESHOLDS.holdPreference) {
      holdReasons.push('firm preference is unavailable or below the fit floor')
    }
  }
  if (review?.status === 'missing') holdReasons.push('review probability is unavailable')

  if (holdReasons.length > 0) return { recommendation: 'hold', blockers, holdReasons }

  const globalComplete = globalFactors.every((factor) => factor.status !== 'missing')
  const firmComplete = firmFactors !== null && firmFactors.every((factor) => factor.status !== 'missing')
  const publishReady =
    score >= OPPORTUNITY_SCORE_THRESHOLDS.publish &&
    firmFactors !== null &&
    globalComplete &&
    firmComplete &&
    (globalFactors.find((factor) => factor.key === 'confidence')?.normalizedValue ?? 0) >= 0.6 &&
    (globalFactors.find((factor) => factor.key === 'sourceIndependence')?.normalizedValue ?? 0) >= 0.5 &&
    (review?.normalizedValue ?? 0) >= 0.7

  if (publishReady) return { recommendation: 'publish', blockers, holdReasons }
  if (score >= OPPORTUNITY_SCORE_THRESHOLDS.watch) return { recommendation: 'watch', blockers, holdReasons }
  return { recommendation: 'hold', blockers, holdReasons }
}

function buildReasonSnapshot(
  score: number,
  recommendation: OpportunityRecommendation,
  global: OpportunityContextSnapshot,
  firm: OpportunityContextSnapshot | null,
  blockers: string[],
  holdReasons: string[],
): OpportunityReasonSnapshot {
  const factors = [...global.factors, ...(firm?.factors ?? [])]
  const strengths = factors
    .filter((factor) => factor.status !== 'missing' && factor.normalizedValue >= 0.65)
    .map((factor) => factor.reason)
  const cautions = factors
    .filter((factor) => factor.status === 'missing' || factor.normalizedValue < 0.5)
    .map((factor) => factor.reason)
  const missing = factors.filter((factor) => factor.status === 'missing').map((factor) => factor.key)
  const all = factors.map((factor) => factor.reason)
  const decisionReasons = [...blockers, ...holdReasons]
  const decisionText = decisionReasons.length > 0 ? ` ${decisionReasons.join('; ')}.` : ''
  const summary = `${recommendation} at ${round(score)}/100.${decisionText}`

  return {
    summary,
    global,
    firm,
    strengths,
    cautions,
    blockers,
    missing,
    all,
  }
}

/**
 * Score one opportunity without side effects.
 *
 * Global signals account for 80 points. When firm context is supplied it
 * contributes the remaining 20 points; without it, `score` is the normalized
 * global score and publishing is intentionally not allowed.
 */
export function scoreOpportunity(
  input: OpportunityScoreInput,
  firmContext?: OpportunityFirmContext | null,
): OpportunityScoreResult {
  const globalInput = asGlobal(input)
  const firmInput = asFirm(input, firmContext)
  const recencyVelocity = recencyVelocityMetric(globalInput, input)

  const globalFactors = [
    makeFactor('confidence', 'global', percentMetric(firstFinite(
      globalInput.confidence,
      globalInput.confidenceScore,
      globalInput.evidenceConfidence,
    ))),
    makeFactor('sourceIndependence', 'global', sourceMetric(globalInput)),
    makeFactor('recencyVelocity', 'global', recencyVelocity, recencyVelocity.detail),
    makeFactor('searchDemand', 'global', searchDemandMetric(globalInput)),
    makeFactor('competition', 'global', competitionMetric(globalInput), 'lower crowding is better'),
    makeFactor('cpc', 'global', cpcMetric(globalInput), 'commercial-intent proxy'),
    makeFactor('reviewProbability', 'global', reviewMetric(globalInput)),
  ]

  const firmFactors = firmInput === null ? null : [
    makeFactor('qualifiedConsultationRate', 'firm', firmMetric(
      firmInput.qualifiedConsultationRate,
      firmInput.qualifiedConsultRate,
    )),
    makeFactor('retainedRate', 'firm', firmMetric(firmInput.retainedRate)),
    makeFactor('preference', 'firm', firmMetric(
      firmInput.preference,
      firmInput.firmPreference,
      firmInput.preferenceScore,
    )),
    makeFactor('capacity', 'firm', firmCapacityMetric(firmInput)),
  ]

  const globalSnapshot = contextSnapshot(globalFactors, GLOBAL_WEIGHT, true)
  const firmSnapshot = firmFactors === null
    ? null
    : contextSnapshot(firmFactors, FIRM_WEIGHT, true)
  const points = globalFactors.reduce((sum, factor) => sum + factor.normalizedValue * factor.weight, 0) +
    (firmFactors?.reduce((sum, factor) => sum + factor.normalizedValue * factor.weight, 0) ?? 0)
  const globalScore = globalSnapshot.score
  const firmScore = firmSnapshot?.score ?? null
  const score = firmSnapshot === null
    ? globalScore
    : round((points / TOTAL_WEIGHT) * 100)
  const explicitBlock = Boolean(input.blocked || globalInput.blocked || globalInput.complianceBlocked)
  const decision = decide(score, globalFactors, firmFactors, explicitBlock)
  const reasonSnapshot = buildReasonSnapshot(
    score,
    decision.recommendation,
    globalSnapshot,
    firmSnapshot,
    decision.blockers,
    decision.holdReasons,
  )

  return {
    score,
    recommendation: decision.recommendation,
    globalScore,
    firmScore,
    reasonSnapshot,
    reasons: reasonSnapshot.all,
  }
}

/** Score global evidence only; useful for catalog-wide ranking. */
export function scoreGlobalContext(context: OpportunityGlobalContext): OpportunityContextSnapshot {
  return scoreOpportunity({ global: context }).reasonSnapshot.global
}

/** Score firm fit only using the same 20-point firm weighting. */
export function scoreFirmContext(context: OpportunityFirmContext): OpportunityContextSnapshot {
  const result = scoreOpportunity({
    global: {
      confidence: 1,
      sourceIndependence: 1,
      recencyScore: 1,
      velocityScore: 1,
      searchDemandScore: 1,
      competitionScore: 1,
      cpcScore: 1,
      reviewProbability: 1,
    },
    firm: context,
  })
  return result.reasonSnapshot.firm!
}

/** Descriptive alias for callers that prefer a calculation verb. */
export const calculateOpportunityScore = scoreOpportunity
