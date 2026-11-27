import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import {
  adDailyStatsV2,
  adExecutions,
  caseEntities,
  contentAssets,
  firmPolicies,
  firms,
  leadQualifications,
  leads,
  matterOutcomes,
  publications,
  searchIntegrations,
  searchQueryStats,
} from '@/lib/db/schema'
import {
  deriveOpportunityContexts,
  opportunityFirmCaseKey,
} from '@/domains/opportunities/context'

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number, slug: string) {
  await db.insert(firms).values({
    id,
    slug,
    name: `${slug} firm`,
    adLawyerName: 'Test Lawyer',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Jung-gu',
    status: 'active',
  })
}

describe('observed opportunity contexts', () => {
  it('derives search, ad review/CPC, policy and customer outcomes without synthetic defaults', async () => {
    const db = await createTestDb()
    await seedFirm(db, 81, 'context-a')
    await seedFirm(db, 82, 'context-b')
    const [caseEntity] = await db.insert(caseEntities).values({
      canonicalName: 'Context Case',
      slug: 'context-case',
      category: 'coin',
      status: 'approved',
    }).returning()
    const [seoAsset, adAssetA, adAssetB] = await db.insert(contentAssets).values([
      { firmId: 81, caseEntityId: caseEntity.id, assetType: 'seo_page', status: 'published', templateVersion: 'v1', content: {} },
      { firmId: 81, caseEntityId: caseEntity.id, assetType: 'ad_landing', status: 'approved', templateVersion: 'v1', content: {} },
      { firmId: 82, caseEntityId: caseEntity.id, assetType: 'ad_landing', status: 'approved', templateVersion: 'v1', content: {} },
    ]).returning()
    const [publication] = await db.insert(publications).values({
      firmId: 81,
      contentAssetId: seoAsset.id,
      domain: 'context-a.test',
      url: 'https://context-a.test/case/context-case',
      canonicalUrl: 'https://context-a.test/case/context-case',
      indexPolicy: 'index',
      status: 'live',
    }).returning()
    const [integration] = await db.insert(searchIntegrations).values({
      firmId: 81,
      provider: 'naver_search_advisor',
      status: 'active',
      siteUrl: 'https://context-a.test',
    }).returning()
    await db.insert(searchQueryStats).values([
      { integrationId: integration.id, publicationId: publication.id, day: '2026-08-09', query: 'context case', impressions: 120, clicks: 12 },
      { integrationId: integration.id, publicationId: publication.id, day: '2026-06-01', query: 'old data', impressions: 99_999, clicks: 999 },
    ])
    const [executionA, executionB] = await db.insert(adExecutions).values([
      { firmId: 81, caseEntityId: caseEntity.id, contentAssetId: adAssetA.id, status: 'live', reviewStatus: 'approved' },
      { firmId: 82, caseEntityId: caseEntity.id, contentAssetId: adAssetB.id, status: 'rejected', reviewStatus: 'rejected' },
    ]).returning()
    await db.insert(adDailyStatsV2).values([
      { firmId: 81, adExecutionId: executionA.id, day: '2026-08-09', clicks: 10, cost: 5_000 },
      { firmId: 82, adExecutionId: executionB.id, day: '2026-08-09', clicks: 10, cost: 15_000 },
      { firmId: 81, adExecutionId: executionA.id, day: '2026-06-01', clicks: 1, cost: 999_999 },
    ])

    const leadRows = await db.insert(leads).values([
      { firmId: 81, vertical: 'scam', nameEnc: 'a', phoneEnc: 'a', caseEntityId: caseEntity.id },
      { firmId: 81, vertical: 'scam', nameEnc: 'b', phoneEnc: 'b', caseEntityId: caseEntity.id },
      { firmId: 82, vertical: 'scam', nameEnc: 'c', phoneEnc: 'c', caseEntityId: caseEntity.id },
    ]).returning()
    await db.insert(leadQualifications).values([
      { firmId: 81, leadId: leadRows[0].id, status: 'qualified', actor: 'test' },
      { firmId: 81, leadId: leadRows[1].id, status: 'unqualified', actor: 'test' },
      { firmId: 82, leadId: leadRows[2].id, status: 'qualified', actor: 'test' },
    ])
    await db.insert(matterOutcomes).values([
      { firmId: 81, leadId: leadRows[0].id, status: 'retained' },
      { firmId: 81, leadId: leadRows[1].id, status: 'not_retained' },
      { firmId: 82, leadId: leadRows[2].id, status: 'retained' },
    ])
    await db.insert(firmPolicies).values({
      firmId: 81,
      policyVersion: 'context-policy-v1',
      allowedActions: ['content_approve'],
      allowedCaseEntityIds: [caseEntity.id],
    })

    const contexts = await deriveOpportunityContexts(db, {
      caseEntityIds: [caseEntity.id],
      firmIds: [81, 82],
      asOf: '2026-08-10T23:59:59Z',
    })

    expect(contexts.globalByCase.get(caseEntity.id)).toMatchObject({
      searchVolume: 120,
      averageCpc: 1_000,
      reviewProbability: 0.5,
    })
    expect(contexts.firmByCase.get(opportunityFirmCaseKey(81, caseEntity.id))).toEqual({
      qualifiedConsultationRate: 0.5,
      retainedRate: 0.5,
      preference: 1,
    })
    expect(contexts.firmByCase.get(opportunityFirmCaseKey(82, caseEntity.id))).toEqual({
      qualifiedConsultationRate: 1,
      retainedRate: 1,
    })
  })

  it('leaves unobserved metrics missing and validates windows', async () => {
    const db = await createTestDb()
    const contexts = await deriveOpportunityContexts(db, {
      caseEntityIds: ['00000000-0000-0000-0000-000000000001'],
      firmIds: [],
      asOf: '2026-08-10T00:00:00Z',
    })
    expect(contexts.globalByCase.size).toBe(0)
    expect(contexts.firmByCase.size).toBe(0)
    await expect(deriveOpportunityContexts(db, {
      caseEntityIds: [],
      firmIds: [],
      velocityWindowDays: 0,
    })).resolves.toEqual({ globalByCase: new Map(), firmByCase: new Map() })
    await expect(deriveOpportunityContexts(db, {
      caseEntityIds: ['00000000-0000-0000-0000-000000000001'],
      firmIds: [],
      velocityWindowDays: 0,
    })).rejects.toThrow(/positive integer/)
  })
})
