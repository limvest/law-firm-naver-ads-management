import { describe, expect, it } from 'vitest'
import {
  CONSULTATION_TRANSITIONS,
  LEAD_LIFECYCLE_TRANSITIONS,
  MATTER_OUTCOME_TRANSITIONS,
  OutcomeTransitionError,
  FirmIsolationError,
  bookConsultation,
  canTransitionLead,
  createLeadLifecycle,
  deriveFunnelSummary,
  qualifyLead,
  recordFunnelSignal,
  recordMatterOutcome,
  transitionConsultation,
} from '@/domains/outcomes'

const createdAt = '2026-08-10T00:00:00.000Z'

describe('outcome lifecycle transition graph', () => {
  it('keeps qualification, consultation, and matter transitions explicit', () => {
    expect(LEAD_LIFECYCLE_TRANSITIONS).toMatchObject({
      new: ['qualified', 'unqualified'],
      qualified: ['consultation_booked'],
      consultation_cancelled: ['consultation_booked'],
      consultation_no_show: ['consultation_booked'],
      matter_retained: [],
      matter_not_retained: [],
      matter_closed: [],
    })
    expect(CONSULTATION_TRANSITIONS).toEqual({
      booked: ['completed', 'cancelled', 'no_show'],
      completed: [],
      cancelled: ['booked'],
      no_show: ['booked'],
    })
    expect(MATTER_OUTCOME_TRANSITIONS).toEqual({ retained: [], not_retained: [], closed: [] })
    expect(canTransitionLead('new', 'qualified')).toBe(true)
    expect(canTransitionLead('new', 'consultation_booked')).toBe(false)
    expect(canTransitionLead('matter_retained', 'new')).toBe(false)
  })
})

describe('lead qualification, consultation, and matter outcomes', () => {
  it('does not infer qualification from a form submit or consultation from a call click', () => {
    let lifecycle = createLeadLifecycle({
      firmId: 7,
      leadId: 'lead-1',
      signals: ['form_submit', 'call_click'],
      occurredAt: createdAt,
    })

    expect(lifecycle.status).toBe('new')
    expect(lifecycle.qualification.status).toBe('pending')
    expect(lifecycle.consultation).toBeNull()

    lifecycle = recordFunnelSignal(lifecycle, { type: 'call_click', firmId: 7 })
    expect(lifecycle.status).toBe('new')
    expect(lifecycle.consultation).toBeNull()
    expect(() => bookConsultation(lifecycle, { source: 'call_click' })).toThrow(
      'call click is not a consultation',
    )
  })

  it('records immutable history through qualification, consultation, and retained outcome', () => {
    const initial = createLeadLifecycle({ firmId: 7, leadId: 'lead-2', occurredAt: createdAt })
    const qualified = qualifyLead(initial, {
      status: 'qualified',
      reason: 'within practice and evidence is available',
      actor: 'operator:1',
      occurredAt: '2026-08-10T00:01:00Z',
    })
    const booked = bookConsultation(qualified, {
      consultationId: 'consultation-2',
      scheduledAt: '2026-08-11T01:00:00Z',
      occurredAt: '2026-08-10T00:02:00Z',
    })
    const completed = transitionConsultation(booked, 'completed', {
      completedAt: '2026-08-11T02:00:00Z',
    })
    const retained = recordMatterOutcome(completed, {
      status: 'retained',
      reason: 'engagement signed',
      feeBand: '10m-30m KRW',
      occurredAt: '2026-08-11T03:00:00Z',
    })

    expect(retained.status).toBe('matter_retained')
    expect(retained.qualification.status).toBe('qualified')
    expect(retained.consultation?.status).toBe('completed')
    expect(retained.matterOutcome).toMatchObject({
      status: 'retained',
      reason: 'engagement signed',
      feeBand: '10m-30m KRW',
    })
    expect(retained.statusHistory.map((event) => event.eventType)).toEqual([
      'lead.created',
      'lead.qualified',
      'consultation.booked',
      'consultation.completed',
      'matter.retained',
    ])
    expect(retained.history).toBe(retained.statusHistory)
    expect(retained.statusHistory[0].type).toBe('lead.created')
    expect(Object.isFrozen(retained)).toBe(true)
    expect(Object.isFrozen(retained.statusHistory)).toBe(true)
    expect(Object.isFrozen(retained.statusHistory[1])).toBe(true)
    expect(initial.status).toBe('new')
    expect(initial.statusHistory).toHaveLength(1)
  })

  it('requires a reason for not-retained outcomes and leaves fee band optional', () => {
    const qualified = qualifyLead(createLeadLifecycle({ firmId: 7, leadId: 'lead-3' }), 'qualified')
    const booked = bookConsultation(qualified)
    expect(() => recordMatterOutcome(booked, { status: 'not_retained' })).toThrow(
      'matter outcome reason is required',
    )
    const outcome = recordMatterOutcome(booked, {
      status: 'not_retained',
      reason: 'outside budget',
    })
    expect(outcome.matterOutcome).toMatchObject({
      status: 'not_retained',
      reason: 'outside budget',
      feeBand: null,
    })
  })
})

describe('outcome firm isolation and funnel summaries', () => {
  it('rejects cross-firm commands and keeps equal lead IDs isolated by firm', () => {
    const lifecycle = createLeadLifecycle({ firmId: 7, leadId: 'same-lead' })
    expect(() => qualifyLead(lifecycle, { status: 'qualified', firmId: 8 })).toThrow(FirmIsolationError)
    expect(() => recordFunnelSignal(lifecycle, { type: 'form_submit', firmId: 8 })).toThrow(FirmIsolationError)

    const otherFirm = createLeadLifecycle({ firmId: 8, leadId: 'same-lead', signals: ['form_submit'] })
    const summary = deriveFunnelSummary([lifecycle, otherFirm])
    expect(summary.totalLeads).toBe(2)
    expect(summary.formSubmits).toBe(1)
    expect(deriveFunnelSummary([lifecycle, otherFirm], { firmId: 7 }).totalLeads).toBe(1)
  })

  it('counts explicit outcome stages while retaining raw form/call signals as separate funnel facts', () => {
    let lifecycle = createLeadLifecycle({ firmId: 7, leadId: 'lead-4', signals: ['form_submit', 'call_click'] })
    lifecycle = qualifyLead(lifecycle, 'qualified')
    lifecycle = bookConsultation(lifecycle)
    lifecycle = recordMatterOutcome(lifecycle, { status: 'retained', reason: 'signed' })
    const summary = deriveFunnelSummary([lifecycle])

    expect(summary).toMatchObject({
      totalLeads: 1,
      formSubmits: 1,
      callClicks: 1,
      qualifiedLeads: 1,
      consultationsBooked: 1,
      retainedMatters: 1,
      notRetainedMatters: 0,
    })
    expect(summary.formSubmits).not.toBe(summary.qualifiedLeads + 1)
    expect(summary.consultationsBooked).toBe(1)
  })

  it('rejects illegal transitions instead of silently rewriting history', () => {
    const lifecycle = createLeadLifecycle({ firmId: 7, leadId: 'lead-5' })
    expect(() => transitionConsultation(lifecycle, 'completed')).toThrow(OutcomeTransitionError)
    expect(() => qualifyLead(lifecycle, { status: 'qualified', source: 'form_submit' })).toThrow(
      'funnel signal is not a qualification decision',
    )
  })
})
