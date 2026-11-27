import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  caseEntities,
  contentAssets,
  firmPolicies,
  firms,
  outboxEvents,
} from '@/lib/db/schema'
import {
  CustomerAdPolicyValidationError,
  getFirmAdPolicyView,
  saveFirmAdPolicy,
} from '@/domains/advertising/customer-policy'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function seedFirmCase(db: TestDb, firmId: number, slug: string) {
  await db.insert(firms).values({
    id: firmId,
    slug: `firm-${firmId}`,
    name: `Firm ${firmId}`,
    adLawyerName: `Lawyer ${firmId}`,
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Gangnam',
  })
  const [caseEntity] = await db.insert(caseEntities).values({
    canonicalName: slug,
    slug,
    category: 'coin',
    status: 'approved',
  }).returning()
  const [asset] = await db.insert(contentAssets).values({
    firmId,
    caseEntityId: caseEntity.id,
    assetType: 'ad_landing',
    status: 'approved',
    templateVersion: 'ad-v1',
    contentVersion: 1,
    content: {},
  }).returning()
  return { caseEntity, asset }
}

describe('customer-approved advertising policy', () => {
  it('persists an explicit tenant scope, dual-writes legacy bounds, and appends an idempotent audit event', async () => {
    const db = await createTestDb()
    const { caseEntity } = await seedFirmCase(db, 301, 'policy-case')
    const input = {
      firmId: 301,
      monthlyBudget: 1_000_000,
      dailyBudget: 50_000,
      bidCeiling: 1_500,
      allowedCaseEntityIds: [caseEntity.id],
      allowedActions: ['register', 'activate', 'pause', 'recommend_pause'],
      autoSubmit: false,
      approvedBy: 'firm:301:dashboard',
      reason: '대표변호사가 파일럿 범위와 예산을 확인함',
      occurredAt: new Date('2026-08-10T08:00:00Z'),
    } as const

    const first = await saveFirmAdPolicy(db, input)
    expect(first).toMatchObject({ inserted: true, updated: false, unchanged: false, auditEventInserted: true })
    expect(first.policy).toMatchObject({
      firmId: 301,
      monthlyBudget: 1_000_000,
      dailyBudget: 50_000,
      bidCeiling: 1_500,
      allowedCaseEntityIds: [caseEntity.id],
      approvedBy: 'firm:301:dashboard',
    })
    expect(first.policy.policyVersion).toMatch(/^firm-301-ad-policy-v1-/)

    const [firm] = await db.select().from(firms).where(eq(firms.id, 301))
    expect(firm.adConfig).toMatchObject({ bidAmt: 1_500, dailyBudget: 50_000, useDailyBudget: true })
    expect((await db.select().from(outboxEvents))[0]).toMatchObject({
      eventType: 'firm.ad_policy.approved',
      aggregateType: 'firm_ad_policy',
      firmId: 301,
    })

    const replay = await saveFirmAdPolicy(db, input)
    expect(replay).toMatchObject({ inserted: false, updated: false, unchanged: true, auditEventInserted: false })
    expect(await db.select().from(firmPolicies)).toHaveLength(1)
    expect(await db.select().from(outboxEvents)).toHaveLength(1)

    const view = await getFirmAdPolicyView(db, 301)
    expect(view.approved).toBe(true)
    expect(view.cases).toEqual([expect.objectContaining({ id: caseEntity.id, canonicalName: 'policy-case' })])
  })

  it('fails closed for invalid limits, unsupported actions, and cases outside the firm', async () => {
    const db = await createTestDb()
    const own = await seedFirmCase(db, 311, 'own-case')
    const other = await seedFirmCase(db, 312, 'other-case')
    const base = {
      firmId: 311,
      monthlyBudget: 100_000,
      dailyBudget: 10_000,
      bidCeiling: 500,
      allowedCaseEntityIds: [own.caseEntity.id],
      allowedActions: ['register', 'pause'],
      approvedBy: 'firm:311:dashboard',
      reason: '고객이 허용 범위를 직접 확인함',
    }

    await expect(saveFirmAdPolicy(db, { ...base, dailyBudget: 200_000 }))
      .rejects.toBeInstanceOf(CustomerAdPolicyValidationError)
    await expect(saveFirmAdPolicy(db, { ...base, bidCeiling: 69 }))
      .rejects.toThrow(/bidCeiling must be at least 70/)
    await expect(saveFirmAdPolicy(db, { ...base, allowedActions: ['delete_everything'] }))
      .rejects.toThrow(/unsupported advertising actions/)
    await expect(saveFirmAdPolicy(db, { ...base, allowedCaseEntityIds: [other.caseEntity.id] }))
      .rejects.toThrow(/not approved for this firm/)
    expect(await db.select().from(firmPolicies)).toHaveLength(0)
    expect(await db.select().from(outboxEvents)).toHaveLength(0)
  })
})
