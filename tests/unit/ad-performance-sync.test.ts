import { describe, expect, it } from 'vitest'
import {
  NaverSearchAdAdapter,
  type NaverSearchAdReadClient,
} from '@/platform/integrations/naver-searchad'
import {
  groupAdPerformanceTargets,
  main,
  previousSeoulDay,
  syncAdPerformance,
  type AdPerformanceSyncDependencies,
  type AdPerformanceTarget,
} from '../../scripts/agent/sync-ad-performance'
import type { UpsertAdDailyStatInput } from '@/domains/advertising/repository'

type ProviderCall = {
  firmId: number
  method: string
  path: string
  body?: unknown
  ids: string[]
  day: string
}

const targets: readonly AdPerformanceTarget[] = [
  { firmId: 11, firmStatus: 'active', adExecutionId: 'execution-11-a', adGroupExternalId: 'group-11-a' },
  { firmId: 11, firmStatus: 'active', adExecutionId: 'execution-11-b', adGroupExternalId: 'group-11-b' },
  { firmId: 22, firmStatus: 'pilot', adExecutionId: 'execution-22-a', adGroupExternalId: 'group-22-a' },
]

function encryptedCredentials(firmId: number) {
  return {
    firmId,
    provider: 'naver_searchad',
    customerId: `customer-${firmId}`,
    apiKeyEnc: `encrypted-api-${firmId}`,
    secretEnc: `encrypted-secret-${firmId}`,
  }
}

function fakeDependencies() {
  const providerCalls: ProviderCall[] = []
  const adapterFirms: number[] = []
  const accountPatches: Array<{ firmId: number; provider: string; patch: Record<string, unknown> }> = []
  const persistence = new Map<string, UpsertAdDailyStatInput>()
  const persistenceCalls: UpsertAdDailyStatInput[] = []

  const dependencies: AdPerformanceSyncDependencies = {
    loadTargets: async () => targets,
    loadCredentials: async (firmId) => encryptedCredentials(firmId),
    decryptCredential: (payload) => payload.replace(/^encrypted-/, ''),
    createAdapter: (credentials, context) => {
      expect(credentials).toEqual({
        customerId: `customer-${context.firmId}`,
        apiKey: `api-${context.firmId}`,
        secret: `secret-${context.firmId}`,
      })
      adapterFirms.push(context.firmId)
      const client: NaverSearchAdReadClient = {
        request: async <T>(method, path, options) => {
          const ids = [options?.query?.id ?? ''].filter(Boolean)
          const day = JSON.parse(options?.query?.timeRange ?? '{}') as { since?: string }
          providerCalls.push({
            firmId: context.firmId,
            method,
            path,
            body: options?.body,
            ids,
            day: day.since ?? '',
          })
          if (context.firmId === 22) throw new Error('simulated provider failure')
          return ids.map((id, index) => ({
            id,
            impCnt: 100 + index,
            clkCnt: 10 + index,
            salesAmt: 1_000 + index,
            ccnt: index,
          })) as T
        },
      }
      return new NaverSearchAdAdapter(client)
    },
    upsertAdDailyStat: async (input) => {
      persistenceCalls.push(input)
      const key = `${input.firmId}:${input.adExecutionId}:${input.day}`
      const existing = persistence.get(key)
      if (!existing) {
        persistence.set(key, input)
        return { inserted: true, updated: false, unchanged: false }
      }
      if (
        existing.impressions === input.impressions
        && existing.clicks === input.clicks
        && existing.cost === input.cost
        && existing.conversions === input.conversions
      ) {
        return { inserted: false, updated: false, unchanged: true }
      }
      persistence.set(key, input)
      return { inserted: false, updated: true, unchanged: false }
    },
    updateAdAccount: async (firmId, provider, patch) => {
      accountPatches.push({ firmId, provider, patch })
      return 1
    },
  }

  return { dependencies, providerCalls, adapterFirms, accountPatches, persistence, persistenceCalls }
}

describe('daily target Naver performance synchronizer', () => {
  it('calculates the prior Asia/Seoul calendar day at UTC boundaries', () => {
    expect(previousSeoulDay(new Date('2026-08-09T14:59:59.000Z'))).toBe('2026-08-08')
    expect(previousSeoulDay(new Date('2026-08-09T15:00:00.000Z'))).toBe('2026-08-09')
    expect(previousSeoulDay(new Date('2026-08-10T00:30:00.000Z'))).toBe('2026-08-09')
  })

  it('groups strictly by tenant, isolates a failed firm, persists idempotently, and performs GET-only provider reads', async () => {
    const fake = fakeDependencies()
    const input = { now: new Date('2026-08-10T00:30:00.000Z') }

    const first = await syncAdPerformance(input, fake.dependencies)
    expect(first).toMatchObject({
      status: 'partial',
      day: '2026-08-09',
      firms: 2,
      succeededFirms: 1,
      failedFirms: 1,
      skippedFirms: 0,
      eligibleExecutions: 3,
      statsReturned: 2,
      statsPersisted: 2,
      statsInserted: 2,
    })
    expect(fake.adapterFirms).toEqual([11, 22])
    expect(fake.providerCalls.map(({ firmId, ids }) => ({ firmId, ids }))).toEqual([
      { firmId: 11, ids: ['group-11-a'] },
      { firmId: 11, ids: ['group-11-b'] },
      { firmId: 22, ids: ['group-22-a'] },
    ])
    expect(fake.providerCalls.every((call) => call.method === 'GET' && call.path === '/stats' && call.body === undefined)).toBe(true)
    expect(fake.accountPatches).toEqual([
      expect.objectContaining({ firmId: 11, provider: 'naver_searchad', patch: expect.objectContaining({ status: 'active' }) }),
      expect.objectContaining({ firmId: 22, provider: 'naver_searchad', patch: { status: 'failed' } }),
    ])
    expect(first.issues).toContainEqual({ firmId: 22, kind: 'failed', reason: 'Error' })

    const second = await syncAdPerformance(input, fake.dependencies)
    expect(second).toMatchObject({
      status: 'partial',
      succeededFirms: 1,
      failedFirms: 1,
      statsReturned: 2,
      statsPersisted: 2,
      statsInserted: 0,
      statsUnchanged: 2,
    })
    expect(fake.persistence).toHaveLength(2)
    expect(fake.persistenceCalls).toHaveLength(4)
  })

  it('filters paused, empty-group, and no-target inputs before credentials or provider access', async () => {
    const grouped = groupAdPerformanceTargets([
      { firmId: 1, firmStatus: 'paused', adExecutionId: 'paused', adGroupExternalId: 'group-paused' },
      { firmId: 2, firmStatus: 'active', adExecutionId: 'empty', adGroupExternalId: '  ' },
      { firmId: 3, firmStatus: 'pilot', adExecutionId: 'eligible', adGroupExternalId: 'group-eligible' },
      { firmId: 3, firmStatus: 'pilot', adExecutionId: 'eligible-2', adGroupExternalId: 'group-eligible-2' },
    ])
    expect([...grouped.entries()]).toEqual([
      [3, [
        { firmId: 3, firmStatus: 'pilot', adExecutionId: 'eligible', adGroupExternalId: 'group-eligible' },
        { firmId: 3, firmStatus: 'pilot', adExecutionId: 'eligible-2', adGroupExternalId: 'group-eligible-2' },
      ]],
    ])

    let credentialLoads = 0
    let adapterCreates = 0
    const result = await syncAdPerformance({ day: '2026-08-09' }, {
      loadTargets: async () => [],
      loadCredentials: async () => {
        credentialLoads += 1
        return null
      },
      createAdapter: async () => {
        adapterCreates += 1
        throw new Error('must not be called')
      },
      upsertAdDailyStat: async () => undefined,
    })
    expect(result).toMatchObject({ status: 'skipped', skipReason: 'no-eligible-executions' })
    expect(credentialLoads).toBe(0)
    expect(adapterCreates).toBe(0)
  })

  it('main skips cleanly without DATABASE_URL and does not require the live-engine flag', async () => {
    const logs: string[] = []
    const result = await main({ env: {}, log: (message) => logs.push(message) })
    expect(result).toMatchObject({ status: 'skipped', skipReason: 'database-url-missing' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('database-url-missing')
  })
})
