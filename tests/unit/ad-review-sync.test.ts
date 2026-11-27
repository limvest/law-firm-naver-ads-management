import { describe, expect, it } from 'vitest'
import {
  NaverSearchAdAdapter,
  type NaverSearchAdReadClient,
} from '@/platform/integrations/naver-searchad'
import {
  groupAdReviewTargets,
  main,
  syncAdReviews,
  type AdReviewSyncDependencies,
  type AdReviewTarget,
} from '../../scripts/agent/sync-ad-reviews'
import type {
  RecordAdProviderStateInput,
  RecordAdReviewEventInput,
} from '@/domains/advertising/repository'

const NOW = new Date('2026-08-10T03:00:00.000Z')

function credentials(firmId: number, verifiedAt: Date | null = NOW) {
  return {
    firmId,
    provider: 'naver_searchad',
    customerId: `customer-${firmId}`,
    apiKeyEnc: `encrypted-api-${firmId}`,
    secretEnc: `encrypted-secret-${firmId}`,
    verifiedAt,
  }
}

function target(
  firmId: number,
  adExecutionId: string,
  creativeExternalId: string | null,
  overrides: Partial<AdReviewTarget> = {},
): AdReviewTarget {
  return {
    firmId,
    firmStatus: 'active',
    adExecutionId,
    status: 'submitted',
    creativeExternalId,
    ...overrides,
  }
}

describe('daily target Naver creative-review synchronizer', () => {
  it('filters to pilot/active firms, submitted or pending_review executions, and non-null creatives', () => {
    const grouped = groupAdReviewTargets([
      target(1, 'paused-firm', 'creative-paused-firm', { firmStatus: 'paused' }),
      target(1, 'live-execution', 'creative-live', { status: 'live' }),
      target(1, 'draft-execution', 'creative-draft', { status: 'draft' }),
      target(1, 'missing-creative', null),
      target(2, 'pending-execution', 'creative-pending', {
        firmStatus: 'pilot',
        status: 'pending_review',
      }),
      target(2, 'eligible-execution', 'creative-eligible'),
    ])

    expect([...grouped.entries()]).toEqual([
      [2, [
        target(2, 'pending-execution', 'creative-pending', {
          firmStatus: 'pilot',
          status: 'pending_review',
        }),
        target(2, 'eligible-execution', 'creative-eligible'),
      ]],
    ])
  })

  it('maps pending, approved, and rejected states, preserves rejection reason, and performs GET-only reads', async () => {
    const targets: AdReviewTarget[] = [
      target(7, 'execution-pending', 'creative-pending', { status: 'pending_review' }),
      target(7, 'execution-approved', 'creative-approved'),
      target(7, 'execution-rejected', 'creative-rejected'),
      target(7, 'execution-unknown', 'creative-unknown'),
    ]
    const responses: unknown[] = [
      { nccAdId: 'creative-pending', inspectStatus: 'UNDER_REVIEW' },
      { nccAdId: 'creative-approved', inspectStatus: 'ELIGIBLE' },
      { nccAdId: 'creative-rejected', inspectStatus: 'DENIED' },
      {
        id: 'creative-rejected',
        pcInspectComment: [{ content: 'policy reason' }],
        mobileInspectComment: [],
      },
      { nccAdId: 'creative-unknown', inspectStatus: 'NOT_A_KNOWN_STATUS' },
    ]
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const providerStates: RecordAdProviderStateInput[] = []
    const reviewEvents: RecordAdReviewEventInput[] = []

    const dependencies: AdReviewSyncDependencies = {
      loadTargets: async () => targets,
      loadCredentials: async (firmId) => credentials(firmId),
      decryptCredential: (payload) => payload.replace(/^encrypted-/, ''),
      createAdapter: (clientCredentials, context) => {
        expect(clientCredentials).toEqual({
          customerId: 'customer-7',
          apiKey: 'api-7',
          secret: 'secret-7',
        })
        const client: NaverSearchAdReadClient = {
          request: async <T>(method, path, options) => {
            calls.push({ method, path, body: options?.body })
            expect(context.firmId).toBe(7)
            const response = responses.shift()
            if (response === undefined) throw new Error('test response queue exhausted')
            return response as T
          },
        }
        return new NaverSearchAdAdapter(client)
      },
      recordAdProviderState: async (input) => {
        providerStates.push(input)
      },
      recordAdReviewEvent: async (input) => {
        reviewEvents.push(input)
      },
    }

    const result = await syncAdReviews({ now: NOW }, dependencies)

    expect(result).toMatchObject({
      status: 'ok',
      firms: 1,
      succeededFirms: 1,
      eligibleExecutions: 4,
      reviewsReturned: 4,
      reviewsPersisted: 4,
      providerTransitions: 3,
      reviewEvents: 4,
    })
    expect(providerStates.map(({ adExecutionId, status, reason }) => ({
      adExecutionId,
      status,
      reason,
    }))).toEqual([
      { adExecutionId: 'execution-pending', status: 'pending_review', reason: null },
      { adExecutionId: 'execution-approved', status: 'live', reason: null },
      { adExecutionId: 'execution-rejected', status: 'rejected', reason: 'policy reason' },
    ])
    expect(reviewEvents.map(({ adExecutionId, status, reason }) => ({
      adExecutionId,
      status,
      reason,
    }))).toEqual([
      { adExecutionId: 'execution-pending', status: 'pending', reason: null },
      { adExecutionId: 'execution-approved', status: 'approved', reason: null },
      { adExecutionId: 'execution-rejected', status: 'rejected', reason: 'policy reason' },
      { adExecutionId: 'execution-unknown', status: 'unknown', reason: null },
    ])
    expect(calls.every(({ method, body }) => method === 'GET' && body === undefined)).toBe(true)
    expect(calls.map(({ path }) => path)).toEqual([
      '/ncc/ads/creative-pending',
      '/ncc/ads/creative-approved',
      '/ncc/ads/creative-rejected',
      '/ncc/inspect-history/creative-rejected',
      '/ncc/ads/creative-unknown',
    ])
  })

  it('records unknown review only and never transitions provider state', async () => {
    const providerStates: RecordAdProviderStateInput[] = []
    const reviewEvents: RecordAdReviewEventInput[] = []
    const dependencies: AdReviewSyncDependencies = {
      loadTargets: async () => [target(8, 'execution-unknown-only', 'creative-unknown-only')],
      loadCredentials: async (firmId) => credentials(firmId),
      decryptCredential: (payload) => payload.replace(/^encrypted-/, ''),
      createAdapter: () => ({
        fetchCreativeReviews: async (requested) => requested.map((requestedTarget) => ({
          ...requestedTarget,
          reviewStatus: 'unknown',
          reason: null,
          raw: { inspectStatus: 'future-status' },
        })),
      }),
      recordAdProviderState: async (input) => {
        providerStates.push(input)
      },
      recordAdReviewEvent: async (input) => {
        reviewEvents.push(input)
      },
    }

    const result = await syncAdReviews({ now: NOW }, dependencies)

    expect(result).toMatchObject({ status: 'ok', providerTransitions: 0, reviewEvents: 1 })
    expect(providerStates).toEqual([])
    expect(reviewEvents[0]).toMatchObject({
      adExecutionId: 'execution-unknown-only',
      status: 'unknown',
    })
  })

  it('rejects any provider result that cannot be joined to the exact requested firm, execution, and creative', async () => {
    const providerStates: RecordAdProviderStateInput[] = []
    const reviewEvents: RecordAdReviewEventInput[] = []
    const dependencies: AdReviewSyncDependencies = {
      loadTargets: async () => [target(9, 'execution-9', 'creative-9')],
      loadCredentials: async (firmId) => credentials(firmId),
      decryptCredential: (payload) => payload.replace(/^encrypted-/, ''),
      createAdapter: () => ({
        fetchCreativeReviews: async () => [{
          firmId: 9,
          adExecutionId: 'execution-from-another-row',
          creativeId: 'creative-9',
          reviewStatus: 'approved',
          reason: null,
          raw: { nccAdId: 'creative-9' },
        }],
      }),
      recordAdProviderState: async (input) => {
        providerStates.push(input)
      },
      recordAdReviewEvent: async (input) => {
        reviewEvents.push(input)
      },
    }

    const result = await syncAdReviews({ now: NOW }, dependencies)

    expect(result).toMatchObject({ status: 'partial', failedFirms: 1, succeededFirms: 0 })
    expect(result.issues).toEqual([
      { firmId: 9, kind: 'failed', reason: 'provider-result-mismatch' },
    ])
    expect(providerStates).toEqual([])
    expect(reviewEvents).toEqual([])
  })

  it('processes firms sequentially, isolates a failed firm, and does not expose secrets or raw errors', async () => {
    const adapterOrder: number[] = []
    const providerStates: RecordAdProviderStateInput[] = []
    const reviewEvents: RecordAdReviewEventInput[] = []
    const targets: AdReviewTarget[] = [
      target(10, 'execution-failed', 'creative-failed'),
      target(11, 'execution-ok', 'creative-ok'),
    ]
    const dependencies: AdReviewSyncDependencies = {
      loadTargets: async () => targets,
      loadCredentials: async (firmId) => credentials(firmId),
      decryptCredential: (payload) => payload.replace(/^encrypted-/, ''),
      createAdapter: (_clientCredentials, context) => {
        adapterOrder.push(context.firmId)
        if (context.firmId === 10) {
          throw new Error('apiKey=super-secret raw={"secret":"provider-body"}')
        }
        return {
          fetchCreativeReviews: async (requested) => requested.map((requestedTarget) => ({
            ...requestedTarget,
            reviewStatus: 'approved',
            reason: null,
            raw: {},
          })),
        }
      },
      recordAdProviderState: async (input) => {
        providerStates.push(input)
      },
      recordAdReviewEvent: async (input) => {
        reviewEvents.push(input)
      },
    }

    const result = await syncAdReviews({ now: NOW }, dependencies)
    const serialized = JSON.stringify(result)

    expect(adapterOrder).toEqual([10, 11])
    expect(result).toMatchObject({
      status: 'partial',
      firms: 2,
      succeededFirms: 1,
      failedFirms: 1,
      reviewsReturned: 1,
      reviewsPersisted: 1,
    })
    expect(result.issues).toEqual([
      { firmId: 10, kind: 'failed', reason: 'firm-sync-failed' },
    ])
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('provider-body')
    expect(providerStates).toHaveLength(1)
    expect(reviewEvents).toHaveLength(1)
  })

  it('skips unverified credentials without touching the provider', async () => {
    let adapterCalls = 0
    const result = await syncAdReviews({ now: NOW }, {
      loadTargets: async () => [target(12, 'execution-unverified', 'creative-unverified')],
      loadCredentials: async (firmId) => credentials(firmId, null),
      createAdapter: () => {
        adapterCalls += 1
        throw new Error('must not call provider')
      },
      recordAdProviderState: async () => undefined,
      recordAdReviewEvent: async () => undefined,
    })

    expect(result).toMatchObject({
      status: 'skipped',
      skippedFirms: 1,
      skipReason: 'credentials-missing-or-unverified',
    })
    expect(adapterCalls).toBe(0)
  })

  it('passes a stable review idempotency key across repeated observations', async () => {
    const storedEvents = new Map<string, RecordAdReviewEventInput>()
    const providerStates: RecordAdProviderStateInput[] = []
    const dependencies: AdReviewSyncDependencies = {
      loadTargets: async () => [target(13, 'execution-repeat', 'creative-repeat')],
      loadCredentials: async (firmId) => credentials(firmId),
      decryptCredential: (payload) => payload.replace(/^encrypted-/, ''),
      createAdapter: () => ({
        fetchCreativeReviews: async (requested) => requested.map((requestedTarget) => ({
          ...requestedTarget,
          reviewStatus: 'approved',
          reason: null,
          raw: { responseVersion: Math.random() },
        })),
      }),
      recordAdProviderState: async (input) => {
        providerStates.push(input)
      },
      recordAdReviewEvent: async (input) => {
        const key = input.idempotencyKey ?? ''
        if (!storedEvents.has(key)) storedEvents.set(key, input)
      },
    }

    await syncAdReviews({ now: NOW }, dependencies)
    await syncAdReviews({ now: new Date(NOW.getTime() + 86_400_000) }, dependencies)

    expect(storedEvents).toHaveLength(1)
    expect([...storedEvents.values()][0]).toMatchObject({
      idempotencyKey: 'ad-review-sync:13:execution-repeat:creative-repeat:approved:',
    })
    expect(providerStates).toHaveLength(2)
  })

  it('skips cleanly without DATABASE_URL and treats a missing target schema as a safe direct-CLI skip', async () => {
    const noDatabaseLogs: string[] = []
    const noDatabase = await main({
      env: {},
      log: (message) => noDatabaseLogs.push(message),
    })
    expect(noDatabase).toMatchObject({ status: 'skipped', skipReason: 'database-url-missing' })
    expect(noDatabaseLogs).toHaveLength(1)

    const schemaLogs: string[] = []
    const missingSchema = Object.assign(
      new Error('relation "ad_executions" does not exist secret=must-not-leak'),
      { code: '42P01' },
    )
    const targetSchema = await main({
      env: { DATABASE_URL: 'postgres://test-only' },
      getDb: async () => { throw missingSchema },
      log: (message) => schemaLogs.push(message),
    })
    expect(targetSchema).toMatchObject({ status: 'skipped', skipReason: 'target-schema-missing' })
    expect(schemaLogs).toHaveLength(1)
    expect(schemaLogs[0]).not.toContain('must-not-leak')
    expect(schemaLogs[0]).not.toContain('ad_executions')
  })

  it('runs a fully injected main without DATABASE_URL', async () => {
    const logs: string[] = []
    const result = await main({
      env: {},
      now: NOW,
      log: (message) => logs.push(message),
      dependencies: {
        loadTargets: async () => [target(14, 'execution-injected', 'creative-injected')],
        loadCredentials: async (firmId) => credentials(firmId),
        decryptCredential: (payload) => payload.replace(/^encrypted-/, ''),
        createAdapter: () => ({
          fetchCreativeReviews: async (requested) => requested.map((requestedTarget) => ({
            ...requestedTarget,
            reviewStatus: 'unknown',
            reason: null,
            raw: {},
          })),
        }),
        recordAdProviderState: async () => undefined,
        recordAdReviewEvent: async () => undefined,
      },
    })

    expect(result).toMatchObject({ status: 'ok', reviewEvents: 1 })
    expect(logs).toHaveLength(1)
  })
})
