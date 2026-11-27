import { beforeEach, describe, expect, it } from 'vitest'
import { asc, eq, sql } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, leads, productLeadProfiles, productLeadStageHistory } from '@/lib/db/schema'
import {
  calculateGtmGateProgress,
  getGtmPipeline,
  listProductLeadProfiles,
  setProductLeadFollowUp,
  transitionProductLeadStage,
} from '@/domains/gtm'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function ensureProductLeadProfileTable(db: TestDb): Promise<void> {
  // The parent agent owns generated migrations. Keeping this fixture additive
  // lets the focused tests run before that migration is generated as well.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "product_lead_profiles" (
      "lead_id" uuid PRIMARY KEY NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
      "firm_id" integer NOT NULL REFERENCES "firms"("id"),
      "package_interest" text DEFAULT 'founding_pilot' NOT NULL,
      "managed_ops" boolean DEFAULT false NOT NULL,
      "budget_band" text,
      "team_size" text,
      "repeat_fraud_matters" text,
      "own_domain" text,
      "naver_account" text,
      "response_owner" text,
      "outcome_tracking" text,
      "stage" text DEFAULT 'targeted' NOT NULL,
      "follow_up_at" timestamp with time zone,
      "lost_reason" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `)
}

async function seedProfile(
  db: TestDb,
  input: { firmId: number; stage?: string },
): Promise<string> {
  const [lead] = await db.insert(leads).values({
    firmId: input.firmId,
    vertical: 'product',
    nameEnc: 'encrypted-office',
    phoneEnc: 'encrypted-phone',
  }).returning({ id: leads.id })
  await db.insert(productLeadProfiles).values({
    leadId: lead.id,
    firmId: input.firmId,
    packageInterest: 'founding_pilot',
    stage: input.stage ?? 'targeted',
  })
  await db.insert(productLeadStageHistory).values({
    leadId: lead.id,
    firmId: input.firmId,
    fromStage: null,
    toStage: input.stage ?? 'targeted',
    evidenceNote: '테스트 타깃 근거',
    actor: 'test',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
  })
  return lead.id
}

describe('founder-led GTM pipeline', () => {
  let db: TestDb

  beforeEach(async () => {
    db = await createTestDb()
    await ensureProductLeadProfileTable(db)
    await db.insert(firms).values([
      { id: 1, slug: 'platform', name: 'Platform', adLawyerName: 'Operator', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'r', addressLocality: 'l', status: 'active' },
      { id: 2, slug: 'other', name: 'Other', adLawyerName: 'Operator', phone: '2', phoneIntl: '2', address: 'x', addressRegion: 'r', addressLocality: 'l', status: 'active' },
    ])
  })

  it('lists only the requested firm/platform scope and omits lead PII', async () => {
    const platformLead = await seedProfile(db, { firmId: 1 })
    await seedProfile(db, { firmId: 2 })

    const rows = await listProductLeadProfiles(db, { platformFirmId: 1 })
    expect(rows.map((row) => row.leadId)).toEqual([platformLead])
    expect(rows[0]).not.toHaveProperty('nameEnc')
    expect(rows[0]).not.toHaveProperty('phoneEnc')

    const pipeline = await getGtmPipeline(db, { firmId: 1 })
    expect(pipeline.firmId).toBe(1)
    expect(pipeline.rows).toHaveLength(1)
    expect(pipeline.rows[0].history).toHaveLength(1)
    expect(pipeline.rows[0].history?.[0].evidenceNote).toBe('테스트 타깃 근거')
  })

  it('rejects skipped transitions, requires lost reason, and protects cross-firm mutations', async () => {
    const leadId = await seedProfile(db, { firmId: 1 })
    const otherLeadId = await seedProfile(db, { firmId: 2 })

    await expect(transitionProductLeadStage(db, {
      firmId: 1,
      leadId,
      toStage: 'demo',
    })).rejects.toThrow('invalid product lead stage transition')
    await expect(transitionProductLeadStage(db, {
      firmId: 1,
      leadId,
      toStage: 'lost',
    })).rejects.toThrow('lostReason is required')
    const contacted = await transitionProductLeadStage(db, {
      firmId: 1,
      leadId,
      toStage: 'contacted',
      now: new Date('2026-08-10T00:00:00.000Z'),
    })
    expect(contacted?.stage).toBe('contacted')
    await expect(transitionProductLeadStage(db, {
      firmId: 1,
      leadId,
      toStage: 'interview',
    })).rejects.toThrow('evidenceNote is required')
    expect(await transitionProductLeadStage(db, {
      firmId: 2,
      leadId,
      toStage: 'interview',
    })).toBeNull()
    expect(await transitionProductLeadStage(db, {
      firmId: 1,
      leadId: otherLeadId,
      toStage: 'contacted',
    })).toBeNull()

    const lost = await transitionProductLeadStage(db, {
      firmId: 1,
      leadId,
      toStage: 'lost',
      lostReason: '예산 보류',
      evidenceNote: '90일 파일럿 예산 보류를 확인',
    })
    expect(lost?.stage).toBe('lost')
    expect(lost?.lostReason).toBe('예산 보류')
    const history = await db.select().from(productLeadStageHistory)
      .where(eq(productLeadStageHistory.leadId, leadId))
      .orderBy(asc(productLeadStageHistory.createdAt))
    expect(history.map((event) => event.toStage)).toEqual(['targeted', 'contacted', 'lost'])
    expect(history.at(-1)?.evidenceNote).toBe('90일 파일럿 예산 보류를 확인')
  })

  it('stores a firm-scoped follow-up date', async () => {
    const leadId = await seedProfile(db, { firmId: 1 })
    const followUp = new Date('2026-08-15T04:00:00.000Z')
    const updated = await setProductLeadFollowUp(db, {
      firmId: 1,
      leadId,
      followUpAt: followUp,
      now: new Date('2026-08-10T00:00:00.000Z'),
    })
    expect(updated?.followUpAt?.toISOString()).toBe(followUp.toISOString())
    expect(await setProductLeadFollowUp(db, {
      firmId: 2,
      leadId,
      followUpAt: null,
    })).toBeNull()
  })

  it('counts reached milestones from history rather than current stage', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, index) => ({ leadId: `target-${index}`, stage: 'targeted' })),
      ...Array.from({ length: 10 }, (_, index) => ({ leadId: `interview-${index}`, stage: 'interview' })),
      ...Array.from({ length: 5 }, (_, index) => ({ leadId: `demo-${index}`, stage: 'demo' })),
      { leadId: 'pilot-1', stage: 'pilot' },
      { leadId: 'lost-1', stage: 'lost' },
      { leadId: 'target-0', stage: 'targeted' }, // duplicate IDs cannot inflate a gate
    ] as const
    const history = rows
      .filter((row, index, all) => all.findIndex((candidate) => candidate.leadId === row.leadId) === index)
      .map((row) => ({
        leadId: row.leadId,
        fromStage: row.stage === 'targeted' ? null : 'targeted',
        toStage: row.stage,
      }))
    const gates = calculateGtmGateProgress(rows.map((row) => ({ ...row, stage: 'lost' })), history)
    expect(gates).toEqual([
      { key: 'targets', label: '목표 사무소', target: 30, current: 47, remaining: 0, complete: true },
      { key: 'interviews', label: '인터뷰', target: 10, current: 16, remaining: 0, complete: true },
      { key: 'qualifiedDemos', label: '적격 데모', target: 5, current: 6, remaining: 0, complete: true },
      { key: 'paidPilots', label: '유료 파일럿', target: 1, current: 1, remaining: 0, complete: true },
    ])
  })
})
