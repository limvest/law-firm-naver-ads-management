import { describe, expect, it } from 'vitest'
import {
  AD_LANDING_TRANSITIONS,
  SEO_PAGE_TRANSITIONS,
  assertAdLandingTransition,
  assertContentAssetInvariant,
  assertContentAssetTransition,
  assertIndexPolicy,
  assertPublicationInvariant,
  canPublishContentAsset,
  canTransitionAdLanding,
  canTransitionContentAsset,
  canTransitionSeoPage,
  getContentAssetInvariantIssues,
  getPublicationInvariantIssues,
  getReadinessIssues,
  isAdLandingActive,
  isAdLandingTerminal,
  isContentAssetActive,
  isContentAssetTerminal,
  isEvidenceReady,
  isIndexPolicyAllowed,
  isPlaceholderReady,
  isPublicationReady,
  isSeoPageActive,
  isSeoPageTerminal,
  transitionContentAsset,
  transitionSeoPageStatus,
  type AdLandingAsset,
  type ContentReadiness,
  type Publication,
  type SeoPageAsset,
} from '@/domains/content'

const ready: ContentReadiness = {
  evidence: {
    hasCaseSpecificEvidence: true,
    competitorSitemapTitleOnly: false,
  },
  unresolvedPlaceholders: [],
  deadLinks: [],
  firmInfoValid: true,
  links: ['/f/example', '/contact'],
}

const noEvidence: ContentReadiness = {
  ...ready,
  evidence: {
    hasCaseSpecificEvidence: false,
    competitorSitemapTitleOnly: false,
  },
}

const competitorOnly: ContentReadiness = {
  ...ready,
  evidence: {
    hasCaseSpecificEvidence: true,
    competitorSitemapTitleOnly: true,
  },
}

const seoApproved: SeoPageAsset = {
  id: 'asset-seo-1',
  assetType: 'seo_page',
  caseEntityId: 'case-1',
  firmId: 'firm-1',
  templateVersion: 'seo-v1',
  contentVersion: 'content-v3',
  evidenceSnapshotId: 'evidence-1',
  status: 'approved',
}

const adApproved: AdLandingAsset = {
  id: 'asset-ad-1',
  assetType: 'ad_landing',
  caseEntityId: 'case-1',
  firmId: 'firm-1',
  templateVersion: 'ad-v1',
  contentVersion: 'content-v2',
  evidenceSnapshotId: 'evidence-1',
  status: 'approved',
}

const seoPublication: Publication = {
  contentAssetId: seoApproved.id,
  domainId: 'domain-1',
  url: 'https://firm.example/f/case-1',
  canonicalUrl: 'https://firm.example/f/case-1',
  indexPolicy: 'index',
  deployedVersion: seoApproved.contentVersion,
}

const adPublication: Publication = {
  contentAssetId: adApproved.id,
  domainId: 'domain-1',
  url: 'https://firm.example/ad/case-1',
  canonicalUrl: 'https://firm.example/ad/case-1',
  indexPolicy: 'noindex',
  deployedVersion: adApproved.contentVersion,
}

describe('seo_page state machine', () => {
  it('matches every documented SEO transition and rejects skips', () => {
    expect(SEO_PAGE_TRANSITIONS).toEqual({
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
    })

    expect(canTransitionSeoPage('draft', 'evidence_ready')).toBe(true)
    expect(canTransitionSeoPage('quality_review', 'rejected')).toBe(true)
    expect(canTransitionSeoPage('published', 'stale')).toBe(true)
    expect(canTransitionSeoPage('published', 'blocked')).toBe(true)
    expect(canTransitionSeoPage('draft', 'published')).toBe(false)
    expect(canTransitionSeoPage('indexed', 'draft')).toBe(false)
    expect(transitionSeoPageStatus('approved', 'published')).toBe('published')
  })

  it('derives terminal and active states from the graph', () => {
    expect(isSeoPageTerminal('indexed')).toBe(true)
    expect(isSeoPageTerminal('rejected')).toBe(true)
    expect(isSeoPageTerminal('refreshed')).toBe(true)
    expect(isSeoPageTerminal('blocked')).toBe(true)
    expect(isSeoPageActive('published')).toBe(true)
    expect(isSeoPageActive('stale')).toBe(true)
    expect(isSeoPageActive('blocked')).toBe(false)
  })
})

describe('ad_landing state machine', () => {
  it('matches the separate documented ad transition graph', () => {
    expect(AD_LANDING_TRANSITIONS).toEqual({
      draft: ['brand_review'],
      brand_review: ['approved'],
      approved: ['published'],
      published: ['experiment_live'],
      experiment_live: ['winner', 'retired'],
      winner: [],
      retired: [],
    })

    expect(canTransitionAdLanding('draft', 'brand_review')).toBe(true)
    expect(canTransitionAdLanding('experiment_live', 'winner')).toBe(true)
    expect(canTransitionAdLanding('experiment_live', 'retired')).toBe(true)
    expect(canTransitionAdLanding('draft', 'evidence_ready' as never)).toBe(
      false,
    )
    expect(canTransitionAdLanding('winner', 'published')).toBe(false)
    expect(isAdLandingTerminal('winner')).toBe(true)
    expect(isAdLandingTerminal('retired')).toBe(true)
    expect(isAdLandingActive('experiment_live')).toBe(true)
    expect(isAdLandingActive('retired')).toBe(false)
  })

  it('does not allow a status from the other asset graph', () => {
    expect(
      canTransitionContentAsset('ad_landing', 'draft', 'evidence_ready' as never),
    ).toBe(false)
    expect(
      canTransitionContentAsset('seo_page', 'draft', 'brand_review' as never),
    ).toBe(false)
    expect(() => assertAdLandingTransition('published', 'winner' as never)).toThrow(
      'illegal ad_landing transition',
    )
  })
})

describe('evidence, placeholder, and index policy gates', () => {
  it('requires case-specific evidence and rejects competitor sitemap titles', () => {
    expect(isEvidenceReady(ready.evidence)).toBe(true)
    expect(isEvidenceReady(noEvidence.evidence)).toBe(false)
    expect(isEvidenceReady(competitorOnly.evidence)).toBe(false)
    expect(getReadinessIssues(noEvidence).map((issue) => issue.code)).toContain(
      'missing_case_specific_evidence',
    )
    expect(
      getReadinessIssues(competitorOnly).map((issue) => issue.code),
    ).toContain('competitor_sitemap_title_only')
  })

  it('blocks unresolved placeholders, # links, and invalid firm details', () => {
    const incomplete: ContentReadiness = {
      ...ready,
      unresolvedPlaceholders: ['{{PHONE}}'],
      deadLinks: [],
      links: ['#'],
      firmInfoValid: false,
    }
    expect(isPlaceholderReady(incomplete)).toBe(false)
    expect(getReadinessIssues(incomplete).map((issue) => issue.code)).toEqual([
      'unresolved_placeholder',
      'dead_link',
      'invalid_firm_information',
    ])
  })

  it('allows noindex previews without evidence but gates index publication', () => {
    expect(isIndexPolicyAllowed('seo_page', 'index', ready.evidence)).toBe(true)
    expect(isIndexPolicyAllowed('seo_page', 'index', noEvidence.evidence)).toBe(
      false,
    )
    expect(
      isIndexPolicyAllowed('seo_page', 'noindex', noEvidence.evidence),
    ).toBe(true)
    expect(isIndexPolicyAllowed('ad_landing', 'index', ready.evidence)).toBe(
      false,
    )
    expect(isIndexPolicyAllowed('ad_landing', 'noindex', ready.evidence)).toBe(
      true,
    )
    expect(() => assertIndexPolicy('seo_page', 'index', noEvidence.evidence)).toThrow()
    expect(() => assertIndexPolicy('ad_landing', 'index', ready.evidence)).toThrow(
      'ad_landing publications must use noindex',
    )
  })
})

describe('publication lifecycle invariants', () => {
  it('accepts a fully verified SEO publication and a noindex ad landing', () => {
    expect(isPublicationReady(seoApproved, seoPublication, ready)).toBe(true)
    expect(canPublishContentAsset(seoApproved, seoPublication, ready)).toBe(true)
    expect(isPublicationReady(adApproved, adPublication, ready)).toBe(true)
  })

  it('rejects mismatched versions, assets, URLs, and unsafe readiness', () => {
    expect(
      isPublicationReady(
        seoApproved,
        { ...seoPublication, deployedVersion: 'old-version' },
        ready,
      ),
    ).toBe(false)
    expect(
      isPublicationReady(
        seoApproved,
        { ...seoPublication, contentAssetId: 'other-asset' },
        ready,
      ),
    ).toBe(false)
    expect(
      isPublicationReady(seoApproved, { ...seoPublication, url: '#' }, ready),
    ).toBe(false)
    expect(
      isPublicationReady(seoApproved, { ...seoPublication, canonicalUrl: '/#' }, ready),
    ).toBe(false)
    expect(isPublicationReady(seoApproved, seoPublication, competitorOnly)).toBe(
      false,
    )
    expect(isPublicationReady(seoApproved, seoPublication, { ...ready, links: ['#'] })).toBe(
      false,
    )
    expect(
      getPublicationInvariantIssues(seoApproved, seoPublication, {
        ...ready,
        firmInfoValid: false,
      }).map((issue) => issue.code),
    ).toContain('invalid_firm_information')
    expect(
      isPublicationReady(
        { ...seoApproved, id: '' },
        { ...seoPublication, contentAssetId: '' },
        ready,
      ),
    ).toBe(false)
  })

  it('keeps no-evidence SEO previews noindex-only', () => {
    const preview = { ...seoPublication, indexPolicy: 'noindex' as const }
    expect(isPublicationReady(seoApproved, preview, noEvidence)).toBe(true)
    expect(isPublicationReady(seoApproved, seoPublication, noEvidence)).toBe(false)
  })

  it('requires the lifecycle gate when moving an asset to published', () => {
    expect(() => transitionContentAsset(seoApproved, 'published')).toThrow(
      'publication and readiness checks',
    )
    expect(
      transitionContentAsset(seoApproved, 'published', {
        publication: seoPublication,
        readiness: ready,
      }).status,
    ).toBe('published')
    expect(() =>
      transitionContentAsset(seoApproved, 'published', {
        publication: seoPublication,
        readiness: noEvidence,
      }),
    ).toThrow('publication invariant violation')
    expect(() =>
      transitionContentAsset(
        { ...adApproved, evidenceSnapshotId: null },
        'published',
        { publication: adPublication, readiness: ready },
      ),
    ).toThrow('publication invariant violation')
  })
})

describe('content asset invariants', () => {
  it('requires identity/version fields and an evidence snapshot after draft', () => {
    const invalid = {
      ...seoApproved,
      id: '',
      caseEntityId: ' ',
      firmId: '',
      templateVersion: '',
      contentVersion: '',
      evidenceSnapshotId: null,
      status: 'quality_review' as const,
    }
    expect(getContentAssetInvariantIssues(invalid)).toHaveLength(6)
    expect(() => assertContentAssetInvariant(invalid)).toThrow(
      'content asset invariant violation',
    )
    expect(
      getContentAssetInvariantIssues({
        ...seoApproved,
        status: 'brand_review' as never,
      }),
    ).toContainEqual({ code: 'invalid_status_for_asset_type' })
  })

  it('treats graph leaves as terminal on the asset itself', () => {
    const terminalSeo = { ...seoApproved, status: 'blocked' as const }
    const terminalAd = { ...adApproved, status: 'retired' as const }
    expect(isContentAssetTerminal(terminalSeo)).toBe(true)
    expect(isContentAssetActive(terminalSeo)).toBe(false)
    expect(isContentAssetTerminal(terminalAd)).toBe(true)
    expect(isContentAssetActive(terminalAd)).toBe(false)
  })
})
