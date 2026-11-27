import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getFirmActivationChecklist } from '@/domains/tenancy'
import {
  adAccounts,
  caseApprovals,
  caseEntities,
  contentAssets,
  firmCredentials,
  firmDomains,
  firmPolicies,
  firms,
  leadStatusHistory,
  leads,
  publications,
  visitorSessions,
} from '@/lib/db/schema'
import { createTestDb } from '../helpers/test-db'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

function firmValues(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: `activation-${id}`,
    name: `Activation Firm ${id}`,
    adLawyerName: `Lawyer ${id}`,
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Gangnam',
    ...overrides,
  }
}

async function addApprovedCases(
  db: TestDb,
  firmId: number,
  count: number,
  withAssets = true,
  startIndex = 0,
) {
  const rows = await db.insert(caseEntities).values(Array.from({ length: count }, (_, index) => ({
    canonicalName: `Approved case ${firmId}-${startIndex + index}`,
    slug: `approved-case-${firmId}-${startIndex + index}`,
    category: 'financial-fraud',
    status: 'approved',
  }))).returning()
  await db.insert(caseApprovals).values(rows.map((row) => ({
    caseEntityId: row.id,
    firmId: null,
    decision: 'approved',
    actorType: 'operator',
    actorId: 'operator-1',
    policyVersion: 'case-approval-v1',
    reason: 'independent evidence reviewed',
  })))
  if (withAssets) {
    await db.insert(contentAssets).values(rows.map((row) => ({
      firmId,
      caseEntityId: row.id,
      assetType: 'seo_page' as const,
      status: 'published',
      templateVersion: 'seo-v1',
      contentVersion: 1,
      content: {},
    })))
  }
  return rows
}

describe('firm activation checklist', () => {
  it('keeps approved case counts and leads isolated by firm', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      firmValues(401),
      firmValues(402),
    ])
    await addApprovedCases(db, 401, 20)

    const first = await getFirmActivationChecklist(db, 401)
    const second = await getFirmActivationChecklist(db, 402)

    expect(first?.approvedCases.count).toBe(20)
    expect(first?.checksByKey.approved_cases.status).toBe('ready')
    expect(second?.approvedCases.count).toBe(0)
    expect(second?.checksByKey.approved_cases.status).toBe('pending')
  })

  it('treats 19 as pending and 20 as the current activation boundary', async () => {
    const db = await createTestDb()
    await db.insert(firms).values(firmValues(403))
    await addApprovedCases(db, 403, 19)

    const before = await getFirmActivationChecklist(db, 403)
    expect(before?.approvedCases).toMatchObject({ count: 19, minimum: 20, meetsMinimum: false })
    expect(before?.checksByKey.approved_cases.status).toBe('pending')

    await addApprovedCases(db, 403, 1, true, 19)
    const after = await getFirmActivationChecklist(db, 403)
    expect(after?.approvedCases).toMatchObject({ count: 20, minimum: 20, meetsMinimum: true })
    expect(after?.checksByKey.approved_cases.status).toBe('ready')
    expect(after?.approvedCases.pilotTargetLabel).toBe('50–100')
  })

  it('returns pending for incomplete onboarding and blocked for explicit domain failure', async () => {
    const db = await createTestDb()
    await db.insert(firms).values(firmValues(404))

    const incomplete = await getFirmActivationChecklist(db, 404)
    expect(incomplete?.complete).toBe(false)
    expect(incomplete?.status).toBe('pending')
    expect(incomplete?.checks.every((item) => item.status === 'pending')).toBe(true)

    await db.update(firms).set({ domain: 'blocked.example' }).where(eq(firms.id, 404))
    await db.insert(firmDomains).values({
      firmId: 404,
      hostname: 'blocked.example',
      isCanonical: true,
      status: 'failed',
      tlsStatus: 'invalid',
    })
    const blocked = await getFirmActivationChecklist(db, 404)
    expect(blocked?.checksByKey.domain_tls.status).toBe('blocked')
    expect(blocked?.complete).toBe(false)
    expect(blocked?.status).toBe('blocked')
  })

  it('is complete only when every required DB condition is ready', async () => {
    const db = await createTestDb()
    const firmId = 405
    await db.insert(firms).values(firmValues(firmId, {
      domain: 'ready.example',
      status: 'active',
      // Public readiness is the result of this checklist, not an input gate.
      landingReady: false,
      wordmark: 'READY',
      profileIntro: '상담 전 사실관계와 증거를 검토합니다.',
      lawyers: [{ name: '홍길동', title: '대표변호사', badges: [], photo: null, career: ['사법연수원'] }],
      adConfig: {
        bidAmt: 100,
        dailyBudget: 10_000,
        useDailyBudget: true,
        channelOk: true,
        channelCheckedAt: '2026-08-10T00:00:00Z',
        pcChannelId: 'pc-405',
        mobileChannelId: 'mobile-405',
      },
    }))
    await db.insert(firmDomains).values({
      firmId,
      hostname: 'ready.example',
      isCanonical: true,
      status: 'active',
      tlsStatus: 'valid',
    })
    await db.insert(firmCredentials).values({
      firmId,
      provider: 'naver_searchad',
      customerId: 'customer-405',
      apiKeyEnc: 'enc-key',
      secretEnc: 'enc-secret',
      verifiedAt: new Date('2026-08-10T00:00:00Z'),
    })
    await db.insert(adAccounts).values({
      firmId,
      provider: 'naver_searchad',
      externalCustomerId: 'customer-405',
      status: 'active',
      verifiedAt: new Date('2026-08-10T00:00:00Z'),
    })
    const cases = await addApprovedCases(db, firmId, 20, false)
    const [seoAsset, adAsset] = await db.insert(contentAssets).values([
      {
        firmId,
        caseEntityId: cases[0].id,
        assetType: 'seo_page',
        status: 'published',
        templateVersion: 'seo-v1',
        contentVersion: 1,
        content: {},
      },
      {
        firmId,
        caseEntityId: cases[1].id,
        assetType: 'ad_landing',
        status: 'published',
        templateVersion: 'ad-v1',
        contentVersion: 1,
        content: {},
      },
    ]).returning()
    const [seoPublication, adPublication] = await db.insert(publications).values([
      {
        firmId,
        contentAssetId: seoAsset.id,
        domain: 'ready.example',
        url: 'https://ready.example/case/one',
        canonicalUrl: 'https://ready.example/case/one',
        indexPolicy: 'index',
        status: 'live',
      },
      {
        firmId,
        contentAssetId: adAsset.id,
        domain: 'ready.example',
        url: 'https://ready.example/response/two',
        canonicalUrl: 'https://ready.example/response/two',
        indexPolicy: 'noindex',
        status: 'live',
      },
    ]).returning()
    await db.insert(firmPolicies).values({
      firmId,
      policyVersion: 'firm-405-ad-policy-v1',
      allowedActions: ['register', 'activate'],
      allowedCaseEntityIds: cases.map((row) => row.id),
      monthlyBudget: 100_000,
      dailyBudget: 10_000,
      bidCeiling: 500,
      approvedBy: 'customer:405',
      approvedAt: new Date('2026-08-10T00:00:00Z'),
    })
    const [lead] = await db.insert(leads).values({
      firmId,
      vertical: 'scam',
      slug: 'ready-case',
      nameEnc: 'enc-name',
      phoneEnc: 'enc-phone',
      sessionId: 'activation-session-405',
      caseEntityId: cases[0].id,
      contentAssetId: seoAsset.id,
      publicationId: seoPublication.id,
      utm: { source: 'real', medium: 'organic' },
    }).returning()
    await db.insert(visitorSessions).values({
      id: 'activation-session-405',
      firmId,
      firstCaseEntityId: cases[0].id,
      firstContentAssetId: seoAsset.id,
      firstPublicationId: seoPublication.id,
      firstTouch: { source: 'test' },
      lastTouch: { source: 'test' },
    })
    await db.insert(leadStatusHistory).values({
      idempotencyKey: 'activation-outcome-405',
      firmId,
      leadId: lead.id,
      fromStatus: 'new',
      toStatus: 'qualified',
      actor: `firm-dashboard:${firmId}`,
      reason: '고객이 적격 상담으로 갱신',
    })

    const checklist = await getFirmActivationChecklist(db, firmId)
    expect(checklist).toMatchObject({ status: 'ready', complete: true })
    expect(checklist?.checks.every((item) => item.status === 'ready')).toBe(true)
    expect(checklist?.checksByKey.live_surfaces.status).toBe('ready')
    expect(checklist?.checksByKey.canonical_lead.status).toBe('ready')
    expect(checklist?.checksByKey.customer_outcome.status).toBe('ready')
    expect(checklist?.leads).toMatchObject({ canonicalLeads: 1, realLeads: 1 })
    expect(adPublication.id).toBeTruthy()
  })
})
