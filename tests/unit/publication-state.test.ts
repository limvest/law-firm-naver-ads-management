import { describe, expect, it } from 'vitest'
import {
  INDEX_POLICIES,
  PUBLICATION_STATUSES,
  PUBLICATION_TRANSITIONS,
  PublicationPolicyError,
  PublicationTransitionError,
  assertCanIndexPublication,
  assertIndexPolicy,
  canIndexPublication,
  canTransitionPublication,
  decidePublicationStatus,
  getDeploymentVerificationIssues,
  getPublicationVerificationIssues,
  isDeploymentVerificationPassing,
  isIndexPolicyAllowed,
  transitionPublication,
  transitionPublicationStatus,
  type DeploymentVerification,
  type Publication,
} from '@/domains/publishing'

const passingCheck: DeploymentVerification = {
  statusCode: 200,
  canonicalOk: true,
  ctaOk: true,
  brandOk: true,
  placeholderFree: true,
}

const seoPublication: Publication = {
  status: 'pending',
  assetType: 'seo_page',
  indexPolicy: 'index',
  deployedVersion: 'v3',
  expectedVersion: 'v3',
}

const adPublication: Publication = {
  status: 'pending',
  assetType: 'ad_landing',
  indexPolicy: 'noindex',
  deployedVersion: 'v3',
  expectedVersion: 'v3',
}

describe('publication lifecycle graph', () => {
  it('exposes only the explicit production states and edges', () => {
    expect(PUBLICATION_STATUSES).toEqual([
      'pending',
      'live',
      'stale',
      'failed',
      'blocked',
    ])
    expect(PUBLICATION_TRANSITIONS).toEqual({
      pending: ['live', 'failed', 'blocked'],
      live: ['stale', 'failed', 'blocked'],
      stale: ['pending', 'failed', 'blocked'],
      failed: ['pending', 'blocked'],
      blocked: [],
    })

    for (const from of PUBLICATION_STATUSES) {
      for (const to of PUBLICATION_STATUSES) {
        expect(
          canTransitionPublication(from, to),
          `${from} -> ${to}`,
        ).toBe(PUBLICATION_TRANSITIONS[from].includes(to))
      }
    }
    expect(transitionPublicationStatus('pending', 'live')).toBe('live')
    expect(() => transitionPublicationStatus('live', 'pending')).toThrow(
      PublicationTransitionError,
    )
  })
})

describe('deployment verification', () => {
  it('requires 2xx, canonical, CTA, brand, and placeholder-free gates', () => {
    expect(isDeploymentVerificationPassing(passingCheck)).toBe(true)
    expect(getDeploymentVerificationIssues({
      statusCode: 500,
      canonicalOk: false,
      ctaOk: false,
      brandOk: false,
      placeholderFree: false,
    }).map((issue) => issue.code)).toEqual([
      'http_status_not_2xx',
      'canonical_mismatch',
      'cta_missing',
      'brand_mismatch',
      'placeholder_found',
    ])
    expect(getDeploymentVerificationIssues(undefined)).toEqual([
      { code: 'verification_missing' },
    ])
  })

  it('accepts the adapter aliases without weakening the gates', () => {
    expect(isDeploymentVerificationPassing({
      httpStatus: 204,
      canonical: true,
      cta: true,
      brand: true,
      placeholdersFree: true,
    })).toBe(true)
    expect(isDeploymentVerificationPassing({ ...passingCheck, stale: true })).toBe(
      false,
    )
  })
})

describe('index/noindex policy and deterministic status decisions', () => {
  it('keeps ad landing noindex and gates SEO index on every check', () => {
    expect(INDEX_POLICIES).toEqual(['index', 'noindex'])
    expect(isIndexPolicyAllowed('seo_page', 'index')).toBe(false)
    expect(isIndexPolicyAllowed('seo_page', 'index', passingCheck)).toBe(true)
    expect(isIndexPolicyAllowed('ad_landing', 'index')).toBe(false)
    expect(isIndexPolicyAllowed('ad_landing', 'noindex')).toBe(true)
    expect(isIndexPolicyAllowed('seo_page', 'index', {
      ...passingCheck,
      ctaOk: false,
    })).toBe(false)
    expect(() => assertIndexPolicy('ad_landing', 'index')).toThrow(
      'ad_landing publications must use noindex',
    )
    expect(() => assertIndexPolicy('seo_page', 'index', {
      ...passingCheck,
      brandOk: false,
    })).toThrow(PublicationPolicyError)
  })

  it('returns pending without a check and live/indexable only after all gates', () => {
    const pending = decidePublicationStatus(seoPublication)
    expect(pending).toMatchObject({
      status: 'pending',
      reasonCodes: ['verification_missing'],
      allGatesPassed: false,
      canIndex: false,
    })

    const live = decidePublicationStatus(seoPublication, passingCheck)
    expect(live).toEqual({
      status: 'live',
      reasons: [],
      reasonCodes: [],
      allGatesPassed: true,
      canIndex: true,
    })
    expect(canIndexPublication(seoPublication, passingCheck)).toBe(true)
    expect(() => assertCanIndexPublication(seoPublication, passingCheck)).not.toThrow()
  })

  it('classifies technical failures, quality blocks, and stale versions deterministically', () => {
    const failed = decidePublicationStatus(seoPublication, {
      statusCode: 503,
      canonicalOk: false,
      ctaOk: false,
      brandOk: false,
      placeholderFree: false,
    })
    expect(failed.status).toBe('failed')
    expect(failed.reasonCodes).toEqual([
      'http_status_not_2xx',
      'canonical_mismatch',
      'cta_missing',
      'brand_mismatch',
      'placeholder_found',
    ])

    const blocked = decidePublicationStatus(seoPublication, {
      ...passingCheck,
      placeholderFree: false,
    })
    expect(blocked.status).toBe('blocked')
    expect(blocked.reasonCodes).toEqual(['placeholder_found'])
    expect(blocked.canIndex).toBe(false)

    const stale = decidePublicationStatus(
      { ...seoPublication, deployedVersion: 'v2' },
      passingCheck,
    )
    expect(stale.status).toBe('stale')
    expect(stale.reasonCodes).toEqual(['deployed_version_stale'])
    expect(stale.canIndex).toBe(false)
  })

  it('blocks an ad landing configured for index even when its page is healthy', () => {
    const decision = decidePublicationStatus(
      { ...adPublication, indexPolicy: 'index' },
      passingCheck,
    )
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toEqual(['ad_landing_must_be_noindex'])
    expect(decision.canIndex).toBe(false)
    expect(getPublicationVerificationIssues(
      { ...adPublication, indexPolicy: 'index' },
      passingCheck,
    )).toEqual([{ code: 'ad_landing_must_be_noindex' }])
  })
})

describe('verification-gated record transitions', () => {
  it('requires a passing check before entering live and does not mutate input', () => {
    expect(() => transitionPublication(seoPublication, 'live')).toThrow(
      'publication cannot become live',
    )
    expect(() => transitionPublication(seoPublication, 'live', {
      verification: { ...passingCheck, canonicalOk: false },
    })).toThrow('canonical_mismatch')

    const live = transitionPublication(seoPublication, 'live', {
      verification: passingCheck,
    })
    expect(live.status).toBe('live')
    expect(seoPublication.status).toBe('pending')
  })

  it('allows explicit operational degradation edges but never reactivates blocked records', () => {
    const live = { ...seoPublication, status: 'live' as const }
    const stale = transitionPublication(live, 'stale')
    expect(stale.status).toBe('stale')
    expect(transitionPublication(stale, 'pending').status).toBe('pending')

    const blocked = { ...seoPublication, status: 'blocked' as const }
    expect(() => transitionPublication(blocked, 'pending')).toThrow(
      PublicationTransitionError,
    )
  })
})
