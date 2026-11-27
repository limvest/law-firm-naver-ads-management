import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  firms,
  leadStatusHistory,
  leads,
  outboxEvents,
} from '@/lib/db/schema'
import {
  bookConsultationForFirm,
  getLeadOutcome,
  initializeLeadOutcome,
  outcomeSummaryForFirm,
  qualifyLeadForFirm,
  recordMatterOutcomeForFirm,
  transitionConsultationForFirm,
} from '@/domains/outcomes/repository'

async function seed() {
  const db = await createTestDb()
  await db.insert(firms).values([71, 72].map((id) => ({
    id,
    slug: `outcome-${id}`,
    name: `Outcome Firm ${id}`,
    adLawyerName: `Lawyer ${id}`,
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Seoul',
  })))
  const [lead, otherLead] = await db.insert(leads).values([
    {
      firmId: 71,
      vertical: 'scam',
      slug: 'alpha-outcome',
      nameEnc: 'enc-name',
      phoneEnc: 'enc-phone',
      sessionId: 'session-outcome-1',
      createdAt: new Date('2026-08-11T00:00:00Z'),
    },
    {
      firmId: 72,
      vertical: 'scam',
      slug: 'other-outcome',
      nameEnc: 'enc-name-2',
      phoneEnc: 'enc-phone-2',
      createdAt: new Date('2026-08-11T00:00:00Z'),
    },
  ]).returning()
  return { db, lead, otherLead }
}

describe('outcome repository', () => {
  it('persists an idempotent lead → qualified → consultation → retained chain', async () => {
    const { db, lead } = await seed()
    const created = await initializeLeadOutcome(db, { firmId: 71, leadId: lead.id })
    expect(created.status).toBe('new')

    await qualifyLeadForFirm(db, 71, lead.id, {
      status: 'qualified', actor: 'firm-user:7', reason: 'practice fit',
      occurredAt: new Date('2026-08-12T01:00:00Z'),
    })
    await qualifyLeadForFirm(db, 71, lead.id, {
      status: 'qualified', actor: 'firm-user:7', reason: 'same replay',
      occurredAt: new Date('2026-08-12T01:01:00Z'),
    })
    await bookConsultationForFirm(db, 71, lead.id, {
      actor: 'firm-user:7', scheduledAt: new Date('2026-08-13T01:00:00Z'),
      occurredAt: new Date('2026-08-12T01:02:00Z'),
    })
    await transitionConsultationForFirm(db, 71, lead.id, {
      status: 'completed', actor: 'firm-user:7',
      occurredAt: new Date('2026-08-13T02:00:00Z'),
    })
    const retained = await recordMatterOutcomeForFirm(db, 71, lead.id, {
      status: 'retained', actor: 'firm-user:7', reason: 'engagement signed', feeBand: '10m-30m KRW',
      occurredAt: new Date('2026-08-13T03:00:00Z'),
    })

    expect(retained.status).toBe('matter_retained')
    expect(retained.history.map((row) => row.toStatus)).toEqual([
      'new', 'qualified', 'consultation_booked', 'consultation_completed', 'matter_retained',
    ])
    expect(retained.matterOutcome).toMatchObject({ status: 'retained', feeBand: '10m-30m KRW' })
    const [legacy] = await db.select({ status: leads.status }).from(leads).where(eq(leads.id, lead.id))
    expect(legacy.status).toBe('수임')
    expect(await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, lead.id))).toHaveLength(5)
  })

  it('rejects illegal shortcuts and cross-firm commands without writing outcome rows', async () => {
    const { db, lead } = await seed()
    await expect(bookConsultationForFirm(db, 71, lead.id, { actor: 'firm-user:7' }))
      .rejects.toThrow('only a qualified lead')
    await expect(qualifyLeadForFirm(db, 72, lead.id, {
      status: 'qualified', actor: 'firm-user:8',
    })).rejects.toThrow('lead not found in firm scope')
    expect(await getLeadOutcome(db, 72, lead.id)).toBeNull()
    expect(await db.select().from(leadStatusHistory).where(and(
      eq(leadStatusHistory.firmId, 72),
      eq(leadStatusHistory.leadId, lead.id),
    ))).toHaveLength(0)
  })

  it('summarizes qualified and retained results without calling a form submit a qualification', async () => {
    const { db, lead, otherLead } = await seed()
    await initializeLeadOutcome(db, { firmId: 71, leadId: lead.id })
    let summary = await outcomeSummaryForFirm(db, 71)
    expect(summary).toMatchObject({ totalLeads: 1, qualifiedLeads: 0, retainedMatters: 0 })
    expect(summary.qualificationRate).toBe(0)

    await qualifyLeadForFirm(db, 71, lead.id, { status: 'qualified', actor: 'operator' })
    await bookConsultationForFirm(db, 71, lead.id, { actor: 'operator' })
    await recordMatterOutcomeForFirm(db, 71, lead.id, {
      status: 'retained', actor: 'operator', reason: 'signed', feeBand: '5m-10m KRW',
    })
    summary = await outcomeSummaryForFirm(db, 71)
    expect(summary).toMatchObject({
      totalLeads: 1,
      qualifiedLeads: 1,
      consultationsBooked: 1,
      retainedMatters: 1,
      mattersWithFeeBand: 1,
      attributedQualifiedLeads: 0,
      attributedRetainedMatters: 0,
      feeBands: { '5m-10m KRW': 1 },
    })
    expect(summary.qualificationRate).toBe(1)
    expect(summary.consultationRate).toBe(1)
    expect(summary.retentionRate).toBe(1)
    expect(summary.attributionRate).toBe(0)
    expect((await outcomeSummaryForFirm(db, 72)).totalLeads).toBe(1)
    expect(otherLead.firmId).toBe(72)
  })

  it('requires an explicit reason for retained and not-retained decisions', async () => {
    const { db, lead } = await seed()
    await qualifyLeadForFirm(db, 71, lead.id, { status: 'qualified', actor: 'operator' })
    await bookConsultationForFirm(db, 71, lead.id, { actor: 'operator' })
    await expect(recordMatterOutcomeForFirm(db, 71, lead.id, {
      status: 'not_retained', actor: 'operator',
    })).rejects.toThrow('matter outcome reason is required')
  })
})
