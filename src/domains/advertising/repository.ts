import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  adAccounts,
  adDailyStatsV2,
  adExecutions,
  adReviewEvents,
  caseEntities,
  contentAssets,
  firmPolicies,
  firms,
  publications,
} from '@/lib/db/schema'
import {
  decideNaverAdPacing,
  evaluateNaverAdAction,
  isNaverAdActionAllowed,
  normalizeNaverAdPolicy,
  type NaverAdActionDecision,
  type NaverAdPacingDecision,
  type NaverAdPolicyInput,
} from './policy'
import { createEventEnvelope } from '@/domains/operations/event-envelope'
import { appendOutboxEvent } from '@/domains/operations/outbox'

type AdAccountRow = typeof adAccounts.$inferSelect
type AdExecutionRow = typeof adExecutions.$inferSelect
type AdReviewEventRow = typeof adReviewEvents.$inferSelect
type AdDailyStatRow = typeof adDailyStatsV2.$inferSelect
type FirmPolicyRow = typeof firmPolicies.$inferSelect
type CaseEntityRow = typeof caseEntities.$inferSelect
type ContentAssetRow = typeof contentAssets.$inferSelect
type PublicationRow = typeof publications.$inferSelect

export class AdvertisingValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdvertisingValidationError'
  }
}

export class AdvertisingScopeError extends Error {
  readonly code = 'ADVERTISING_FIRM_SCOPE_MISMATCH'

  constructor(message: string) {
    super(message)
    this.name = 'AdvertisingScopeError'
  }
}

export const AdScopeError = AdvertisingScopeError

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareDatesDescending(left: Date | null, right: Date | null): number {
  const leftMs = left?.getTime() ?? Number.NEGATIVE_INFINITY
  const rightMs = right?.getTime() ?? Number.NEGATIVE_INFINITY
  return rightMs - leftMs
}

function normalizeFirmId(value: unknown): number {
  const normalized = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new AdvertisingValidationError('firmId must be a non-negative safe integer')
  }
  return normalized as number
}

function normalizeCanonicalId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdvertisingValidationError(`${label} must be a canonical ID`)
  }
  const normalized = value.trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new AdvertisingValidationError(`${label} must be a canonical UUID`)
  }
  return normalized
}

function normalizeText(value: unknown, label: string, required = false): string | null {
  if (value === null || value === undefined) {
    if (required) throw new AdvertisingValidationError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw new AdvertisingValidationError(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized && required) throw new AdvertisingValidationError(`${label} is required`)
  return normalized || null
}

function normalizeProvider(value: unknown): string {
  const provider = normalizeText(value, 'provider') ?? 'naver_searchad'
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) {
    throw new AdvertisingValidationError('provider must be a canonical provider name')
  }
  return provider
}

function normalizeNonNegativeInteger(value: unknown, label: string, defaultValue?: number): number {
  const candidate = value === undefined || value === null ? defaultValue : value
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new AdvertisingValidationError(`${label} must be a non-negative safe integer`)
  }
  return candidate as number
}

function normalizeDate(value: Date | string | number | null | undefined, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new AdvertisingValidationError(`${label} must be a valid date`)
  return date
}

function normalizeDay(value: Date | string | number, label = 'day'): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const candidate = value.trim()
    const date = new Date(`${candidate}T00:00:00.000Z`)
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate) return candidate
  }
  const date = normalizeDate(value, label)
  return date.toISOString().slice(0, 10)
}

function dayFromDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function monthOf(day: string): string {
  return day.slice(0, 7)
}

function lastDayOfMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new AdvertisingValidationError('month must use YYYY-MM')
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  if (!Number.isSafeInteger(year) || monthNumber < 1 || monthNumber > 12) {
    throw new AdvertisingValidationError('month must use YYYY-MM')
  }
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
}

function stableJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (Array.isArray(value)) return value.map(stableJson)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableJson(record[key])]))
  }
  return value
}

function stableString(value: unknown): string {
  return JSON.stringify(stableJson(value))
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)
  const versioned = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${hex.slice(16, 20)}${hex.slice(20)}`
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}`
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime()
}

async function assertFirmExists(db: Db, firmId: number): Promise<void> {
  const [firm] = await db.select({ id: firms.id }).from(firms).where(eq(firms.id, firmId)).limit(1)
  if (!firm) throw new AdvertisingScopeError(`firm ${firmId} was not found`)
}

async function loadPolicy(db: Db, firmId: number): Promise<FirmPolicyRow | null> {
  const [policy] = await db.select().from(firmPolicies)
    .where(eq(firmPolicies.firmId, firmId)).limit(1)
  return policy ?? null
}

function policyInput(row: FirmPolicyRow | null, dryRun = true): NaverAdPolicyInput {
  return {
    monthlyBudget: row?.monthlyBudget ?? null,
    dailyBudget: row?.dailyBudget ?? null,
    bidCeiling: row?.bidCeiling ?? null,
    allowedCaseEntityIds: row?.allowedCaseEntityIds ?? [],
    allowedActions: row?.allowedActions ?? [],
    // A persisted policy is not customer-approved until both approval fields
    // are present.  The repository still forces dry-run for every command.
    customerApproved: row ? Boolean(row.approvedBy && row.approvedAt) : false,
    dryRun,
  }
}

function policySummary(row: FirmPolicyRow | null) {
  const normalized = normalizeNaverAdPolicy(policyInput(row, true))
  return {
    policyId: row?.id ?? null,
    policyVersion: row?.policyVersion ?? null,
    monthlyCeiling: normalized.monthlyCeiling,
    dailyCeiling: normalized.dailyCeiling,
    bidCeiling: normalized.bidCeiling,
    allowedCaseIds: [...normalized.allowedCaseIds],
    allowedActions: [...normalized.allowedActions],
    dryRun: true as const,
    validationErrors: [...normalized.validationErrors],
    performanceErrors: [...normalized.performanceErrors],
  }
}

function policyAllowsPlanning(row: FirmPolicyRow | null, caseId: string): boolean {
  if (!row) return false
  const input = policyInput(row, true)
  return isNaverAdActionAllowed(input, 'register', caseId)
    || isNaverAdActionAllowed(input, 'activate', caseId)
}

async function loadExecutionInFirm(db: Db, firmId: number, executionId: string): Promise<AdExecutionRow> {
  const [execution] = await db.select().from(adExecutions)
    .where(eq(adExecutions.id, executionId)).limit(1)
  if (!execution) throw new AdvertisingScopeError(`ad execution ${executionId} was not found`)
  if (execution.firmId !== firmId) {
    throw new AdvertisingScopeError(
      `ad execution ${executionId} belongs to firm ${execution.firmId}, not ${firmId}`,
    )
  }
  return execution
}

async function loadAccountInFirm(
  db: Db,
  firmId: number,
  accountId: string,
): Promise<AdAccountRow> {
  const [account] = await db.select().from(adAccounts)
    .where(eq(adAccounts.id, accountId)).limit(1)
  if (!account) throw new AdvertisingScopeError(`ad account ${accountId} was not found`)
  if (account.firmId !== firmId) {
    throw new AdvertisingScopeError(
      `ad account ${accountId} belongs to firm ${account.firmId}, not ${firmId}`,
    )
  }
  return account
}

async function assertExecutionCanonicalLinks(
  db: Db,
  firmId: number,
  execution: AdExecutionRow,
): Promise<{ caseRow: CaseEntityRow; asset: ContentAssetRow; publication: PublicationRow | null }> {
  const [caseRow] = await db.select().from(caseEntities)
    .where(eq(caseEntities.id, execution.caseEntityId)).limit(1)
  if (!caseRow) throw new AdvertisingScopeError(`case entity ${execution.caseEntityId} was not found`)

  const [asset] = await db.select().from(contentAssets)
    .where(eq(contentAssets.id, execution.contentAssetId)).limit(1)
  if (!asset) throw new AdvertisingScopeError(`content asset ${execution.contentAssetId} was not found`)
  if (asset.firmId !== firmId || asset.caseEntityId !== execution.caseEntityId) {
    throw new AdvertisingScopeError(`content asset ${asset.id} is outside the execution firm/case scope`)
  }

  let publication: PublicationRow | null = null
  if (execution.publicationId) {
    const [publicationRow] = await db.select().from(publications)
      .where(eq(publications.id, execution.publicationId)).limit(1)
    if (!publicationRow) throw new AdvertisingScopeError(`publication ${execution.publicationId} was not found`)
    if (
      publicationRow.firmId !== firmId
      || publicationRow.contentAssetId !== execution.contentAssetId
    ) {
      throw new AdvertisingScopeError(`publication ${publicationRow.id} is outside the execution asset scope`)
    }
    publication = publicationRow
  }
  if (execution.adAccountId) await loadAccountInFirm(db, firmId, execution.adAccountId)
  return { caseRow, asset, publication }
}

export interface PlanAdAccountInput {
  readonly firmId: number | string
  readonly provider?: string | null
  readonly externalCustomerId?: string | null
  readonly externalAccountId?: string | null
  readonly customerId?: string | null
  readonly status?: string
  readonly verifiedAt?: Date | null
  readonly lastSyncedAt?: Date | null
  readonly asOf?: Date | string | number
}

export interface AdAccountPlanResult {
  readonly account: AdAccountRow
  readonly created: boolean
  readonly updated: boolean
  readonly unchanged: boolean
  readonly inserted: boolean
}

/** Create or update one firm/provider account without contacting a provider. */
export async function planAdAccount(
  db: Db,
  input: PlanAdAccountInput,
): Promise<AdAccountPlanResult> {
  const firmId = normalizeFirmId(input.firmId)
  await assertFirmExists(db, firmId)
  const provider = normalizeProvider(input.provider)
  const externalCustomerId = normalizeText(
    input.externalCustomerId ?? input.externalAccountId ?? input.customerId,
    'externalCustomerId',
    true,
  )!
  const asOf = normalizeDate(input.asOf, 'asOf')
  const verifiedAt = input.verifiedAt === undefined || input.verifiedAt === null
    ? input.verifiedAt
    : normalizeDate(input.verifiedAt, 'verifiedAt')
  const lastSyncedAt = input.lastSyncedAt === undefined || input.lastSyncedAt === null
    ? input.lastSyncedAt
    : normalizeDate(input.lastSyncedAt, 'lastSyncedAt')

  const [existing] = await db.select().from(adAccounts).where(and(
    eq(adAccounts.firmId, firmId),
    eq(adAccounts.provider, provider),
  )).limit(1)
  if (!existing) {
    const [account] = await db.insert(adAccounts).values({
      firmId,
      provider,
      externalCustomerId,
      status: input.status?.trim() || 'pending',
      verifiedAt: verifiedAt ?? null,
      lastSyncedAt: lastSyncedAt ?? null,
      updatedAt: asOf,
    }).returning()
    if (!account) throw new Error('ad account insert returned no row')
    return { account, created: true, updated: false, unchanged: false, inserted: true }
  }

  const patch: Partial<typeof adAccounts.$inferInsert> = {}
  const status = input.status?.trim()
  if (existing.externalCustomerId !== externalCustomerId) patch.externalCustomerId = externalCustomerId
  if (status && existing.status !== status) patch.status = status
  if (input.verifiedAt !== undefined && !sameDate(existing.verifiedAt, verifiedAt ?? null)) {
    patch.verifiedAt = verifiedAt ?? null
  }
  if (input.lastSyncedAt !== undefined && !sameDate(existing.lastSyncedAt, lastSyncedAt ?? null)) {
    patch.lastSyncedAt = lastSyncedAt ?? null
  }
  if (Object.keys(patch).length === 0) {
    return { account: existing, created: false, updated: false, unchanged: true, inserted: false }
  }
  patch.updatedAt = asOf
  const [account] = await db.update(adAccounts).set(patch).where(and(
    eq(adAccounts.id, existing.id),
    eq(adAccounts.firmId, firmId),
    eq(adAccounts.provider, provider),
  )).returning()
  if (!account) throw new Error('ad account update returned no row')
  return { account, created: false, updated: true, unchanged: false, inserted: false }
}

export const ensureAdAccount = planAdAccount
export const createOrUpdateAdAccount = planAdAccount
export const planAdAccounts = planAdAccount
export const planAdvertisingAccount = planAdAccount

export interface PlanAdExecutionsInput {
  readonly firmId: number | string
  readonly adAccountId?: string | null
  readonly accountId?: string | null
  readonly provider?: string | null
  readonly externalCustomerId?: string | null
  readonly externalAccountId?: string | null
  readonly customerId?: string | null
  readonly publicationId?: string | null
  readonly caseEntityIds?: readonly string[]
  readonly contentAssetIds?: readonly string[]
  readonly desiredActive?: boolean
  readonly asOf?: Date | string | number
}

export interface AdExecutionPlanSkip {
  readonly contentAssetId: string
  readonly caseEntityId: string | null
  readonly reason:
    | 'policy_missing'
    | 'policy_not_allowed'
    | 'case_not_approved'
    | 'asset_not_ready'
    | 'publication_missing'
    | 'publication_not_live'
    | 'asset_case_mismatch'
}

export interface AdExecutionsPlanResult {
  readonly firmId: number
  readonly policy: ReturnType<typeof policySummary>
  readonly account: AdAccountRow | null
  readonly candidates: number
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: readonly AdExecutionPlanSkip[]
  readonly executions: readonly AdExecutionRow[]
}

function normalizeIdFilter(values: readonly string[] | undefined, label: string): Set<string> | null {
  if (values === undefined) return null
  const result = new Set<string>()
  for (const value of values) result.add(normalizeCanonicalId(value, label))
  return result
}

/**
 * Plan firm-owned executions from approved ad assets and live publications.
 * This only writes local intent/state rows; it never invokes an ad provider.
 */
export async function planAdExecutions(
  db: Db,
  input: PlanAdExecutionsInput,
): Promise<AdExecutionsPlanResult> {
  const firmId = normalizeFirmId(input.firmId)
  await assertFirmExists(db, firmId)
  const provider = normalizeProvider(input.provider)
  const asOf = normalizeDate(input.asOf, 'asOf')
  const requestedCaseIds = normalizeIdFilter(input.caseEntityIds, 'caseEntityId')
  const requestedAssetIds = normalizeIdFilter(input.contentAssetIds, 'contentAssetId')

  let account: AdAccountRow | null = null
  const requestedAccountId = input.adAccountId ?? input.accountId
  if (requestedAccountId) {
    account = await loadAccountInFirm(db, firmId, normalizeCanonicalId(requestedAccountId, 'adAccountId'))
    if (account.provider !== provider && input.provider !== undefined) {
      throw new AdvertisingScopeError(`ad account ${account.id} uses provider ${account.provider}, not ${provider}`)
    }
  } else if (input.externalCustomerId || input.externalAccountId || input.customerId) {
    account = (await planAdAccount(db, {
      firmId,
      provider,
      externalCustomerId: input.externalCustomerId,
      externalAccountId: input.externalAccountId,
      customerId: input.customerId,
      asOf,
    })).account
  } else {
    const [existingAccount] = await db.select().from(adAccounts).where(and(
      eq(adAccounts.firmId, firmId),
      eq(adAccounts.provider, provider),
    )).limit(1)
    account = existingAccount ?? null
  }

  const allAssets = await db.select().from(contentAssets).where(eq(contentAssets.firmId, firmId))
  const assets = allAssets
    .filter((asset) => asset.assetType === 'ad_landing')
    .filter((asset) => requestedAssetIds === null || requestedAssetIds.has(asset.id))
    .sort((left, right) => compareStrings(left.id, right.id))
  if (requestedAssetIds) {
    for (const id of requestedAssetIds) {
      const matching = allAssets.find((asset) => asset.id === id)
      if (!matching) {
        const [otherFirmAsset] = await db.select({ id: contentAssets.id, firmId: contentAssets.firmId })
          .from(contentAssets).where(eq(contentAssets.id, id)).limit(1)
        if (otherFirmAsset) {
          throw new AdvertisingScopeError(`content asset ${id} belongs to firm ${otherFirmAsset.firmId}, not ${firmId}`)
        }
        throw new AdvertisingScopeError(`content asset ${id} was not found`)
      }
    }
  }

  const caseIds = [...new Set(assets.map((asset) => asset.caseEntityId))]
  const [caseRows, publicationRows, existingExecutions, policy] = await Promise.all([
    caseIds.length
      ? db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds))
      : Promise.resolve([] as CaseEntityRow[]),
    db.select().from(publications).where(eq(publications.firmId, firmId)),
    db.select().from(adExecutions).where(eq(adExecutions.firmId, firmId)),
    loadPolicy(db, firmId),
  ])
  const cases = new Map(caseRows.map((row) => [row.id, row]))
  const publicationsByAsset = new Map<string, PublicationRow[]>()
  for (const publication of publicationRows) {
    const rows = publicationsByAsset.get(publication.contentAssetId) ?? []
    rows.push(publication)
    publicationsByAsset.set(publication.contentAssetId, rows)
  }
  for (const rows of publicationsByAsset.values()) {
    rows.sort((left, right) => (
      Number(right.status === 'live') - Number(left.status === 'live')
      || compareDatesDescending(left.updatedAt, right.updatedAt)
      || compareStrings(left.id, right.id)
    ))
  }
  const executionsByAsset = new Map(existingExecutions.map((execution) => [execution.contentAssetId, execution]))
  const skipped: AdExecutionPlanSkip[] = []
  const planned: AdExecutionRow[] = []
  let created = 0
  let updated = 0
  let unchanged = 0

  for (const asset of assets) {
    const caseRow = cases.get(asset.caseEntityId)
    const skip = (reason: AdExecutionPlanSkip['reason']): void => {
      skipped.push({ contentAssetId: asset.id, caseEntityId: caseRow?.id ?? null, reason })
    }
    if (requestedCaseIds && !requestedCaseIds.has(asset.caseEntityId)) continue
    if (!caseRow || caseRow.status !== 'approved') {
      skip('case_not_approved')
      continue
    }
    if (!policy) {
      skip('policy_missing')
      continue
    }
    if (!policyAllowsPlanning(policy, caseRow.id)) {
      skip('policy_not_allowed')
      continue
    }
    if (asset.status !== 'approved' && asset.status !== 'published') {
      skip('asset_not_ready')
      continue
    }
    const requestedPublicationId = input.publicationId
      ? normalizeCanonicalId(input.publicationId, 'publicationId')
      : null
    const publication = publicationsByAsset.get(asset.id)?.find((row) => (
      row.status === 'live'
      && row.contentAssetId === asset.id
      && row.firmId === firmId
      && (requestedPublicationId === null || row.id === requestedPublicationId)
    ))
    if (!publication) {
      const anyPublication = publicationsByAsset.get(asset.id)?.[0]
      skip(anyPublication ? 'publication_not_live' : 'publication_missing')
      continue
    }
    if (publication.firmId !== firmId || publication.contentAssetId !== asset.id) {
      skip('asset_case_mismatch')
      continue
    }

    const existing = executionsByAsset.get(asset.id)
    if (!existing) {
      const [execution] = await db.insert(adExecutions).values({
        firmId,
        adAccountId: account?.id ?? null,
        caseEntityId: caseRow.id,
        contentAssetId: asset.id,
        publicationId: publication.id,
        status: 'draft',
        desiredActive: input.desiredActive ?? false,
        updatedAt: asOf,
      }).returning()
      if (!execution) throw new Error('ad execution insert returned no row')
      executionsByAsset.set(asset.id, execution)
      planned.push(execution)
      created += 1
      continue
    }

    if (existing.firmId !== firmId || existing.caseEntityId !== caseRow.id) {
      throw new AdvertisingScopeError(`ad execution ${existing.id} has non-canonical tenant/case links`)
    }
    const patch: Partial<typeof adExecutions.$inferInsert> = {}
    if (existing.adAccountId !== (account?.id ?? null)) patch.adAccountId = account?.id ?? null
    if (existing.publicationId !== publication.id) patch.publicationId = publication.id
    if (input.desiredActive !== undefined && existing.desiredActive !== input.desiredActive) {
      patch.desiredActive = input.desiredActive
    }
    let execution = existing
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = asOf
      const [updatedExecution] = await db.update(adExecutions).set(patch).where(and(
        eq(adExecutions.id, existing.id),
        eq(adExecutions.firmId, firmId),
        eq(adExecutions.contentAssetId, asset.id),
      )).returning()
      if (!updatedExecution) throw new Error('ad execution update returned no row')
      execution = updatedExecution
      updated += 1
    } else {
      unchanged += 1
    }
    executionsByAsset.set(asset.id, execution)
    planned.push(execution)
  }

  planned.sort((left, right) => compareStrings(left.id, right.id))
  skipped.sort((left, right) => (
    compareStrings(left.contentAssetId, right.contentAssetId)
    || compareStrings(left.reason, right.reason)
  ))
  return {
    firmId,
    policy: policySummary(policy),
    account,
    candidates: assets.length,
    created,
    updated,
    unchanged,
    skipped,
    executions: planned,
  }
}

export const planAdvertising = planAdExecutions
export const planAdExecutionSet = planAdExecutions
export const planAdvertisingForFirm = planAdExecutions

export interface PlanSingleAdExecutionInput extends PlanAdExecutionsInput {
  readonly caseEntityId: string
  readonly contentAssetId: string
  readonly publicationId?: string | null
}

export interface SingleAdExecutionPlanResult {
  readonly execution: AdExecutionRow
  readonly created: boolean
  readonly updated: boolean
  readonly unchanged: boolean
}

/** Plan one canonical execution and return the persisted local row. */
export async function planAdExecution(
  db: Db,
  input: PlanSingleAdExecutionInput,
): Promise<SingleAdExecutionPlanResult> {
  const result = await planAdExecutions(db, {
    ...input,
    caseEntityIds: [normalizeCanonicalId(input.caseEntityId, 'caseEntityId')],
    contentAssetIds: [normalizeCanonicalId(input.contentAssetId, 'contentAssetId')],
  })
  const execution = result.executions[0]
  if (!execution) {
    const reason = result.skipped[0]?.reason ?? 'not eligible'
    throw new AdvertisingValidationError(`ad execution was not planned: ${reason}`)
  }
  if (input.publicationId && execution.publicationId !== normalizeCanonicalId(input.publicationId, 'publicationId')) {
    throw new AdvertisingScopeError(`ad execution ${execution.id} is linked to another publication`)
  }
  return {
    execution,
    created: result.created > 0,
    updated: result.updated > 0,
    unchanged: result.unchanged > 0,
  }
}

export const ensureAdExecution = planAdExecution

const AD_EXECUTION_STATES = new Set([
  'draft', 'submitted', 'pending_review', 'live', 'paused', 'rejected', 'retired',
])

const AD_EXECUTION_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  draft: new Set(['draft', 'submitted', 'retired']),
  submitted: new Set(['submitted', 'pending_review', 'live', 'rejected', 'paused', 'retired']),
  pending_review: new Set(['pending_review', 'live', 'rejected', 'paused', 'retired']),
  live: new Set(['live', 'paused', 'rejected', 'retired']),
  paused: new Set(['paused', 'live', 'rejected', 'retired']),
  rejected: new Set(['rejected', 'submitted', 'retired']),
  retired: new Set(['retired']),
})

export interface RecordAdProviderStateInput {
  readonly firmId: number | string
  readonly adExecutionId: string
  readonly status: string
  readonly campaignExternalId?: string | null
  readonly adGroupExternalId?: string | null
  readonly creativeExternalId?: string | null
  readonly bidAmount?: number | null
  readonly dailyBudget?: number | null
  readonly actor?: string
  readonly reason?: string | null
  readonly observedAt?: Date | string | number
}

export interface RecordedAdProviderState {
  readonly execution: AdExecutionRow
  readonly updated: boolean
  readonly unchanged: boolean
  readonly outboxInserted: boolean
}

/**
 * Persist one provider-state observation with a legal state transition and an
 * append-only audit event. This function performs no provider call itself.
 */
export async function recordAdProviderState(
  db: Db,
  input: RecordAdProviderStateInput,
): Promise<RecordedAdProviderState> {
  const firmId = normalizeFirmId(input.firmId)
  const executionId = normalizeCanonicalId(input.adExecutionId, 'adExecutionId')
  const status = normalizeText(input.status, 'status', true)!.toLocaleLowerCase('en-US')
  if (!AD_EXECUTION_STATES.has(status)) {
    throw new AdvertisingValidationError(`unsupported ad execution status: ${input.status}`)
  }
  const observedAt = normalizeDate(input.observedAt, 'observedAt')
  const actor = normalizeText(input.actor, 'actor') ?? 'system:naver-searchad'
  const reason = normalizeText(input.reason, 'reason')
  const campaignExternalId = input.campaignExternalId === undefined
    ? undefined
    : normalizeText(input.campaignExternalId, 'campaignExternalId')
  const adGroupExternalId = input.adGroupExternalId === undefined
    ? undefined
    : normalizeText(input.adGroupExternalId, 'adGroupExternalId')
  const creativeExternalId = input.creativeExternalId === undefined
    ? undefined
    : normalizeText(input.creativeExternalId, 'creativeExternalId')
  const bidAmount = input.bidAmount === undefined || input.bidAmount === null
    ? input.bidAmount
    : normalizeNonNegativeInteger(input.bidAmount, 'bidAmount')
  const dailyBudget = input.dailyBudget === undefined || input.dailyBudget === null
    ? input.dailyBudget
    : normalizeNonNegativeInteger(input.dailyBudget, 'dailyBudget')

  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db
    const execution = await loadExecutionInFirm(transactionalDb, firmId, executionId)
    await assertExecutionCanonicalLinks(transactionalDb, firmId, execution)
    if (!AD_EXECUTION_TRANSITIONS[execution.status]?.has(status)) {
      throw new AdvertisingValidationError(`illegal ad execution transition: ${execution.status} → ${status}`)
    }

    const next = {
      status,
      campaignExternalId: campaignExternalId === undefined ? execution.campaignExternalId : campaignExternalId,
      adGroupExternalId: adGroupExternalId === undefined ? execution.adGroupExternalId : adGroupExternalId,
      creativeExternalId: creativeExternalId === undefined ? execution.creativeExternalId : creativeExternalId,
      bidAmount: bidAmount === undefined ? execution.bidAmount : bidAmount,
      dailyBudget: dailyBudget === undefined ? execution.dailyBudget : dailyBudget,
    }
    const changed = execution.status !== next.status
      || execution.campaignExternalId !== next.campaignExternalId
      || execution.adGroupExternalId !== next.adGroupExternalId
      || execution.creativeExternalId !== next.creativeExternalId
      || execution.bidAmount !== next.bidAmount
      || execution.dailyBudget !== next.dailyBudget
    if (!changed) return { execution, updated: false, unchanged: true, outboxInserted: false }

    const [updated] = await transactionalDb.update(adExecutions).set({
      ...next,
      updatedAt: observedAt,
    }).where(and(
      eq(adExecutions.id, execution.id),
      eq(adExecutions.firmId, firmId),
      // Compare-and-set protects the pre-provider `submitted` barrier: two
      // workers that observed the same draft cannot both proceed to a write.
      eq(adExecutions.status, execution.status),
    )).returning()
    if (!updated) {
      throw new AdvertisingValidationError('ad execution changed concurrently; provider call was not authorized')
    }

    const payload = {
      previousStatus: execution.status,
      status: updated.status,
      campaignExternalId: updated.campaignExternalId,
      adGroupExternalId: updated.adGroupExternalId,
      creativeExternalId: updated.creativeExternalId,
      bidAmount: updated.bidAmount,
      dailyBudget: updated.dailyBudget,
      reason,
    }
    const fingerprint = createHash('sha256').update(stableString(payload), 'utf8').digest('hex')
    const idempotencyKey = `ad-provider-state:${firmId}:${execution.id}:${fingerprint}`
    const outbox = await appendOutboxEvent(transactionalDb, {
      aggregateType: 'ad_execution',
      envelope: createEventEnvelope({
        eventType: `ad.${updated.status}`,
        aggregateId: updated.id,
        firmId,
        actor,
        occurredAt: observedAt,
        recordedAt: observedAt,
        correlationId: idempotencyKey,
        causationId: null,
        schemaVersion: 1,
        policyVersion: 1,
        idempotencyKey,
        payload,
      }),
    })
    return { execution: updated, updated: true, unchanged: false, outboxInserted: outbox.inserted }
  })
}

export const recordProviderAdState = recordAdProviderState

export interface RecordAdReviewEventInput {
  readonly firmId: number | string
  readonly adExecutionId?: string
  readonly executionId?: string
  readonly status: string
  readonly reason?: string | null
  readonly raw?: Record<string, unknown> | null
  readonly observedAt?: Date | string | number
  readonly eventId?: string | null
  readonly idempotencyKey?: string | null
}

export interface RecordedAdReviewEvent {
  readonly event: AdReviewEventRow
  readonly execution: AdExecutionRow
  readonly inserted: boolean
}

function normalizeReviewStatus(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US')
  if (!normalized) throw new AdvertisingValidationError('review status is required')
  switch (normalized) {
    case 'approved':
    case 'accepted':
    case 'live': return 'approved'
    case 'pending':
    case 'under_review':
    case 'reviewing': return 'pending'
    case 'not_submitted':
    case 'draft': return 'not_submitted'
    case 'rejected':
    case 'denied':
    case 'disapproved': return 'rejected'
    case 'unknown': return 'unknown'
    default: return 'unknown'
  }
}

/** Record a tenant-scoped review observation and update its current state. */
export async function recordAdReviewEvent(
  db: Db,
  input: RecordAdReviewEventInput,
): Promise<RecordedAdReviewEvent> {
  const firmId = normalizeFirmId(input.firmId)
  const executionId = normalizeCanonicalId(input.adExecutionId ?? input.executionId, 'adExecutionId')
  const execution = await loadExecutionInFirm(db, firmId, executionId)
  await assertExecutionCanonicalLinks(db, firmId, execution)
  const status = normalizeReviewStatus(input.status)
  const reason = normalizeText(input.reason, 'reason')
  const observedAt = normalizeDate(input.observedAt, 'observedAt')
  const eventSeed = input.eventId?.trim()
    || input.idempotencyKey?.trim()
    || `review:${firmId}:${executionId}:${status}:${reason ?? ''}:${stableString(input.raw ?? null)}`
  const eventId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventSeed)
    ? eventSeed
    : deterministicUuid(`lawfirm-ads:review:v1:${firmId}:${executionId}:${eventSeed}`)

  const [inserted] = await db.insert(adReviewEvents).values({
    id: eventId,
    adExecutionId: execution.id,
    status,
    reason,
    raw: input.raw ?? null,
    observedAt,
  }).onConflictDoNothing({ target: adReviewEvents.id }).returning()
  const event = inserted ?? (await db.select().from(adReviewEvents)
    .where(eq(adReviewEvents.id, eventId)).limit(1))[0]
  if (!event) throw new Error('ad review event persistence returned no row')

  const [updatedExecution] = await db.update(adExecutions).set({
    reviewStatus: status,
    reviewReason: reason,
    updatedAt: observedAt,
  }).where(and(
    eq(adExecutions.id, execution.id),
    eq(adExecutions.firmId, firmId),
  )).returning()
  if (!updatedExecution) throw new Error('ad execution review update returned no row')
  return { event, execution: updatedExecution, inserted: Boolean(inserted) }
}

export const recordReviewEvent = recordAdReviewEvent
export const recordAdReview = recordAdReviewEvent
export const recordAdReviewEventForFirm = recordAdReviewEvent

export interface UpsertAdDailyStatInput {
  readonly firmId: number | string
  readonly adExecutionId: string
  readonly executionId?: string
  readonly day: Date | string | number
  readonly impressions?: number
  readonly clicks?: number
  readonly cost?: number
  readonly spend?: number
  readonly conversions?: number
  readonly qualifiedLeads?: number
  readonly retainedMatters?: number
  readonly syncedAt?: Date | string | number
}

export interface UpsertedAdDailyStat {
  readonly stat: AdDailyStatRow
  readonly inserted: boolean
  readonly updated: boolean
  readonly unchanged: boolean
}

/** Upsert one canonical execution/day snapshot; no provider read is performed. */
export async function upsertAdDailyStat(
  db: Db,
  input: UpsertAdDailyStatInput,
): Promise<UpsertedAdDailyStat> {
  const firmId = normalizeFirmId(input.firmId)
  const executionId = normalizeCanonicalId(input.adExecutionId ?? input.executionId, 'adExecutionId')
  const execution = await loadExecutionInFirm(db, firmId, executionId)
  await assertExecutionCanonicalLinks(db, firmId, execution)
  const day = normalizeDay(input.day)
  const impressions = normalizeNonNegativeInteger(input.impressions, 'impressions', 0)
  const clicks = normalizeNonNegativeInteger(input.clicks, 'clicks', 0)
  const cost = normalizeNonNegativeInteger(input.cost ?? input.spend, 'cost', 0)
  const conversions = normalizeNonNegativeInteger(input.conversions, 'conversions', 0)
  const qualifiedLeads = normalizeNonNegativeInteger(input.qualifiedLeads, 'qualifiedLeads', 0)
  const retainedMatters = normalizeNonNegativeInteger(input.retainedMatters, 'retainedMatters', 0)
  const syncedAt = input.syncedAt === undefined
    ? new Date()
    : normalizeDate(input.syncedAt, 'syncedAt')

  const [existing] = await db.select().from(adDailyStatsV2).where(and(
    eq(adDailyStatsV2.adExecutionId, execution.id),
    eq(adDailyStatsV2.day, day),
  )).limit(1)
  if (!existing) {
    const [stat] = await db.insert(adDailyStatsV2).values({
      firmId,
      adExecutionId: execution.id,
      day,
      impressions,
      clicks,
      cost,
      conversions,
      qualifiedLeads,
      retainedMatters,
      syncedAt,
    }).returning()
    if (!stat) throw new Error('ad daily stat insert returned no row')
    return { stat, inserted: true, updated: false, unchanged: false }
  }
  if (existing.firmId !== firmId) {
    throw new AdvertisingScopeError(`daily stat ${existing.id} belongs to firm ${existing.firmId}, not ${firmId}`)
  }
  const changed = existing.impressions !== impressions
    || existing.clicks !== clicks
    || existing.cost !== cost
    || existing.conversions !== conversions
    || existing.qualifiedLeads !== qualifiedLeads
    || existing.retainedMatters !== retainedMatters
  if (!changed && input.syncedAt === undefined) {
    return { stat: existing, inserted: false, updated: false, unchanged: true }
  }
  const [stat] = await db.update(adDailyStatsV2).set({
    firmId,
    impressions,
    clicks,
    cost,
    conversions,
    qualifiedLeads,
    retainedMatters,
    syncedAt,
  }).where(and(
    eq(adDailyStatsV2.id, existing.id),
    eq(adDailyStatsV2.firmId, firmId),
    eq(adDailyStatsV2.adExecutionId, execution.id),
    eq(adDailyStatsV2.day, day),
  )).returning()
  if (!stat) throw new Error('ad daily stat update returned no row')
  return { stat, inserted: false, updated: changed || input.syncedAt !== undefined, unchanged: false }
}

export const upsertDailyAdStat = upsertAdDailyStat
export const recordAdDailyStat = upsertAdDailyStat
export const upsertAdDailyStats = upsertAdDailyStat

export interface AdvertisingMetricsOptions {
  readonly firmId: number | string
  readonly from?: Date | string | number
  readonly to?: Date | string | number
  readonly day?: Date | string | number
  readonly month?: string
  readonly asOf?: Date | string | number
  readonly caseEntityIds?: readonly string[]
}

export interface AdvertisingMetricTotals {
  readonly impressions: number
  readonly clicks: number
  readonly spend: number
  readonly cost: number
  readonly conversions: number
  readonly qualifiedLeads: number
  readonly retainedMatters: number
  readonly ctr: number | null
  readonly cpc: number | null
}

export interface AdvertisingCaseMetrics extends AdvertisingMetricTotals {
  readonly firmId: number
  readonly caseEntityId: string
  readonly caseId: string
  readonly canonicalName: string
  readonly slug: string
  readonly contentAssetIds: readonly string[]
  readonly publicationIds: readonly string[]
  readonly adExecutionIds: readonly string[]
  readonly statuses: readonly string[]
  readonly status: string
  readonly desiredActive: boolean
  readonly reviewStatus: string
  readonly reviewState: string
  readonly reviewStatuses: readonly string[]
  readonly reviewReason: string | null
  readonly reviewStates: Readonly<Record<string, number>>
  readonly review: {
    readonly status: string
    readonly reason: string | null
    readonly states: Readonly<Record<string, number>>
    readonly eventCount: number
  }
  readonly pacing: AdvertisingPacingMetrics
  readonly pacingStatus: NaverAdPacingDecision['decision']
  readonly reviewEventCount: number
}

export interface AdvertisingPacingMetrics extends NaverAdPacingDecision {
  readonly monthlySpend: number | null
  readonly dailySpend: number | null
  readonly monthlyBudget: number | null
  readonly dailyBudget: number | null
  readonly monthlyPacing: number | null
  readonly dailyPacing: number | null
}

export interface AdvertisingDashboardMetrics {
  readonly firmId: number
  readonly period: { readonly from: string | null; readonly to: string | null; readonly asOf: string }
  readonly policy: ReturnType<typeof policySummary>
  readonly totals: AdvertisingMetricTotals
  readonly total: AdvertisingMetricTotals
  readonly cases: readonly AdvertisingCaseMetrics[]
  readonly byCase: readonly AdvertisingCaseMetrics[]
}

function emptyTotals(): AdvertisingMetricTotals {
  return {
    impressions: 0,
    clicks: 0,
    spend: 0,
    cost: 0,
    conversions: 0,
    qualifiedLeads: 0,
    retainedMatters: 0,
    ctr: null,
    cpc: null,
  }
}

function calculateTotals(rows: readonly AdDailyStatRow[]): AdvertisingMetricTotals {
  const totals = rows.reduce((result, row) => ({
    impressions: result.impressions + row.impressions,
    clicks: result.clicks + row.clicks,
    spend: result.spend + row.cost,
    cost: result.cost + row.cost,
    conversions: result.conversions + row.conversions,
    qualifiedLeads: result.qualifiedLeads + row.qualifiedLeads,
    retainedMatters: result.retainedMatters + row.retainedMatters,
  }), {
    impressions: 0,
    clicks: 0,
    spend: 0,
    cost: 0,
    conversions: 0,
    qualifiedLeads: 0,
    retainedMatters: 0,
  })
  return {
    ...totals,
    ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : null,
    cpc: totals.clicks > 0 ? totals.cost / totals.clicks : null,
  }
}

function normalizeMetricsWindow(input: AdvertisingMetricsOptions): {
  from: string | null
  to: string | null
  asOf: string
} {
  const month = input.month?.trim()
  const monthFrom = month ? `${month}-01` : null
  const monthTo = month ? lastDayOfMonth(month) : null
  const from = input.from === undefined ? monthFrom : normalizeDay(input.from, 'from')
  const to = input.to === undefined ? monthTo : normalizeDay(input.to, 'to')
  if (from && to && from > to) throw new AdvertisingValidationError('from must not be after to')
  const asOf = input.asOf !== undefined
    ? dayFromDate(normalizeDate(input.asOf, 'asOf'))
    : input.day !== undefined
      ? normalizeDay(input.day, 'day')
      : to ?? dayFromDate(new Date())
  return { from, to, asOf }
}

function statIsInWindow(day: string, window: { from: string | null; to: string | null }): boolean {
  return (window.from === null || day >= window.from) && (window.to === null || day <= window.to)
}

function statInMonth(day: string, asOf: string): boolean {
  return monthOf(day) === monthOf(asOf) && day <= asOf
}

function dailyStatForDay(rows: readonly AdDailyStatRow[], day: string): AdDailyStatRow[] {
  return rows.filter((row) => row.day === day)
}

function reviewStateCounts(executions: readonly AdExecutionRow[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const execution of executions) result[execution.reviewStatus] = (result[execution.reviewStatus] ?? 0) + 1
  return Object.fromEntries(Object.keys(result).sort(compareStrings).map((key) => [key, result[key]]))
}

function latestExecution(executions: readonly AdExecutionRow[]): AdExecutionRow {
  return [...executions].sort((left, right) => (
    compareDatesDescending(left.updatedAt, right.updatedAt)
    || compareStrings(right.id, left.id)
  ))[0]
}

/** Read only firm metrics; missing observations remain distinguishable from CPC=0. */
export async function getAdvertisingDashboardMetrics(
  db: Db,
  input: AdvertisingMetricsOptions | number,
): Promise<AdvertisingDashboardMetrics> {
  const options: AdvertisingMetricsOptions = typeof input === 'number'
    ? { firmId: input }
    : input
  const firmId = normalizeFirmId(options.firmId)
  await assertFirmExists(db, firmId)
  const window = normalizeMetricsWindow(options)
  const requestedCaseIds = normalizeIdFilter(options.caseEntityIds, 'caseEntityId')
  const [policy, executions] = await Promise.all([
    loadPolicy(db, firmId),
    db.select().from(adExecutions).where(eq(adExecutions.firmId, firmId)).orderBy(asc(adExecutions.id)),
  ])
  const selectedExecutions = executions.filter((execution) => (
    requestedCaseIds === null || requestedCaseIds.has(execution.caseEntityId)
  ))
  const executionIds = selectedExecutions.map((execution) => execution.id)
  const [statRows, eventRows] = executionIds.length
    ? await Promise.all([
        db.select().from(adDailyStatsV2).where(and(
          eq(adDailyStatsV2.firmId, firmId),
          inArray(adDailyStatsV2.adExecutionId, executionIds),
        )).orderBy(asc(adDailyStatsV2.day), asc(adDailyStatsV2.adExecutionId)),
        db.select().from(adReviewEvents).where(inArray(adReviewEvents.adExecutionId, executionIds))
          .orderBy(desc(adReviewEvents.observedAt), desc(adReviewEvents.id)),
      ])
    : [[], []] as [AdDailyStatRow[], AdReviewEventRow[]]
  const visibleStats = statRows.filter((row) => statIsInWindow(row.day, window))
  const statsByExecution = new Map<string, AdDailyStatRow[]>()
  for (const row of visibleStats) {
    const rows = statsByExecution.get(row.adExecutionId) ?? []
    rows.push(row)
    statsByExecution.set(row.adExecutionId, rows)
  }
  const allStatsByExecution = new Map<string, AdDailyStatRow[]>()
  for (const row of statRows) {
    const rows = allStatsByExecution.get(row.adExecutionId) ?? []
    rows.push(row)
    allStatsByExecution.set(row.adExecutionId, rows)
  }
  const eventsByExecution = new Map<string, AdReviewEventRow[]>()
  for (const event of eventRows) {
    const rows = eventsByExecution.get(event.adExecutionId) ?? []
    rows.push(event)
    eventsByExecution.set(event.adExecutionId, rows)
  }
  const caseIds = [...new Set(selectedExecutions.map((execution) => execution.caseEntityId))]
  const assetIds = [...new Set(selectedExecutions.map((execution) => execution.contentAssetId))]
  const publicationIds = [...new Set(selectedExecutions.flatMap((execution) => execution.publicationId ? [execution.publicationId] : []))]
  const [caseRows, assetRows, publicationRows] = await Promise.all([
    caseIds.length ? db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds)) : Promise.resolve([] as CaseEntityRow[]),
    assetIds.length ? db.select().from(contentAssets).where(and(eq(contentAssets.firmId, firmId), inArray(contentAssets.id, assetIds))) : Promise.resolve([] as ContentAssetRow[]),
    publicationIds.length ? db.select().from(publications).where(and(eq(publications.firmId, firmId), inArray(publications.id, publicationIds))) : Promise.resolve([] as PublicationRow[]),
  ])
  const casesById = new Map(caseRows.map((row) => [row.id, row]))
  const assetsById = new Map(assetRows.map((row) => [row.id, row]))
  const publicationsById = new Map(publicationRows.map((row) => [row.id, row]))
  const executionsByCase = new Map<string, AdExecutionRow[]>()
  for (const execution of selectedExecutions) {
    const asset = assetsById.get(execution.contentAssetId)
    if (!asset || asset.caseEntityId !== execution.caseEntityId) continue
    if (execution.publicationId) {
      const publication = publicationsById.get(execution.publicationId)
      if (!publication || publication.contentAssetId !== execution.contentAssetId) continue
    }
    const rows = executionsByCase.get(execution.caseEntityId) ?? []
    rows.push(execution)
    executionsByCase.set(execution.caseEntityId, rows)
  }

  const policyForPacing = policyInput(policy, true)
  const normalizedPolicy = normalizeNaverAdPolicy(policyForPacing)
  const caseMetrics: AdvertisingCaseMetrics[] = []
  for (const [caseEntityId, caseExecutions] of executionsByCase.entries()) {
    const caseRow = casesById.get(caseEntityId)
    if (!caseRow) continue
    caseExecutions.sort((left, right) => compareStrings(left.id, right.id))
    const reportStats = caseExecutions.flatMap((execution) => statsByExecution.get(execution.id) ?? [])
    const allStats = caseExecutions.flatMap((execution) => allStatsByExecution.get(execution.id) ?? [])
    const totals = calculateTotals(reportStats)
    const monthlyStats = allStats.filter((row) => statInMonth(row.day, window.asOf))
    const dailyStats = dailyStatForDay(monthlyStats, window.asOf)
    const monthlyTotals = calculateTotals(monthlyStats)
    const dailyTotals = calculateTotals(dailyStats)
    const hasMonthlyData = monthlyStats.length > 0
    const hasDailyData = dailyStats.length > 0
    const latest = latestExecution(caseExecutions)
    const pacingDecision = decideNaverAdPacing(policyForPacing, {
      caseEntityId,
      reviewStatus: latest.reviewStatus,
      monthlySpend: hasMonthlyData ? monthlyTotals.spend : undefined,
      dailySpend: hasDailyData ? dailyTotals.spend : undefined,
      performance: {
        impressions: totals.impressions,
        clicks: totals.clicks,
        conversions: totals.conversions,
        cost: totals.cost,
        cpc: totals.cpc,
        ctr: totals.ctr,
      },
    })
    const monthlyBudget = normalizedPolicy.monthlyCeiling
    const dailyBudget = normalizedPolicy.dailyCeiling
    const pacing: AdvertisingPacingMetrics = {
      ...pacingDecision,
      monthlySpend: hasMonthlyData ? monthlyTotals.spend : null,
      dailySpend: hasDailyData ? dailyTotals.spend : null,
      monthlyBudget,
      dailyBudget,
      monthlyPacing: monthlyBudget && hasMonthlyData ? monthlyTotals.spend / monthlyBudget : null,
      dailyPacing: dailyBudget && hasDailyData ? dailyTotals.spend / dailyBudget : null,
    }
    const states = reviewStateCounts(caseExecutions)
    const reviewEvents = caseExecutions.flatMap((execution) => eventsByExecution.get(execution.id) ?? [])
    const latestEvents = reviewEvents.sort((left, right) => (
      compareDatesDescending(left.observedAt, right.observedAt)
      || compareStrings(right.id, left.id)
    ))
    const assetIdList = [...new Set(caseExecutions.map((execution) => execution.contentAssetId))].sort(compareStrings)
    const publicationIdList = [...new Set(caseExecutions.flatMap((execution) => execution.publicationId ? [execution.publicationId] : []))].sort(compareStrings)
    const executionIdList = caseExecutions.map((execution) => execution.id).sort(compareStrings)
    const statusList = [...new Set(caseExecutions.map((execution) => execution.status))].sort(compareStrings)
    caseMetrics.push({
      firmId,
      caseEntityId,
      caseId: caseEntityId,
      canonicalName: caseRow.canonicalName,
      slug: caseRow.slug,
      contentAssetIds: assetIdList,
      publicationIds: publicationIdList,
      adExecutionIds: executionIdList,
      statuses: statusList,
      status: latest.status,
      desiredActive: latest.desiredActive,
      reviewStatus: latest.reviewStatus,
      reviewState: latest.reviewStatus,
      reviewStatuses: Object.keys(states).sort(compareStrings),
      reviewReason: latest.reviewReason,
      reviewStates: states,
      review: {
        status: latest.reviewStatus,
        reason: latest.reviewReason,
        states,
        eventCount: latestEvents.length,
      },
      reviewEventCount: latestEvents.length,
      pacing,
      pacingStatus: pacing.decision,
      ...totals,
    })
  }
  caseMetrics.sort((left, right) => (
    compareStrings(left.canonicalName, right.canonicalName)
    || compareStrings(left.caseEntityId, right.caseEntityId)
  ))
  const totals = calculateTotals(visibleStats.filter((row) => (
    selectedExecutions.some((execution) => execution.id === row.adExecutionId)
  )))
  return {
    firmId,
    period: window,
    policy: policySummary(policy),
    totals,
    total: totals,
    cases: caseMetrics,
    byCase: caseMetrics,
  }
}

export const getAdDashboardMetrics = getAdvertisingDashboardMetrics
export const getAdvertisingMetrics = getAdvertisingDashboardMetrics
export const loadAdvertisingMetrics = getAdvertisingDashboardMetrics
export const getDashboardMetrics = getAdvertisingDashboardMetrics

export interface DesiredStateRecommendationOptions extends AdvertisingMetricsOptions {
  /** Accepted for caller compatibility, but external execution is impossible here. */
  readonly dryRun?: boolean
  readonly execute?: boolean
}

export interface AdDesiredStateRecommendation {
  readonly firmId: number
  readonly caseEntityId: string
  readonly caseId: string
  readonly adExecutionId: string
  readonly currentStatus: string
  readonly desiredActive: boolean
  readonly action: 'register' | 'activate' | 'pause' | null
  readonly recommendation: 'register' | 'activate' | 'pause' | 'hold' | 'none'
  readonly reasonCodes: readonly string[]
  readonly pacing: AdvertisingPacingMetrics
  readonly policyDecision: NaverAdActionDecision | null
  readonly dryRun: true
  readonly allowed: false
  readonly executable: false
  readonly wouldExecute: false
}

export interface DesiredStateRecommendationResult {
  readonly firmId: number
  readonly dryRun: true
  readonly executed: false
  readonly externalCalls: 0
  readonly recommendations: readonly AdDesiredStateRecommendation[]
  readonly items: readonly AdDesiredStateRecommendation[]
}

/**
 * Recommend local desired-state changes only.  This function intentionally has
 * no executor parameter and always returns dry-run/false execution flags.
 */
export async function recommendAdDesiredState(
  db: Db,
  input: DesiredStateRecommendationOptions | number,
): Promise<DesiredStateRecommendationResult> {
  const options: DesiredStateRecommendationOptions = typeof input === 'number'
    ? { firmId: input }
    : input
  const metrics = await getAdvertisingDashboardMetrics(db, options)
  const policy = await loadPolicy(db, metrics.firmId)
  const executions = await db.select().from(adExecutions)
    .where(eq(adExecutions.firmId, metrics.firmId)).orderBy(asc(adExecutions.id))
  const byExecution = new Map<string, AdvertisingCaseMetrics>()
  for (const metric of metrics.cases) {
    for (const executionId of metric.adExecutionIds) byExecution.set(executionId, metric)
  }
  const recommendations: AdDesiredStateRecommendation[] = []
  const activeStatuses = new Set(['submitted', 'pending_review', 'live'])
  for (const execution of executions) {
    const metric = byExecution.get(execution.id)
    if (!metric) continue
    let action: AdDesiredStateRecommendation['action'] = null
    let recommendation: AdDesiredStateRecommendation['recommendation'] = 'none'
    if (!execution.desiredActive && activeStatuses.has(execution.status)) {
      action = 'pause'
      recommendation = 'pause'
    } else if (execution.desiredActive && execution.status === 'paused') {
      if (metric.reviewStatus !== 'approved' || metric.pacing.decision !== 'continue') {
        recommendation = 'hold'
      } else {
        action = 'activate'
        recommendation = 'activate'
      }
    } else if (execution.desiredActive && execution.status === 'draft') {
      if (metric.reviewStatus !== 'approved' || metric.pacing.decision !== 'continue') {
        recommendation = 'hold'
      } else {
        action = 'register'
        recommendation = 'register'
      }
    }

    let policyDecision: NaverAdActionDecision | null = null
    const reasonCodes = [...metric.pacing.reasonCodes]
    if (action) {
      const request = {
        action,
        caseEntityId: execution.caseEntityId,
        monthlySpend: metric.pacing.monthlySpend ?? undefined,
        dailySpend: metric.pacing.dailySpend ?? undefined,
        requestedMonthlyBudget: policy?.monthlyBudget ?? undefined,
        requestedDailyBudget: execution.dailyBudget ?? policy?.dailyBudget ?? undefined,
        requestedBid: execution.bidAmount ?? undefined,
      }
      // Force the policy input to dry-run even if a caller passes execute=true.
      policyDecision = evaluateNaverAdAction(policyInput(policy, true), request)
      for (const code of policyDecision.reasonCodes) {
        if (!reasonCodes.includes(code)) reasonCodes.push(code)
      }
      if (!policyDecision.approved) recommendation = 'hold'
    }
    recommendations.push({
      firmId: metrics.firmId,
      caseEntityId: execution.caseEntityId,
      caseId: execution.caseEntityId,
      adExecutionId: execution.id,
      currentStatus: execution.status,
      desiredActive: execution.desiredActive,
      action,
      recommendation,
      reasonCodes,
      pacing: metric.pacing,
      policyDecision,
      dryRun: true,
      allowed: false,
      executable: false,
      wouldExecute: false,
    })
  }
  recommendations.sort((left, right) => compareStrings(left.adExecutionId, right.adExecutionId))
  return {
    firmId: metrics.firmId,
    dryRun: true,
    executed: false,
    externalCalls: 0,
    recommendations,
    items: recommendations,
  }
}

export const recommendDesiredState = recommendAdDesiredState
export const recommendAdvertisingDesiredState = recommendAdDesiredState
export const recommendDesiredAdState = recommendAdDesiredState
