import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  adAccounts,
  adDailyStatsV2,
  adExecutions,
  adReviewEvents,
  caseEntities,
  contentAssets,
  firmPolicies,
  firms,
  outboxEvents,
  publications,
} from '@/lib/db/schema'
import {
  getAdvertisingDashboardMetrics,
  planAdAccount,
  planAdExecutions,
  recordAdProviderState,
  recordAdReviewEvent,
  recommendAdDesiredState,
  upsertAdDailyStat,
} from '@/domains/advertising'

const firmValues = (id: number) => ({
  id,
  slug: `advertising-${id}`,
  name: `Advertising Firm ${id}`,
  adLawyerName: 'Test Lawyer',
  phone: '02-0000-0000',
  phoneIntl: '+82-2-0000-0000',
  address: 'Seoul',
  addressRegion: 'Seoul',
  addressLocality: 'Jung-gu',
})

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, firmId: number, prefix: string) {
  await db.insert(firms).values(firmValues(firmId))
  const [caseRow] = await db.insert(caseEntities).values({
    canonicalName: `${prefix} case`,
    slug: `${prefix}-case`,
    category: 'coin',
    status: 'approved',
  }).returning()
  const [asset] = await db.insert(contentAssets).values({
    firmId,
    caseEntityId: caseRow.id,
    assetType: 'ad_landing',
    status: 'approved',
    templateVersion: 'ad-v1',
    contentVersion: 1,
    content: { title: prefix },
  }).returning()
  const [publication] = await db.insert(publications).values({
    firmId,
    contentAssetId: asset.id,
    domain: `${prefix}.example`,
    url: `https://${prefix}.example/response/${prefix}-case`,
    canonicalUrl: `https://${prefix}.example/response/${prefix}-case`,
    indexPolicy: 'noindex',
    status: 'live',
  }).returning()
  await db.insert(firmPolicies).values({
    firmId,
    policyVersion: 'advertising-test-v1',
    allowedActions: ['register', 'activate', 'pause'],
    allowedCaseEntityIds: [caseRow.id],
    monthlyBudget: 100_000,
    dailyBudget: 10_000,
    bidCeiling: 1_000,
    approvedBy: 'test-operator',
    approvedAt: new Date('2026-08-10T00:00:00Z'),
  })
  return { caseRow, asset, publication }
}

describe('advertising repository', () => {
  it('plans accounts and executions idempotently inside a firm', async () => {
    const db = await createTestDb()
    const first = await seedFirm(db, 71, 'alpha')
    await seedFirm(db, 72, 'beta')

    const account1 = await planAdAccount(db, {
      firmId: 71,
      externalCustomerId: 'customer-71',
      status: 'active',
      asOf: '2026-08-10T01:00:00Z',
    })
    expect(account1.created).toBe(true)
    const account2 = await planAdAccount(db, {
      firmId: 71,
      externalCustomerId: 'customer-71',
      status: 'active',
      asOf: '2026-08-10T02:00:00Z',
    })
    expect(account2).toMatchObject({ created: false, updated: false, unchanged: true })

    const firstPlan = await planAdExecutions(db, { firmId: 71, adAccountId: account1.account.id })
    expect(firstPlan).toMatchObject({ candidates: 1, created: 1, updated: 0, unchanged: 0 })
    expect(firstPlan.executions[0]).toMatchObject({
      firmId: 71,
      caseEntityId: first.caseRow.id,
      contentAssetId: first.asset.id,
      publicationId: first.publication.id,
      desiredActive: false,
      status: 'draft',
    })
    const secondPlan = await planAdExecutions(db, { firmId: 71, adAccountId: account1.account.id })
    expect(secondPlan).toMatchObject({ candidates: 1, created: 0, unchanged: 1 })
    expect(await db.select().from(adAccounts)).toHaveLength(1)
    expect(await db.select().from(adExecutions)).toHaveLength(1)
    expect((await db.select().from(adExecutions))[0].firmId).toBe(71)
  })

  it('rejects cross-firm account and execution writes', async () => {
    const db = await createTestDb()
    const first = await seedFirm(db, 81, 'alpha')
    const second = await seedFirm(db, 82, 'beta')
    const account = await planAdAccount(db, { firmId: 81, externalCustomerId: 'customer-81' })
    await expect(planAdExecutions(db, {
      firmId: 82,
      adAccountId: account.account.id,
      contentAssetIds: [second.asset.id],
    })).rejects.toThrow(/belongs to firm 81/)
    expect(first.asset.firmId).toBe(81)
  })

  it('records review events idempotently and upserts daily stats by canonical execution/day', async () => {
    const db = await createTestDb()
    const seeded = await seedFirm(db, 91, 'review')
    const account = await planAdAccount(db, { firmId: 91, externalCustomerId: 'customer-91' })
    const plan = await planAdExecutions(db, { firmId: 91, adAccountId: account.account.id })
    const execution = plan.executions[0]

    const review = {
      firmId: 91,
      adExecutionId: execution.id,
      status: 'approved',
      reason: 'provider accepted',
      observedAt: '2026-08-10T03:00:00Z',
      raw: { reviewId: 'r-1', status: 'accepted' },
    } as const
    expect((await recordAdReviewEvent(db, review)).inserted).toBe(true)
    expect((await recordAdReviewEvent(db, review)).inserted).toBe(false)
    const [updatedExecution] = await db.select().from(adExecutions).where(eq(adExecutions.id, execution.id))
    expect(updatedExecution.reviewStatus).toBe('approved')
    expect(await db.select().from(adReviewEvents)).toHaveLength(1)

    const stat = {
      firmId: 91,
      adExecutionId: execution.id,
      day: '2026-08-10',
      impressions: 1_000,
      clicks: 100,
      spend: 5_000,
      conversions: 4,
      qualifiedLeads: 2,
      retainedMatters: 1,
      syncedAt: '2026-08-10T04:00:00Z',
    } as const
    expect((await upsertAdDailyStat(db, stat)).inserted).toBe(true)
    const updated = await upsertAdDailyStat(db, { ...stat, clicks: 120, spend: 6_000 })
    expect(updated.updated).toBe(true)
    expect(updated.stat.clicks).toBe(120)
    expect(await db.select().from(adDailyStatsV2)).toHaveLength(1)
    expect(seeded.caseRow.id).toBe(execution.caseEntityId)
  })

  it('records legal provider state transitions and external IDs with an append-only event', async () => {
    const db = await createTestDb()
    await seedFirm(db, 96, 'provider-state')
    const account = await planAdAccount(db, { firmId: 96, externalCustomerId: 'customer-96' })
    const plan = await planAdExecutions(db, { firmId: 96, adAccountId: account.account.id })
    const execution = plan.executions[0]

    const submitted = await recordAdProviderState(db, {
      firmId: 96,
      adExecutionId: execution.id,
      status: 'submitted',
      campaignExternalId: 'cmp-96',
      adGroupExternalId: 'grp-96',
      creativeExternalId: 'ad-96',
      bidAmount: 500,
      dailyBudget: 10_000,
      actor: 'worker:naver-submit',
      reason: 'provider objects created',
      observedAt: '2026-08-10T05:30:00Z',
    })
    expect(submitted).toMatchObject({ updated: true, unchanged: false, outboxInserted: true })
    expect(submitted.execution).toMatchObject({
      status: 'submitted',
      campaignExternalId: 'cmp-96',
      adGroupExternalId: 'grp-96',
      creativeExternalId: 'ad-96',
      bidAmount: 500,
      dailyBudget: 10_000,
    })
    expect((await db.select().from(outboxEvents))[0]).toMatchObject({
      eventType: 'ad.submitted',
      aggregateType: 'ad_execution',
      firmId: 96,
    })

    const replay = await recordAdProviderState(db, {
      firmId: 96,
      adExecutionId: execution.id,
      status: 'submitted',
      campaignExternalId: 'cmp-96',
      adGroupExternalId: 'grp-96',
      creativeExternalId: 'ad-96',
      bidAmount: 500,
      dailyBudget: 10_000,
    })
    expect(replay).toMatchObject({ updated: false, unchanged: true, outboxInserted: false })
    expect(await db.select().from(outboxEvents)).toHaveLength(1)
  })

  it('rejects illegal provider state jumps', async () => {
    const db = await createTestDb()
    await seedFirm(db, 97, 'provider-illegal')
    const plan = await planAdExecutions(db, { firmId: 97 })
    await expect(recordAdProviderState(db, {
      firmId: 97,
      adExecutionId: plan.executions[0].id,
      status: 'live',
    })).rejects.toThrow(/illegal ad execution transition/)
  })

  it('reports honest per-case metrics and never executes desired-state recommendations', async () => {
    const db = await createTestDb()
    const seeded = await seedFirm(db, 101, 'metrics')
    const account = await planAdAccount(db, { firmId: 101, externalCustomerId: 'customer-101' })
    const plan = await planAdExecutions(db, {
      firmId: 101,
      adAccountId: account.account.id,
      desiredActive: true,
    })
    const execution = plan.executions[0]
    await db.update(adExecutions).set({ status: 'live', desiredActive: false }).where(eq(adExecutions.id, execution.id))
    await recordAdReviewEvent(db, {
      firmId: 101,
      adExecutionId: execution.id,
      status: 'approved',
      observedAt: '2026-08-10T05:00:00Z',
    })
    await upsertAdDailyStat(db, {
      firmId: 101,
      adExecutionId: execution.id,
      day: '2026-08-10',
      impressions: 2_000,
      clicks: 100,
      cost: 5_000,
      syncedAt: '2026-08-10T06:00:00Z',
    })

    const metrics = await getAdvertisingDashboardMetrics(db, { firmId: 101, asOf: '2026-08-10' })
    expect(metrics.cases).toHaveLength(1)
    expect(metrics.cases[0]).toMatchObject({
      caseEntityId: seeded.caseRow.id,
      impressions: 2_000,
      clicks: 100,
      spend: 5_000,
      cpc: 50,
      reviewStatus: 'approved',
      pacingStatus: 'hold',
    })
    expect(metrics.cases[0].cpc).not.toBe(0)
    expect(metrics.totals.cpc).toBe(50)

    const recommendation = await recommendAdDesiredState(db, {
      firmId: 101,
      asOf: '2026-08-10',
      execute: true,
      dryRun: false,
    })
    expect(recommendation).toMatchObject({
      dryRun: true,
      executed: false,
      externalCalls: 0,
    })
    expect(recommendation.recommendations[0]).toMatchObject({
      action: 'pause',
      recommendation: 'pause',
      allowed: false,
      executable: false,
      wouldExecute: false,
    })
    expect(await db.select().from(adExecutions)).toHaveLength(1)
  })
})
