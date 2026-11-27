import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  adAccounts,
  adDailyStatsV2,
  adExecutions,
  adReviewEvents,
  caseAliases,
  caseEntities,
  contentAssets,
  firmCredentials,
  firmPolicies,
  firms,
  operationAlerts,
  publications,
} from '@/lib/db/schema'
import {
  executeApprovedTargetAds,
  TARGET_AD_LIVE_CONFIRMATION,
  type TargetAdWriter,
} from '@/domains/advertising/execution-service'

const NOW = new Date('2026-08-10T03:00:00.000Z')

async function seedEligibleExecution(firmId: number) {
  const db = await createTestDb()
  await db.insert(firms).values({
    id: firmId,
    slug: `target-ad-${firmId}`,
    name: '테스트 법률사무소',
    adLawyerName: '김변호',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: '서울시 테스트로 1',
    addressRegion: '서울특별시',
    addressLocality: '서초구',
    domain: `firm-${firmId}.example`,
    domainAliases: [`www.firm-${firmId}.example`],
    status: 'active',
    landingReady: true,
    adConfig: {
      bidAmt: 500,
      dailyBudget: 10_000,
      useDailyBudget: true,
      channelOk: true,
      pcChannelId: `pc-${firmId}`,
      mobileChannelId: `mobile-${firmId}`,
    },
  })
  const [caseEntity] = await db.insert(caseEntities).values({
    canonicalName: '알파플랫폼',
    slug: `alpha-platform-${firmId}`,
    category: 'financial-fraud',
    status: 'approved',
  }).returning()
  await db.insert(caseAliases).values({
    caseEntityId: caseEntity.id,
    alias: '알파앱',
    normalizedAlias: '알파앱',
  })
  const [asset] = await db.insert(contentAssets).values({
    firmId,
    caseEntityId: caseEntity.id,
    assetType: 'ad_landing',
    status: 'approved',
    templateVersion: 'ad-response-v1',
    contentVersion: 1,
    content: {},
    qualityReport: {
      evidenceReady: true,
      placeholderFree: true,
      linksReady: true,
      brandReady: true,
      complianceReady: true,
      uniqueFacts: 3,
      issues: [],
    },
  }).returning()
  const [publication] = await db.insert(publications).values({
    firmId,
    contentAssetId: asset.id,
    domain: `firm-${firmId}.example`,
    url: `https://firm-${firmId}.example/response/${caseEntity.slug}`,
    canonicalUrl: `https://firm-${firmId}.example/response/${caseEntity.slug}`,
    indexPolicy: 'noindex',
    status: 'live',
    deployedVersion: '1',
    publishedAt: NOW,
    lastVerifiedAt: NOW,
  }).returning()
  await db.insert(firmPolicies).values({
    firmId,
    policyVersion: 'target-ad-policy-v1',
    adAutoSubmit: true,
    allowedActions: ['register', 'activate', 'pause'],
    allowedCaseEntityIds: [caseEntity.id],
    monthlyBudget: 100_000,
    dailyBudget: 10_000,
    bidCeiling: 500,
    approvedBy: 'customer:owner',
    approvedAt: NOW,
  })
  await db.insert(firmCredentials).values({
    firmId,
    provider: 'naver_searchad',
    customerId: `customer-${firmId}`,
    apiKeyEnc: 'encrypted-api-key',
    secretEnc: 'encrypted-secret',
    verifiedAt: NOW,
  })
  const [execution] = await db.insert(adExecutions).values({
    firmId,
    caseEntityId: caseEntity.id,
    contentAssetId: asset.id,
    publicationId: publication.id,
    status: 'draft',
    desiredActive: true,
  }).returning()
  return { db, caseEntity, asset, publication, execution }
}

function successfulWriter(executionId: string) {
  const execute = vi.fn<TargetAdWriter['execute']>(async (input) => ({
    adExecutionId: executionId,
    campaignId: 'campaign-1',
    campaignReused: false,
    adgroupId: 'adgroup-1',
    adGroupId: 'adgroup-1',
    adgroupReused: false,
    keywordIds: input.keywordVariants.map((_, index) => `keyword-${index + 1}`),
    creativeId: 'creative-1',
    creative: { id: 'creative-1', reused: false, idempotency: 'non-idempotent-create' },
    creativeIdempotency: 'non-idempotent-create',
  }))
  return { writer: { execute }, execute }
}

describe('customer-approved target ad execution service', () => {
  it('evaluates the complete scope in dry-run mode without decrypting, mutating, or calling Naver', async () => {
    const { db, execution } = await seedEligibleExecution(911)
    const createWriter = vi.fn(() => { throw new Error('must not construct a live writer') })
    const decryptCredential = vi.fn(() => { throw new Error('must not decrypt in dry-run') })

    const result = await executeApprovedTargetAds(db, { mode: 'dry-run', now: NOW }, {
      createWriter,
      decryptCredential,
    })

    expect(result).toMatchObject({ considered: 1, dryRun: 1, submitted: 0, failed: 0 })
    expect(result.items[0]).toMatchObject({
      adExecutionId: execution.id,
      outcome: 'dry_run',
      reasonCodes: ['dry_run'],
      policyDecision: { approved: true, allowed: false, decision: 'dry_run' },
    })
    expect(createWriter).not.toHaveBeenCalled()
    expect(decryptCredential).not.toHaveBeenCalled()
    expect((await db.select().from(adExecutions))[0].status).toBe('draft')
    expect(await db.select().from(adAccounts)).toHaveLength(0)
  })

  it('submits once behind the persisted barrier and records canonical provider IDs', async () => {
    const { db, execution } = await seedEligibleExecution(912)
    const { writer, execute } = successfulWriter(execution.id)
    const createWriter = vi.fn(() => writer)

    const first = await executeApprovedTargetAds(db, {
      mode: 'live',
      liveConfirmation: TARGET_AD_LIVE_CONFIRMATION,
      now: NOW,
    }, {
      decryptCredential: (value) => `plain:${value}`,
      createWriter,
    })
    const second = await executeApprovedTargetAds(db, {
      mode: 'live',
      liveConfirmation: TARGET_AD_LIVE_CONFIRMATION,
      now: new Date(NOW.getTime() + 1_000),
    }, {
      decryptCredential: (value) => `plain:${value}`,
      createWriter,
    })

    expect(first).toMatchObject({ considered: 1, submitted: 1, providerOutcomeUnknown: 0, failed: 0 })
    expect(second).toMatchObject({ considered: 0, submitted: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toMatchObject({
      adExecutionId: execution.id,
      pcChannelId: 'pc-912',
      mobileChannelId: 'mobile-912',
      bidAmt: 100,
      dailyBudget: 10_000,
      creative: { finalUrl: expect.stringContaining('utm_source=naver') },
    })
    const [stored] = await db.select().from(adExecutions).where(eq(adExecutions.id, execution.id))
    expect(stored).toMatchObject({
      status: 'submitted',
      reviewStatus: 'pending',
      campaignExternalId: 'campaign-1',
      adGroupExternalId: 'adgroup-1',
      creativeExternalId: 'creative-1',
      bidAmount: 100,
      dailyBudget: 10_000,
    })
    expect(await db.select().from(adAccounts)).toHaveLength(1)
    expect(await db.select().from(adReviewEvents)).toHaveLength(1)
  })

  it('blocks automatic retries and opens an operator alert when a provider POST outcome is unknown', async () => {
    const { db, execution } = await seedEligibleExecution(913)
    const execute = vi.fn(async () => { throw new TypeError('simulated transport failure with no response') })
    const createWriter = vi.fn(() => ({ execute }))

    const first = await executeApprovedTargetAds(db, {
      mode: 'live',
      liveConfirmation: TARGET_AD_LIVE_CONFIRMATION,
      now: NOW,
    }, {
      decryptCredential: (value) => value,
      createWriter,
    })
    const second = await executeApprovedTargetAds(db, {
      mode: 'live',
      liveConfirmation: TARGET_AD_LIVE_CONFIRMATION,
      now: new Date(NOW.getTime() + 1_000),
    }, {
      decryptCredential: (value) => value,
      createWriter,
    })

    expect(first).toMatchObject({ considered: 1, providerOutcomeUnknown: 1, submitted: 0 })
    expect(first.items[0]).toMatchObject({
      outcome: 'provider_outcome_unknown',
      reasonCodes: ['provider_outcome_unknown', 'automatic_retry_blocked'],
    })
    expect(second.considered).toBe(0)
    expect(execute).toHaveBeenCalledTimes(1)
    const [stored] = await db.select().from(adExecutions).where(eq(adExecutions.id, execution.id))
    expect(stored).toMatchObject({ status: 'submitted', reviewStatus: 'unknown' })
    const [alert] = await db.select().from(operationAlerts)
    expect(alert).toMatchObject({
      firmId: 913,
      alertType: 'ad.provider_outcome_unknown',
      severity: 'critical',
      status: 'open',
      detail: { adExecutionId: execution.id, automaticRetryBlocked: true, errorType: 'TypeError' },
    })
  })

  it('keeps configuration failures retryable because they occur before the provider barrier', async () => {
    const { db, execution } = await seedEligibleExecution(916)
    const createWriter = vi.fn(() => { throw new Error('must not construct writer') })

    const result = await executeApprovedTargetAds(db, {
      mode: 'live',
      liveConfirmation: TARGET_AD_LIVE_CONFIRMATION,
      now: NOW,
    }, {
      decryptCredential: () => { throw new Error('local key mismatch') },
      createWriter,
    })

    expect(result).toMatchObject({ considered: 1, failed: 1, providerOutcomeUnknown: 0 })
    expect(createWriter).not.toHaveBeenCalled()
    const [stored] = await db.select().from(adExecutions).where(eq(adExecutions.id, execution.id))
    expect(stored.status).toBe('draft')
    expect(await db.select().from(operationAlerts)).toHaveLength(0)
  })

  it('denies a new registration when the projected day exceeds the approved ceiling', async () => {
    const { db, execution } = await seedEligibleExecution(914)
    await db.insert(adDailyStatsV2).values({
      firmId: 914,
      adExecutionId: execution.id,
      day: '2026-08-10',
      cost: 1,
    })
    const createWriter = vi.fn(() => { throw new Error('must not call provider') })

    const result = await executeApprovedTargetAds(db, { mode: 'dry-run', now: NOW }, { createWriter })

    expect(result).toMatchObject({ considered: 1, skipped: 1, dryRun: 0 })
    expect(result.items[0].reasonCodes).toContain('projected_daily_ceiling_exceeded')
    expect(createWriter).not.toHaveBeenCalled()
    expect((await db.select().from(adExecutions))[0].status).toBe('draft')
  })

  it('refuses live mode unless the caller supplies the explicit second confirmation', async () => {
    const { db } = await seedEligibleExecution(915)
    await expect(executeApprovedTargetAds(db, { mode: 'live', now: NOW }))
      .rejects.toThrow('explicit confirmation token')
  })
})
