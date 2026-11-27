/**
 * Inputs and outputs for the opportunity scorer.
 *
 * The scorer deliberately keeps these types independent from the database. A
 * caller can pass already-normalized values (0..1), percentages (0..100), or
 * the raw demand/CPC values documented on the individual fields.
 */

export type OpportunityRecommendation = 'publish' | 'watch' | 'hold' | 'block'

export type OpportunityFactorKey =
  | 'confidence'
  | 'sourceIndependence'
  | 'recencyVelocity'
  | 'searchDemand'
  | 'competition'
  | 'cpc'
  | 'reviewProbability'
  | 'qualifiedConsultationRate'
  | 'retainedRate'
  | 'preference'
  | 'capacity'

export type OpportunityContext = 'global' | 'firm'
export type OpportunityMetricStatus = 'observed' | 'derived' | 'missing'

export interface OpportunityGlobalContext {
  /** Evidence confidence. Accepts 0..1 or a percentage in 0..100. */
  confidence?: number
  confidenceScore?: number
  evidenceConfidence?: number

  /** Independent-source share, or independent-source count when > 1. */
  sourceIndependence?: number
  sourceIndependenceScore?: number
  independentSourceCount?: number
  independentSources?: number
  sourceCount?: number
  totalSourceCount?: number

  /** Freshness can be passed directly, or derived from observed/as-of dates. */
  recencyScore?: number
  freshness?: number
  recencyDays?: number
  observedAt?: string | Date
  asOf?: string | Date

  /** Velocity is a trend in -1..1; velocityScore may be supplied in 0..1. */
  velocity?: number
  velocityScore?: number

  /** searchDemand is normalized when <= 1, otherwise monthly search volume. */
  searchDemand?: number
  searchDemandScore?: number
  monthlySearches?: number
  searchVolume?: number

  /** competition is crowding in 0..1 (higher is worse). */
  competition?: number
  competitionRate?: number
  competitionScore?: number

  /** cpc is normalized when <= 1, otherwise a raw currency amount. */
  cpc?: number
  averageCpc?: number
  cpcWon?: number
  cpcScore?: number

  /** Review/approval probability. Accepts 0..1 or a percentage in 0..100. */
  reviewProbability?: number
  reviewRate?: number
  approvalProbability?: number

  /** A compliance or operator block is a hard decision guard. */
  blocked?: boolean
  complianceBlocked?: boolean
}

export interface OpportunityFirmContext {
  /** Qualified consultation and retained-client rates. */
  qualifiedConsultationRate?: number
  qualifiedConsultRate?: number
  retainedRate?: number

  /** Preference/fit and available capacity. */
  preference?: number
  firmPreference?: number
  preferenceScore?: number
  capacity?: number
  capacityScore?: number
  capacityRemaining?: number
  capacityTotal?: number
}

/**
 * `global`/`firm` are the canonical form. Flat global fields are accepted as
 * a convenience for callers that already have a global signal object.
 */
export interface OpportunityScoreInput extends OpportunityGlobalContext {
  global?: OpportunityGlobalContext
  globalContext?: OpportunityGlobalContext
  firm?: OpportunityFirmContext | null
  firmContext?: OpportunityFirmContext | null
  blocked?: boolean
}

export interface OpportunityFactorSnapshot {
  key: OpportunityFactorKey
  context: OpportunityContext
  label: string
  rawValue: number | null
  normalizedValue: number
  weight: number
  contribution: number
  status: OpportunityMetricStatus
  reason: string
}

export interface OpportunityContextSnapshot {
  provided: boolean
  score: number
  points: number
  weight: number
  factors: OpportunityFactorSnapshot[]
}

export interface OpportunityReasonSnapshot {
  summary: string
  global: OpportunityContextSnapshot
  firm: OpportunityContextSnapshot | null
  strengths: string[]
  cautions: string[]
  blockers: string[]
  missing: OpportunityFactorKey[]
  all: string[]
}

export interface OpportunityScoreResult {
  score: number
  recommendation: OpportunityRecommendation
  globalScore: number
  firmScore: number | null
  reasonSnapshot: OpportunityReasonSnapshot
  /** Convenience alias for consumers that render a list of reasons. */
  reasons: string[]
}
