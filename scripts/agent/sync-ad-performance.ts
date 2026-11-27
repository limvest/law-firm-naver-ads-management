/**
 * Daily target-model Naver SearchAd performance synchronizer.
 *
 * The core is deliberately provider-client agnostic.  The real CLI supplies a
 * NaverSearchAdClient-backed read adapter; tests can supply a fake adapter and
 * fake persistence without a database, credential key, or network.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb, type Db } from '@/lib/db/client'
import { upsertAdDailyStat as repositoryUpsertAdDailyStat, type UpsertAdDailyStatInput } from '@/domains/advertising/repository'
import type {
  NaverAdDailyStatRow,
  NaverAdGroupStatsTarget,
} from '@/platform/integrations/naver-searchad'
import { decryptCred } from '@/lib/engine/cred-crypto'
import { adAccounts, adExecutions, firmCredentials, firms } from '@/lib/db/schema'

export const NAVER_SEARCHAD_PROVIDER = 'naver_searchad' as const
const SEOUL_TIME_ZONE = 'Asia/Seoul'
const DAY_MS = 86_400_000
const ACTIVE_FIRM_STATUSES = ['pilot', 'active'] as const

export type AdPerformanceFirmStatus = (typeof ACTIVE_FIRM_STATUSES)[number]

export interface AdPerformanceTarget {
  readonly firmId: number
  readonly adExecutionId: string
  readonly adGroupExternalId: string
  /** Populated by the database loader; injected loaders may omit it. */
  readonly firmStatus?: string
}

export interface EncryptedFirmCredentials {
  readonly firmId?: number
  readonly provider?: string
  readonly customerId: string
  readonly apiKeyEnc: string
  readonly secretEnc: string
}

export interface NaverSearchAdCredentials {
  readonly customerId: string
  readonly apiKey: string
  readonly secret: string
}

export interface NaverDailyStatsAdapter {
  fetchDailyStats(input: {
    readonly targets: readonly NaverAdGroupStatsTarget[]
    readonly day: string
  }): Promise<readonly NaverAdDailyStatRow[]>
}

export interface AdPerformanceAdapterContext {
  readonly firmId: number
  readonly provider: typeof NAVER_SEARCHAD_PROVIDER
  readonly day: string
  readonly targets: readonly AdPerformanceTarget[]
}

export interface AdPerformanceAccountPatch {
  readonly lastSyncedAt?: Date
  readonly status?: 'active' | 'failed'
}

export interface AdPerformanceSyncDependencies {
  /** Must already be scoped to pilot/active firms and target executions. */
  readonly loadTargets: () => Promise<readonly AdPerformanceTarget[]>
  /** Returns encrypted values only; decryption happens inside the core. */
  readonly loadCredentials: (firmId: number) => Promise<EncryptedFirmCredentials | null>
  readonly decryptCredential?: (payload: string) => string
  /** The core never constructs a provider client; this factory returns a read adapter. */
  readonly createAdapter: (
    credentials: NaverSearchAdCredentials,
    context: AdPerformanceAdapterContext,
  ) => NaverDailyStatsAdapter | Promise<NaverDailyStatsAdapter>
  readonly upsertAdDailyStat: (input: UpsertAdDailyStatInput) => Promise<unknown>
  /** The implementation must scope every update by firmId and provider. */
  readonly updateAdAccount?: (
    firmId: number,
    provider: typeof NAVER_SEARCHAD_PROVIDER,
    patch: AdPerformanceAccountPatch,
  ) => Promise<number | void>
}

export interface AdPerformanceSyncInput {
  /** A concrete YYYY-MM-DD day.  If omitted, the prior Seoul calendar day is used. */
  readonly day?: string
  readonly now?: Date
}

export type AdPerformanceSyncStatus = 'ok' | 'partial' | 'skipped'

export interface AdPerformanceFirmIssue {
  readonly firmId: number
  readonly kind: 'failed' | 'skipped'
  /** Static reason/type only; credential values and provider error bodies are never returned. */
  readonly reason: string
}

export interface AdPerformanceSyncResult {
  readonly status: AdPerformanceSyncStatus
  readonly day: string
  readonly skipReason: string | null
  readonly firms: number
  readonly succeededFirms: number
  readonly failedFirms: number
  readonly skippedFirms: number
  readonly eligibleExecutions: number
  readonly statsReturned: number
  readonly statsPersisted: number
  readonly statsInserted: number
  readonly statsUpdated: number
  readonly statsUnchanged: number
  readonly accountUpdates: number
  readonly issues: readonly AdPerformanceFirmIssue[]
}

export type DatabaseAdPerformanceDependencies = Omit<
  AdPerformanceSyncDependencies,
  'createAdapter' | 'decryptCredential'
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeFirmId(value: unknown): number {
  const candidate = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new TypeError('firmId must be a non-negative safe integer')
  }
  return candidate as number
}

function normalizeDay(value: string, label = 'day'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new TypeError(`${label} must be YYYY-MM-DD`)
  }
  const day = value.trim()
  const date = new Date(`${day}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new TypeError(`${label} must be a valid day`)
  }
  return day
}

function assertValidDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${label} must be a valid date`)
  }
  return value
}

/** Return the previous calendar day in Seoul, independent of the host timezone. */
export function previousSeoulDay(now = new Date()): string {
  assertValidDate(now, 'now')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SEOUL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  const seoulDay = `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`
  const anchor = new Date(`${seoulDay}T00:00:00.000Z`)
  return new Date(anchor.getTime() - DAY_MS).toISOString().slice(0, 10)
}

function resolvedDay(input: AdPerformanceSyncInput): { day: string; now: Date } {
  const now = assertValidDate(input.now ? new Date(input.now.getTime()) : new Date(), 'now')
  return {
    day: input.day === undefined ? previousSeoulDay(now) : normalizeDay(input.day),
    now,
  }
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function usableCredentials(value: EncryptedFirmCredentials | null): value is EncryptedFirmCredentials {
  return Boolean(
    value
    && nonEmptyText(value.customerId)
    && nonEmptyText(value.apiKeyEnc)
    && nonEmptyText(value.secretEnc),
  )
}

function credentialsBelongToFirm(
  value: EncryptedFirmCredentials,
  firmId: number,
): boolean {
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

function errorType(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  return 'UnknownError'
}

function undefinedTable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (value.code === '42P01') return true
    if (typeof value.message === 'string' && /relation .* does not exist/i.test(value.message)) return true
    current = value.cause
  }
  return false
}

export { undefinedTable }

/** Group targets without ever combining executions from different firms. */
export function groupAdPerformanceTargets(
  targets: readonly AdPerformanceTarget[],
): Map<number, readonly AdPerformanceTarget[]> {
  const groups = new Map<number, AdPerformanceTarget[]>()
  for (const target of targets) {
    if (!isRecord(target)) throw new TypeError('ad performance target must be an object')
    const firmId = normalizeFirmId(target.firmId)
    const executionId = nonEmptyText(target.adExecutionId)
    const adGroupExternalId = nonEmptyText(target.adGroupExternalId)
    if (!executionId || !adGroupExternalId) continue
    if (target.firmStatus !== undefined && !ACTIVE_FIRM_STATUSES.includes(target.firmStatus as AdPerformanceFirmStatus)) {
      continue
    }
    const targetWithNormalizedIds: AdPerformanceTarget = {
      firmId,
      adExecutionId: executionId,
      adGroupExternalId,
      ...(target.firmStatus === undefined ? {} : { firmStatus: target.firmStatus }),
    }
    const group = groups.get(firmId)
    if (group) group.push(targetWithNormalizedIds)
    else groups.set(firmId, [targetWithNormalizedIds])
  }
  return groups
}

function issueResult(
  day: string,
  skipReason: string | null,
): AdPerformanceSyncResult {
  return {
    status: 'skipped',
    day,
    skipReason,
    firms: 0,
    succeededFirms: 0,
    failedFirms: 0,
    skippedFirms: 0,
    eligibleExecutions: 0,
    statsReturned: 0,
    statsPersisted: 0,
    statsInserted: 0,
    statsUpdated: 0,
    statsUnchanged: 0,
    accountUpdates: 0,
    issues: [],
  }
}

function countUpsertOutcome(
  outcome: unknown,
  counts: { inserted: number; updated: number; unchanged: number },
): void {
  if (!isRecord(outcome)) return
  if (outcome.inserted === true) counts.inserted += 1
  else if (outcome.updated === true) counts.updated += 1
  else if (outcome.unchanged === true) counts.unchanged += 1
}

function rowDay(value: unknown): string {
  if (typeof value === 'string') return normalizeDay(value, 'provider row day')
  if (value instanceof Date) {
    assertValidDate(value, 'provider row day')
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number') {
    const date = new Date(value)
    assertValidDate(date, 'provider row day')
    return date.toISOString().slice(0, 10)
  }
  throw new TypeError('provider row day is required')
}

function validateProviderRow(
  row: NaverAdDailyStatRow,
  firmId: number,
  day: string,
  targetsByExecution: ReadonlyMap<string, AdPerformanceTarget>,
): UpsertAdDailyStatInput {
  if (!isRecord(row)) throw new Error('provider row is not an object')
  const rowFirmId = normalizeFirmId(row.firmId)
  if (rowFirmId !== firmId) throw new Error('provider row crossed firm scope')
  const executionId = nonEmptyText(row.adExecutionId)
  if (!executionId || !targetsByExecution.has(executionId)) {
    throw new Error('provider row crossed execution scope')
  }
  if (rowDay(row.day) !== day) throw new Error('provider row returned an unexpected day')
  return {
    firmId: rowFirmId,
    adExecutionId: executionId,
    day,
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    conversions: row.conversions,
  }
}

/**
 * Run one read-only daily sync.  Every firm is processed in its own try/catch;
 * one credential, provider, or persistence failure cannot stop other firms.
 */
export async function syncAdPerformance(
  input: AdPerformanceSyncInput,
  dependencies: AdPerformanceSyncDependencies,
): Promise<AdPerformanceSyncResult> {
  const { day, now } = resolvedDay(input)
  const targets = await dependencies.loadTargets()
  const groups = groupAdPerformanceTargets(targets)
  if (groups.size === 0) return issueResult(day, 'no-eligible-executions')

  let succeededFirms = 0
  let failedFirms = 0
  let skippedFirms = 0
  let statsReturned = 0
  let statsPersisted = 0
  let statsInserted = 0
  let statsUpdated = 0
  let statsUnchanged = 0
  let accountUpdates = 0
  const issues: AdPerformanceFirmIssue[] = []

  for (const [firmId, group] of groups) {
    let accountWriteAttempted = false
    try {
      const encrypted = await dependencies.loadCredentials(firmId)
      if (!usableCredentials(encrypted) || !credentialsBelongToFirm(encrypted, firmId)) {
        skippedFirms += 1
        issues.push({ firmId, kind: 'skipped', reason: 'credentials-missing' })
        continue
      }

      const decrypt = dependencies.decryptCredential ?? decryptCred
      const credentials = credentialsForClient(encrypted, decrypt)
      const adapter = await dependencies.createAdapter(credentials, {
        firmId,
        provider: NAVER_SEARCHAD_PROVIDER,
        day,
        targets: group,
      })
      const adapterTargets: NaverAdGroupStatsTarget[] = group.map((target) => ({
        firmId,
        adExecutionId: target.adExecutionId,
        adGroupId: target.adGroupExternalId,
      }))
      const rows = await adapter.fetchDailyStats({ targets: adapterTargets, day })
      statsReturned += rows.length
      const targetsByExecution = new Map(group.map((target) => [target.adExecutionId, target]))
      for (const row of rows) {
        const stat = validateProviderRow(row, firmId, day, targetsByExecution)
        const outcome = await dependencies.upsertAdDailyStat(stat)
        statsPersisted += 1
        const outcomeCounts = { inserted: 0, updated: 0, unchanged: 0 }
        countUpsertOutcome(outcome, outcomeCounts)
        statsInserted += outcomeCounts.inserted
        statsUpdated += outcomeCounts.updated
        statsUnchanged += outcomeCounts.unchanged
      }

      if (dependencies.updateAdAccount) {
        accountWriteAttempted = true
        const updated = await dependencies.updateAdAccount(firmId, NAVER_SEARCHAD_PROVIDER, {
          status: 'active',
          lastSyncedAt: now,
        })
        accountUpdates += typeof updated === 'number' ? updated : 1
      }
      succeededFirms += 1
    } catch (error) {
      if (undefinedTable(error)) throw error
      failedFirms += 1
      issues.push({ firmId, kind: 'failed', reason: errorType(error) })
      if (dependencies.updateAdAccount && !accountWriteAttempted) {
        try {
          const updated = await dependencies.updateAdAccount(firmId, NAVER_SEARCHAD_PROVIDER, { status: 'failed' })
          accountUpdates += typeof updated === 'number' ? updated : 1
        } catch {
          // The original firm failure is already isolated and reported.  Do not
          // expose a second provider/database error or any credential material.
        }
      }
    }
  }

  const status: AdPerformanceSyncStatus = failedFirms > 0 || (succeededFirms > 0 && skippedFirms > 0)
    ? 'partial'
    : skippedFirms > 0
      ? 'skipped'
      : 'ok'
  return {
    status,
    day,
    skipReason: status === 'skipped' && skippedFirms > 0 ? 'credentials-missing' : null,
    firms: groups.size,
    succeededFirms,
    failedFirms,
    skippedFirms,
    eligibleExecutions: [...groups.values()].reduce((sum, group) => sum + group.length, 0),
    statsReturned,
    statsPersisted,
    statsInserted,
    statsUpdated,
    statsUnchanged,
    accountUpdates,
    issues,
  }
}

/** Database-backed loaders/writers used only by the CLI wrapper. */
export function createDatabaseAdPerformanceDependencies(db: Db): DatabaseAdPerformanceDependencies {
  return {
    loadTargets: async () => {
      const rows = await db.select({
        firmId: firms.id,
        firmStatus: firms.status,
        adExecutionId: adExecutions.id,
        adGroupExternalId: adExecutions.adGroupExternalId,
      }).from(firms)
        .innerJoin(adExecutions, eq(adExecutions.firmId, firms.id))
        .where(inArray(firms.status, ACTIVE_FIRM_STATUSES))
      return rows.flatMap((row) => {
        const adGroupExternalId = nonEmptyText(row.adGroupExternalId)
        return adGroupExternalId
          ? [{
              firmId: row.firmId,
              firmStatus: row.firmStatus,
              adExecutionId: row.adExecutionId,
              adGroupExternalId,
            }]
          : []
      })
    },
    loadCredentials: async (firmId) => {
      const [row] = await db.select({
        firmId: firmCredentials.firmId,
        provider: firmCredentials.provider,
        customerId: firmCredentials.customerId,
        apiKeyEnc: firmCredentials.apiKeyEnc,
        secretEnc: firmCredentials.secretEnc,
      }).from(firmCredentials).where(and(
        eq(firmCredentials.firmId, firmId),
        eq(firmCredentials.provider, NAVER_SEARCHAD_PROVIDER),
      )).limit(1)
      return row ?? null
    },
    upsertAdDailyStat: (input) => repositoryUpsertAdDailyStat(db, input),
    updateAdAccount: async (firmId, provider, patch) => {
      const set: Partial<typeof adAccounts.$inferInsert> = {}
      if (patch.lastSyncedAt !== undefined) set.lastSyncedAt = patch.lastSyncedAt
      if (patch.status !== undefined) set.status = patch.status
      if (Object.keys(set).length === 0) return 0
      const updated = await db.update(adAccounts).set(set).where(and(
        eq(adAccounts.firmId, firmId),
        eq(adAccounts.provider, provider),
      )).returning({ id: adAccounts.id })
      return updated.length
    },
  }
}

async function createRealNaverAdapter(
  credentials: NaverSearchAdCredentials,
): Promise<NaverDailyStatsAdapter> {
  const [{ NaverSearchAdClient }, { NaverSearchAdAdapter }] = await Promise.all([
    import('@/lib/engine/naver/client'),
    import('@/platform/integrations/naver-searchad'),
  ])
  const client = new NaverSearchAdClient(credentials)
  return new NaverSearchAdAdapter(client)
}

export interface AdPerformanceSyncMainOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly argv?: readonly string[]
  readonly day?: string
  readonly now?: Date
  readonly db?: Db
  readonly getDb?: () => Db | Promise<Db>
  /** Complete or partial core dependencies for tests. */
  readonly dependencies?: Partial<AdPerformanceSyncDependencies>
  readonly log?: (message: string) => void
}

function configuredDay(options: AdPerformanceSyncMainOptions): string | undefined {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)
  let cliDay: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--day') cliDay = argv[index + 1]
  }
  const candidate = options.day
    ?? env.NAVER_AD_PERFORMANCE_DAY
    ?? env.AD_PERFORMANCE_DAY
    ?? env.NAVER_AD_DAY
    ?? cliDay
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

function summary(result: AdPerformanceSyncResult): string {
  return JSON.stringify({
    status: result.status,
    day: result.day,
    firms: result.firms,
    succeededFirms: result.succeededFirms,
    failedFirms: result.failedFirms,
    skippedFirms: result.skippedFirms,
    eligibleExecutions: result.eligibleExecutions,
    statsReturned: result.statsReturned,
    statsPersisted: result.statsPersisted,
    statsInserted: result.statsInserted,
    statsUpdated: result.statsUpdated,
    statsUnchanged: result.statsUnchanged,
    accountUpdates: result.accountUpdates,
    skipReason: result.skipReason,
    issues: result.issues,
  })
}

function skipResultForMain(reason: string, input: AdPerformanceSyncInput): AdPerformanceSyncResult {
  const { day } = resolvedDay(input)
  return issueResult(day, reason)
}

/** Injectable CLI entry point; no external provider writes are reachable here. */
export async function main(options: AdPerformanceSyncMainOptions = {}): Promise<AdPerformanceSyncResult> {
  const env = options.env ?? process.env
  const log = options.log ?? console.log
  const input: AdPerformanceSyncInput = { day: configuredDay(options), now: options.now }
  const hasInjectedRuntime = options.db !== undefined
    || options.getDb !== undefined
    || options.dependencies?.loadTargets !== undefined
  if (!hasInjectedRuntime && !env.DATABASE_URL?.trim()) {
    const result = skipResultForMain('database-url-missing', input)
    log(`sync-ad-performance: ${summary(result)}`)
    return result
  }

  const db = options.db ?? (options.getDb ? await options.getDb() : getDb())
  const databaseDependencies = db ? createDatabaseAdPerformanceDependencies(db) : undefined
  const supplied = options.dependencies ?? {}
  const dependencies: AdPerformanceSyncDependencies = {
    loadTargets: supplied.loadTargets ?? databaseDependencies?.loadTargets ?? (async () => {
      throw new Error('database dependency is required')
    }),
    loadCredentials: supplied.loadCredentials ?? databaseDependencies?.loadCredentials ?? (async () => null),
    decryptCredential: supplied.decryptCredential ?? decryptCred,
    createAdapter: supplied.createAdapter ?? createRealNaverAdapter,
    upsertAdDailyStat: supplied.upsertAdDailyStat ?? databaseDependencies?.upsertAdDailyStat ?? (async () => undefined),
    updateAdAccount: supplied.updateAdAccount ?? databaseDependencies?.updateAdAccount,
  }

  try {
    const result = await syncAdPerformance(input, dependencies)
    log(`sync-ad-performance: ${summary(result)}`)
    return result
  } catch (error) {
    if (undefinedTable(error)) {
      const result = skipResultForMain('target-schema-missing', input)
      log(`sync-ad-performance: ${summary(result)}`)
      return result
    }
    throw error
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`sync-ad-performance failed: ${errorType(error)}`)
    process.exitCode = 1
  })
}
