import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  caseEntities,
  contentAssets,
  firmDomains,
  firms,
  publicationChecks,
  publications,
} from '@/lib/db/schema'
import { planPublications, recordPublicationVerification } from '@/domains/publishing/repository'
import type { PublicationCacheInvalidation } from '@/domains/publishing'

async function seed(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values({
    id: 51, slug: 'publisher', name: 'Publisher Firm', adLawyerName: 'Lawyer',
    phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: 'Seoul',
    addressRegion: 'Seoul', addressLocality: 'Seoul', domain: 'legacy.example', landingReady: true,
  })
  await db.insert(firmDomains).values({
    firmId: 51, hostname: 'law.example', isCanonical: true, status: 'active', tlsStatus: 'valid',
  })
  const [caseRow] = await db.insert(caseEntities).values({
    canonicalName: 'Alpha', slug: 'alpha-publish', category: 'coin', status: 'approved',
  }).returning()
  const [seo, ad] = await db.insert(contentAssets).values([
    { firmId: 51, caseEntityId: caseRow.id, assetType: 'seo_page', status: 'approved', templateVersion: 'seo-v1', contentVersion: 1, content: {} },
    { firmId: 51, caseEntityId: caseRow.id, assetType: 'ad_landing', status: 'approved', templateVersion: 'ad-v1', contentVersion: 1, content: {} },
  ]).returning()
  return { seo, ad }
}

const passing = { statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true }

describe('publication repository', () => {
  it('plans separate SEO/index and ad/noindex URLs idempotently', async () => {
    const db = await createTestDb()
    await seed(db)
    expect(await planPublications(db)).toMatchObject({ candidates: 2, created: 2 })
    const rows = await db.select().from(publications)
    expect(rows.map((row) => [row.url, row.indexPolicy]).sort()).toEqual([
      ['https://law.example/case/alpha-publish', 'index'],
      ['https://law.example/response/alpha-publish', 'noindex'],
    ])
    expect(await planPublications(db)).toMatchObject({ created: 0, unchanged: 2 })
  })

  it('stores post-deploy gates and advances pending publication/content to live/published', async () => {
    const db = await createTestDb()
    const { seo } = await seed(db)
    await planPublications(db)
    const [publication] = await db.select().from(publications)
      .where(eq(publications.contentAssetId, seo.id))
    const invalidations: PublicationCacheInvalidation[] = []
    const result = await recordPublicationVerification(db, {
      publicationId: publication.id,
      verification: { ...passing, verifiedVersion: '1' },
      checkedAt: new Date('2026-08-10T01:00:00Z'),
      invalidateCache: (event) => { invalidations.push(event) },
    })
    expect(result).toMatchObject({ publication: { status: 'live' }, reasonCodes: [], canIndex: true })
    expect((await db.select().from(publicationChecks))).toHaveLength(1)
    const [asset] = await db.select().from(contentAssets).where(eq(contentAssets.id, seo.id))
    expect(asset.status).toBe('published')
    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]).toMatchObject({
      reason: 'became-live',
      paths: ['/case/alpha-publish', '/f/alpha-publish'],
      previousStatus: 'pending',
      status: 'live',
    })
  })

  it('invalidates immediately when a live publication is replanned for a new deployed version', async () => {
    const db = await createTestDb()
    const { seo } = await seed(db)
    await planPublications(db)
    const [publication] = await db.select().from(publications)
      .where(eq(publications.contentAssetId, seo.id))
    await recordPublicationVerification(db, {
      publicationId: publication.id,
      verification: { ...passing, verifiedVersion: '1' },
    })
    await db.update(contentAssets).set({ contentVersion: 2, status: 'approved' })
      .where(eq(contentAssets.id, seo.id))

    const invalidations: PublicationCacheInvalidation[] = []
    const result = await planPublications(db, {
      invalidateCache: (event) => { invalidations.push(event) },
    })

    expect(result).toMatchObject({ candidates: 2, updated: 1 })
    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]).toMatchObject({
      reason: 'deployed-version-changed',
      previousStatus: 'live',
      status: 'pending',
      previousDeployedVersion: '1',
      deployedVersion: '2',
      paths: ['/case/alpha-publish', '/f/alpha-publish'],
    })
  })

  it('blocks a placeholder-bearing deployment and records the exact reason', async () => {
    const db = await createTestDb()
    const { ad } = await seed(db)
    await planPublications(db)
    const [publication] = await db.select().from(publications)
      .where(eq(publications.contentAssetId, ad.id))
    const result = await recordPublicationVerification(db, {
      publicationId: publication.id,
      verification: { ...passing, placeholderFree: false },
    })
    expect(result.publication.status).toBe('blocked')
    expect(result.reasonCodes).toEqual(['placeholder_found'])
  })

  it('does not plan a publication for an unverified canonical hostname', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 52, slug: 'unverified', name: 'Unverified Firm', adLawyerName: 'Lawyer',
      phone: '02-0000-0001', phoneIntl: '+82-2-0000-0001', address: 'Seoul',
      addressRegion: 'Seoul', addressLocality: 'Seoul', domain: 'unverified.example', landingReady: true,
    })
    await db.insert(firmDomains).values({
      firmId: 52, hostname: 'unverified.example', isCanonical: true, status: 'pending', tlsStatus: 'valid',
    })
    const [caseRow] = await db.insert(caseEntities).values({
      canonicalName: 'Unverified Case', slug: 'unverified-case', category: 'coin', status: 'approved',
    }).returning()
    await db.insert(contentAssets).values({
      firmId: 52, caseEntityId: caseRow.id, assetType: 'seo_page', status: 'approved',
      templateVersion: 'seo-v1', contentVersion: 1, content: {},
    })

    expect(await planPublications(db)).toMatchObject({ candidates: 1, created: 0, skippedNoDomain: 1 })
    expect(await db.select().from(publications)).toHaveLength(0)
  })
})
