// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
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
import { getFirmActivationChecklist } from '@/domains/tenancy'
import FirmActivationPage, { metadata } from '../../app/d/[token]/activation/page'

const NOW = new Date('2026-08-10T12:00:00.000Z')
const LAWYERS = [{
  id: 'lawyer-1',
  name: '김테스트 변호사',
  title: '대표변호사',
  badges: ['형사법'],
  photo: null,
  career: ['법률사무소 경력'],
}] as const

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function seedFirm(
  db: TestDb,
  id: number,
  options: { token?: string; domain?: string | null; landingReady?: boolean } = {},
) {
  const [firm] = await db.insert(firms).values({
    id,
    slug: `activation-${id}`,
    name: `활성화 법률사무소 ${id}`,
    adLawyerName: '김테스트 변호사',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: '서울시 테스트로 1',
    addressRegion: '서울',
    addressLocality: '강남구',
    domain: options.domain ?? null,
    status: 'active',
    lawyers: [...LAWYERS],
    wordmark: `TEST-${id}`,
    profileIntro: '사건 기록과 상담 준비 자료를 확인합니다.',
    landingReady: options.landingReady ?? true,
    dashboardToken: options.token ?? `activation-token-${id}`,
  }).returning()
  return firm
}

async function seedApprovedCases(
  db: TestDb,
  firmId: number,
  count: number,
  prefix: string,
) {
  const rows = await db.insert(caseEntities).values(Array.from({ length: count }, (_, index) => ({
    canonicalName: `${prefix} 사건 ${index + 1}`,
    slug: `${prefix}-${index + 1}`,
    category: 'financial-fraud',
    status: 'approved',
    confidence: 8_000,
  }))).returning()
  await db.insert(caseApprovals).values(rows.map((row, index) => ({
    caseEntityId: row.id,
    firmId: null,
    decision: 'approved',
    actorType: 'operator',
    actorId: `operator-${firmId}`,
    policyVersion: 'case-approval-v1',
    reason: 'case-specific evidence reviewed',
    createdAt: new Date(NOW.getTime() + index),
  })))
  return rows
}

async function seedCompleteFirm(db: TestDb, id: number) {
  const firm = await seedFirm(db, id, {
    token: `complete-token-${id}`,
    domain: `firm-${id}.example`,
    landingReady: false,
  })
  await db.update(firms).set({
    adConfig: {
      bidAmt: 500,
      dailyBudget: 10_000,
      useDailyBudget: true,
      channelOk: true,
      pcChannelId: `pc-${id}`,
      mobileChannelId: `mobile-${id}`,
    },
  }).where(eq(firms.id, id))

  await db.insert(firmDomains).values({
    firmId: id,
    hostname: `firm-${id}.example`,
    isCanonical: true,
    status: 'active',
    tlsStatus: 'valid',
    verifiedAt: NOW,
  })
  await db.insert(firmCredentials).values({
    firmId: id,
    provider: 'naver_searchad',
    customerId: `customer-${id}`,
    apiKeyEnc: 'encrypted-api-key',
    secretEnc: 'encrypted-secret',
    verifiedAt: NOW,
  })
  await db.insert(adAccounts).values({
    firmId: id,
    provider: 'naver_searchad',
    externalCustomerId: `customer-${id}`,
    status: 'active',
    verifiedAt: NOW,
  })

  const cases = await seedApprovedCases(db, id, 20, `firm-${id}-case`)
  await db.insert(firmPolicies).values({
    firmId: id,
    policyVersion: `firm-${id}-ad-policy-v1`,
    allowedActions: ['register', 'activate', 'pause'],
    allowedCaseEntityIds: cases.map((row) => row.id),
    monthlyBudget: 100_000,
    dailyBudget: 10_000,
    bidCeiling: 1_500,
    approvedBy: `customer:${id}`,
    approvedAt: NOW,
  })

  const [seoAsset, adAsset] = await db.insert(contentAssets).values([
    {
      firmId: id,
      caseEntityId: cases[0].id,
      assetType: 'seo_page',
      status: 'published',
      templateVersion: 'seo-v1',
      contentVersion: 1,
      content: {},
    },
    {
      firmId: id,
      caseEntityId: cases[0].id,
      assetType: 'ad_landing',
      status: 'published',
      templateVersion: 'ad-v1',
      contentVersion: 1,
      content: {},
    },
  ]).returning()
  const [seoPublication, adPublication] = await db.insert(publications).values([
    {
      firmId: id,
      contentAssetId: seoAsset.id,
      domain: `firm-${id}.example`,
      url: `https://firm-${id}.example/case/${cases[0].slug}`,
      canonicalUrl: `https://firm-${id}.example/case/${cases[0].slug}`,
      indexPolicy: 'index',
      status: 'live',
      deployedVersion: '1',
      lastVerifiedAt: NOW,
    },
    {
      firmId: id,
      contentAssetId: adAsset.id,
      domain: `firm-${id}.example`,
      url: `https://firm-${id}.example/response/${cases[0].slug}`,
      canonicalUrl: `https://firm-${id}.example/response/${cases[0].slug}`,
      indexPolicy: 'noindex',
      status: 'live',
      deployedVersion: '1',
      lastVerifiedAt: NOW,
    },
  ]).returning()

  const [testSession, realSession] = await db.insert(visitorSessions).values([
    {
      id: `activation-test-session-${id}`,
      firmId: id,
      firstCaseEntityId: cases[0].id,
      firstContentAssetId: seoAsset.id,
      firstPublicationId: seoPublication.id,
      firstTouch: { source: 'demo-seed' },
      lastTouch: { source: 'demo-seed' },
      startedAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: `activation-real-session-${id}`,
      firmId: id,
      firstCaseEntityId: cases[0].id,
      firstContentAssetId: adAsset.id,
      firstPublicationId: adPublication.id,
      firstTouch: { source: 'naver' },
      lastTouch: { source: 'naver' },
      startedAt: NOW,
      lastSeenAt: NOW,
    },
  ]).returning()
  const [testLead, realLead] = await db.insert(leads).values([
    {
      firmId: id,
      vertical: 'scam',
      slug: cases[0].slug,
      nameEnc: 'test-name',
      phoneEnc: 'test-phone',
      sessionId: testSession.id,
      caseEntityId: cases[0].id,
      contentAssetId: seoAsset.id,
      publicationId: seoPublication.id,
      utm: { source: 'demo-seed' },
    },
    {
      firmId: id,
      vertical: 'scam',
      slug: cases[0].slug,
      nameEnc: 'real-name',
      phoneEnc: 'real-phone',
      sessionId: realSession.id,
      caseEntityId: cases[0].id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      utm: { source: 'naver', medium: 'organic' },
    },
  ]).returning()
  await db.insert(leadStatusHistory).values({
    firmId: id,
    leadId: realLead.id,
    idempotencyKey: `activation-outcome-${id}`,
    fromStatus: 'new',
    toStatus: 'qualified',
    reason: '고객이 상담 결과를 확인함',
    actor: `firm-dashboard:${id}`,
    createdAt: NOW,
  })
  return { firm, cases, testLead, realLead }
}

describe('firm activation checklist', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL

  beforeEach(() => {
    process.env.DATABASE_URL = 'test://activation'
  })

  afterEach(() => {
    setDbForTesting(null)
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalDatabaseUrl
  })

  it('returns pending for incomplete rows and never infers external readiness', async () => {
    const db = await createTestDb()
    await seedFirm(db, 401, { token: 'incomplete-token-401' })
    setDbForTesting(db)

    const checklist = await getFirmActivationChecklist(db, 401)

    expect(checklist).toMatchObject({ status: 'pending', complete: false, evidenceSource: 'database' })
    expect(checklist?.checks).toHaveLength(8)
    expect(checklist?.checks.filter((item) => item.key !== 'firm_profile').every((item) => item.status === 'pending')).toBe(true)
    expect(checklist?.checksByKey.firm_profile.status).toBe('ready')
    expect(checklist?.checksByKey.domain_tls.detail).toContain('firms.domain')
    expect(checklist?.checksByKey.naver_connection.status).toBe('pending')
  })

  it('keeps approved-case counts tenant-scoped and treats 19/20 as the exact boundary', async () => {
    const db = await createTestDb()
    await seedFirm(db, 402)
    await seedFirm(db, 403)
    const ownCases = await seedApprovedCases(db, 402, 19, 'own')
    const otherCases = await seedApprovedCases(db, 403, 20, 'other')
    await db.insert(firmPolicies).values({
      firmId: 402,
      policyVersion: 'firm-402-policy',
      allowedActions: ['register'],
      allowedCaseEntityIds: ownCases.map((row) => row.id),
      monthlyBudget: 100_000,
      dailyBudget: 10_000,
      bidCeiling: 500,
      approvedBy: 'customer:402',
      approvedAt: NOW,
    })
    await db.insert(firmPolicies).values({
      firmId: 403,
      policyVersion: 'firm-403-policy',
      allowedActions: ['register'],
      allowedCaseEntityIds: otherCases.map((row) => row.id),
      monthlyBudget: 100_000,
      dailyBudget: 10_000,
      bidCeiling: 500,
      approvedBy: 'customer:403',
      approvedAt: NOW,
    })
    setDbForTesting(db)

    const below = await getFirmActivationChecklist(db, 402)
    expect(below?.approvedCases).toMatchObject({ count: 19, minimum: 20, meetsMinimum: false })
    expect(below?.checksByKey.approved_cases.status).toBe('pending')

    const [boundaryCase] = await seedApprovedCases(db, 402, 1, 'own-boundary')
    await db.update(firmPolicies).set({
      allowedCaseEntityIds: [...ownCases.map((row) => row.id), boundaryCase.id],
    }).where(eq(firmPolicies.firmId, 402))

    const atBoundary = await getFirmActivationChecklist(db, 402)
    expect(atBoundary?.approvedCases).toMatchObject({ count: 20, minimum: 20, meetsMinimum: true })
    expect(atBoundary?.approvedCases.count).not.toBe(40)
    expect(atBoundary?.checksByKey.approved_cases.status).toBe('ready')
  })

  it('marks explicit domain/TLS failure blocked, while a missing row remains pending', async () => {
    const db = await createTestDb()
    await seedFirm(db, 404, { domain: 'blocked.example' })
    await db.insert(firmDomains).values({
      firmId: 404,
      hostname: 'blocked.example',
      isCanonical: true,
      status: 'failed',
      tlsStatus: 'invalid',
      verificationError: 'stored verification failure',
    })
    setDbForTesting(db)

    const checklist = await getFirmActivationChecklist(db, 404)

    expect(checklist?.checksByKey.domain_tls.status).toBe('blocked')
    expect(checklist?.status).toBe('blocked')
    expect(checklist?.complete).toBe(false)
  })

  it('calculates a complete tenant from canonical IDs and renders noindex next-action links', async () => {
    const db = await createTestDb()
    await seedCompleteFirm(db, 405)
    setDbForTesting(db)

    const checklist = await getFirmActivationChecklist(db, 405)
    expect(checklist).toMatchObject({ status: 'ready', complete: true })
    expect(checklist?.checks.every((item) => item.status === 'ready')).toBe(true)
    expect(checklist?.approvedCases).toMatchObject({ count: 20, pilotTargetLabel: '50–100' })
    expect(checklist?.leads).toMatchObject({ canonicalLeads: 2, testLeads: 1, realLeads: 1 })

    const page = await FirmActivationPage({ params: Promise.resolve({ token: 'complete-token-405' }) })
    const { container } = render(page)
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(container.querySelector('[data-activation-complete="true"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-activation-check]')).toHaveLength(8)
    expect(container.querySelector('a[href="/d/complete-token-405/profile"]')).toBeTruthy()
    expect(container.querySelector('a[href="/d/complete-token-405/leads"]')).toBeTruthy()
    expect(container.textContent).toContain('ready')
    expect(container.textContent).toContain('50–100')
  })
})
