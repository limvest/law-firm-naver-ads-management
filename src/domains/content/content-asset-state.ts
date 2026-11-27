/**
 * Pure lifecycle and publication rules for content assets.
 *
 * The two asset types deliberately have different state graphs.  In
 * particular, an ad landing must not be advanced through the SEO review
 * states (and vice versa); the shared names draft/approved/published do not
 * make the workflows interchangeable.
 */

export const SEO_PAGE_STATUSES = [
  'draft',
  'evidence_ready',
  'quality_review',
  'approved',
  'published',
  'indexed',
  'rejected',
  'stale',
  'refreshed',
  'blocked',
] as const

export type SeoPageStatus = (typeof SEO_PAGE_STATUSES)[number]

export const AD_LANDING_STATUSES = [
  'draft',
  'brand_review',
  'approved',
  'published',
  'experiment_live',
  'winner',
  'retired',
] as const

export type AdLandingStatus = (typeof AD_LANDING_STATUSES)[number]

export const CONTENT_ASSET_TYPES = ['seo_page', 'ad_landing'] as const
export type ContentAssetType = (typeof CONTENT_ASSET_TYPES)[number]

export const INDEX_POLICIES = ['index', 'noindex'] as const
export type IndexPolicy = (typeof INDEX_POLICIES)[number]

export type ContentAssetStatus = SeoPageStatus | AdLandingStatus

type StatusForAssetType<T extends ContentAssetType> = T extends 'seo_page'
  ? SeoPageStatus
  : AdLandingStatus

export type SeoPageTransitionMap = Readonly<
  Record<SeoPageStatus, readonly SeoPageStatus[]>
>

export type AdLandingTransitionMap = Readonly<
  Record<AdLandingStatus, readonly AdLandingStatus[]>
>

/** The SEO graph in PRODUCT-GOAL-ARCHITECTURE-GTM.md §5.3. */
export const SEO_PAGE_TRANSITIONS: SeoPageTransitionMap = {
  draft: ['evidence_ready'],
  evidence_ready: ['quality_review'],
  quality_review: ['approved', 'rejected'],
  approved: ['published'],
  published: ['indexed', 'stale', 'blocked'],
  indexed: [],
  rejected: [],
  stale: ['refreshed'],
  refreshed: [],
  blocked: [],
}

/** The ad landing graph in PRODUCT-GOAL-ARCHITECTURE-GTM.md §5.3. */
export const AD_LANDING_TRANSITIONS: AdLandingTransitionMap = {
  draft: ['brand_review'],
  brand_review: ['approved'],
  approved: ['published'],
  published: ['experiment_live'],
  experiment_live: ['winner', 'retired'],
  winner: [],
  retired: [],
}

// Compatibility-friendly names for callers that describe the tables as
// allowed transitions rather than transition maps.
export const SEO_PAGE_ALLOWED_TRANSITIONS = SEO_PAGE_TRANSITIONS
export const AD_LANDING_ALLOWED_TRANSITIONS = AD_LANDING_TRANSITIONS

const SEO_PAGE_STATUS_SET: ReadonlySet<string> = new Set(SEO_PAGE_STATUSES)
const AD_LANDING_STATUS_SET: ReadonlySet<string> = new Set(AD_LANDING_STATUSES)

function isSeoPageStatus(value: string): value is SeoPageStatus {
  return SEO_PAGE_STATUS_SET.has(value)
}

function isAdLandingStatus(value: string): value is AdLandingStatus {
  return AD_LANDING_STATUS_SET.has(value)
}

export function canTransitionSeoPage(
  from: SeoPageStatus,
  to: SeoPageStatus,
): boolean {
  return SEO_PAGE_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertSeoPageTransition(
  from: SeoPageStatus,
  to: SeoPageStatus,
): void {
  if (!canTransitionSeoPage(from, to)) {
    throw new Error(`illegal seo_page transition: ${from} → ${to}`)
  }
}

export function transitionSeoPageStatus(
  from: SeoPageStatus,
  to: SeoPageStatus,
): SeoPageStatus {
  assertSeoPageTransition(from, to)
  return to
}

export function canTransitionAdLanding(
  from: AdLandingStatus,
  to: AdLandingStatus,
): boolean {
  return AD_LANDING_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertAdLandingTransition(
  from: AdLandingStatus,
  to: AdLandingStatus,
): void {
  if (!canTransitionAdLanding(from, to)) {
    throw new Error(`illegal ad_landing transition: ${from} → ${to}`)
  }
}

export function transitionAdLandingStatus(
  from: AdLandingStatus,
  to: AdLandingStatus,
): AdLandingStatus {
  assertAdLandingTransition(from, to)
  return to
}

export function canTransitionContentAsset<T extends ContentAssetType>(
  assetType: T,
  from: StatusForAssetType<T>,
  to: StatusForAssetType<T>,
): boolean
export function canTransitionContentAsset(
  assetType: ContentAssetType,
  from: ContentAssetStatus,
  to: ContentAssetStatus,
): boolean
export function canTransitionContentAsset(
  assetType: ContentAssetType,
  from: ContentAssetStatus,
  to: ContentAssetStatus,
): boolean {
  if (assetType === 'seo_page') {
    return isSeoPageStatus(from) && isSeoPageStatus(to)
      ? canTransitionSeoPage(from, to)
      : false
  }

  return isAdLandingStatus(from) && isAdLandingStatus(to)
    ? canTransitionAdLanding(from, to)
    : false
}

export function assertContentAssetTransition<T extends ContentAssetType>(
  assetType: T,
  from: StatusForAssetType<T>,
  to: StatusForAssetType<T>,
): void
export function assertContentAssetTransition(
  assetType: ContentAssetType,
  from: ContentAssetStatus,
  to: ContentAssetStatus,
): void
export function assertContentAssetTransition(
  assetType: ContentAssetType,
  from: ContentAssetStatus,
  to: ContentAssetStatus,
): void {
  const allowed = assetType === 'seo_page'
    ? isSeoPageStatus(from) &&
      isSeoPageStatus(to) &&
      canTransitionSeoPage(from, to)
    : isAdLandingStatus(from) &&
      isAdLandingStatus(to) &&
      canTransitionAdLanding(from, to)
  if (!allowed) {
    throw new Error(`illegal ${assetType} transition: ${from} → ${to}`)
  }
}

export function isSeoPageTerminal(status: SeoPageStatus): boolean {
  return SEO_PAGE_TRANSITIONS[status].length === 0
}

export function isAdLandingTerminal(status: AdLandingStatus): boolean {
  return AD_LANDING_TRANSITIONS[status].length === 0
}

/**
 * Active means that the state has a legal next state in its own graph.  This
 * is intentionally a lifecycle property, not a claim that the asset is
 * currently serving traffic; `published` and `indexed` answer that different
 * operational question.
 */
export function isSeoPageActive(status: SeoPageStatus): boolean {
  return !isSeoPageTerminal(status)
}

export function isAdLandingActive(status: AdLandingStatus): boolean {
  return !isAdLandingTerminal(status)
}

export const SEO_PAGE_TERMINAL_STATUSES = SEO_PAGE_STATUSES.filter(
  isSeoPageTerminal,
) as readonly SeoPageStatus[]

export const AD_LANDING_TERMINAL_STATUSES = AD_LANDING_STATUSES.filter(
  isAdLandingTerminal,
) as readonly AdLandingStatus[]

export const SEO_PAGE_ACTIVE_STATUSES = SEO_PAGE_STATUSES.filter(
  isSeoPageActive,
) as readonly SeoPageStatus[]

export const AD_LANDING_ACTIVE_STATUSES = AD_LANDING_STATUSES.filter(
  isAdLandingActive,
) as readonly AdLandingStatus[]

export function isContentAssetTerminal(asset: ContentAsset): boolean {
  return asset.assetType === 'seo_page'
    ? isSeoPageTerminal(asset.status)
    : isAdLandingTerminal(asset.status)
}

export function isContentAssetActive(asset: ContentAsset): boolean {
  return !isContentAssetTerminal(asset)
}

export function isTerminalStatus<T extends ContentAssetType>(
  assetType: T,
  status: StatusForAssetType<T>,
): boolean
export function isTerminalStatus(
  assetType: ContentAssetType,
  status: ContentAssetStatus,
): boolean
export function isTerminalStatus(
  assetType: ContentAssetType,
  status: ContentAssetStatus,
): boolean {
  return assetType === 'seo_page'
    ? isSeoPageStatus(status) && isSeoPageTerminal(status)
    : isAdLandingStatus(status) && isAdLandingTerminal(status)
}

export function isActiveStatus<T extends ContentAssetType>(
  assetType: T,
  status: StatusForAssetType<T>,
): boolean
export function isActiveStatus(
  assetType: ContentAssetType,
  status: ContentAssetStatus,
): boolean
export function isActiveStatus(
  assetType: ContentAssetType,
  status: ContentAssetStatus,
): boolean {
  return assetType === 'seo_page'
    ? isSeoPageStatus(status) && isSeoPageActive(status)
    : isAdLandingStatus(status) && isAdLandingActive(status)
}

export interface ContentAssetBase {
  /** The content_assets primary identifier. */
  readonly id: string
  readonly caseEntityId: string
  readonly firmId: string
  readonly templateVersion: string
  readonly contentVersion: string
  readonly evidenceSnapshotId: string | null
}

export interface SeoPageAsset extends ContentAssetBase {
  readonly assetType: 'seo_page'
  readonly status: SeoPageStatus
}

export interface AdLandingAsset extends ContentAssetBase {
  readonly assetType: 'ad_landing'
  readonly status: AdLandingStatus
}

export type ContentAsset = SeoPageAsset | AdLandingAsset

type StatusForAsset<T extends ContentAsset> = T extends SeoPageAsset
  ? SeoPageStatus
  : AdLandingStatus

export interface EvidenceReadiness {
  /** Evidence tied to this case entity, rather than a generic topic. */
  readonly hasCaseSpecificEvidence: boolean
  /** A competitor sitemap title is not sufficient evidence for publication. */
  readonly competitorSitemapTitleOnly: boolean
}

export interface ContentReadiness {
  readonly evidence: EvidenceReadiness
  /** Values identify unresolved template tokens or other unfinished copy. */
  readonly unresolvedPlaceholders: readonly string[]
  /** Links known to be dead by the quality check. */
  readonly deadLinks: readonly string[]
  /** The rendered asset uses the intended law-firm identity and details. */
  readonly firmInfoValid: boolean
  /** Raw links are optional; `#` is always treated as a placeholder link. */
  readonly links?: readonly string[]
}

export type ReadinessIssueCode =
  | 'missing_case_specific_evidence'
  | 'competitor_sitemap_title_only'
  | 'unresolved_placeholder'
  | 'dead_link'
  | 'invalid_firm_information'

export interface ReadinessIssue {
  readonly code: ReadinessIssueCode
  readonly detail?: string
}

function hasPlaceholderLink(readiness: ContentReadiness): boolean {
  return readiness.links?.some((link) => link.trim() === '#') ?? false
}

export function isEvidenceReady(evidence: EvidenceReadiness): boolean {
  return (
    evidence.hasCaseSpecificEvidence && !evidence.competitorSitemapTitleOnly
  )
}

export function hasUnresolvedPlaceholders(
  readiness: ContentReadiness,
): boolean {
  return readiness.unresolvedPlaceholders.length > 0
}

export function hasDeadLinks(readiness: ContentReadiness): boolean {
  return readiness.deadLinks.length > 0 || hasPlaceholderLink(readiness)
}

export function isPlaceholderReady(readiness: ContentReadiness): boolean {
  return (
    !hasUnresolvedPlaceholders(readiness) &&
    !hasDeadLinks(readiness) &&
    readiness.firmInfoValid
  )
}

export function getReadinessIssues(
  readiness: ContentReadiness,
): readonly ReadinessIssue[] {
  const issues: ReadinessIssue[] = []

  if (!readiness.evidence.hasCaseSpecificEvidence) {
    issues.push({ code: 'missing_case_specific_evidence' })
  }
  if (readiness.evidence.competitorSitemapTitleOnly) {
    issues.push({ code: 'competitor_sitemap_title_only' })
  }
  if (hasUnresolvedPlaceholders(readiness)) {
    issues.push({
      code: 'unresolved_placeholder',
      detail: readiness.unresolvedPlaceholders.join(', '),
    })
  }
  if (hasDeadLinks(readiness)) {
    const deadLinks = [
      ...readiness.deadLinks,
      ...(readiness.links?.filter((link) => link.trim() === '#') ?? []),
    ]
    issues.push({ code: 'dead_link', detail: deadLinks.join(', ') })
  }
  if (!readiness.firmInfoValid) {
    issues.push({ code: 'invalid_firm_information' })
  }

  return issues
}

/**
 * `index` is reserved for evidence-backed SEO pages.  A paid ad landing is a
 * separate acquisition asset and is always noindex.  `noindex` is the safe
 * preview policy when evidence is not yet sufficient for search indexing.
 */
export function isIndexPolicyAllowed(
  assetType: ContentAssetType,
  indexPolicy: IndexPolicy,
  evidence: EvidenceReadiness,
): boolean {
  if (indexPolicy === 'noindex') return true
  if (indexPolicy !== 'index') return false
  return assetType === 'seo_page' && isEvidenceReady(evidence)
}

export function assertIndexPolicy(
  assetType: ContentAssetType,
  indexPolicy: IndexPolicy,
  evidence: EvidenceReadiness,
): void {
  if (!isIndexPolicyAllowed(assetType, indexPolicy, evidence)) {
    if (assetType === 'ad_landing' && indexPolicy === 'index') {
      throw new Error('ad_landing publications must use noindex')
    }
    throw new Error(
      'seo_page index publication requires case-specific, non-competitor-only evidence',
    )
  }
}

export interface Publication {
  readonly contentAssetId: string
  readonly domainId: string
  readonly url: string
  readonly canonicalUrl: string
  readonly indexPolicy: IndexPolicy
  readonly deployedVersion: string
  readonly publishedAt?: string | null
  readonly lastVerifiedAt?: string | null
}

export type ContentAssetInvariantCode =
  | 'invalid_status_for_asset_type'
  | 'missing_asset_id'
  | 'missing_case_entity_id'
  | 'missing_firm_id'
  | 'missing_template_version'
  | 'missing_content_version'
  | 'missing_evidence_snapshot'

export interface ContentAssetInvariantIssue {
  readonly code: ContentAssetInvariantCode
}

function isNonBlank(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function statusRequiresEvidenceSnapshot(asset: ContentAsset): boolean {
  if (asset.status === 'draft') return false
  if (asset.assetType === 'seo_page') return true
  return ['published', 'experiment_live', 'winner', 'retired'].includes(
    asset.status,
  )
}

export function getContentAssetInvariantIssues(
  asset: ContentAsset,
): readonly ContentAssetInvariantIssue[] {
  const issues: ContentAssetInvariantIssue[] = []
  if (
    (asset.assetType === 'seo_page' && !isSeoPageStatus(asset.status)) ||
    (asset.assetType === 'ad_landing' && !isAdLandingStatus(asset.status))
  ) {
    issues.push({ code: 'invalid_status_for_asset_type' })
  }
  if (!isNonBlank(asset.id)) issues.push({ code: 'missing_asset_id' })
  if (!isNonBlank(asset.caseEntityId)) {
    issues.push({ code: 'missing_case_entity_id' })
  }
  if (!isNonBlank(asset.firmId)) issues.push({ code: 'missing_firm_id' })
  if (!isNonBlank(asset.templateVersion)) {
    issues.push({ code: 'missing_template_version' })
  }
  if (!isNonBlank(asset.contentVersion)) {
    issues.push({ code: 'missing_content_version' })
  }
  if (
    statusRequiresEvidenceSnapshot(asset) &&
    !isNonBlank(asset.evidenceSnapshotId)
  ) {
    issues.push({ code: 'missing_evidence_snapshot' })
  }
  return issues
}

export function assertContentAssetInvariant(asset: ContentAsset): void {
  const issues = getContentAssetInvariantIssues(asset)
  if (issues.length > 0) {
    throw new Error(
      `content asset invariant violation: ${issues
        .map((issue) => issue.code)
        .join(', ')}`,
    )
  }
}

export type PublicationInvariantCode =
  | 'asset_not_publishable'
  | 'invalid_content_asset'
  | 'content_asset_mismatch'
  | 'missing_domain_id'
  | 'invalid_url'
  | 'invalid_canonical_url'
  | 'missing_deployed_version'
  | 'deployed_version_mismatch'
  | 'competitor_sitemap_title_only'
  | 'unresolved_placeholder'
  | 'dead_link'
  | 'invalid_firm_information'
  | 'index_policy_not_allowed'

export interface PublicationInvariantIssue {
  readonly code: PublicationInvariantCode
  readonly detail?: string
}

function isPublishableStatus(asset: ContentAsset): boolean {
  if (asset.assetType === 'seo_page') {
    return (
      asset.status === 'approved' ||
      asset.status === 'published' ||
      asset.status === 'indexed' ||
      asset.status === 'stale' ||
      asset.status === 'refreshed'
    )
  }

  return (
    asset.status === 'approved' ||
    asset.status === 'published' ||
    asset.status === 'experiment_live' ||
    asset.status === 'winner'
  )
}

function isUsablePublicationUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('#')) return false

  try {
    const parsed = new URL(trimmed, 'https://publication.invalid')
    return (
      !parsed.hash &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    )
  } catch {
    return false
  }
}

export function getPublicationInvariantIssues(
  asset: ContentAsset,
  publication: Publication,
  readiness: ContentReadiness,
): readonly PublicationInvariantIssue[] {
  const issues: PublicationInvariantIssue[] = []

  const assetIssues = getContentAssetInvariantIssues(asset)
  if (assetIssues.length > 0) {
    issues.push({
      code: 'invalid_content_asset',
      detail: assetIssues.map((issue) => issue.code).join(', '),
    })
  }
  if (!isPublishableStatus(asset)) {
    issues.push({ code: 'asset_not_publishable' })
  }
  if (publication.contentAssetId !== asset.id) {
    issues.push({ code: 'content_asset_mismatch' })
  }
  if (!isNonBlank(publication.domainId)) {
    issues.push({ code: 'missing_domain_id' })
  }
  if (!isUsablePublicationUrl(publication.url)) {
    issues.push({ code: 'invalid_url' })
  }
  if (!isUsablePublicationUrl(publication.canonicalUrl)) {
    issues.push({ code: 'invalid_canonical_url' })
  }
  if (!isNonBlank(publication.deployedVersion)) {
    issues.push({ code: 'missing_deployed_version' })
  } else if (publication.deployedVersion !== asset.contentVersion) {
    issues.push({ code: 'deployed_version_mismatch' })
  }

  if (readiness.evidence.competitorSitemapTitleOnly) {
    issues.push({ code: 'competitor_sitemap_title_only' })
  }
  if (hasUnresolvedPlaceholders(readiness)) {
    issues.push({
      code: 'unresolved_placeholder',
      detail: readiness.unresolvedPlaceholders.join(', '),
    })
  }
  if (hasDeadLinks(readiness)) {
    const deadLinks = [
      ...readiness.deadLinks,
      ...(readiness.links?.filter((link) => link.trim() === '#') ?? []),
    ]
    issues.push({ code: 'dead_link', detail: deadLinks.join(', ') })
  }
  if (!readiness.firmInfoValid) {
    issues.push({ code: 'invalid_firm_information' })
  }
  if (
    !isIndexPolicyAllowed(
      asset.assetType,
      publication.indexPolicy,
      readiness.evidence,
    )
  ) {
    issues.push({ code: 'index_policy_not_allowed' })
  }

  return issues
}

export function isPublicationReady(
  asset: ContentAsset,
  publication: Publication,
  readiness: ContentReadiness,
): boolean {
  return getPublicationInvariantIssues(asset, publication, readiness).length === 0
}

export function canPublishContentAsset(
  asset: ContentAsset,
  publication: Publication,
  readiness: ContentReadiness,
): boolean {
  return isPublicationReady(asset, publication, readiness)
}

export function assertPublicationInvariant(
  asset: ContentAsset,
  publication: Publication,
  readiness: ContentReadiness,
): void {
  const issues = getPublicationInvariantIssues(asset, publication, readiness)
  if (issues.length > 0) {
    throw new Error(
      `publication invariant violation: ${issues
        .map((issue) => issue.code)
        .join(', ')}`,
    )
  }
}

export interface ContentAssetTransitionOptions {
  readonly publication?: Publication
  readonly readiness?: ContentReadiness
}

export function transitionContentAsset<T extends ContentAsset>(
  asset: T,
  to: StatusForAsset<T>,
  options?: ContentAssetTransitionOptions,
): T
export function transitionContentAsset(
  asset: ContentAsset,
  to: ContentAssetStatus,
  options?: ContentAssetTransitionOptions,
): ContentAsset
export function transitionContentAsset(
  asset: ContentAsset,
  to: ContentAssetStatus,
  options: ContentAssetTransitionOptions = {},
): ContentAsset {
  assertContentAssetInvariant(asset)
  if (asset.assetType === 'seo_page') {
    if (!isSeoPageStatus(to)) {
      throw new Error(`illegal seo_page transition: ${asset.status} → ${to}`)
    }
    assertSeoPageTransition(asset.status, to)
  } else {
    if (!isAdLandingStatus(to)) {
      throw new Error(`illegal ad_landing transition: ${asset.status} → ${to}`)
    }
    assertAdLandingTransition(asset.status, to)
  }

  const next = { ...asset, status: to } as ContentAsset

  if (to === 'evidence_ready') {
    if (!options.readiness || !isEvidenceReady(options.readiness.evidence)) {
      throw new Error('seo_page evidence_ready requires case-specific evidence')
    }
  }

  if (to === 'published') {
    if (!options.publication || !options.readiness) {
      throw new Error(
        'published content assets require publication and readiness checks',
      )
    }
    assertPublicationInvariant(next, options.publication, options.readiness)
  }

  assertContentAssetInvariant(next)
  return next
}
