export {
  calculateOpportunityScore,
  OPPORTUNITY_SCORE_THRESHOLDS,
  OPPORTUNITY_SCORE_WEIGHTS,
  scoreFirmContext,
  scoreGlobalContext,
  scoreOpportunity,
} from './score'

export type {
  OpportunityContext,
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

export {
  DEFAULT_OPPORTUNITY_MODEL_VERSION,
  OPPORTUNITY_MODEL_VERSION,
  projectCaseOpportunities,
  projectFirmOpportunities,
  projectGlobalOpportunities,
  projectOpportunities,
  projectOpportunityScores,
} from './projector'

export type {
  OpportunityFirmCaseContextMap,
  OpportunityFirmContextMap,
  OpportunityGlobalCaseContextMap,
  OpportunityProjectionOptions,
  OpportunityProjectionRow,
  OpportunityProjectionScope,
} from './projector'

export {
  deriveOpportunityContexts,
  opportunityFirmCaseKey,
} from './context'

export type {
  DeriveOpportunityContextOptions,
  DerivedOpportunityContexts,
} from './context'
