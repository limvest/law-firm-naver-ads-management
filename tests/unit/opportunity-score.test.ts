import { describe, expect, it } from 'vitest'
import {
  calculateOpportunityScore,
  scoreFirmContext,
  scoreGlobalContext,
  scoreOpportunity,
  type OpportunityFirmContext,
  type OpportunityGlobalContext,
} from '@/domains/opportunities'

const STRONG_GLOBAL: OpportunityGlobalContext = {
  confidence: 1,
  sourceIndependence: 1,
  recencyScore: 1,
  velocityScore: 1,
  searchDemandScore: 1,
  competitionScore: 1,
  cpcScore: 1,
  reviewProbability: 1,
}

const STRONG_FIRM: OpportunityFirmContext = {
  qualifiedConsultationRate: 1,
  retainedRate: 1,
  preference: 1,
  capacity: 1,
}

function withGlobal(overrides: Partial<OpportunityGlobalContext> = {}): OpportunityGlobalContext {
  return { ...STRONG_GLOBAL, ...overrides }
}

function withFirm(overrides: Partial<OpportunityFirmContext> = {}): OpportunityFirmContext {
  return { ...STRONG_FIRM, ...overrides }
}

describe('opportunity scoring', () => {
  it('returns a fully explainable 100-point publish decision for strong global and firm signals', () => {
    const result = scoreOpportunity({ global: STRONG_GLOBAL, firm: STRONG_FIRM })

    expect(result).toMatchObject({
      score: 100,
      globalScore: 100,
      firmScore: 100,
      recommendation: 'publish',
    })
    expect(result.reasonSnapshot.blockers).toEqual([])
    expect(result.reasonSnapshot.missing).toEqual([])
    expect(result.reasonSnapshot.global.factors.map((factor) => factor.key)).toEqual([
      'confidence',
      'sourceIndependence',
      'recencyVelocity',
      'searchDemand',
      'competition',
      'cpc',
      'reviewProbability',
    ])
    expect(result.reasonSnapshot.firm?.factors.map((factor) => factor.key)).toEqual([
      'qualifiedConsultationRate',
      'retainedRate',
      'preference',
      'capacity',
    ])
    expect(result.reasons).toEqual(result.reasonSnapshot.all)
    expect(result.reasonSnapshot.summary).toBe('publish at 100/100.')
  })

  it('uses the global score when firm context is absent but prevents publish without firm fit', () => {
    const result = scoreOpportunity({ global: STRONG_GLOBAL })

    expect(result.score).toBe(100)
    expect(result.globalScore).toBe(100)
    expect(result.firmScore).toBeNull()
    expect(result.recommendation).toBe('watch')
    expect(result.reasonSnapshot.firm).toBeNull()
    expect(scoreGlobalContext(STRONG_GLOBAL)).toEqual(result.reasonSnapshot.global)
  })

  it('applies all weights deterministically and exposes factor contributions', () => {
    const result = scoreOpportunity({
      global: withGlobal({
        confidence: 0.5,
        sourceIndependence: 0.5,
        recencyScore: 0.5,
        velocityScore: 0.5,
        searchDemandScore: 0.5,
        competitionScore: 0.5,
        cpcScore: 0.5,
        reviewProbability: 0.5,
      }),
      firm: withFirm({
        qualifiedConsultationRate: 0.5,
        retainedRate: 0.5,
        preference: 0.5,
        capacity: 0.5,
      }),
    })

    expect(result.score).toBe(50)
    expect(result.globalScore).toBe(50)
    expect(result.firmScore).toBe(50)
    expect(result.recommendation).toBe('watch')
    expect(result.reasonSnapshot.global.points).toBe(40)
    expect(result.reasonSnapshot.firm?.points).toBe(10)
    expect(result.reasonSnapshot.global.factors.every((factor) => factor.contribution > 0)).toBe(true)
  })

  it('blocks an explicit compliance/operator block even when the economics are excellent', () => {
    const result = scoreOpportunity({ global: STRONG_GLOBAL, firm: STRONG_FIRM, blocked: true })

    expect(result.score).toBe(100)
    expect(result.recommendation).toBe('block')
    expect(result.reasonSnapshot.blockers).toContain('explicit compliance/operator block')
  })

  it('blocks a low observed review probability as a hard safety gate', () => {
    const result = scoreOpportunity({
      global: withGlobal({ reviewProbability: 0.2 }),
      firm: STRONG_FIRM,
    })

    expect(result.score).toBeGreaterThan(75)
    expect(result.recommendation).toBe('block')
    expect(result.reasonSnapshot.blockers).toContain('review probability below 25%')
  })

  it('holds otherwise attractive opportunities when the firm has no capacity or fit', () => {
    const result = scoreOpportunity({
      global: STRONG_GLOBAL,
      firm: withFirm({ capacity: 0, preference: 0 }),
    })

    expect(result.score).toBe(94)
    expect(result.recommendation).toBe('hold')
    expect(result.reasonSnapshot.blockers).toEqual([])
    expect(result.reasonSnapshot.summary).toContain('firm capacity')
    expect(result.reasonSnapshot.summary).toContain('firm preference')
  })

  it('distinguishes a low-scoring hold from a hard block', () => {
    const result = scoreOpportunity({
      global: {
        confidence: 0.3,
        sourceIndependence: 0.3,
        recencyScore: 0.3,
        velocityScore: 0.3,
        searchDemandScore: 0.3,
        competitionScore: 0.3,
        cpcScore: 0.3,
        reviewProbability: 0.3,
      },
      firm: {
        qualifiedConsultationRate: 0.3,
        retainedRate: 0.3,
        preference: 0.3,
        capacity: 0.3,
      },
    })

    expect(result.score).toBe(30)
    expect(result.recommendation).toBe('hold')
    expect(result.reasonSnapshot.blockers).toEqual([])
  })

  it('blocks a score below the minimum threshold when every signal is absent or invalid', () => {
    const result = scoreOpportunity({
      global: {
        confidence: Number.NaN,
        sourceIndependence: -10,
        recencyDays: Number.POSITIVE_INFINITY,
        searchDemand: -1,
        competition: 200,
        cpc: -1,
        reviewProbability: 0,
      },
      firm: {
        qualifiedConsultationRate: -1,
        retainedRate: Number.NaN,
        preference: -1,
        capacity: -1,
      },
    })

    expect(result.score).toBe(0)
    expect(result.recommendation).toBe('block')
    expect(result.reasonSnapshot.blockers).toEqual([
      'review probability below 25%',
      'score below 25',
    ])
    expect(result.reasonSnapshot.global.factors.every((factor) => Number.isFinite(factor.contribution))).toBe(true)
  })

  it('derives source independence from independent and total source counts', () => {
    const result = scoreOpportunity({
      global: withGlobal({ independentSourceCount: 1, sourceCount: 4, sourceIndependence: undefined }),
    })
    const factor = result.reasonSnapshot.global.factors.find((item) => item.key === 'sourceIndependence')!

    expect(factor.normalizedValue).toBe(0.25)
    expect(factor.status).toBe('derived')
    expect(factor.reason).toContain('25%')
  })

  it('derives recency from a fixed as-of date and keeps repeated scoring identical', () => {
    const input = {
      global: {
        ...withGlobal({
          recencyScore: undefined,
          velocityScore: undefined,
          observedAt: '2026-08-01T00:00:00.000Z',
          asOf: '2026-08-11T00:00:00.000Z',
          velocity: 0.5,
        }),
      },
      firm: STRONG_FIRM,
    } as const

    const first = scoreOpportunity(input)
    const second = scoreOpportunity(input)

    expect(first).toEqual(second)
    const factor = first.reasonSnapshot.global.factors.find((item) => item.key === 'recencyVelocity')!
    expect(factor.status).toBe('derived')
    expect(factor.reason).toContain('10d')
    expect(factor.reason).toContain('velocity 75%')
  })

  it('rewards fresh positive velocity over stale negative velocity', () => {
    const fresh = scoreOpportunity({
      global: withGlobal({ recencyDays: 1, velocity: 0.8, recencyScore: undefined, velocityScore: undefined }),
    })
    const stale = scoreOpportunity({
      global: withGlobal({ recencyDays: 365, velocity: -0.8, recencyScore: undefined, velocityScore: undefined }),
    })

    const freshFactor = fresh.reasonSnapshot.global.factors.find((item) => item.key === 'recencyVelocity')!
    const staleFactor = stale.reasonSnapshot.global.factors.find((item) => item.key === 'recencyVelocity')!
    expect(freshFactor.normalizedValue).toBeGreaterThan(staleFactor.normalizedValue)
    expect(fresh.score).toBeGreaterThan(stale.score)
  })

  it('normalizes raw search demand and CPC while treating lower competition as better', () => {
    const lowOpportunity = scoreOpportunity({
      global: withGlobal({
        searchDemandScore: undefined,
        searchDemand: 100,
        cpcScore: undefined,
        cpc: 500,
        competitionScore: undefined,
        competition: 0.9,
      }),
    })
    const highOpportunity = scoreOpportunity({
      global: withGlobal({
        searchDemandScore: undefined,
        searchDemand: 10_000,
        cpcScore: undefined,
        cpc: 50_000,
        competitionScore: undefined,
        competition: 0.1,
      }),
    })

    expect(highOpportunity.score).toBeGreaterThan(lowOpportunity.score)
    const highDemand = highOpportunity.reasonSnapshot.global.factors.find((item) => item.key === 'searchDemand')!
    const highCpc = highOpportunity.reasonSnapshot.global.factors.find((item) => item.key === 'cpc')!
    const lowCompetition = highOpportunity.reasonSnapshot.global.factors.find((item) => item.key === 'competition')!
    expect(highDemand.normalizedValue).toBe(1)
    expect(highCpc.normalizedValue).toBe(1)
    expect(lowCompetition.normalizedValue).toBe(0.9)
    expect(highDemand.status).toBe('derived')
    expect(highCpc.status).toBe('derived')
  })

  it('uses consultation, retention, preference, and capacity in the firm score', () => {
    const high = scoreFirmContext(STRONG_FIRM)
    const low = scoreFirmContext({
      qualifiedConsultationRate: 0,
      retainedRate: 0,
      preference: 0,
      capacity: 0,
    })

    expect(high.score).toBe(100)
    expect(low.score).toBe(0)
    expect(high.factors.map((factor) => factor.key)).toEqual([
      'qualifiedConsultationRate',
      'retainedRate',
      'preference',
      'capacity',
    ])
    expect(high.factors.map((factor) => factor.weight)).toEqual([8, 6, 3, 3])
  })

  it('accepts flat global fields and the calculation alias without changing the result', () => {
    const nested = scoreOpportunity({ global: withGlobal(), firm: withFirm() })
    const flat = calculateOpportunityScore({ ...withGlobal(), firm: withFirm() })

    expect(flat).toEqual(nested)
  })

  it('clamps percentages and raw capacities to a finite, bounded result', () => {
    const result = scoreOpportunity({
      global: {
        confidence: 250,
        sourceIndependence: 250,
        recencyScore: 250,
        velocityScore: -250,
        searchDemand: Number.MAX_VALUE,
        competition: -100,
        cpc: Number.MAX_VALUE,
        reviewProbability: 250,
      },
      firm: {
        qualifiedConsultationRate: 250,
        retainedRate: -100,
        preference: 250,
        capacity: 250,
      },
    })

    expect(Number.isFinite(result.score)).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.reasonSnapshot.global.factors.every((factor) => factor.normalizedValue >= 0 && factor.normalizedValue <= 1)).toBe(true)
    expect(result.reasonSnapshot.firm?.factors.every((factor) => factor.normalizedValue >= 0 && factor.normalizedValue <= 1)).toBe(true)
  })
})
