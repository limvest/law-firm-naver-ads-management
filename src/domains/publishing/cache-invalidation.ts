import type { PublicationAssetType } from './publication-state'

/**
 * The worker must not import a framework cache module.  The application layer
 * can adapt these paths/tags to Next's `revalidatePath`/`revalidateTag`, while
 * tests can collect the same deterministic event with a plain function.
 */
export type PublicationCacheInvalidationReason =
  | 'became-live'
  | 'status-changed'
  | 'deployed-version-changed'

export type PublicationCacheInvalidation = Readonly<{
  publicationId: string
  firmId: number
  caseEntityId: string
  contentAssetId: string
  caseSlug: string
  assetType: PublicationAssetType
  previousStatus: string
  status: string
  previousDeployedVersion: string | null
  deployedVersion: string | null
  reason: PublicationCacheInvalidationReason
  /** Public target path plus the legacy firm-compatible path. */
  paths: readonly string[]
  /** Stable tags for consumers that prefer tag-based invalidation. */
  tags: readonly string[]
}>

export type PublicationCacheInvalidator = (
  event: PublicationCacheInvalidation,
) => void | Promise<void>

export const noopPublicationCacheInvalidator: PublicationCacheInvalidator = () => {}

function normalizedVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function encodedSlug(slug: string): string {
  return encodeURIComponent(slug.trim())
}

/**
 * Return the public paths affected by one target publication.  `/f/[slug]`
 * remains a compatibility route and must be refreshed with the target route.
 */
export function publicPublicationPaths(input: {
  assetType: PublicationAssetType
  caseSlug: string
}): readonly string[] {
  const slug = encodedSlug(input.caseSlug)
  const targetPath = input.assetType === 'seo_page' ? 'case' : 'response'
  return Object.freeze([`/${targetPath}/${slug}`, `/f/${slug}`])
}

/** Stable tag set for path- or tag-based framework adapters. */
export function publicPublicationTags(input: {
  publicationId: string
  firmId: number
  caseEntityId: string
  contentAssetId: string
}): readonly string[] {
  return Object.freeze([
    `publication:${input.publicationId}`,
    `firm:${input.firmId}`,
    `case:${input.caseEntityId}`,
    `content-asset:${input.contentAssetId}`,
  ])
}

export function shouldInvalidatePublicationCache(input: {
  previousStatus: string
  status: string
  previousDeployedVersion?: string | null
  deployedVersion?: string | null
}): boolean {
  const versionChanged = normalizedVersion(input.previousDeployedVersion)
    !== normalizedVersion(input.deployedVersion)
  const statusChanged = input.previousStatus !== input.status
  const publicExposureChanged = input.previousStatus === 'live' || input.status === 'live'
  return versionChanged || (statusChanged && publicExposureChanged)
}

export function publicationCacheInvalidationReason(input: {
  previousStatus: string
  status: string
  previousDeployedVersion?: string | null
  deployedVersion?: string | null
}): PublicationCacheInvalidationReason {
  const versionChanged = normalizedVersion(input.previousDeployedVersion)
    !== normalizedVersion(input.deployedVersion)
  if (versionChanged) return 'deployed-version-changed'
  if (input.previousStatus !== input.status && input.status === 'live') return 'became-live'
  return 'status-changed'
}

export function buildPublicationCacheInvalidation(input: {
  publicationId: string
  firmId: number
  caseEntityId: string
  contentAssetId: string
  caseSlug: string
  assetType: PublicationAssetType
  previousStatus: string
  status: string
  previousDeployedVersion?: string | null
  deployedVersion?: string | null
}): PublicationCacheInvalidation {
  const previousDeployedVersion = normalizedVersion(input.previousDeployedVersion)
  const deployedVersion = normalizedVersion(input.deployedVersion)
  return Object.freeze({
    publicationId: input.publicationId,
    firmId: input.firmId,
    caseEntityId: input.caseEntityId,
    contentAssetId: input.contentAssetId,
    caseSlug: input.caseSlug,
    assetType: input.assetType,
    previousStatus: input.previousStatus,
    status: input.status,
    previousDeployedVersion,
    deployedVersion,
    reason: publicationCacheInvalidationReason({
      ...input,
      previousDeployedVersion,
      deployedVersion,
    }),
    paths: publicPublicationPaths(input),
    tags: publicPublicationTags(input),
  })
}

/**
 * Framework-neutral adapter factory.  A Next route/action can pass bound
 * cache functions here; the publishing domain remains importable in workers
 * and unit tests without loading Next runtime modules.
 */
export function createPublicationCacheInvalidator(hooks: {
  revalidatePath?: (path: string) => void | Promise<void>
  revalidateTag?: (tag: string) => void | Promise<void>
}): PublicationCacheInvalidator {
  return async (event) => {
    if (hooks.revalidatePath) {
      for (const path of event.paths) await hooks.revalidatePath(path)
    }
    if (hooks.revalidateTag) {
      for (const tag of event.tags) await hooks.revalidateTag(tag)
    }
  }
}
