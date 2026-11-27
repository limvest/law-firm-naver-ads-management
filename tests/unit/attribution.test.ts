import { describe, expect, it } from 'vitest'
import {
  AttributionScopeError,
  createAttribution,
  deriveAttributionCompleteness,
  deriveFunnelCounters,
  deriveFunnelCountersByFirm,
  deriveLeadAttribution,
  getAttributionKey,
  mergeAttribution,
  serializeAttributionKey,
} from '@/domains/acquisition'

const first = {
  touchpointId: 'tp-first',
  sessionId: 'session-1',
  firmId: 7,
  caseEntityId: 'case-1',
  contentAssetId: 'asset-seo-1',
  publicationId: 'publication-1',
  occurredAt: '2026-08-10T00:00:00Z',
  utm: { utm_source: 'naver', utm_medium: 'organic' },
  referrer: 'https://search.naver.com/',
  eventType: 'page_view',
}

const paidLast = {
  touchpointId: 'tp-last',
  sessionId: 'session-1',
  firmId: 7,
  caseEntityId: 'case-1',
  contentAssetId: 'asset-ad-1',
  publicationId: 'publication-2',
  adExecutionId: 'ad-execution-1',
  occurredAt: '2026-08-10T00:01:00Z',
  utm: { utm_campaign: 'campaign-1', utm_medium: 'cpc', utm_source: 'naver' },
  referrer: null,
  eventType: 'form_submit',
}

describe('acquisition attribution', () => {
  it('normalizes the complete tenant-scoped key without mutating UTM input', () => {
    const utm = { utm_medium: 'cpc', utm_source: 'naver' }
    const key = getAttributionKey({ ...paidLast, utm })

    expect(key).toEqual({
      sessionId: 'session-1',
      firmId: '7',
      caseEntityId: 'case-1',
      contentAssetId: 'asset-ad-1',
      publicationId: 'publication-2',
      adExecutionId: 'ad-execution-1',
      utm: { utm_medium: 'cpc', utm_source: 'naver' },
      referrer: null,
    })
    expect(Object.keys(key.utm)).toEqual(['utm_medium', 'utm_source'])
    expect(utm).toEqual({ utm_medium: 'cpc', utm_source: 'naver' })
    expect(serializeAttributionKey({ ...paidLast, utm })).toBe(
      serializeAttributionKey({ ...paidLast, utm: { utm_source: 'naver', utm_medium: 'cpc' } }),
    )
  })

  it('selects first and last touches by timestamp, independent of input order', () => {
    const ordered = createAttribution([paidLast, first])
    const reversed = createAttribution([first, paidLast])

    expect(ordered.firstTouch.touchpointId).toBe('tp-first')
    expect(ordered.lastTouch.touchpointId).toBe('tp-last')
    expect(JSON.stringify(ordered)).toBe(JSON.stringify(reversed))
  })

  it('merges later case/assets in one firm while rejecting session or firm joins', () => {
    const initial = createAttribution(first)
    const merged = mergeAttribution(initial, paidLast)

    expect(merged.firstTouch.touchpointId).toBe('tp-first')
    expect(merged.lastTouch.touchpointId).toBe('tp-last')
    expect(merged.touchpoints).toHaveLength(2)
    expect(initial.touchpoints).toHaveLength(1)

    expect(() => mergeAttribution(initial, { ...paidLast, sessionId: 'other-session' }))
      .toThrow(AttributionScopeError)
    expect(() => mergeAttribution(initial, { ...paidLast, firmId: 8 }))
      .toThrow(AttributionScopeError)
  })

  it('derives conditional ad completeness and reports missing required fields', () => {
    const organic = createAttribution(first)
    const paid = createAttribution(paidLast)

    expect(deriveAttributionCompleteness(organic)).toMatchObject({
      complete: true,
      hasUtmOrReferrer: true,
      hasAdExecutionId: false,
    })
    expect(deriveAttributionCompleteness(paid)).toMatchObject({
      complete: true,
      hasAdExecutionId: true,
    })
    expect(deriveAttributionCompleteness(paid, { requireAdExecution: true })).toMatchObject({
      complete: true,
    })
    expect(deriveAttributionCompleteness(
      createAttribution({ ...paidLast, adExecutionId: null, publicationId: null }),
    )).toMatchObject({
      complete: false,
      missing: ['publicationId', 'adExecutionId'],
    })
  })

  it('derives qualified and retained flags from lifecycle statuses', () => {
    const lead = deriveLeadAttribution({
      leadId: 'lead-1',
      firmId: 7,
      attribution: createAttribution([first, paidLast]),
      statusHistory: [
        { eventType: 'lead.created' },
        { eventType: 'lead.qualified' },
        { eventType: 'matter.retained' },
      ],
    })

    expect(lead).toMatchObject({
      leadId: 'lead-1',
      firmId: '7',
      attributionComplete: true,
      qualified: true,
      retained: true,
    })
  })

  it('rejects a raw lead touchpoint whose firm differs from the lead scope', () => {
    expect(() => deriveLeadAttribution({
      leadId: 'lead-cross-firm',
      firmId: 7,
      touchpoints: [{ ...first, firmId: 8 }],
    })).toThrow(AttributionScopeError)
  })

  it('counts distinct leads and keeps equal lead ids isolated by firm', () => {
    const inputs = [
      {
        leadId: 'lead-same',
        firmId: 7,
        attribution: createAttribution([first, paidLast]),
        qualified: true,
      },
      {
        leadId: 'lead-same',
        firmId: 7,
        attribution: createAttribution({ ...paidLast, occurredAt: '2026-08-10T00:02:00Z' }),
        retained: true,
      },
      {
        leadId: 'lead-same',
        firmId: 8,
        qualified: true,
      },
    ]

    expect(deriveFunnelCounters(inputs)).toEqual({
      totalLeads: 2,
      attributedLeads: 1,
      completeAttributionLeads: 1,
      incompleteAttributionLeads: 1,
      qualifiedLeads: 2,
      retainedLeads: 1,
      qualifiedWithCompleteAttribution: 1,
      retainedWithCompleteAttribution: 1,
    })
    expect(deriveFunnelCounters(inputs, { firmId: 8 })).toMatchObject({
      totalLeads: 1,
      qualifiedLeads: 1,
      retainedLeads: 0,
    })
    expect(deriveFunnelCountersByFirm(inputs)).toMatchObject({
      '7': { totalLeads: 1, qualifiedLeads: 1, retainedLeads: 1 },
      '8': { totalLeads: 1, qualifiedLeads: 1, retainedLeads: 0 },
    })
  })
})
