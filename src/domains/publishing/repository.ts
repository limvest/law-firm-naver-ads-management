import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  caseEntities,
  contentAssets,
  firmDomains,
  firms,
  publicationChecks,
  publications,
} from '@/lib/db/schema'
import { normalizeHost } from '@/lib/engine/firms'
import {
  canTransitionPublication,
  decidePublicationStatus,
  type DeploymentVerification,
  type PublicationAssetType,
  type PublicationStatus,
} from './publication-state'
import {
  buildPublicationCacheInvalidation,
  noopPublicationCacheInvalidator,
  shouldInvalidatePublicationCache,
  type PublicationCacheInvalidator,
} from './cache-invalidation'

type PublicationRow = typeof publications.$inferSelect

export type PublicationPlanResult = {
  candidates: number
  created: number
  updated: number
  unchanged: number
  skippedNoDomain: number
}

function hostname(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, '')
  if (!trimmed || trimmed.includes('#') || trimmed.includes('?') || trimmed.includes('/') || trimmed.includes(':')) {
    throw new TypeError(`invalid publication domain: ${value}`)
  }
  const normalized = normalizeHost(trimmed)
  if (!normalized) throw new TypeError(`invalid publication domain: ${value}`)
  return normalized
}

function publicationPath(assetType: string, slug: string): string {
  const encodedSlug = encodeURIComponent(slug)
  return assetType === 'seo_page' ? `/case/${encodedSlug}` : `/response/${encodedSlug}`
}

type FirmDomainRow = typeof firmDomains.$inferSelect

function isUsableDomain(row: FirmDomainRow): boolean {
  const status = row.status.trim().toLowerCase()
  return (status === 'active' || status === 'verified')
    && row.tlsStatus.trim().toLowerCase() === 'valid'
}

function canonicalDomain(rows: FirmDomainRow[]): string | null {
  const row = rows
    .filter((candidate) => candidate.isCanonical && isUsableDomain(candidate))
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))[0]
  if (!row) return null
  try {
    return hostname(row.hostname)
  } catch {
    return null
  }
}

function canonicalPublicationUrl(domain: string, assetType: string, slug: string): string {
  return `https://${domain}${publicationPath(assetType, slug)}`
}

function sameStoredHostname(value: string, expected: string): boolean {
  try {
    return hostname(value) === expected
  } catch {
    return false
  }
}

/** Create/update URL plans without deploying anything externally. */
export async function planPublications(
  db: Db,
  options: {
    firmIds?: number[]
    invalidateCache?: PublicationCacheInvalidator
  } = {},
): Promise<PublicationPlanResult> {
  const invalidateCache = options.invalidateCache ?? noopPublicationCacheInvalidator
  const assetRows = options.firmIds?.length
    ? await db.select().from(contentAssets).where(inArray(contentAssets.firmId, options.firmIds))
    : await db.select().from(contentAssets)
  const candidates = assetRows.filter((asset) => asset.status === 'approved')
  const result: PublicationPlanResult = {
    candidates: candidates.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedNoDomain: 0,
  }
  if (!candidates.length) return result

  const firmIds = [...new Set(candidates.map((asset) => asset.firmId))]
  const caseIds = [...new Set(candidates.map((asset) => asset.caseEntityId))]
  const [firmRows, domainRows, caseRows] = await Promise.all([
    db.select().from(firms).where(inArray(firms.id, firmIds)),
    db.select().from(firmDomains).where(inArray(firmDomains.firmId, firmIds)),
    db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds)),
  ])
  const firmById = new Map(firmRows.map((firm) => [firm.id, firm]))
  const caseById = new Map(caseRows.map((caseRow) => [caseRow.id, caseRow]))
  const domainsByFirm = new Map<number, FirmDomainRow[]>()
  for (const row of domainRows) {
    const rows = domainsByFirm.get(row.firmId) ?? []
    rows.push(row)
    domainsByFirm.set(row.firmId, rows)
  }
  const activeDomainByFirm = new Map<number, string>()
  for (const firmId of firmIds) {
    const rows = domainsByFirm.get(firmId) ?? []
    const domain = rows.length ? canonicalDomain(rows) : null
    if (domain) activeDomainByFirm.set(firmId, domain)
  }

  for (const asset of candidates) {
    const firm = firmById.get(asset.firmId)
    const caseRow = caseById.get(asset.caseEntityId)
    // Once a firm_domains record exists, only its verified canonical hostname
    // is authoritative. The legacy firms.domain fallback is retained solely
    // for tenants that have not migrated to firm_domains yet.
    const firmDomainRows = domainsByFirm.get(asset.firmId) ?? []
    const domainValue = firmDomainRows.length
      ? activeDomainByFirm.get(asset.firmId) ?? null
      : firm?.domain ?? null
    if (!firm || firm.status === 'paused' || !firm.landingReady || !caseRow || caseRow.status !== 'approved' || !domainValue) {
      result.skippedNoDomain += 1
      continue
    }
    const domain = hostname(domainValue)
    const path = publicationPath(asset.assetType, caseRow.slug)
    const url = `https://${domain}${path}`
    const [existingByUrl] = await db.select().from(publications).where(and(
      eq(publications.firmId, firm.id),
      eq(publications.url, url),
    )).limit(1)
    const [existing] = existingByUrl
      ? [existingByUrl]
      : await db.select().from(publications).where(and(
        eq(publications.firmId, firm.id),
        eq(publications.contentAssetId, asset.id),
      )).orderBy(desc(publications.updatedAt)).limit(1)
    const deployedVersion = String(asset.contentVersion)
    if (!existing) {
      await db.insert(publications).values({
        firmId: firm.id,
        contentAssetId: asset.id,
        domain,
        url,
        canonicalUrl: url,
        indexPolicy: asset.assetType === 'seo_page' ? 'index' : 'noindex',
        status: 'pending',
        deployedVersion,
      })
      result.created += 1
    } else if (
      existing.contentAssetId === asset.id
      && existing.deployedVersion === deployedVersion
      && sameStoredHostname(existing.domain, domain)
      && existing.canonicalUrl === url
      && existing.indexPolicy === (asset.assetType === 'seo_page' ? 'index' : 'noindex')
    ) {
      result.unchanged += 1
    } else {
      const nextStatus = 'pending'
      const previousDeployedVersion = existing.deployedVersion
      const shouldInvalidate = shouldInvalidatePublicationCache({
        previousStatus: existing.status,
        status: nextStatus,
        previousDeployedVersion,
        deployedVersion,
      })
      await db.update(publications).set({
        contentAssetId: asset.id,
        domain,
        url,
        canonicalUrl: url,
        indexPolicy: asset.assetType === 'seo_page' ? 'index' : 'noindex',
        status: nextStatus,
        deployedVersion,
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(publications.id, existing.id))
      if (shouldInvalidate) {
        await invalidateCache(buildPublicationCacheInvalidation({
          publicationId: existing.id,
          firmId: firm.id,
          caseEntityId: caseRow.id,
          contentAssetId: asset.id,
          caseSlug: caseRow.slug,
          assetType: asset.assetType as PublicationAssetType,
          previousStatus: existing.status,
          status: nextStatus,
          previousDeployedVersion,
          deployedVersion,
        }))
      }
      result.updated += 1
    }
  }
  return result
}

export type PublicationVerificationResult = {
  publication: PublicationRow
  reasonCodes: string[]
  canIndex: boolean
}

/** Persist a post-deploy check and advance only through a legal lifecycle edge. */
export async function recordPublicationVerification(
  db: Db,
  input: {
    publicationId: string
    verification: DeploymentVerification
    checkedAt?: Date
    invalidateCache?: PublicationCacheInvalidator
  },
): Promise<PublicationVerificationResult> {
  const [publication] = await db.select().from(publications)
    .where(eq(publications.id, input.publicationId)).limit(1)
  if (!publication) throw new Error('publication not found')
  const [asset] = await db.select().from(contentAssets)
    .where(eq(contentAssets.id, publication.contentAssetId)).limit(1)
  if (!asset) throw new Error('publication content asset not found')
  const [firm] = await db.select().from(firms).where(eq(firms.id, publication.firmId)).limit(1)
  const [caseRow] = await db.select().from(caseEntities).where(eq(caseEntities.id, asset.caseEntityId)).limit(1)
  if (
    !firm
    || !caseRow
    || publication.firmId !== asset.firmId
    || caseRow.status !== 'approved'
  ) {
    throw new Error('publication canonical chain mismatch')
  }
  const domainRows = await db.select().from(firmDomains).where(eq(firmDomains.firmId, firm.id))
  const domain = domainRows.length
    ? canonicalDomain(domainRows)
    : (firm.domain ? hostname(firm.domain) : null)
  const expectedUrl = domain
    ? canonicalPublicationUrl(domain, asset.assetType, caseRow.slug)
    : null
  if (
    !domain
    || !expectedUrl
    || !sameStoredHostname(publication.domain, domain)
    || publication.url !== expectedUrl
    || publication.canonicalUrl !== expectedUrl
  ) {
    throw new Error('publication domain or canonical URL mismatch')
  }
  const checkedAt = input.checkedAt ?? new Date()
  const decision = decidePublicationStatus({
    assetType: asset.assetType as PublicationAssetType,
    indexPolicy: publication.indexPolicy as 'index' | 'noindex',
    deployedVersion: publication.deployedVersion,
    expectedVersion: String(asset.contentVersion),
  }, input.verification)
  const currentStatus = publication.status as PublicationStatus
  if (decision.status !== currentStatus && !canTransitionPublication(currentStatus, decision.status)) {
    throw new Error(`illegal verified publication transition: ${currentStatus} → ${decision.status}`)
  }
  await db.transaction(async (tx) => {
    await tx.insert(publicationChecks).values({
      publicationId: publication.id,
      statusCode: input.verification.statusCode ?? input.verification.httpStatus ?? null,
      canonicalOk: input.verification.canonicalOk ?? input.verification.canonical ?? false,
      ctaOk: input.verification.ctaOk ?? input.verification.cta ?? false,
      brandOk: input.verification.brandOk ?? input.verification.brand ?? false,
      placeholderFree: input.verification.placeholderFree ?? input.verification.placeholdersFree ?? false,
      checkedAt,
      detail: {
        reasonCodes: decision.reasonCodes,
        verifiedVersion: input.verification.verifiedVersion ?? null,
        error: input.verification.error ?? null,
      },
    })
    await tx.update(publications).set({
      status: decision.status,
      lastVerifiedAt: checkedAt,
      lastError: decision.reasonCodes.length ? decision.reasonCodes.join(',') : null,
      publishedAt: decision.status === 'live' ? (publication.publishedAt ?? checkedAt) : publication.publishedAt,
      updatedAt: checkedAt,
    }).where(eq(publications.id, publication.id))
    if (decision.status === 'live' && asset.status === 'approved') {
      await tx.update(contentAssets).set({ status: 'published', updatedAt: checkedAt })
        .where(eq(contentAssets.id, asset.id))
    }
  })
  const [updated] = await db.select().from(publications)
    .where(eq(publications.id, publication.id)).limit(1)
  if (!updated) throw new Error('publication update returned no row')
  if (shouldInvalidatePublicationCache({
    previousStatus: publication.status,
    status: updated.status,
    previousDeployedVersion: publication.deployedVersion,
    deployedVersion: updated.deployedVersion,
  })) {
    await (input.invalidateCache ?? noopPublicationCacheInvalidator)(
      buildPublicationCacheInvalidation({
        publicationId: updated.id,
        firmId: updated.firmId,
        caseEntityId: caseRow.id,
        contentAssetId: asset.id,
        caseSlug: caseRow.slug,
        assetType: asset.assetType as PublicationAssetType,
        previousStatus: publication.status,
        status: updated.status,
        previousDeployedVersion: publication.deployedVersion,
        deployedVersion: updated.deployedVersion,
      }),
    )
  }
  return { publication: updated, reasonCodes: [...decision.reasonCodes], canIndex: decision.canIndex }
}
