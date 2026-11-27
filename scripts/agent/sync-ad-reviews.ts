/**
 * Daily target-model Naver SearchAd creative-review synchronizer.
 *
 * The service is intentionally independent of the database, credential key,
 * and provider client.  The CLI wrapper supplies those pieces; tests can
 * inject all of them without DATABASE_URL or a live Naver account.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { getDb, type Db } from '@/lib/db/client'
import {
  recordAdProviderState as repositoryRecordAdProviderState,
  recordAdReviewEvent as repositoryRecordAdReviewEvent,
  type RecordAdProviderStateInput,
  type RecordAdReviewEventInput,
} from '@/domains/advertising/repository'
import { decryptCred } from '@/lib/engine/cred-crypto'
import { adExecutions, firmCredentials, firms } from '@/lib/db/schema'
import type {
  NaverCreativeReviewResult,
  NaverCreativeReviewTarget,
} from '@/platform/integrations/naver-searchad'

export const NAVER_SEARCHAD_PROVIDER = 'naver_searchad' as const
const ACTIVE_FIRM_STATUSES = ['pilot', 'active'] as const
const TARGET_EXECUTION_STATUSES = ['submitted', 'pending_review'] as const
const REVIEW_STATUSES = ['approved', 'pending', 'rejected', 'unknown'] as const

export type AdReviewFirmStatus = (typeof ACTIVE_FIRM_STATUSES)[number]
export type AdReviewExecutionStatus = (typeof TARGET_EXECUTION_STATUSES)[number]
export type AdReviewStatus = (typeof REVIEW_STATUSES)[number]

export interface AdReviewTarget {
  readonly firmId: number
  readonly firmStatus: string
  readonly adExecutionId: string
  readonly status: string
  readonly creativeExternalId: string | null
}

export interface EncryptedFirmCredentials {
  readonly firmId?: number
  readonly provider?: string
  readonly customerId: string
  readonly apiKeyEnc: string
  readonly secretEnc: string
  readonly verifiedAt: Date | null
}

export interface NaverSearchAdCredentials {
  readonly customerId: string
  readonly apiKey: string
  readonly secret: string
}

export interface NaverCreativeReviewAdapter {
  fetchCreativeReviews(
    targets: readonly NaverCreativeReviewTarget[],
  ): Promise<readonly NaverCreativeReviewResult[]>
}

export interface AdReviewAdapterContext {
  readonly firmId: number
  readonly provider: typeof NAVER_SEARCHAD_PROVIDER
  readonly targets: readonly AdReviewTarget[]
}

export interface AdReviewSyncDependencies {
  /** Must already be loaded from pilot/active firms and target statuses. */
  readonly loadTargets: () => Promise<readonly AdReviewTarget[]>
  /** Returns one verified credential row with encrypted values only. */
  readonly loadCredentials: (firmId: number) => Promise<EncryptedFirmCredentials | null>
  readonly decryptCredential?: (payload: string) => string
  /** The service never constructs a provider client; this factory returns a read adapter. */
  readonly createAdapter: (
    credentials: NaverSearchAdCredentials,
    context: AdReviewAdapterContext,
  ) => NaverCreativeReviewAdapter | Promise<NaverCreativeReviewAdapter>
  readonly recordAdProviderState: (input: RecordAdProviderStateInput) => Promise<unknown>
  readonly recordAdReviewEvent: (input: RecordAdReviewEventInput) => Promise<unknown>
}

export interface AdReviewSyncInput {
  /** Observation time used for local provider-state and review-event records. */
  readonly now?: Date
}

export type AdReviewSyncStatus = 'ok' | 'partial' | 'skipped'

export interface AdReviewFirmIssue {
  readonly firmId: number
  readonly kind: 'failed' | 'skipped'
  /** Static reason only. Provider/database error messages are never returned. */
  readonly reason: string
}

export interface AdReviewSyncResult {
  readonly status: AdReviewSyncStatus
  readonly skipReason: string | null
  readonly firms: number
  readonly succeededFirms: number
  readonly failedFirms: number
  readonly skippedFirms: number
  readonly eligibleExecutions: number
  readonly reviewsReturned: number
  readonly reviewsPersisted: number
  readonly providerTransitions: number
  readonly reviewEvents: number
  readonly issues: readonly AdReviewFirmIssue[]
}

export type DatabaseAdReviewDependencies = Omit<AdReviewSyncDependencies, 'decryptCredential' | 'createAdapter'>

export interface AdReviewSyncMainOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly argv?: readonly string[]
  readonly now?: Date
  readonly db?: Db
  readonly getDb?: () => Db | Promise<Db>
  /** Complete or partial core dependencies for tests. */
  readonly dependencies?: Partial<AdReviewSyncDependencies>
  readonly log?: (message: string) => void
}

class ProviderResultMismatchError extends Error {
  constructor() {
    super('provider review result did not match its requested target')
    this.name = 'ProviderResultMismatchError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function normalizeFirmId(value: unknown): number {
  const candidate = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new TypeError('firmId must be a non-negative safe integer')
  }
  return candidate as number
}

function normalizeDate(value: Date | undefined): Date {
  const date = value ? new Date(value.getTime()) : new Date()
  if (Number.isNaN(date.getTime())) throw new TypeError('now must be a valid date')
  return date
}

function normalizeTargetStatus(value: unknown): AdReviewExecutionStatus | null {
  const status = nonEmptyText(value)?.toLocaleLowerCase('en-US')
  return status && (TARGET_EXECUTION_STATUSES as readonly string[]).includes(status)
    ? status as AdReviewExecutionStatus
    : null
}

function normalizeFirmStatus(value: unknown): AdReviewFirmStatus | null {
  const status = nonEmptyText(value)?.toLocaleLowerCase('en-US')
  return status && (ACTIVE_FIRM_STATUSES as readonly string[]).includes(status)
    ? status as AdReviewFirmStatus
    : null
}

function normalizeReviewStatus(value: unknown): AdReviewStatus {
  const status = nonEmptyText(value)?.toLocaleLowerCase('en-US')
  switch (status) {
    case 'approved':
    case 'accepted':
    case 'eligible':
    case 'live':
      return 'approved'
    case 'pending':
    case 'reviewing':
    case 'under_review':
    case 'in_review':
      return 'pending'
    case 'rejected':
    case 'denied':
    case 'disapproved':
      return 'rejected'
    default:
      return 'unknown'
  }
}

function normalizeTargets(targets: readonly AdReviewTarget[]): AdReviewTarget[] {
  if (!Array.isArray(targets)) throw new TypeError('ad review targets must be an array')

  const byExecutionId = new Map<string, AdReviewTarget>()
  for (const target of targets) {
    if (!isRecord(target)) throw new TypeError('ad review target must be an object')
    const firmId = normalizeFirmId(target.firmId)
    const firmStatus = normalizeFirmStatus(target.firmStatus)
    const status = normalizeTargetStatus(target.status)
    const adExecutionId = nonEmptyText(target.adExecutionId)
    const creativeExternalId = nonEmptyText(target.creativeExternalId)
    if (!firmStatus || !status || !adExecutionId || !creativeExternalId) continue

    const normalized: AdReviewTarget = {
      firmId,
      firmStatus,
      status,
      adExecutionId,
      creativeExternalId,
    }
    const existing = byExecutionId.get(adExecutionId)
    if (existing) {
      if (
        existing.firmId !== normalized.firmId
        || existing.creativeExternalId !== normalized.creativeExternalId
      ) {
        throw new TypeError(`ad execution ${adExecutionId} maps to multiple review targets`)
      }
      continue
    }
    byExecutionId.set(adExecutionId, normalized)
  }
  return [...byExecutionId.values()]
}

/** Group eligible executions without ever mixing firms. */
export function groupAdReviewTargets(
  targets: readonly AdReviewTarget[],
): Map<number, readonly AdReviewTarget[]> {
  const groups = new Map<number, AdReviewTarget[]>()
  for (const target of normalizeTargets(targets)) {
    const group = groups.get(target.firmId)
    if (group) group.push(target)
    else groups.set(target.firmId, [target])
  }
  return groups
}

function emptyResult(skipReason: string | null): AdReviewSyncResult {
  return {
    status: 'skipped',
    skipReason,
    firms: 0,
    succeededFirms: 0,
    failedFirms: 0,
    skippedFirms: 0,
    eligibleExecutions: 0,
    reviewsReturned: 0,
    reviewsPersisted: 0,
    providerTransitions: 0,
    reviewEvents: 0,
    issues: [],
  }
}

function usableCredentials(value: EncryptedFirmCredentials | null): value is EncryptedFirmCredentials {
  return Boolean(
    value
    && value.verifiedAt instanceof Date
    && !Number.isNaN(value.verifiedAt.getTime())
    && nonEmptyText(value.customerId)
    && nonEmptyText(value.apiKeyEnc)
    && nonEmptyText(value.secretEnc),
  )
}

function credentialsBelongToFirm(value: EncryptedFirmCredentials, firmId: number): boolean {
  if (value.firmId !== undefined && normalizeFirmId(value.firmId) !== firmId) return false
  if (value.provider !== undefined && value.provider !== NAVER_SEARCHAD_PROVIDER) return false
  return true
}

function credentialsForClient(
  encrypted: EncryptedFirmCredentials,
  decrypt: (payload: string) => string,
): NaverSearchAdCredentials {
  const customerId = nonEmptyText(encrypted.customerId)
  const apiKey = nonEmptyText(decrypt(encrypted.apiKeyEnc))
  const secret = nonEmptyText(decrypt(encrypted.secretEnc))
  if (!customerId || !apiKey || !secret) throw new Error('credentials are incomplete after decryption')
  return { customerId, apiKey, secret }
}

function safeFailureReason(error: unknown): string {
  return error instanceof ProviderResultMismatchError
    ? 'provider-result-mismatch'
    : 'firm-sync-failed'
}

/** Recognize PostgreSQL's missing-relation error without exposing its message. */
export function undefinedTable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (value.code === '42P01') return true
    if (typeof value.message === 'string' && /relation .* does not exist/i.test(value.message)) return true
    current = value.cause
  }
  return false
}

function normalizeProviderResult(
  result: unknown,
  targetsByKey: ReadonlyMap<string, AdReviewTarget>,
  firmId: number,
): NaverCreativeReviewResult & { reviewStatus: AdReviewStatus; reason: string | null } {
  if (!isRecord(result)) throw new ProviderResultMismatchError()
  const resultFirmId = normalizeFirmId(result.firmId)
  const adExecutionId = nonEmptyText(result.adExecutionId)
  const creativeId = nonEmptyText(result.creativeId)
  if (resultFirmId !== firmId || !adExecutionId || !creativeId) {
    throw new ProviderResultMismatchError()
  }

  const target = targetsByKey.get(`${adExecutionId}:${creativeId}`)
  if (!target || target.firmId !== resultFirmId) throw new ProviderResultMismatchError()

  let reason: string | null = null
  if (result.reason !== undefined && result.reason !== null) {
    if (typeof result.reason !== 'string') throw new ProviderResultMismatchError()
    reason = nonEmptyText(result.reason)
  }
  const raw = isRecord(result.raw) ? result.raw : {}
  return {
    firmId: resultFirmId,
    adExecutionId,
    creativeId,
    reviewStatus: normalizeReviewStatus(result.reviewStatus),
    reason,
    raw,
  }
}

function validateProviderResults(
  results: readonly NaverCreativeReviewResult[],
  targets: readonly AdReviewTarget[],
  firmId: number,
): Array<NaverCreativeReviewResult & { reviewStatus: AdReviewStatus; reason: string | null }> {
  if (!Array.isArray(results)) throw new ProviderResultMismatchError()
  const targetsByKey = new Map(
    targets.map((target) => [`${target.adExecutionId}:${target.creativeExternalId}`, target]),
  )
  const seen = new Set<string>()
  const normalized = results.map((result) => {
    const value = normalizeProviderResult(result, targetsByKey, firmId)
    const key = `${value.adExecutionId}:${value.creativeId}`
    if (seen.has(key)) throw new ProviderResultMismatchError()
    seen.add(key)
    return value
  })
  if (seen.size !== targetsByKey.size) throw new ProviderResultMismatchError()
  return normalized
}

function providerStateFor(status: AdReviewStatus): 'pending_review' | 'live' | 'rejected' | null {
  switch (status) {
    case 'pending': return 'pending_review'
    case 'approved': return 'live'
    case 'rejected': return 'rejected'
    case 'unknown': return null
  }
}

function reviewIdempotencyKey(
  target: AdReviewTarget,
  status: AdReviewStatus,
  reason: string | null,
): string {
  return `ad-review-sync:${target.firmId}:${target.adExecutionId}:${target.creativeExternalId}:${status}:${reason ?? ''}`
}

/**
 * Run one read-only provider sync. Local provider-state and review-event
 * records are the only writes; the provider adapter is queried through GETs.
 */
export async function syncAdReviews(
  input: AdReviewSyncInput,
  dependencies: AdReviewSyncDependencies,
): Promise<AdReviewSyncResult> {
  const observedAt = normalizeDate(input.now)
  const targets = await dependencies.loadTargets()
  const groups = groupAdReviewTargets(targets)
  if (groups.size === 0) return emptyResult('no-eligible-executions')

  let succeededFirms = 0
  let failedFirms = 0
  let skippedFirms = 0
  let reviewsReturned = 0
  let reviewsPersisted = 0
  let providerTransitions = 0
  let reviewEvents = 0
  const issues: AdReviewFirmIssue[] = []

  // Deliberately sequential: one firm's credentials/provider/database failure
  // must not prevent the next firm from being checked.
  for (const [firmId, group] of groups) {
    try {
      const encrypted = await dependencies.loadCredentials(firmId)
      if (!usableCredentials(encrypted) || !credentialsBelongToFirm(encrypted, firmId)) {
        skippedFirms += 1
        issues.push({ firmId, kind: 'skipped', reason: 'credentials-missing-or-unverified' })
        continue
      }

      const decrypt = dependencies.decryptCredential ?? decryptCred
      const credentials = credentialsForClient(encrypted, decrypt)
      const adapter = await dependencies.createAdapter(credentials, {
        firmId,
        provider: NAVER_SEARCHAD_PROVIDER,
        targets: group,
      })
      const adapterTargets: NaverCreativeReviewTarget[] = group.map((target) => ({
        firmId,
        adExecutionId: target.adExecutionId,
        creativeId: target.creativeExternalId as string,
      }))
      const providerResults = await adapter.fetchCreativeReviews(adapterTargets)
      const reviews = validateProviderResults(providerResults, group, firmId)
      reviewsReturned += reviews.length

      const targetByKey = new Map(
        group.map((target) => [`${target.adExecutionId}:${target.creativeExternalId}`, target]),
      )
      for (const review of reviews) {
        const target = targetByKey.get(`${review.adExecutionId}:${review.creativeId}`)
        if (!target) throw new ProviderResultMismatchError()
        const providerStatus = providerStateFor(review.reviewStatus)
        if (providerStatus) {
          await dependencies.recordAdProviderState({
            firmId,
            adExecutionId: target.adExecutionId,
            status: providerStatus,
            creativeExternalId: target.creativeExternalId,
            reason: review.reason,
            actor: 'system:naver-searchad-review-sync',
            observedAt,
          })
          providerTransitions += 1
        }

        await dependencies.recordAdReviewEvent({
          firmId,
          adExecutionId: target.adExecutionId,
          status: review.reviewStatus,
          reason: review.reason,
          raw: review.raw,
          observedAt,
          idempotencyKey: reviewIdempotencyKey(target, review.reviewStatus, review.reason),
        })
        reviewEvents += 1
        reviewsPersisted += 1
      }
      succeededFirms += 1
    } catch (error) {
      if (undefinedTable(error)) throw error
      failedFirms += 1
      issues.push({ firmId, kind: 'failed', reason: safeFailureReason(error) })
    }
  }

  const status: AdReviewSyncStatus = failedFirms > 0 || (succeededFirms > 0 && skippedFirms > 0)
    ? 'partial'
    : skippedFirms > 0
      ? 'skipped'
      : 'ok'
  return {
    status,
    skipReason: status === 'skipped' && skippedFirms > 0 ? 'credentials-missing-or-unverified' : null,
    firms: groups.size,
    succeededFirms,
    failedFirms,
    skippedFirms,
    eligibleExecutions: [...groups.values()].reduce((sum, group) => sum + group.length, 0),
    reviewsReturned,
    reviewsPersisted,
    providerTransitions,
    reviewEvents,
    issues,
  }
}

/** Database-backed loaders and local repository writers used by the CLI. */
export function createDatabaseAdReviewDependencies(db: Db): DatabaseAdReviewDependencies {
  return {
    loadTargets: async () => {
      const rows = await db.select({
        firmId: firms.id,
        firmStatus: firms.status,
        adExecutionId: adExecutions.id,
        status: adExecutions.status,
        creativeExternalId: adExecutions.creativeExternalId,
      }).from(firms)
        .innerJoin(adExecutions, eq(adExecutions.firmId, firms.id))
        .where(and(
          inArray(firms.status, ACTIVE_FIRM_STATUSES),
          inArray(adExecutions.status, TARGET_EXECUTION_STATUSES),
          isNotNull(adExecutions.creativeExternalId),
        ))
      return rows.flatMap((row) => row.creativeExternalId
        ? [{
            firmId: row.firmId,
            firmStatus: row.firmStatus,
            adExecutionId: row.adExecutionId,
            status: row.status,
            creativeExternalId: row.creativeExternalId,
          }]
        : [])
    },
    loadCredentials: async (firmId) => {
      const [row] = await db.select({
        firmId: firmCredentials.firmId,
        provider: firmCredentials.provider,
        customerId: firmCredentials.customerId,
        apiKeyEnc: firmCredentials.apiKeyEnc,
        secretEnc: firmCredentials.secretEnc,
        verifiedAt: firmCredentials.verifiedAt,
      }).from(firmCredentials).where(and(
        eq(firmCredentials.firmId, firmId),
        eq(firmCredentials.provider, NAVER_SEARCHAD_PROVIDER),
        isNotNull(firmCredentials.verifiedAt),
      )).limit(1)
      return row ?? null
    },
    recordAdProviderState: (input) => repositoryRecordAdProviderState(db, input),
    recordAdReviewEvent: (input) => repositoryRecordAdReviewEvent(db, input),
  }
}

export const createDatabaseAdReviewSyncDependencies = createDatabaseAdReviewDependencies

export async function createRealNaverReviewAdapter(
  credentials: NaverSearchAdCredentials,
): Promise<NaverCreativeReviewAdapter> {
  const [{ NaverSearchAdClient }, { NaverSearchAdAdapter }] = await Promise.all([
    import('@/lib/engine/naver/client'),
    import('@/platform/integrations/naver-searchad'),
  ])
  const client = new NaverSearchAdClient(credentials)
  return new NaverSearchAdAdapter(client)
}

function summary(result: AdReviewSyncResult): string {
  return JSON.stringify({
    status: result.status,
    firms: result.firms,
    succeededFirms: result.succeededFirms,
    failedFirms: result.failedFirms,
    skippedFirms: result.skippedFirms,
    eligibleExecutions: result.eligibleExecutions,
    reviewsReturned: result.reviewsReturned,
    reviewsPersisted: result.reviewsPersisted,
    providerTransitions: result.providerTransitions,
    reviewEvents: result.reviewEvents,
    skipReason: result.skipReason,
    issues: result.issues,
  })
}

function skipResultForMain(reason: string): AdReviewSyncResult {
  return emptyResult(reason)
}

/** Injectable CLI entry point. */
export async function main(options: AdReviewSyncMainOptions = {}): Promise<AdReviewSyncResult> {
  const env = options.env ?? process.env
  const log = options.log ?? console.log
  const supplied = options.dependencies ?? {}
  const hasInjectedRuntime = options.db !== undefined
    || options.getDb !== undefined
    || Object.keys(supplied).length > 0
  if (!hasInjectedRuntime && !env.DATABASE_URL?.trim()) {
    const result = skipResultForMain('database-url-missing')
    log(`sync-ad-reviews: ${summary(result)}`)
    return result
  }

  try {
    const db = options.db
      ?? (options.getDb ? await options.getDb() : hasInjectedRuntime ? undefined : getDb())
    const databaseDependencies = db ? createDatabaseAdReviewDependencies(db) : undefined
    const dependencies: AdReviewSyncDependencies = {
      loadTargets: supplied.loadTargets ?? databaseDependencies?.loadTargets ?? (async () => {
        throw new Error('database dependency is required')
      }),
      loadCredentials: supplied.loadCredentials ?? databaseDependencies?.loadCredentials ?? (async () => null),
      decryptCredential: supplied.decryptCredential ?? decryptCred,
      createAdapter: supplied.createAdapter ?? createRealNaverReviewAdapter,
      recordAdProviderState: supplied.recordAdProviderState
        ?? databaseDependencies?.recordAdProviderState
        ?? (async () => undefined),
      recordAdReviewEvent: supplied.recordAdReviewEvent
        ?? databaseDependencies?.recordAdReviewEvent
        ?? (async () => undefined),
    }
    const result = await syncAdReviews({ now: options.now }, dependencies)
    log(`sync-ad-reviews: ${summary(result)}`)
    return result
  } catch (error) {
    if (undefinedTable(error)) {
      const result = skipResultForMain('target-schema-missing')
      log(`sync-ad-reviews: ${summary(result)}`)
      return result
    }
    throw error
  }
}

// Keep common service naming variants available to callers during the
// migration from the older engine polling scripts.
export const syncAdReviewStatuses = syncAdReviews
export const syncAdReview = syncAdReviews

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main()
    .then((result) => {
      if (result.failedFirms > 0) process.exitCode = 1
    })
    .catch((error) => {
      // Deliberately report only a static category; provider bodies and
      // credential material must not reach stdout/stderr or the exit summary.
      console.error(`sync-ad-reviews failed: ${safeFailureReason(error)}`)
      process.exitCode = 1
    })
}
