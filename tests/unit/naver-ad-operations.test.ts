import { describe, expect, it, vi } from 'vitest'
import {
  NaverSearchAdWriteAdapter,
  type NaverAdExecutionWriteInput,
  type NaverSearchAdWriteClient,
} from '@/platform/integrations/naver-ad-operations'

type RequestCall = {
  method: string
  path: string
  query?: Record<string, string>
  body?: unknown
}

type RequestOptions = {
  query?: Record<string, string>
  body?: unknown
}

function fakeClient(handler: (call: RequestCall) => unknown | Promise<unknown>): {
  client: NaverSearchAdWriteClient
  calls: RequestCall[]
} {
  const calls: RequestCall[] = []
  const client: NaverSearchAdWriteClient = {
    request: vi.fn(async <T>(method: string, path: string, options?: RequestOptions): Promise<T> => {
      const call = { method, path, query: options?.query, body: options?.body }
      calls.push(call)
      return await handler(call) as T
    }),
  }
  return { client, calls }
}

const input: NaverAdExecutionWriteInput = {
  adExecutionId: 'execution-1',
  campaignName: 'engine_firm_1',
  adgroupName: 'engine_case_1',
  pcChannelId: 'pc-channel-1',
  mobileChannelId: 'mobile-channel-1',
  bidAmt: 100,
  dailyBudget: 5_000,
  keywordVariants: [{ text: '사기 업체' }, { text: '사기 업체 후기' }],
  creative: {
    headline: '피해 대응 안내',
    description: '확인할 자료와 대응 순서를 안내합니다.',
    finalUrl: 'https://lawfirm.example/f/case-1',
  },
}

describe('NaverSearchAdWriteAdapter', () => {
  it('creates one target with the proven request sequence and explicit creative risk', async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.method === 'GET' && call.path === '/ncc/campaigns') return []
      if (call.method === 'POST' && call.path === '/ncc/campaigns') return { nccCampaignId: 'campaign-1' }
      if (call.method === 'GET' && call.path === '/ncc/adgroups') return []
      if (call.method === 'POST' && call.path === '/ncc/adgroups') return { nccAdgroupId: 'adgroup-1' }
      if (call.method === 'POST' && call.path === '/ncc/keywords') {
        return [{ nccKeywordId: 'keyword-1' }, { nccKeywordId: 'keyword-2' }]
      }
      if (call.method === 'POST' && call.path === '/ncc/ads') return { nccAdId: 'ad-1' }
      throw new Error(`unexpected ${call.method} ${call.path}`)
    })

    const result = await new NaverSearchAdWriteAdapter(client).execute(input)

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /ncc/campaigns',
      'POST /ncc/campaigns',
      'GET /ncc/adgroups',
      'POST /ncc/adgroups',
      'POST /ncc/keywords',
      'POST /ncc/ads',
    ])
    expect(calls[1].body).toEqual({ name: input.campaignName, campaignTp: 'WEB_SITE' })
    expect(calls[3]).toMatchObject({
      query: undefined,
      body: {
        name: input.adgroupName,
        nccCampaignId: 'campaign-1',
        pcChannelId: input.pcChannelId,
        mobileChannelId: input.mobileChannelId,
        bidAmt: input.bidAmt,
        dailyBudget: input.dailyBudget,
        useDailyBudget: true,
      },
    })
    expect(calls[4]).toMatchObject({
      query: { nccAdgroupId: 'adgroup-1' },
      body: [
        { keyword: '사기 업체', useGroupBidAmt: true },
        { keyword: '사기 업체 후기', useGroupBidAmt: true },
      ],
    })
    expect(calls[5].body).toEqual({
      nccAdgroupId: 'adgroup-1',
      type: 'TEXT_45',
      ad: {
        headline: input.creative.headline,
        description: input.creative.description,
        pc: { final: input.creative.finalUrl },
        mobile: { final: input.creative.finalUrl },
      },
    })
    expect(result).toMatchObject({
      adExecutionId: input.adExecutionId,
      campaignId: 'campaign-1',
      campaignReused: false,
      adgroupId: 'adgroup-1',
      adGroupId: 'adgroup-1',
      adgroupReused: false,
      keywordIds: ['keyword-1', 'keyword-2'],
      creativeId: 'ad-1',
      creative: { id: 'ad-1', reused: false, idempotency: 'non-idempotent-create' },
      creativeIdempotency: 'non-idempotent-create',
    })
  })

  it('reuses deterministic campaign and ad-group names without their POST paths', async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.method === 'GET' && call.path === '/ncc/campaigns') {
        return [{ name: input.campaignName, nccCampaignId: 'campaign-existing' }]
      }
      if (call.method === 'GET' && call.path === '/ncc/adgroups') {
        expect(call.query).toEqual({ nccCampaignId: 'campaign-existing' })
        return [{ name: input.adgroupName, nccCampaignId: 'campaign-existing', nccAdgroupId: 'adgroup-existing' }]
      }
      if (call.method === 'POST' && call.path === '/ncc/keywords') {
        return [{ nccKeywordId: 'keyword-existing-1' }, { nccKeywordId: 'keyword-existing-2' }]
      }
      if (call.method === 'POST' && call.path === '/ncc/ads') return { nccAdId: 'ad-new' }
      throw new Error(`unexpected ${call.method} ${call.path}`)
    })

    const result = await new NaverSearchAdWriteAdapter(client).execute({ ...input, dailyBudget: 0 })

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /ncc/campaigns',
      'GET /ncc/adgroups',
      'POST /ncc/keywords',
      'POST /ncc/ads',
    ])
    expect(result.campaignReused).toBe(true)
    expect(result.adgroupReused).toBe(true)
    expect(calls[2].body).toEqual([
      { keyword: '사기 업체', useGroupBidAmt: true },
      { keyword: '사기 업체 후기', useGroupBidAmt: true },
    ])
    expect(calls[1].body).toBeUndefined()
  })

  it('rejects a malformed existing-object response before attempting a write', async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.method === 'GET' && call.path === '/ncc/campaigns') return [{ name: input.campaignName }]
      throw new Error(`unexpected ${call.method} ${call.path}`)
    })

    await expect(new NaverSearchAdWriteAdapter(client).execute(input))
      .rejects.toThrow('missing nccCampaignId')
    expect(calls).toHaveLength(1)
  })

  it('rejects missing IDs in the homogeneous keyword response and does not create the creative', async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.method === 'GET' && call.path === '/ncc/campaigns') return []
      if (call.method === 'POST' && call.path === '/ncc/campaigns') return { nccCampaignId: 'campaign-1' }
      if (call.method === 'GET' && call.path === '/ncc/adgroups') return []
      if (call.method === 'POST' && call.path === '/ncc/adgroups') return { nccAdgroupId: 'adgroup-1' }
      if (call.method === 'POST' && call.path === '/ncc/keywords') {
        return [{ nccKeywordId: 'keyword-1' }, { keyword: '사기 업체 후기' }]
      }
      throw new Error(`unexpected ${call.method} ${call.path}`)
    })

    await expect(new NaverSearchAdWriteAdapter(client).execute(input))
      .rejects.toThrow('missing nccKeywordId')
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /ncc/campaigns',
      'POST /ncc/campaigns',
      'GET /ncc/adgroups',
      'POST /ncc/adgroups',
      'POST /ncc/keywords',
    ])
  })

  it('validates all input before making any provider call', async () => {
    const { client, calls } = fakeClient(() => {
      throw new Error('provider must not be called')
    })
    const adapter = new NaverSearchAdWriteAdapter(client)

    await expect(adapter.execute({ ...input, bidAmt: 69 })).rejects.toThrow('bidAmt')
    await expect(adapter.execute({ ...input, keywordVariants: [] })).rejects.toThrow('keywordVariants')
    await expect(adapter.execute({ ...input, creative: { ...input.creative, finalUrl: 'not-a-url' } }))
      .rejects.toThrow('creative.finalUrl')
    expect(calls).toHaveLength(0)
  })
})
