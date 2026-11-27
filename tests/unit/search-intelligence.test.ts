import { describe, expect, it } from 'vitest'
import {
  aggregateQueryStats,
  aggregateSearchQueryStats,
  calculateIndexLatency,
  deriveUrlIndexState,
  inspectUrlIndexState,
  MixedSearchProviderError,
  recommendContentRefresh,
  recommendContentRefreshes,
} from '@/domains/search'

describe('search URL index state', () => {
  it('does not infer indexing from a successful HTTP response', () => {
    const result = inspectUrlIndexState({
      provider: 'google',
      url: 'https://firm.example/f/case',
      httpStatus: 200,
    })

    expect(deriveUrlIndexState({ provider: 'google', httpStatus: 200 })).toBe('unknown')
    expect(result).toMatchObject({
      provider: 'google_search_console',
      providerName: 'google',
      status: 'unknown',
      indexed: false,
      explicit: false,
      evidence: 'none',
      httpStatus: 200,
    })
  })

  it('uses explicit provider status and keeps crawled/excluded distinct from indexed', () => {
    expect(deriveUrlIndexState({
      provider: 'naver_search_advisor',
      status: 'crawled',
      httpStatus: 200,
    })).toBe('crawled')
    expect(deriveUrlIndexState({
      provider: 'naver',
      status: 'excluded',
      httpStatus: 200,
    })).toBe('excluded')
    expect(inspectUrlIndexState({
      provider: 'naver',
      status: 'indexed',
      indexedAt: '2026-08-10T00:00:00.000Z',
    })).toMatchObject({
      provider: 'naver_search_advisor',
      status: 'indexed',
      isIndexed: true,
      explicit: true,
      evidence: 'provider_status',
    })
  })
})

describe('query daily stats aggregation', () => {
  it('recomputes CTR and weights average position by impressions', () => {
    const result = aggregateQueryStats([
      {
        provider: 'naver',
        day: '2026-08-08',
        query: '금융사기 대응',
        publicationId: 'publication-1',
        impressions: 100,
        clicks: 10,
        position: 2,
      },
      {
        provider: 'naver_search_advisor',
        day: '2026-08-09',
        query: '금융사기 대응',
        publicationId: 'publication-1',
        impressions: 300,
        clicks: 30,
        position: 4,
      },
    ])

    expect(result).toMatchObject({
      provider: 'naver_search_advisor',
      providerName: 'naver',
      query: '금융사기 대응',
      impressions: 400,
      clicks: 40,
      ctr: 0.1,
      weightedAvgPosition: 3.5,
      weightedAveragePosition: 3.5,
    })
  })

  it('keeps Naver and Google aggregates separate', () => {
    const rows = [
      {
        provider: 'naver' as const,
        date: '2026-08-09',
        query: '사기 피해',
        impressions: 100,
        clicks: 10,
        positionBasisPoints: 250,
      },
      {
        provider: 'google' as const,
        date: '2026-08-09',
        query: '사기 피해',
        impressions: 200,
        clicks: 20,
        position: 3,
      },
    ]

    expect(() => aggregateQueryStats(rows)).toThrow(MixedSearchProviderError)
    expect(aggregateSearchQueryStats(rows)).toMatchObject([
      {
        provider: 'google_search_console',
        impressions: 200,
        clicks: 20,
        weightedAvgPosition: 3,
      },
      {
        provider: 'naver_search_advisor',
        impressions: 100,
        clicks: 10,
        weightedAvgPosition: 2.5,
      },
    ])
  })
})
describe('index latency', () => {
  it('calculates latency from publication to explicit indexing without using the clock', () => {
    const result = calculateIndexLatency({
      publishedAt: '2026-08-01T00:00:00.000Z',
      indexedAt: '2026-08-04T12:00:00.000Z',
    })

    expect(result).toMatchObject({
      status: 'calculated',
      latencyHours: 84,
      latencyDays: 3.5,
      days: 3.5,
    })
    expect(calculateIndexLatency(
      '2026-08-01T00:00:00.000Z',
      '2026-08-04T12:00:00.000Z',
    )).toBe(3.5)
  })

  it('returns pending when HTTP is healthy but provider indexing is not observed', () => {
    expect(calculateIndexLatency({
      publishedAt: '2026-08-01T00:00:00.000Z',
      httpStatus: 200,
    })).toMatchObject({
      status: 'pending',
      latencyDays: null,
    })
  })
})

describe('content refresh recommendations', () => {
  it('emits fixed-order reasons for stale evidence and declining content', () => {
    const input = {
      url: 'https://firm.example/f/case',
      provider: 'google' as const,
      asOf: '2026-08-31T00:00:00.000Z',
      evidence: { capturedAt: '2026-07-01T00:00:00.000Z' },
      previous: { impressions: 100, clicks: 10, ctr: 0.1, position: 2 },
      current: { impressions: 70, clicks: 8, ctr: 0.07, position: 2.5 },
    }

    const first = recommendContentRefresh(input)
    const second = recommendContentRefresh(input)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      provider: 'google_search_console',
      recommendation: 'refresh',
      action: 'refresh',
      shouldRefresh: true,
      priority: 'high',
      reasons: ['stale_evidence', 'content_decline'],
      contentDeclineMetrics: ['impressions', 'clicks', 'ctr', 'position'],
    })
  })

  it('prioritizes an index error for investigation and remains deterministic', () => {
    const result = recommendContentRefresh({
      url: 'https://firm.example/f/broken',
      index: { status: 'error', errorCode: 'provider_timeout' },
    })

    expect(result).toMatchObject({
      recommendation: 'investigate_index',
      shouldRefresh: false,
      priority: 'high',
      reasons: ['index_error'],
      indexError: true,
      blockedByIndexError: true,
    })
  })

  it('returns monitor for healthy, fresh, non-declining input and sorts queues stably', () => {
    const recommendations = recommendContentRefreshes([
      { url: 'https://firm.example/z', evidenceAgeDays: 1 },
      { url: 'https://firm.example/b', contentDecline: true },
      { url: 'https://firm.example/a', indexError: true },
    ])

    expect(recommendContentRefresh({ evidenceAgeDays: 1 })).toMatchObject({
      recommendation: 'monitor',
      priority: 'low',
      reasons: [],
    })
    expect(recommendations.map((item) => [item.url, item.recommendation])).toEqual([
      ['https://firm.example/a', 'investigate_index'],
      ['https://firm.example/b', 'refresh'],
      ['https://firm.example/z', 'monitor'],
    ])
  })
})
