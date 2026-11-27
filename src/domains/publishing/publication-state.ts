/**
 * Pure lifecycle and deployment-verification rules for publications.
 *
 * A publication is the serving/deployment boundary for a content asset.  It
 * intentionally has a smaller state graph than the content asset itself:
 * content approval decides what may be deployed, while this module decides
 * whether the deployed URL is safe to serve and/or index.
 *
 * This module has no persistence or clock dependency.  A worker can load a
 * publication and its latest check, call these functions, and persist the
 * returned decision in one transaction.
 */

export const PUBLICATION_STATUSES = [
  'pending',
  'live',
  'stale',
  'failed',
  'blocked',
] as const

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number]

/** A publication is either an indexable SEO page or an acquisition landing. */
export const PUBLICATION_ASSET_TYPES = ['seo_page', 'ad_landing'] as const
export type PublicationAssetType = (typeof PUBLICATION_ASSET_TYPES)[number]

export const INDEX_POLICIES = ['index', 'noindex'] as const
export type IndexPolicy = (typeof INDEX_POLICIES)[number]
export type PublicationIndexPolicy = IndexPolicy

/**
 * `blocked` is terminal for a publication record.  A corrected asset should
 * get a new publication/version rather than silently reactivating a URL that
 * an operator explicitly blocked.
 */
export const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationStatus, readonly PublicationStatus[]>
> = {
  pending: ['live', 'failed', 'blocked'],
  live: ['stale', 'failed', 'blocked'],
  stale: ['pending', 'failed', 'blocked'],
  failed: ['pending', 'blocked'],
  blocked: [],
}

// Compatibility-friendly name for callers that describe the table as an
// allowed-transition map.
export const PUBLICATION_ALLOWED_TRANSITIONS = PUBLICATION_TRANSITIONS

const PUBLICATION_STATUS_SET: ReadonlySet<string> = new Set(PUBLICATION_STATUSES)
const PUBLICATION_ASSET_TYPE_SET: ReadonlySet<string> = new Set(
  PUBLICATION_ASSET_TYPES,
)
const INDEX_POLICY_SET: ReadonlySet<string> = new Set(INDEX_POLICIES)

function isPublicationStatus(value: string): value is PublicationStatus {
  return PUBLICATION_STATUS_SET.has(value)
}

function isPublicationAssetType(value: string): value is PublicationAssetType {
  return PUBLICATION_ASSET_TYPE_SET.has(value)
}

function isIndexPolicy(value: string): value is IndexPolicy {
  return INDEX_POLICY_SET.has(value)
}

export function canTransitionPublication(
  from: PublicationStatus,
  to: PublicationStatus,
): boolean {
  return PUBLICATION_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertPublicationTransition(
  from: PublicationStatus,
  to: PublicationStatus,
): void {
  if (!canTransitionPublication(from, to)) {
    throw new PublicationTransitionError(
      `illegal publication transition: ${from} → ${to}`,
    )
  }
}

/** Apply only the explicit graph edge; verification-gated record updates use `transitionPublication`. */
export function transitionPublicationStatus(
  from: PublicationStatus,
  to: PublicationStatus,
): PublicationStatus {
  assertPublicationTransition(from, to)
  return to
}

export function isPublicationTerminal(status: PublicationStatus): boolean {
  return PUBLICATION_TRANSITIONS[status].length === 0
}

export function isPublicationActive(status: PublicationStatus): boolean {
  return !isPublicationTerminal(status)
}

export const PUBLICATION_TERMINAL_STATUSES = PUBLICATION_STATUSES.filter(
  isPublicationTerminal,
) as readonly PublicationStatus[]

export const PUBLICATION_ACTIVE_STATUSES = PUBLICATION_STATUSES.filter(
  isPublicationActive,
) as readonly PublicationStatus[]

/**
 * The five checks stored by `publication_checks`.  Optional fields are
 * deliberate: an incomplete check must fail closed instead of being treated
 * as a passing check.  `httpStatus` and the shorter boolean aliases are
 * accepted for adapters that use those names at the HTTP boundary.
 */
export interface DeploymentVerification {
  readonly statusCode?: number | null
  readonly httpStatus?: number | null
  readonly canonicalOk?: boolean
  readonly canonical?: boolean
  readonly ctaOk?: boolean
  readonly cta?: boolean
  readonly brandOk?: boolean
  readonly brand?: boolean
  readonly placeholderFree?: boolean
  readonly placeholdersFree?: boolean
  /** A transport/worker error is distinct from a rendered page gate failure. */
  readonly error?: string | null
  /** True when the check is known to describe an obsolete deployment. */
  readonly stale?: boolean
  readonly verificationStale?: boolean
  /** Optional version returned by the deployment/check endpoint. */
  readonly verifiedVersion?: string | null
}

export type PublicationCheck = DeploymentVerification
export type DeploymentCheck = DeploymentVerification

/**
 * The fields needed to make a status decision.  `Publication` below adds the
 * current lifecycle status; keeping the decision input separate makes the
 * function useful to workers before a record has been persisted.
 */
export interface PublicationStatusInput {
  readonly assetType: PublicationAssetType
  readonly indexPolicy: IndexPolicy
  readonly deployedVersion?: string | null
  /** The content version that this publication is expected to serve. */
  readonly expectedVersion?: string | null
  readonly verification?: DeploymentVerification | null
}

export interface Publication extends PublicationStatusInput {
  readonly status: PublicationStatus
}

export type PublicationRecord = Publication

export type PublicationReasonCode =
  | 'verification_missing'
  | 'deployment_error'
  | 'http_status_not_2xx'
  | 'canonical_mismatch'
  | 'cta_missing'
  | 'brand_mismatch'
  | 'placeholder_found'
  | 'deployed_version_missing'
  | 'deployed_version_stale'
  | 'verification_version_mismatch'
  | 'verification_stale'
  | 'ad_landing_must_be_noindex'

export type PublicationStatusReasonCode = PublicationReasonCode

export const PUBLICATION_REASON_CODES: readonly PublicationReasonCode[] = [
  'verification_missing',
  'http_status_not_2xx',
  'deployment_error',
  'canonical_mismatch',
  'cta_missing',
  'brand_mismatch',
  'placeholder_found',
  'deployed_version_missing',
  'deployed_version_stale',
  'verification_version_mismatch',
  'verification_stale',
  'ad_landing_must_be_noindex',
]

export interface PublicationReason {
  readonly code: PublicationReasonCode
  readonly detail?: string
}

export interface PublicationStatusDecision {
  readonly status: PublicationStatus
  /** Reasons are emitted in a stable order and never depend on object-key order. */
  readonly reasons: readonly PublicationReason[]
  /** String codes are convenient for persistence, metrics, and operator UIs. */
  readonly reasonCodes: readonly PublicationReasonCode[]
  /** All deployment/version/policy gates passed for the supplied check. */
  readonly allGatesPassed: boolean
  /** `true` only for an evidence-ready SEO publication with index policy. */
  readonly canIndex: boolean
}

export class PublicationTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicationTransitionError'
  }
}

export class PublicationPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicationPolicyError'
  }
}

function reason(code: PublicationReasonCode, detail?: string): PublicationReason {
  return detail === undefined ? { code } : { code, detail }
}

function statusCodeOf(verification: DeploymentVerification): number | null {
  return verification.statusCode ?? verification.httpStatus ?? null
}

function checkBoolean(
  primary: boolean | undefined,
  alias: boolean | undefined,
): boolean {
  return primary ?? alias ?? false
}

function is2xx(statusCode: number | null): boolean {
  return statusCode !== null && Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300
}

function nonBlank(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function deploymentVerificationIssues(
  verification: DeploymentVerification | null | undefined,
): PublicationReason[] {
  if (!verification) return [reason('verification_missing')]

  const issues: PublicationReason[] = []
  const statusCode = statusCodeOf(verification)

  if (!is2xx(statusCode)) {
    issues.push(
      reason(
        'http_status_not_2xx',
        statusCode === null ? 'status code missing' : String(statusCode),
      ),
    )
  }
  if (verification.error?.trim()) {
    issues.push(reason('deployment_error', verification.error.trim()))
  }
  if (!checkBoolean(verification.canonicalOk, verification.canonical)) {
    issues.push(reason('canonical_mismatch'))
  }
  if (!checkBoolean(verification.ctaOk, verification.cta)) {
    issues.push(reason('cta_missing'))
  }
  if (!checkBoolean(verification.brandOk, verification.brand)) {
    issues.push(reason('brand_mismatch'))
  }
  if (
    !checkBoolean(verification.placeholderFree, verification.placeholdersFree)
  ) {
    issues.push(reason('placeholder_found'))
  }

  return issues
}

/** Return the deployment checks in the fixed 2xx/canonical/CTA/brand/placeholder order. */
export function getDeploymentVerificationIssues(
  verification: DeploymentVerification | null | undefined,
): readonly PublicationReason[] {
  return deploymentVerificationIssues(verification)
}

export const getPublicationCheckIssues = getDeploymentVerificationIssues
export const getDeploymentCheckIssues = getDeploymentVerificationIssues

export function isDeploymentVerificationPassing(
  verification: DeploymentVerification | null | undefined,
): boolean {
  return (
    deploymentVerificationIssues(verification).length === 0 &&
    verification?.stale !== true &&
    verification?.verificationStale !== true
  )
}

export const isDeploymentVerified = isDeploymentVerificationPassing

/**
 * `index` is a search policy, not a deployment substitute.  An SEO `index`
 * policy is therefore allowed only when a verification snapshot is supplied
 * and every deployment gate passes.  `noindex` remains valid without a check,
 * which is the safe policy for previews and ad landings.
 */
export function isIndexPolicyAllowed(
  assetType: PublicationAssetType,
  indexPolicy: IndexPolicy,
  verification?: DeploymentVerification | null,
): boolean {
  if (!isPublicationAssetType(assetType) || !isIndexPolicy(indexPolicy)) {
    return false
  }
  if (assetType === 'ad_landing') return indexPolicy === 'noindex'
  if (indexPolicy === 'noindex') return true
  return verification != null && isDeploymentVerificationPassing(verification)
}

export function assertIndexPolicy(
  assetType: PublicationAssetType,
  indexPolicy: IndexPolicy,
  verification?: DeploymentVerification | null,
): void {
  if (assetType === 'ad_landing' && indexPolicy === 'index') {
    throw new PublicationPolicyError('ad_landing publications must use noindex')
  }
  if (!isIndexPolicyAllowed(assetType, indexPolicy, verification)) {
    throw new PublicationPolicyError(
      'seo_page index policy requires all deployment verification gates',
    )
  }
}

function publicationVersionIssues(
  publication: PublicationStatusInput,
  verification: DeploymentVerification | null | undefined,
): PublicationReason[] {
  if (!verification) return []

  const issues: PublicationReason[] = []
  if (nonBlank(publication.expectedVersion)) {
    if (!nonBlank(publication.deployedVersion)) {
      issues.push(reason('deployed_version_missing'))
    } else if (publication.deployedVersion !== publication.expectedVersion) {
      issues.push(
        reason(
          'deployed_version_stale',
          `${publication.deployedVersion} != ${publication.expectedVersion}`,
        ),
      )
    }
  }

  if (
    nonBlank(verification.verifiedVersion) &&
    nonBlank(publication.deployedVersion) &&
    verification.verifiedVersion !== publication.deployedVersion
  ) {
    issues.push(
      reason(
        'verification_version_mismatch',
        `${verification.verifiedVersion} != ${publication.deployedVersion}`,
      ),
    )
  }
  if (verification.stale === true || verification.verificationStale === true) {
    issues.push(reason('verification_stale'))
  }

  return issues
}

/** Return policy, deployment, and version reasons in a deterministic order. */
export function getPublicationVerificationIssues(
  publication: PublicationStatusInput,
  verification: DeploymentVerification | null | undefined = publication.verification,
): readonly PublicationReason[] {
  const issues: PublicationReason[] = []

  if (publication.assetType === 'ad_landing' && publication.indexPolicy === 'index') {
    issues.push(reason('ad_landing_must_be_noindex'))
  }

  issues.push(...deploymentVerificationIssues(verification))
  issues.push(...publicationVersionIssues(publication, verification))
  return issues
}

export const getPublicationIssues = getPublicationVerificationIssues

function hasReason(
  reasons: readonly PublicationReason[],
  ...codes: readonly PublicationReasonCode[]
): boolean {
  return reasons.some((item) => codes.includes(item.code))
}

function normalizeDecisionInput(
  input: PublicationStatusInput,
  verification: DeploymentVerification | null | undefined,
): PublicationStatusInput {
  return verification === undefined
    ? input
    : { ...input, verification }
}

/**
 * Decide the next persisted publication status from a check snapshot.
 *
 * Precedence is intentional and stable:
 * policy blocks first, then technical deployment failures, then quality
 * blocks, then version/check staleness, then pending when no check exists,
 * otherwise live.  A non-2xx response therefore remains `failed` even when
 * the renderer also could not satisfy page-level checks; a policy or quality
 * violation is `blocked` because retrying the same deployment cannot make it
 * safe.
 */
export function decidePublicationStatus(
  input: PublicationStatusInput,
  verification?: DeploymentVerification | null,
): PublicationStatusDecision {
  const normalized = normalizeDecisionInput(input, verification)
  const reasons = getPublicationVerificationIssues(normalized)
  const reasonCodes = reasons.map((item) => item.code)
  const hasVerification = normalized.verification != null

  const policyBlocked = hasReason(reasons, 'ad_landing_must_be_noindex')
  const qualityBlocked = hasReason(
    reasons,
    'canonical_mismatch',
    'cta_missing',
    'brand_mismatch',
    'placeholder_found',
  )
  const deploymentFailed = hasReason(
    reasons,
    'deployment_error',
    'http_status_not_2xx',
    'deployed_version_missing',
  )
  const stale = hasReason(
    reasons,
    'deployed_version_stale',
    'verification_version_mismatch',
    'verification_stale',
  )

  let status: PublicationStatus
  if (policyBlocked) {
    status = 'blocked'
  } else if (deploymentFailed) {
    status = 'failed'
  } else if (qualityBlocked) {
    status = 'blocked'
  } else if (stale) {
    status = 'stale'
  } else if (!hasVerification) {
    status = 'pending'
  } else {
    status = 'live'
  }

  const allGatesPassed =
    hasVerification && reasons.length === 0
  const canIndex =
    status === 'live' &&
    normalized.assetType === 'seo_page' &&
    normalized.indexPolicy === 'index' &&
    allGatesPassed

  return {
    status,
    reasons,
    reasonCodes,
    allGatesPassed,
    canIndex,
  }
}

export const getPublicationStatusDecision = decidePublicationStatus
export const determinePublicationStatus = decidePublicationStatus

/** The indexing decision is stricter than merely having a live URL. */
export function canIndexPublication(
  publication: PublicationStatusInput,
  verification: DeploymentVerification | null | undefined = publication.verification,
): boolean {
  return decidePublicationStatus(publication, verification).canIndex
}

export const isPublicationIndexable = canIndexPublication
export const isSeoPublicationIndexable = canIndexPublication

export function assertCanIndexPublication(
  publication: PublicationStatusInput,
  verification: DeploymentVerification | null | undefined = publication.verification,
): void {
  const decision = decidePublicationStatus(publication, verification)
  if (!decision.canIndex) {
    throw new PublicationPolicyError(
      `publication cannot be indexed: ${decision.reasonCodes.join(', ') || decision.status}`,
    )
  }
}

export interface PublicationTransitionOptions {
  readonly verification?: DeploymentVerification | null
}

/**
 * Apply a lifecycle edge to a record.  Entering `live` is the one edge that
 * requires a fresh, fully passing verification snapshot; all other edges are
 * explicit state commands and remain pure.
 */
export function transitionPublication(
  publication: Publication,
  to: PublicationStatus,
  options: PublicationTransitionOptions = {},
): Publication {
  assertPublicationTransition(publication.status, to)

  if (to === 'live') {
    const decision = decidePublicationStatus(publication, options.verification)
    if (decision.status !== 'live') {
      throw new PublicationTransitionError(
        `publication cannot become live: ${decision.reasonCodes.join(', ') || decision.status}`,
      )
    }
  }

  return { ...publication, status: to }
}

// Short aliases mirror the content/job state modules and keep imports clear
// at call sites that already use the generic names.
export const canTransition = canTransitionPublication
export const assertTransition = assertPublicationTransition
export const transition = transitionPublicationStatus
