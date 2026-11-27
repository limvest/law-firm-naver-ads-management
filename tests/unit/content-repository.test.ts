import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  caseEntities,
  caseEvidenceSnapshots,
  caseOpportunities,
  contentAssets,
  firms,
} from '@/lib/db/schema'
import { buildStructuredContent, bootstrapContentAssets } from '@/domains/content/repository'
import { evaluateContentQuality } from '@/domains/content/quality'

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values({
    id: 21,
    slug: 'firm-21',
    name: '법무법인 봄',
    adLawyerName: '김봄',
    phone: '02-1234-5678',
    phoneIntl: '+82-2-1234-5678',
    address: '서울시 강남구',
    addressRegion: '서울',
    addressLocality: '강남구',
    kakaoUrl: 'https://pf.kakao.com/example',
    // Content review must be possible before the final public activation flag;
    // otherwise activation would depend on assets that can never be created.
    landingReady: false,
  })
}

async function seedCandidate(
  db: Awaited<ReturnType<typeof createTestDb>>,
  input: { slug: string; competitorOnly?: boolean },
) {
  const [caseRow] = await db.insert(caseEntities).values({
    canonicalName: input.slug === 'alpha' ? '알파 프로젝트' : '베타 프로젝트',
    slug: input.slug,
    category: 'coin',
    status: 'approved',
    confidence: 8_000,
  }).returning()
  const [evidence] = await db.insert(caseEvidenceSnapshots).values({
    caseEntityId: caseRow.id,
    observationCount: 3,
    independentSourceCount: 2,
    confidence: 8_000,
    fingerprint: `${input.slug}-evidence-v1`,
    policyVersion: 'case-evidence-v1',
    capturedAt: new Date('2026-08-10T00:00:00Z'),
    facts: {
      methods: ['출금 지연', '추가 입금 요구'],
      infrastructure: [{ type: 'app', value: `${input.slug} app` }],
      amounts: [],
      citations: input.competitorOnly
        ? [
            { sourceUrl: 'https://competitor-a.example/case', sourceFamily: 'competitor-a' },
            { sourceUrl: 'https://competitor-b.example/case', sourceFamily: 'competitor-b' },
          ]
        : [
            { sourceUrl: 'https://news.example/report', sourceFamily: 'news-a' },
            { sourceUrl: 'https://community.example/post', sourceFamily: 'community-b' },
          ],
    },
  }).returning()
  await db.insert(caseOpportunities).values({
    caseEntityId: caseRow.id,
    firmId: 21,
    scopeKey: 'firm:21',
    score: 8_500,
    recommendation: 'publish',
    reasons: ['high confidence'],
    inputSnapshot: { evidenceSnapshotId: evidence.id },
    modelVersion: 'opportunity-v1',
  })
  return { caseRow, evidence }
}

describe('content asset repository', () => {
  it('creates separate reviewable SEO and ad assets from a qualified opportunity', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const { caseRow, evidence } = await seedCandidate(db, { slug: 'alpha' })

    const first = await bootstrapContentAssets(db, { firmIds: [21] })
    expect(first).toMatchObject({ candidates: 1, assetsCreated: 2, seoCreated: 1, adCreated: 1, approved: 0, reviewRequired: 2 })
    const rows = await db.select().from(contentAssets).where(eq(contentAssets.caseEntityId, caseRow.id))
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.assetType).sort()).toEqual(['ad_landing', 'seo_page'])
    expect(rows.find((row) => row.assetType === 'seo_page')?.status).toBe('quality_review')
    expect(rows.find((row) => row.assetType === 'ad_landing')?.status).toBe('brand_review')
    expect(rows.every((row) => row.evidenceSnapshotId === evidence.id)).toBe(true)
    expect(rows.find((row) => row.assetType === 'ad_landing')?.content).toMatchObject({
      assetType: 'ad_landing',
      visual: { strategy: 'template-composition', higgsAssetId: null },
    })
    expect(rows.every((row) => row.qualityReport?.placeholderFree === true
      && row.qualityReport?.evidenceReady === true
      && row.qualityReport?.linksReady === true
      && row.qualityReport?.brandReady === true
      && row.qualityReport?.complianceReady === true
      && row.qualityReport.issues.length === 0)).toBe(true)

    const replay = await bootstrapContentAssets(db, { firmIds: [21] })
    expect(replay).toMatchObject({ assetsCreated: 0, unchanged: 2 })
  })

  it('keeps competitor-sitemap-only evidence in review instead of approving publication', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const { caseRow } = await seedCandidate(db, { slug: 'beta', competitorOnly: true })

    const result = await bootstrapContentAssets(db)
    expect(result).toMatchObject({ assetsCreated: 2, approved: 0, reviewRequired: 2 })
    const rows = await db.select().from(contentAssets).where(eq(contentAssets.caseEntityId, caseRow.id))
    expect(rows.find((row) => row.assetType === 'seo_page')?.status).toBe('draft')
    expect(rows.find((row) => row.assetType === 'ad_landing')?.status).toBe('draft')
    expect(rows[0].qualityReport?.issues).toContain('competitor_sitemap_title_only')
  })

  it('creates a new immutable content version when evidence changes', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const { caseRow } = await seedCandidate(db, { slug: 'alpha' })
    await bootstrapContentAssets(db)
    await db.insert(caseEvidenceSnapshots).values({
      caseEntityId: caseRow.id,
      observationCount: 4,
      independentSourceCount: 3,
      confidence: 9_000,
      fingerprint: 'alpha-evidence-v2',
      policyVersion: 'case-evidence-v1',
      capturedAt: new Date('2026-08-11T00:00:00Z'),
      facts: {
        methods: ['출금 지연'],
        infrastructure: [],
        amounts: ['100만원'],
        citations: [{ sourceUrl: 'https://news.example/new', sourceFamily: 'news-c' }],
      },
    })
    const result = await bootstrapContentAssets(db)
    expect(result.assetsCreated).toBe(2)
    const rows = await db.select().from(contentAssets).where(eq(contentAssets.caseEntityId, caseRow.id))
    expect(rows.map((row) => row.contentVersion).sort()).toEqual([1, 1, 2, 2])
  })

  it('derives quality gates from generated structured fields', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const { caseRow, evidence } = await seedCandidate(db, { slug: 'alpha' })
    const [firm] = await db.select().from(firms).where(eq(firms.id, 21))
    const content = buildStructuredContent({ assetType: 'seo_page', caseEntity: caseRow, evidence, firm })
    const input = {
      assetType: 'seo_page' as const,
      caseEntity: { id: caseRow.id, canonicalName: caseRow.canonicalName, status: caseRow.status },
      evidence: {
        id: evidence.id,
        observationCount: evidence.observationCount,
        independentSourceCount: evidence.independentSourceCount,
        facts: evidence.facts,
      },
      firm: {
        id: firm.id,
        name: firm.name,
        adLawyerName: firm.adLawyerName,
        phone: firm.phone,
        address: firm.address,
        kakaoUrl: firm.kakaoUrl,
        landingReady: firm.landingReady,
      },
      content,
    }

    expect(evaluateContentQuality(input)).toMatchObject({
      evidenceReady: true,
      placeholderFree: true,
      linksReady: true,
      brandReady: true,
      complianceReady: true,
      uniqueFacts: 3,
      issues: [],
    })
    expect(evaluateContentQuality({
      ...input,
      content: { ...content, description: '{{DESCRIPTION}}' },
    })).toMatchObject({ placeholderFree: false, issues: expect.arrayContaining(['content_contains_placeholder']) })
    expect(evaluateContentQuality({
      ...input,
      content: { ...content, disclaimer: '' },
    })).toMatchObject({ complianceReady: false, issues: expect.arrayContaining(['legal_disclaimer_missing']) })
    expect(evaluateContentQuality({
      ...input,
      content: { ...content, cta: { label: '', phone: firm.phone, kakaoUrl: firm.kakaoUrl } },
    })).toMatchObject({ linksReady: false, issues: expect.arrayContaining(['cta_not_ready']) })
    expect(evaluateContentQuality({
      ...input,
      content: {
        ...content,
        cta: { ...(content.cta as Record<string, unknown>), kakaoUrl: '#' },
      },
    })).toMatchObject({
      placeholderFree: false,
      linksReady: false,
      issues: expect.arrayContaining(['content_contains_placeholder']),
    })
    expect(evaluateContentQuality({
      ...input,
      content: { ...content, firm: { ...(content.firm as Record<string, unknown>), name: '다른 사무소' } },
    })).toMatchObject({ brandReady: false, issues: expect.arrayContaining(['firm_brand_not_approved']) })
    expect(evaluateContentQuality({
      ...input,
      content: {
        ...content,
        evidence: {
          ...(content.evidence as Record<string, unknown>),
          methods: [],
          infrastructure: [],
          amounts: [],
        },
      },
    })).toMatchObject({ evidenceReady: false, issues: expect.arrayContaining(['missing_case_specific_evidence']) })
  })

  it('keeps generated placeholders out of the publishable review path', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const { caseRow } = await seedCandidate(db, { slug: 'alpha' })
    await db.update(firms).set({ name: '{{FIRM_NAME}}' }).where(eq(firms.id, 21))

    await bootstrapContentAssets(db)
    const [row] = await db.select().from(contentAssets).where(eq(contentAssets.caseEntityId, caseRow.id))
    expect(row.qualityReport?.placeholderFree).toBe(false)
    expect(row.qualityReport?.issues).toContain('content_contains_placeholder')
    expect(row.status).toBe('draft')
  })
})
