import type { AdApi } from '@/lib/engine/register-run'

/**
 * The write adapter accepts the same request contract as the legacy engine,
 * but never constructs a client or performs a request at module load time.
 */
export type NaverSearchAdWriteClient = AdApi

export type NaverAdKeywordVariant = {
  readonly text: string
  readonly rule?: string
}

export type NaverAdCreativeInput = {
  /** Canonical field name. `title` is accepted as the legacy engine alias. */
  readonly headline?: string
  readonly title?: string
  readonly description: string
  /** Canonical field name. `landingUrl` is accepted as the legacy engine alias. */
  readonly finalUrl?: string
  readonly landingUrl?: string
}

/** One local canonical execution. Names are supplied by the caller and are never generated here. */
export type NaverAdExecutionWriteInput = {
  readonly adExecutionId: string
  readonly campaignName: string
  /** `adgroupName` matches the existing engine contract; `adGroupName` is a spelling alias. */
  readonly adgroupName?: string
  readonly adGroupName?: string
  readonly pcChannelId: string
  readonly mobileChannelId: string
  readonly bidAmt: number
  /** Zero means that the proven engine payload omits the daily-budget fields. */
  readonly dailyBudget: number
  readonly keywordVariants: readonly NaverAdKeywordVariant[]
  readonly creative: NaverAdCreativeInput
}

export type CreativeIdempotency = 'reused' | 'non-idempotent-create'

export type NaverAdExecutionWriteResult = {
  readonly adExecutionId: string
  readonly campaignId: string
  readonly campaignReused: boolean
  /** Both spellings are returned because the legacy provider field is `nccAdgroupId`. */
  readonly adgroupId: string
  readonly adGroupId: string
  readonly adgroupReused: boolean
  readonly keywordIds: readonly string[]
  readonly creativeId: string
  readonly creative: {
    readonly id: string
    readonly reused: boolean
    readonly idempotency: CreativeIdempotency
  }
  /** Explicitly tells callers that a creative POST may duplicate on retry. */
  readonly creativeIdempotency: CreativeIdempotency
}

export const NAVER_AD_OPERATION_ENDPOINTS = Object.freeze({
  campaigns: '/ncc/campaigns',
  adgroups: '/ncc/adgroups',
  keywords: '/ncc/keywords',
  ads: '/ncc/ads',
} as const)

const NAVER_AD_OPERATION_METHODS = Object.freeze({
  get: 'GET',
  post: 'POST',
} as const)

type NaverAdEndpoint = (typeof NAVER_AD_OPERATION_ENDPOINTS)[keyof typeof NAVER_AD_OPERATION_ENDPOINTS]
type NaverAdMethod = (typeof NAVER_AD_OPERATION_METHODS)[keyof typeof NAVER_AD_OPERATION_METHODS]
type RequestOptions = { query?: Record<string, string>; body?: unknown }
type UnknownRecord = Record<string, unknown>

type NormalizedInput = {
  readonly adExecutionId: string
  readonly campaignName: string
  readonly adgroupName: string
  readonly pcChannelId: string
  readonly mobileChannelId: string
  readonly bidAmt: number
  readonly dailyBudget: number
  readonly keywordVariants: readonly { readonly text: string }[]
  readonly creative: {
    readonly headline: string
    readonly description: string
    readonly finalUrl: string
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} is required`)
  }
  return value.trim()
}

function requiredSafeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`)
  }
  return value as number
}

function requiredFinalUrl(value: unknown): string {
  const finalUrl = requiredText(value, 'creative.finalUrl')
  let parsed: URL
  try {
    parsed = new URL(finalUrl)
  } catch {
    throw new TypeError('creative.finalUrl must be an absolute URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('creative.finalUrl must use http or https')
  }
  return finalUrl
}

function normalizeInput(input: NaverAdExecutionWriteInput): NormalizedInput {
  if (!isRecord(input)) throw new TypeError('ad execution input must be an object')

  const adgroupName = input.adgroupName ?? input.adGroupName
  const creative = input.creative
  if (!isRecord(creative)) throw new TypeError('creative is required')

  const keywordVariants = input.keywordVariants
  if (!Array.isArray(keywordVariants) || keywordVariants.length === 0) {
    throw new TypeError('keywordVariants must be a non-empty array')
  }

  const seenKeywords = new Set<string>()
  const normalizedKeywords = keywordVariants.map((variant, index) => {
    if (!isRecord(variant)) throw new TypeError(`keywordVariants[${index}] must be an object`)
    const text = requiredText(variant.text, `keywordVariants[${index}].text`)
    if (seenKeywords.has(text)) throw new TypeError(`keywordVariants contains duplicate keyword: ${text}`)
    seenKeywords.add(text)
    return { text }
  })

  const headline = requiredText(creative.headline ?? creative.title, 'creative.headline')
  const description = requiredText(creative.description, 'creative.description')
  const finalUrl = requiredFinalUrl(creative.finalUrl ?? creative.landingUrl)

  return {
    adExecutionId: requiredText(input.adExecutionId, 'adExecutionId'),
    campaignName: requiredText(input.campaignName, 'campaignName'),
    adgroupName: requiredText(adgroupName, 'adgroupName'),
    pcChannelId: requiredText(input.pcChannelId, 'pcChannelId'),
    mobileChannelId: requiredText(input.mobileChannelId, 'mobileChannelId'),
    bidAmt: requiredSafeInteger(input.bidAmt, 'bidAmt', 70),
    dailyBudget: requiredSafeInteger(input.dailyBudget, 'dailyBudget', 0),
    keywordVariants: normalizedKeywords,
    creative: { headline, description, finalUrl },
  }
}

function responseRecord(value: unknown, operation: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${operation} response must be an object`)
  return value
}

function responseId(value: unknown, field: string, operation: string): string {
  const id = isRecord(value) ? value[field] : undefined
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`${operation} response is missing ${field}`)
  }
  return id.trim()
}

function responseRows(value: unknown, idField: string, operation: string): UnknownRecord[] {
  if (!Array.isArray(value)) throw new Error(`${operation} response must be an array`)
  const ids = new Set<string>()
  return value.map((row, index) => {
    const record = responseRecord(row, `${operation}[${index}]`)
    const id = responseId(record, idField, `${operation}[${index}]`)
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new Error(`${operation}[${index}] response is missing name`)
    }
    if (ids.has(id)) throw new Error(`${operation} response contains duplicate ${idField}`)
    ids.add(id)
    return record
  })
}

function uniqueNamedRow(
  rows: readonly UnknownRecord[], name: string, idField: string, operation: string,
): { id: string; row: UnknownRecord } | null {
  const matches = rows.filter((row) => row.name === name)
  if (matches.length > 1) throw new Error(`${operation} response contains duplicate name: ${name}`)
  if (matches.length === 0) return null
  return { id: responseId(matches[0], idField, operation), row: matches[0] }
}

function assertOptionalParent(row: UnknownRecord, expectedParentId: string, operation: string): void {
  if (row.nccCampaignId === undefined) return
  if (typeof row.nccCampaignId !== 'string' || row.nccCampaignId.trim() === '') {
    throw new Error(`${operation} response has malformed nccCampaignId`)
  }
  if (row.nccCampaignId.trim() !== expectedParentId) {
    throw new Error(`${operation} response has a campaign mismatch`)
  }
}

/**
 * Create one canonical target ad execution against an injected SearchAd
 * client. The local, proven contract has no stable creative lookup shape:
 * `/ncc/ads` is therefore deliberately POST-only and the result exposes that
 * retry risk. Campaigns and ad-groups converge by deterministic name.
 */
export class NaverSearchAdWriteAdapter {
  constructor(private readonly client: NaverSearchAdWriteClient) {
    if (!client || typeof client.request !== 'function') {
      throw new TypeError('a Naver SearchAd request client is required')
    }
  }

  async execute(input: NaverAdExecutionWriteInput): Promise<NaverAdExecutionWriteResult> {
    const normalized = normalizeInput(input)
    const campaign = await this.ensureCampaign(normalized.campaignName)
    const adgroup = await this.ensureAdgroup(campaign.id, normalized)
    const keywordIds = await this.createKeywords(adgroup.id, normalized.keywordVariants)
    const creativeId = await this.createCreative(adgroup.id, normalized.creative)

    return {
      adExecutionId: normalized.adExecutionId,
      campaignId: campaign.id,
      campaignReused: campaign.reused,
      adgroupId: adgroup.id,
      adGroupId: adgroup.id,
      adgroupReused: adgroup.reused,
      keywordIds,
      creativeId,
      creative: { id: creativeId, reused: false, idempotency: 'non-idempotent-create' },
      creativeIdempotency: 'non-idempotent-create',
    }
  }

  /** Alias for callers that name the operation after the canonical target. */
  async write(input: NaverAdExecutionWriteInput): Promise<NaverAdExecutionWriteResult> {
    return this.execute(input)
  }

  private async request<T>(method: NaverAdMethod, endpoint: NaverAdEndpoint, options?: RequestOptions): Promise<T> {
    return this.client.request<T>(method, endpoint, options)
  }

  private async ensureCampaign(name: string): Promise<{ id: string; reused: boolean }> {
    const existing = responseRows(
      await this.request<unknown[]>(NAVER_AD_OPERATION_METHODS.get, NAVER_AD_OPERATION_ENDPOINTS.campaigns),
      'nccCampaignId',
      'GET /ncc/campaigns',
    )
    const found = uniqueNamedRow(existing, name, 'nccCampaignId', 'GET /ncc/campaigns')
    if (found) return { id: found.id, reused: true }

    const created = await this.request<unknown>(NAVER_AD_OPERATION_METHODS.post, NAVER_AD_OPERATION_ENDPOINTS.campaigns, {
      body: { name, campaignTp: 'WEB_SITE' },
    })
    return { id: responseId(responseRecord(created, 'POST /ncc/campaigns'), 'nccCampaignId', 'POST /ncc/campaigns'), reused: false }
  }

  private async ensureAdgroup(
    campaignId: string,
    input: NormalizedInput,
  ): Promise<{ id: string; reused: boolean }> {
    const existing = responseRows(
      await this.request<unknown[]>(NAVER_AD_OPERATION_METHODS.get, NAVER_AD_OPERATION_ENDPOINTS.adgroups, {
        query: { nccCampaignId: campaignId },
      }),
      'nccAdgroupId',
      'GET /ncc/adgroups',
    )
    const sameCampaign = existing.filter((row) => {
      if (row.name !== input.adgroupName) return false
      if (row.nccCampaignId === undefined) return true
      return typeof row.nccCampaignId === 'string' && row.nccCampaignId.trim() === campaignId
    })
    const mismatched = existing.some((row) => row.name === input.adgroupName
      && row.nccCampaignId !== undefined
      && (typeof row.nccCampaignId !== 'string' || row.nccCampaignId.trim() !== campaignId))
    if (mismatched) throw new Error('GET /ncc/adgroups response has a campaign mismatch')
    const found = uniqueNamedRow(sameCampaign, input.adgroupName, 'nccAdgroupId', 'GET /ncc/adgroups')
    if (found) {
      assertOptionalParent(found.row, campaignId, 'GET /ncc/adgroups')
      return { id: found.id, reused: true }
    }

    const body = {
      name: input.adgroupName,
      nccCampaignId: campaignId,
      pcChannelId: input.pcChannelId,
      mobileChannelId: input.mobileChannelId,
      bidAmt: input.bidAmt,
      ...(input.dailyBudget > 0
        ? { dailyBudget: input.dailyBudget, useDailyBudget: true }
        : {}),
    }
    const created = await this.request<unknown>(NAVER_AD_OPERATION_METHODS.post, NAVER_AD_OPERATION_ENDPOINTS.adgroups, { body })
    return {
      id: responseId(responseRecord(created, 'POST /ncc/adgroups'), 'nccAdgroupId', 'POST /ncc/adgroups'),
      reused: false,
    }
  }

  private async createKeywords(
    adgroupId: string,
    variants: readonly { readonly text: string }[],
  ): Promise<readonly string[]> {
    const response = await this.request<unknown>(NAVER_AD_OPERATION_METHODS.post, NAVER_AD_OPERATION_ENDPOINTS.keywords, {
      query: { nccAdgroupId: adgroupId },
      body: variants.map((variant) => ({ keyword: variant.text, useGroupBidAmt: true })),
    })
    if (!Array.isArray(response) || response.length !== variants.length) {
      throw new Error('POST /ncc/keywords response count does not match keywordVariants')
    }
    const ids = response.map((row, index) => responseId(row, 'nccKeywordId', `POST /ncc/keywords[${index}]`))
    if (new Set(ids).size !== ids.length) throw new Error('POST /ncc/keywords response contains duplicate nccKeywordId')
    return ids
  }

  private async createCreative(
    adgroupId: string,
    creative: NormalizedInput['creative'],
  ): Promise<string> {
    const response = await this.request<unknown>(NAVER_AD_OPERATION_METHODS.post, NAVER_AD_OPERATION_ENDPOINTS.ads, {
      body: {
        nccAdgroupId: adgroupId,
        type: 'TEXT_45',
        ad: {
          headline: creative.headline,
          description: creative.description,
          pc: { final: creative.finalUrl },
          mobile: { final: creative.finalUrl },
        },
      },
    })
    return responseId(responseRecord(response, 'POST /ncc/ads'), 'nccAdId', 'POST /ncc/ads')
  }
}

export const NaverAdOperations = NaverSearchAdWriteAdapter

export function createNaverSearchAdWriteAdapter(client: NaverSearchAdWriteClient): NaverSearchAdWriteAdapter {
  return new NaverSearchAdWriteAdapter(client)
}

export async function writeNaverAdExecution(
  client: NaverSearchAdWriteClient,
  input: NaverAdExecutionWriteInput,
): Promise<NaverAdExecutionWriteResult> {
  return new NaverSearchAdWriteAdapter(client).execute(input)
}
