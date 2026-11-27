import { createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { intelligenceSources, sourceRuns } from '@/lib/db/schema'
import staticRegistry from '../../../data/harvest-sources.json'
import { isAutoDiscoveredSource, normalizedHostname, sourceFamilyForCollector } from './source-family'

export const OPERATOR_COLLECTOR_TYPES = ['webpage', 'rss', 'sitemap'] as const
export type OperatorCollectorType = typeof OPERATOR_COLLECTOR_TYPES[number]
export type CollectorOnboardingStatus = 'ready' | 'pending_analysis' | 'needs_review'

export type CollectorConfig = Record<string, unknown> & {
  id: string
  type: string
  name?: string
  url?: string
  sourceType?: string
  sourceFamily?: string
  recrawlDays?: number
  enabled?: boolean
  onboardingStatus?: CollectorOnboardingStatus
  analysisError?: string
  analyzedAt?: string
  submittedUrl?: string
  includePath?: string
  fetchPageMetadata?: boolean
  fetchPageBodyFacts?: boolean
  keywordOnly?: boolean
  pageParam?: string
  maxPages?: number
  pageConcurrency?: number
  sitemapTitleStrategy?: 'last-segment' | 'first-slug-token' | 'query-param'
  sitemapTitleQueryParam?: string
  allowInvalidTls?: boolean
  sitemapTimeoutSeconds?: number
  parserSpec?: {
    schemaVersion: 1
    adapter: string
    entryUrl: string
    listSelector: string
    linkSelector: string
    fields: { title: string; url: string; publishedAt?: string }
    sampleFingerprint: string
    sampleItemCount: number
    sampleUrls: string[]
    extractionRule?: {
      includePath: string
      titleSource: 'og:title-or-title'
      /** A validated tag, class token, or id token from the public detail page. */
      articleSelector: string | null
      samplesAttempted: number
      caseNamesExtracted: number
      observationsExtracted: number
      sampleCaseNames: string[]
    }
  }
}

export type CollectorSourceRow = {
  sourceId: string | null
  sourceKey: string
  name: string
  collectorType: string
  sourceType: string
  sourceFamily: string | null
  url: string | null
  enabled: boolean
  cadenceMinutes: number | null
  origin: 'built-in' | 'operator'
  latestStatus: string | null
  latestStartedAt: Date | null
  latestItemsAccepted: number | null
  onboardingStatus: CollectorOnboardingStatus
  analysisError: string | null
}

export type CreateCollectorSourceInput = {
  name: unknown
  url: unknown
  competitorKeywordSource?: unknown
  discovery?: unknown
}

/**
 * 경쟁사 사이트맵은 URL slug에서 사건명 후보만 얻는다. 상세 페이지를 전부
 * 요청하면 첫 백필이 수시간 걸리고, 경쟁사 본문을 불필요하게 가져오게 된다.
 * 검토된 경쟁사B 정본 1개만 구조화 관측정보가 있어 상세 메타·본문 수집을 허용한다.
 * 경쟁사B 미러까지 상세 수집하면 같은 운영 주체의 페이지를 여러 번 백필하게 된다.
 */
export function applySitemapCollectionPolicy(config: CollectorConfig): CollectorConfig {
  if (config.type !== 'sitemap' || config.competitorKeywordSource !== true) return config
  const family = sourceFamilyForCollector({
    ...config,
    sourceUrl: displayUrl(config),
    baseUrl: displayUrl(config),
  })
  const host = normalizedHostname(displayUrl(config))
  if (family === 'competitorb-law' && host === 'competitor-b-office.kr.example.com') return config
  return {
    ...config,
    keywordOnly: true,
    fetchPageMetadata: false,
    fetchPageBodyFacts: false,
  }
}

export type EnsuredCollectorSource =
  | { result: 'created' | 'existing'; sourceId: string }
  | { result: 'invalid'; sourceId: null }

const builtInSources = (staticRegistry.sources as CollectorConfig[]).map((source) => ({ ...source }))
const builtInByKey = new Map(builtInSources.map((source) => [legacySourceKey(source.id), source]))

function normalizedToken(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/\s+/g, '-').replace(/[^a-z0-9가-힣:_-]+/g, '-')
}

function legacySourceKey(id: string): string {
  return `legacy:${normalizedToken(id)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0
}

export function normalizeCollectorUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.normalize('NFKC').trim()
  if (!raw || raw.length > 2_048) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const host = url.hostname.toLocaleLowerCase('en-US').replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateIpv4(host)) return null
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return null
    url.hash = ''
    const normalized = url.href
    return normalized.length <= 2_048 ? normalized : null
  } catch {
    return null
  }
}

function displayUrl(config: CollectorConfig): string | null {
  if (typeof config.url === 'string') return config.url
  if (config.type === 'naver_blog' && typeof config.blogId === 'string') return `https://blog.naver.com/${config.blogId}`
  if (config.type === 'naver_cafe' && typeof config.cafeUrl === 'string') return `https://cafe.naver.com/${config.cafeUrl}`
  return null
}

function cadenceMinutes(config: CollectorConfig): number | null {
  if (typeof config.recrawlDays === 'number') return config.recrawlDays * 1_440
  return null
}

function normalizedCreateInput(input: CreateCollectorSourceInput): {
  sourceKey: string
  config: CollectorConfig
} | null {
  const name = typeof input.name === 'string' ? input.name.normalize('NFKC').trim() : ''
  const url = normalizeCollectorUrl(input.url)
  if (name.length < 2 || name.length > 120 || !url) return null

  const digest = createHash('sha256').update(url).digest('hex').slice(0, 16)
  const config: CollectorConfig = {
    id: `operator-${digest}`,
    type: 'pending',
    name,
    url,
    submittedUrl: url,
    sourceType: 'pending',
    sourceFamily: sourceFamilyForCollector({ url, type: 'pending' }) ?? undefined,
    onboardingStatus: 'pending_analysis',
    enabled: false,
    ...(input.competitorKeywordSource === true && { competitorKeywordSource: true }),
    ...(isRecord(input.discovery) && { discovery: input.discovery }),
  }
  return { sourceKey: `operator:${digest}`, config }
}

function databaseValues(sourceKey: string, config: CollectorConfig, enabled: boolean) {
  const baseUrl = displayUrl(config)
  const sourceFamily = sourceFamilyForCollector({
    ...config,
    sourceUrl: baseUrl,
    baseUrl,
  })
  return {
    sourceKey,
    name: typeof config.name === 'string' ? config.name : config.id,
    sourceType: typeof config.sourceType === 'string' ? config.sourceType : config.type,
    sourceFamily,
    baseUrl,
    enabled,
    cadenceMinutes: cadenceMinutes(config),
    config: { ...config, enabled },
    updatedAt: new Date(),
  }
}

export async function createCollectorSource(
  db: Db,
  input: CreateCollectorSourceInput,
): Promise<'created' | 'duplicate' | 'invalid'> {
  const ensured = await ensureCollectorSource(db, input)
  if (ensured.result === 'invalid') return 'invalid'
  return ensured.result === 'created' ? 'created' : 'duplicate'
}

/** URL 하나를 전역 수집소스 한 행으로 멱등 보장한다. 외부 URL에는 접속하지 않는다. */
export async function ensureCollectorSource(
  db: Db,
  input: CreateCollectorSourceInput,
): Promise<EnsuredCollectorSource> {
  const normalized = normalizedCreateInput(input)
  if (!normalized) return { result: 'invalid', sourceId: null }
  const normalizedUrl = normalized.config.url!
  const builtIn = builtInSources.find((source) => {
    const current = displayUrl(source)
    return current ? normalizeCollectorUrl(current) === normalizedUrl : false
  })
  if (builtIn) {
    const sourceKey = legacySourceKey(builtIn.id)
    await db.insert(intelligenceSources).values(databaseValues(
      sourceKey,
      builtIn,
      isAutoDiscoveredSource(builtIn) ? false : builtIn.enabled !== false,
    ))
      .onConflictDoNothing({ target: intelligenceSources.sourceKey })
    const row = (await db.select({ id: intelligenceSources.id }).from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, sourceKey)).limit(1))[0]
    if (!row) throw new Error('built-in collector source was not persisted')
    return { result: 'existing', sourceId: row.id }
  }
  const existingUrl = (await db.select({ id: intelligenceSources.id }).from(intelligenceSources)
    .where(eq(intelligenceSources.baseUrl, normalizedUrl)).limit(1))[0]
  if (existingUrl) return { result: 'existing', sourceId: existingUrl.id }
  const inserted = await db.insert(intelligenceSources).values({
    ...databaseValues(normalized.sourceKey, normalized.config, false),
    sourceType: 'pending',
    cadenceMinutes: null,
  }).onConflictDoNothing({ target: intelligenceSources.sourceKey })
    .returning({ id: intelligenceSources.id })
  if (inserted[0]) return { result: 'created', sourceId: inserted[0].id }
  const existingKey = (await db.select({ id: intelligenceSources.id }).from(intelligenceSources)
    .where(eq(intelligenceSources.sourceKey, normalized.sourceKey)).limit(1))[0]
  if (!existingKey) throw new Error('collector source was not persisted')
  return { result: 'existing', sourceId: existingKey.id }
}

export async function setCollectorSourceEnabled(db: Db, sourceKeyInput: unknown, enabled: boolean): Promise<boolean> {
  const sourceKey = typeof sourceKeyInput === 'string' ? sourceKeyInput.trim() : ''
  if (!/^(legacy|operator):[a-z0-9:_-]{2,100}$/.test(sourceKey)) return false
  const existing = (await db.select().from(intelligenceSources).where(eq(intelligenceSources.sourceKey, sourceKey)).limit(1))[0]
  if (existing) {
    const current = isRecord(existing.config) ? existing.config : null
    const autoDiscovered = isAutoDiscoveredSource({ name: existing.name, config: current })
    if (enabled) {
      if (current?.onboardingStatus === 'pending_analysis'
        || current?.onboardingStatus === 'needs_review'
        || (autoDiscovered && current?.onboardingStatus !== 'ready')) return false
    }
    const config = {
      ...(current ?? {}),
      enabled,
      // The existing operator toggle is the explicit approval action for a
      // parser-verified Naver discovery source.  Retain the discovery
      // provenance while releasing the collection gate.
      ...(enabled && autoDiscovered && current?.onboardingStatus === 'ready' ? { approvalStatus: 'approved' } : {}),
    }
    const updated = await db.update(intelligenceSources).set({ enabled, config, updatedAt: new Date() })
      .where(eq(intelligenceSources.sourceKey, sourceKey)).returning({ id: intelligenceSources.id })
    return updated.length > 0
  }
  const builtIn = builtInByKey.get(sourceKey)
  if (!builtIn) return false
  const autoDiscovered = isAutoDiscoveredSource(builtIn)
  if (enabled && (builtIn.onboardingStatus === 'pending_analysis'
    || builtIn.onboardingStatus === 'needs_review'
    || (autoDiscovered && builtIn.onboardingStatus !== 'ready'))) return false
  const approvedBuiltIn = enabled && autoDiscovered && builtIn.onboardingStatus === 'ready'
    ? { ...builtIn, approvalStatus: 'approved' }
    : builtIn
  const inserted = await db.insert(intelligenceSources).values(databaseValues(sourceKey, approvedBuiltIn, enabled))
    .onConflictDoNothing({ target: intelligenceSources.sourceKey }).returning({ id: intelligenceSources.id })
  return inserted.length > 0
}

export async function synchronizeBuiltInCollectorSources(db: Db): Promise<number> {
  let synchronized = 0
  for (const source of builtInSources) {
    const sourceKey = legacySourceKey(source.id)
    const existing = (await db.select({ id: intelligenceSources.id }).from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, sourceKey)).limit(1))[0]
    if (!existing) {
      await db.insert(intelligenceSources).values(databaseValues(
        sourceKey,
        source,
        isAutoDiscoveredSource(source) ? false : source.enabled !== false,
      ))
        .onConflictDoNothing({ target: intelligenceSources.sourceKey })
      synchronized += 1
      continue
    }
    const values = databaseValues(sourceKey, source, true)
    await db.update(intelligenceSources).set({
      name: values.name,
      sourceType: values.sourceType,
      sourceFamily: values.sourceFamily,
      baseUrl: values.baseUrl,
      cadenceMinutes: values.cadenceMinutes,
      config: { ...source, enabled: undefined },
      ...(isAutoDiscoveredSource(source) ? { enabled: false } : {}),
      updatedAt: new Date(),
    }).where(eq(intelligenceSources.id, existing.id))
  }
  return synchronized
}

export async function buildRuntimeCollectorRegistry(
  db: Db,
  options: { sourceIds?: readonly string[] } = {},
): Promise<{ sources: CollectorConfig[] }> {
  const rows = await db.select().from(intelligenceSources)
  const byKey = new Map(rows.map((row) => [row.sourceKey, row]))
  const allowed = options.sourceIds ? new Set(options.sourceIds) : null
  const sources: CollectorConfig[] = builtInSources.flatMap((source) => {
    const override = byKey.get(legacySourceKey(source.id))
    if (allowed && (!override || !allowed.has(override.id))) return []
    const overrideConfig = isRecord(override?.config) ? override.config : {}
    const merged = {
      ...source,
      ...overrideConfig,
      id: source.id,
      type: source.type,
      sourceKey: legacySourceKey(source.id),
      enabled: override?.enabled ?? (source.enabled !== false),
    } as CollectorConfig
    if (isAutoDiscoveredSource({ name: merged.name, config: merged })) merged.enabled = false
    const sourceFamily = sourceFamilyForCollector({
      ...merged,
      sourceUrl: displayUrl(merged),
      baseUrl: displayUrl(merged),
    })
    return [applySitemapCollectionPolicy({ ...merged, sourceFamily: sourceFamily ?? undefined })]
  })
  for (const row of rows) {
    if (!row.sourceKey.startsWith('operator:') || !isRecord(row.config)) continue
    if (allowed && !allowed.has(row.id)) continue
    const config = row.config as CollectorConfig
    if (!config.id || !config.type || config.onboardingStatus !== 'ready') continue
    const sourceFamily = sourceFamilyForCollector({
      ...config,
      sourceUrl: row.baseUrl ?? displayUrl(config),
      baseUrl: row.baseUrl ?? displayUrl(config),
    })
    sources.push(applySitemapCollectionPolicy({
      ...config,
      sourceKey: row.sourceKey,
      sourceFamily: sourceFamily ?? undefined,
      // Discovery results are retained for review, but can never enter the
      // runtime collector merely because an old DB row says enabled=true.
      enabled: isAutoDiscoveredSource({ name: row.name, config }) ? false : row.enabled,
    }))
  }
  return { sources }
}

export async function listCollectorSources(db: Db): Promise<CollectorSourceRow[]> {
  const [rows, runs] = await Promise.all([
    db.select().from(intelligenceSources),
    db.selectDistinctOn([sourceRuns.sourceId]).from(sourceRuns)
      .orderBy(sourceRuns.sourceId, desc(sourceRuns.startedAt), desc(sourceRuns.id)),
  ])
  const byKey = new Map(rows.map((row) => [row.sourceKey, row]))
  const latestBySource = new Map<string, typeof runs[number]>()
  for (const run of runs) if (!latestBySource.has(run.sourceId)) latestBySource.set(run.sourceId, run)

  const result: CollectorSourceRow[] = builtInSources.map((config) => {
    const row = byKey.get(legacySourceKey(config.id))
    const latest = row ? latestBySource.get(row.id) : null
    return {
      sourceId: row?.id ?? null,
      sourceKey: legacySourceKey(config.id),
      name: typeof config.name === 'string' ? config.name : config.id,
      collectorType: config.type,
      sourceType: typeof config.sourceType === 'string' ? config.sourceType : config.type,
      sourceFamily: sourceFamilyForCollector({
        ...config,
        sourceUrl: displayUrl(config),
        baseUrl: displayUrl(config),
      }),
      url: displayUrl(config),
      enabled: isAutoDiscoveredSource({ name: config.name, config })
        ? false
        : row?.enabled ?? (config.enabled !== false),
      cadenceMinutes: cadenceMinutes(config),
      origin: 'built-in',
      latestStatus: latest?.status ?? null,
      latestStartedAt: latest?.startedAt ?? null,
      latestItemsAccepted: latest?.itemsAccepted ?? null,
      onboardingStatus: config.onboardingStatus === 'pending_analysis' || config.onboardingStatus === 'needs_review'
        ? config.onboardingStatus
        : 'ready',
      analysisError: typeof config.analysisError === 'string' ? config.analysisError : null,
    }
  })
  for (const row of rows) {
    if (!row.sourceKey.startsWith('operator:')) continue
    const config = isRecord(row.config) ? row.config as CollectorConfig : null
    const latest = latestBySource.get(row.id)
    const onboardingStatus = config?.onboardingStatus === 'pending_analysis' || config?.onboardingStatus === 'needs_review'
      ? config.onboardingStatus
      : 'ready'
    result.push({
      sourceId: row.id,
      sourceKey: row.sourceKey,
      name: row.name,
      collectorType: typeof config?.type === 'string' ? config.type : 'unknown',
      sourceType: row.sourceType,
      sourceFamily: sourceFamilyForCollector({
        ...config,
        sourceFamily: row.sourceFamily,
        sourceUrl: row.baseUrl,
        baseUrl: row.baseUrl,
      }),
      url: row.baseUrl,
      enabled: isAutoDiscoveredSource({ name: row.name, config: config ?? undefined }) ? false : row.enabled,
      cadenceMinutes: row.cadenceMinutes,
      origin: 'operator',
      latestStatus: latest?.status ?? null,
      latestStartedAt: latest?.startedAt ?? null,
      latestItemsAccepted: latest?.itemsAccepted ?? null,
      onboardingStatus,
      analysisError: typeof config?.analysisError === 'string' ? config.analysisError : null,
    })
  }
  const priority: Record<CollectorOnboardingStatus, number> = { pending_analysis: 0, needs_review: 1, ready: 2 }
  return result.sort((left, right) => priority[left.onboardingStatus] - priority[right.onboardingStatus]
    || Number(right.enabled) - Number(left.enabled)
    || left.name.localeCompare(right.name, 'ko-KR'))
}
