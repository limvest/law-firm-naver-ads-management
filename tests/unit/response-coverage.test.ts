import { describe, expect, it } from 'vitest'
import { calculateQualifiedResponseCoverage } from '@/domains/tenancy/response-coverage'

const READY_QUALITY = {
  evidenceReady: true,
  placeholderFree: true,
  linksReady: true,
  brandReady: true,
  complianceReady: true,
  uniqueFacts: 2,
  issues: [],
}

const SINCE = new Date('2026-08-04T00:00:00.000Z')
const UNTIL = new Date('2026-08-11T00:00:00.000Z')

describe('weekly qualified response coverage', () => {
  it('counts each firm-case once when a verified evidence-backed SEO or approved ad path first becomes ready', () => {
    const result = calculateQualifiedResponseCoverage({
      since: SINCE,
      until: UNTIL,
      assets: [
        { id: 'seo-a', caseEntityId: 'case-a', assetType: 'seo_page', evidenceSnapshotId: 'evidence-a', qualityReport: READY_QUALITY, createdAt: new Date('2026-08-05T00:00:00Z') },
        { id: 'ad-a', caseEntityId: 'case-a', assetType: 'ad_landing', evidenceSnapshotId: 'evidence-a', qualityReport: READY_QUALITY, createdAt: new Date('2026-08-05T00:00:00Z') },
        { id: 'seo-b', caseEntityId: 'case-b', assetType: 'seo_page', evidenceSnapshotId: 'evidence-b', qualityReport: READY_QUALITY, createdAt: new Date('2026-08-06T00:00:00Z') },
      ],
      publications: [
        { id: 'pub-seo-a', contentAssetId: 'seo-a', status: 'live', indexPolicy: 'index', publishedAt: new Date('2026-08-05T01:00:00Z') },
        { id: 'pub-ad-a', contentAssetId: 'ad-a', status: 'live', indexPolicy: 'noindex', publishedAt: new Date('2026-08-05T01:00:00Z') },
        { id: 'pub-seo-b', contentAssetId: 'seo-b', status: 'live', indexPolicy: 'index', publishedAt: new Date('2026-08-06T01:00:00Z') },
      ],
      checks: [
        { publicationId: 'pub-seo-a', statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true, checkedAt: new Date('2026-08-05T02:00:00Z') },
        { publicationId: 'pub-seo-a', statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true, checkedAt: new Date('2026-08-09T02:00:00Z') },
        { publicationId: 'pub-ad-a', statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true, checkedAt: new Date('2026-08-05T02:30:00Z') },
        { publicationId: 'pub-seo-b', statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true, checkedAt: new Date('2026-08-06T02:00:00Z') },
      ],
      adExecutions: [
        { caseEntityId: 'case-a', contentAssetId: 'ad-a', publicationId: 'pub-ad-a', status: 'live', reviewStatus: 'approved', updatedAt: new Date('2026-08-05T03:00:00Z') },
      ],
    })

    expect(result).toMatchObject({ total: 2, seo: 2, approvedAd: 1, both: 1 })
    expect(result.cases).toEqual([
      { caseEntityId: 'case-a', qualifiedAt: new Date('2026-08-05T02:00:00Z'), paths: ['approved_ad', 'seo'] },
      { caseEntityId: 'case-b', qualifiedAt: new Date('2026-08-06T02:00:00Z'), paths: ['seo'] },
    ])
  })

  it('does not count missing evidence, failed quality, broken CTA, non-live publication, or unapproved ads', () => {
    const assets = ['missing-evidence', 'bad-quality', 'broken-cta', 'not-live', 'unapproved-ad'].map((id) => ({
      id,
      caseEntityId: `case-${id}`,
      assetType: id === 'unapproved-ad' ? 'ad_landing' : 'seo_page',
      evidenceSnapshotId: id === 'missing-evidence' ? null : `evidence-${id}`,
      qualityReport: id === 'bad-quality' ? { ...READY_QUALITY, evidenceReady: false } : READY_QUALITY,
      createdAt: new Date('2026-08-05T00:00:00Z'),
    }))
    const publications = assets.map((asset) => ({
      id: `pub-${asset.id}`,
      contentAssetId: asset.id,
      status: asset.id === 'not-live' ? 'failed' : 'live',
      indexPolicy: asset.assetType === 'ad_landing' ? 'noindex' : 'index',
      publishedAt: new Date('2026-08-05T01:00:00Z'),
    }))
    const checks = publications.map((publication) => ({
      publicationId: publication.id,
      statusCode: 200,
      canonicalOk: true,
      ctaOk: publication.id !== 'pub-broken-cta',
      brandOk: true,
      placeholderFree: true,
      checkedAt: new Date('2026-08-05T02:00:00Z'),
    }))

    expect(calculateQualifiedResponseCoverage({
      since: SINCE,
      until: UNTIL,
      assets,
      publications,
      checks,
      adExecutions: [{
        caseEntityId: 'case-unapproved-ad',
        contentAssetId: 'unapproved-ad',
        publicationId: 'pub-unapproved-ad',
        status: 'live',
        reviewStatus: 'rejected',
        updatedAt: new Date('2026-08-05T03:00:00Z'),
      }],
    }).total).toBe(0)
  })

  it('does not count a routine recheck in a later week as new coverage', () => {
    const result = calculateQualifiedResponseCoverage({
      since: SINCE,
      until: UNTIL,
      assets: [{ id: 'seo-old', caseEntityId: 'case-old', assetType: 'seo_page', evidenceSnapshotId: 'evidence-old', qualityReport: READY_QUALITY, createdAt: new Date('2026-07-01T00:00:00Z') }],
      publications: [{ id: 'pub-old', contentAssetId: 'seo-old', status: 'live', indexPolicy: 'index', publishedAt: new Date('2026-07-01T01:00:00Z') }],
      checks: [
        { publicationId: 'pub-old', statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true, checkedAt: new Date('2026-07-01T02:00:00Z') },
        { publicationId: 'pub-old', statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true, checkedAt: new Date('2026-08-05T02:00:00Z') },
      ],
      adExecutions: [],
    })

    expect(result.total).toBe(0)
  })
})
