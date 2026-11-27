import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmDomains, intelligenceSources, keywords, sourceRuns } from '@/lib/db/schema'
import { NaverWebSearchBlockedError } from './naver-web-search'
import { ensureCollectorSource, normalizeCollectorUrl } from './source-registry'

const DISCOVERY_SOURCE_KEY = 'system:naver-search-source-discovery'
const NAVER_API_HUB_WEB_SEARCH_URL = 'https://naverapihub.apigw.ntruss.com/search/v1/webkr'
const NAVER_LEGACY_WEB_SEARCH_URL = 'https://openapi.naver.com/v1/search/webkr.json'
const NAVER_PUBLIC_WEB_SEARCH_URL = 'https://search.naver.com/search.naver'
const DEFAULT_EXCLUDED_HOSTS = new Set([
  'lawfirm-ads.vercel.app', 'fintech.sampleone.attorney', 'sampleone.attorney', 'competitor-f-fintech.example.com',
  'competitor-f-law.example.com',
  'search.naver.com', 'm.search.naver.com', 'openapi.naver.com', 'news.naver.com',
  'kin.naver.com', 'cafe.naver.com', 'm.cafe.naver.com', 'youtube.com', 'www.youtube.com',
  'instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com', 'tiktok.com',
])
const LEGAL_SOURCE_SIGNAL = /법무법인|법률사무소|변호사|법률상담|피해구제|피해자(?:센터|모임)|형사전문/i
const CASE_SIGNAL = /사기|피해|출금|리딩|투자|가상자산|코인|거래소|로맨스|스캠|고소|대응/i

export type NaverSearchItem = { title: string; link: string; description: string }
export type NaverSearch = (query: string) => Promise<readonly NaverSearchItem[]>

export type SourceDiscoveryResult = {
  skipped: boolean
  reason?: 'credentials-missing' | 'no-seeds' | 'already-running'
  queried: number
  resultsSeen: number
  candidateTargets: number
  created: number
  existing: number
  failedQueries: number
  wrapped: boolean
}

type Seed = { id: string; name: string; createdAt: Date; cursorCreatedAt: string }
type Cursor = { keywordCreatedAt?: string; keywordId?: string }

function isBlockedSearchError(error: unknown): boolean {
  if (error instanceof NaverWebSearchBlockedError) return true
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'blocked')
}

/**
 * Drizzle wraps driver errors in a query error, so inspect the cause chain
 * rather than relying on one concrete driver's error class.  The partial
 * unique index on source_runs is the race-safe guard; a 23505 here simply
 * means another discovery worker won the insert between our read and insert.
 */
function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (typeof current === 'object' && 'code' in current
      && (current as { code?: unknown }).code === '23505') return true
    current = typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : null
  }
  return false
}

function cleanSearchText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function excludedHosts(extra: readonly string[] = []): Set<string> {
  return new Set([...DEFAULT_EXCLUDED_HOSTS, ...extra]
    .map((host) => host.trim().toLocaleLowerCase('en-US').replace(/^www\./, ''))
    .filter(Boolean))
}

/** 검색결과의 개별 글 URL을 파서가 사이트맵·RSS를 찾을 수 있는 소스 대표 URL로 바꾼다. */
export function canonicalDiscoveryTarget(input: unknown, extraExcludedHosts: readonly string[] = []): string | null {
  const normalized = normalizeCollectorUrl(input)
  if (!normalized) return null
  const parsed = new URL(normalized)
  const host = parsed.hostname.toLocaleLowerCase('en-US').replace(/^www\./, '')
  if (excludedHosts(extraExcludedHosts).has(host)) return null
  if (host === 'blog.naver.com' || host === 'm.blog.naver.com') {
    // Legacy PostView/Redirect URLs carry the real identity in `blogId`,
    // while modern links put it in the first path segment. Prefer the query
    // value when present so `PostView.naver` is not mistaken for a blog ID.
    const candidates = [
      parsed.searchParams.get('blogId'),
      parsed.pathname.split('/').filter(Boolean)[0],
    ]
    const blogId = candidates
      .map((value) => value?.trim() ?? '')
      .find((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(value))
    if (!blogId) return null
    return `https://blog.naver.com/${blogId}`
  }
  return `${parsed.protocol}//${parsed.host}/`
}

export function sourceDiscoveryCandidates(
  rows: readonly { seedId: string; query: string; item: NaverSearchItem }[],
  options: { minDistinctSeeds?: number; excludedHosts?: readonly string[] } = {},
): Array<{ targetUrl: string; host: string; hitCount: number; seedIds: string[]; queries: string[]; sampleUrls: string[] }> {
  const grouped = new Map<string, {
    host: string; hits: number; seedIds: Set<string>; queries: Set<string>; sampleUrls: Set<string>
  }>()
  for (const row of rows) {
    const text = `${cleanSearchText(row.item.title)} ${cleanSearchText(row.item.description)}`
    if (!LEGAL_SOURCE_SIGNAL.test(text) || !CASE_SIGNAL.test(text)) continue
    const targetUrl = canonicalDiscoveryTarget(row.item.link, options.excludedHosts)
    if (!targetUrl) continue
    const current = grouped.get(targetUrl) ?? {
      host: new URL(targetUrl).hostname.replace(/^www\./, ''), hits: 0,
      seedIds: new Set(), queries: new Set(), sampleUrls: new Set(),
    }
    current.hits += 1
    current.seedIds.add(row.seedId)
    current.queries.add(row.query)
    current.sampleUrls.add(row.item.link)
    grouped.set(targetUrl, current)
  }
  const minimum = Math.max(1, options.minDistinctSeeds ?? 2)
  return [...grouped].flatMap(([targetUrl, value]) => value.seedIds.size < minimum ? [] : [{
    targetUrl,
    host: value.host,
    hitCount: value.hits,
    seedIds: [...value.seedIds].slice(0, 50),
    queries: [...value.queries].slice(0, 20),
    sampleUrls: [...value.sampleUrls].slice(0, 10),
  }]).sort((left, right) => right.seedIds.length - left.seedIds.length || right.hitCount - left.hitCount)
}

export function createNaverWebSearch(input: {
  clientId: string
  clientSecret: string
  fetcher?: typeof fetch
  display?: number
  apiMode?: 'hub' | 'legacy'
}): NaverSearch {
  const fetcher = input.fetcher ?? fetch
  const display = Math.max(1, Math.min(input.display ?? 20, 100))
  const apiMode = input.apiMode ?? 'hub'
  return async (query) => {
    const url = new URL(apiMode === 'hub' ? NAVER_API_HUB_WEB_SEARCH_URL : NAVER_LEGACY_WEB_SEARCH_URL)
    url.searchParams.set('query', query)
    url.searchParams.set('display', String(display))
    url.searchParams.set('start', '1')
    if (apiMode === 'hub') url.searchParams.set('format', 'json')
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(12_000),
      headers: apiMode === 'hub' ? {
        'X-NCP-APIGW-API-KEY-ID': input.clientId,
        'X-NCP-APIGW-API-KEY': input.clientSecret,
        'User-Agent': 'LawfirmAdsSourceDiscovery/1.0',
      } : {
        'X-Naver-Client-Id': input.clientId,
        'X-Naver-Client-Secret': input.clientSecret,
        'User-Agent': 'LawfirmAdsSourceDiscovery/1.0',
      },
    })
    if (!response.ok) throw new Error(`Naver Search API HTTP ${response.status}`)
    const body = await response.json() as { items?: unknown }
    if (!Array.isArray(body.items)) return []
    return body.items.flatMap((item): NaverSearchItem[] => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      return typeof value.link === 'string' ? [{
        title: typeof value.title === 'string' ? value.title : '',
        link: value.link,
        description: typeof value.description === 'string' ? value.description : '',
      }] : []
    })
  }
}

async function discoverySource(db: Db): Promise<typeof intelligenceSources.$inferSelect> {
  const sourceValues = {
    name: '네이버 공개 검색 기반 신규 소스 발견',
    sourceType: 'search-discovery',
    sourceFamily: 'naver-public-html',
    baseUrl: NAVER_PUBLIC_WEB_SEARCH_URL,
    enabled: true,
    cadenceMinutes: 1_440,
    config: { type: 'search-discovery', officialApi: false, publicHtml: true, onboardingStatus: 'ready' },
  } as const
  const [inserted] = await db.insert(intelligenceSources).values({
    sourceKey: DISCOVERY_SOURCE_KEY,
    ...sourceValues,
  }).onConflictDoUpdate({
    target: intelligenceSources.sourceKey,
    set: { ...sourceValues, updatedAt: new Date() },
  }).returning()
  if (inserted) return inserted
  const [existing] = await db.select().from(intelligenceSources)
    .where(eq(intelligenceSources.sourceKey, DISCOVERY_SOURCE_KEY)).limit(1)
  if (!existing) throw new Error('source discovery ledger was not created')
  return existing
}

function cursorFrom(value: unknown): Cursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    keywordCreatedAt: typeof record.keywordCreatedAt === 'string' ? record.keywordCreatedAt : undefined,
    keywordId: typeof record.keywordId === 'string' ? record.keywordId : undefined,
  }
}

async function selectSeeds(db: Db, cursor: Cursor, limit: number): Promise<{ rows: Seed[]; wrapped: boolean }> {
  const base = and(
    ne(keywords.status, 'blocked'),
    sql`exists(select 1 from observations o where o.keyword_id = ${keywords.id})`,
  )
  const cursorDate = cursor.keywordCreatedAt ? new Date(cursor.keywordCreatedAt) : null
  const validCursor = cursorDate && Number.isFinite(cursorDate.getTime()) && cursor.keywordId
  // PostgreSQL timestamps retain microseconds while JavaScript Date truncates
  // them to milliseconds. Compare the exact DB timestamp text as a row value;
  // otherwise a large same-millisecond import repeats the same batch forever.
  const after = validCursor
    ? sql`(${keywords.createdAt}, ${keywords.id}) > (${cursor.keywordCreatedAt}::timestamptz, ${cursor.keywordId!}::uuid)`
    : undefined
  const query = (where: ReturnType<typeof and>) => db.select({
    id: keywords.id,
    name: keywords.name,
    createdAt: keywords.createdAt,
    cursorCreatedAt: sql<string>`${keywords.createdAt}::text`,
  }).from(keywords).where(where).orderBy(asc(keywords.createdAt), asc(keywords.id)).limit(limit)
  const rows = await query(and(base, after))
  if (rows.length || !validCursor) return { rows, wrapped: false }
  return { rows: await query(base), wrapped: true }
}

function skippedDiscovery(reason: 'already-running' | 'no-seeds', wrapped = false): SourceDiscoveryResult {
  return {
    skipped: true,
    reason,
    queried: 0,
    resultsSeen: 0,
    candidateTargets: 0,
    created: 0,
    existing: 0,
    failedQueries: 0,
    wrapped,
  }
}

export async function discoverNaverCollectorSources(
  db: Db,
  options: {
    search: NaverSearch
    batchSize?: number
    minDistinctSeeds?: number
    excludedHosts?: readonly string[]
    now?: Date
  },
): Promise<SourceDiscoveryResult> {
  const now = options.now ?? new Date()
  const ownedDomains = await db.select({ hostname: firmDomains.hostname }).from(firmDomains)
  const effectiveExcludedHosts = [
    ...(options.excludedHosts ?? []),
    ...ownedDomains.map((row) => row.hostname),
  ]
  const source = await discoverySource(db)
  // Fast path for the normal case.  This avoids doing any seed selection or
  // network work while a previous discovery is still active.  It is not the
  // correctness boundary by itself: two workers can both observe no running
  // row, so the insert below is protected by source_runs_source_running_unique.
  const [running] = await db.select({ id: sourceRuns.id }).from(sourceRuns)
    .where(and(eq(sourceRuns.sourceId, source.id), eq(sourceRuns.status, 'running')))
    .limit(1)
  if (running) return skippedDiscovery('already-running')

  const [latest] = await db.select({ id: sourceRuns.id, checkpointAfter: sourceRuns.checkpointAfter }).from(sourceRuns)
    .where(and(eq(sourceRuns.sourceId, source.id), sql`${sourceRuns.status} in ('succeeded', 'warning')`))
    .orderBy(desc(sourceRuns.startedAt), desc(sourceRuns.id)).limit(1)
  const before = cursorFrom(latest?.checkpointAfter)
  const latestRunId = latest?.id ?? null
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 500))
  const seeds = await selectSeeds(db, before, batchSize)
  if (!seeds.rows.length) return skippedDiscovery('no-seeds', seeds.wrapped)

  let run: typeof sourceRuns.$inferSelect | undefined
  try {
    [run] = await db.insert(sourceRuns).values({
      sourceId: source.id,
      runKey: `naver-source-discovery:${now.toISOString()}`,
      trigger: 'source-discovery',
      attempted: true,
      sourceKey: source.sourceKey,
      sourceName: source.name,
      sourceType: source.sourceType,
      sourceFamily: source.sourceFamily,
      sourceUrl: source.baseUrl,
      collectorMethod: 'naver-web-search-source-discovery',
      collectorConfig: source.config ?? {},
      status: 'running', checkpointBefore: before, startedAt: now,
    }).returning()
  } catch (error) {
    // The preflight running check above is intentionally only an optimisation.
    // Concurrent workers race here, and the partial unique index turns the
    // loser into a clean no-op instead of a duplicate search batch.
    if (isUniqueViolation(error)) return skippedDiscovery('already-running')
    throw error
  }
  if (!run) throw new Error('source discovery run was not created')

  try {
  const found: Array<{ seedId: string; query: string; item: NaverSearchItem }> = []
  const failures: string[] = []
  const succeededSeedIds = new Set<string>()
  let blockedError: unknown = null
  for (let offset = 0; offset < seeds.rows.length; offset += 4) {
    const chunk = seeds.rows.slice(offset, offset + 4)
    const results = await Promise.allSettled(chunk.map(async (seed) => {
      const query = `${seed.name} 사기 피해`
      return { seed, query, items: await options.search(query) }
    }))
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push(`${chunk[index].id}:${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        if (isBlockedSearchError(result.reason) && !blockedError) blockedError = result.reason
        return
      }
      succeededSeedIds.add(result.value.seed.id)
      for (const item of result.value.items) found.push({ seedId: result.value.seed.id, query: result.value.query, item })
    })
    // CAPTCHA/403/429 is a hard stop. Do not continue creating rejected work
    // and, more importantly, do not advance the durable cursor below.
    if (blockedError) throw blockedError
  }

  const existingRows = await db.select({ baseUrl: intelligenceSources.baseUrl }).from(intelligenceSources)
  const existingTargets = new Set(existingRows.flatMap((row) => {
    const target = canonicalDiscoveryTarget(row.baseUrl, effectiveExcludedHosts)
    return target ? [target] : []
  }))
  const candidates = sourceDiscoveryCandidates(found, {
    minDistinctSeeds: options.minDistinctSeeds,
    excludedHosts: effectiveExcludedHosts,
  })
  let created = 0
  let existing = 0
  for (const candidate of candidates) {
    if (existingTargets.has(candidate.targetUrl)) {
      existing += 1
      continue
    }
    const ensured = await ensureCollectorSource(db, {
      name: `자동발견 · ${candidate.host}`,
      url: candidate.targetUrl,
      // 네이버에 노출됐다는 사실은 발견 경로일 뿐 사이트맵 권위가 아니다.
      // A2가 실제 sitemap으로 판별한 경우에만 readyConfig가 true로 올린다.
      competitorKeywordSource: false,
      discovery: {
        method: 'naver-web-search',
        discoveredAt: now.toISOString(),
        hitCount: candidate.hitCount,
        seedKeywordIds: candidate.seedIds,
        queries: candidate.queries,
        sampleUrls: candidate.sampleUrls,
      },
    })
    if (ensured.result === 'created') {
      created += 1
      existingTargets.add(candidate.targetUrl)
    } else if (ensured.result === 'existing') existing += 1
  }

  // A warning batch may contain a transiently failed query. Advance only past
  // the contiguous successful prefix; the first failed seed is retried on the
  // next run instead of being silently lost behind a batch-wide cursor.
  const firstFailedIndex = seeds.rows.findIndex((seed) => !succeededSeedIds.has(seed.id))
  const lastSuccessfulIndex = firstFailedIndex < 0 ? seeds.rows.length - 1 : firstFailedIndex - 1
  const lastSuccessful = lastSuccessfulIndex >= 0 ? seeds.rows[lastSuccessfulIndex] : null
  const after = lastSuccessful
    ? { keywordCreatedAt: lastSuccessful.cursorCreatedAt, keywordId: lastSuccessful.id }
    : null
  // The keyword cursor is a compare-and-set value.  A second discovery run
  // can finish while this one is searching; do not let this older snapshot
  // move the durable cursor backwards (or replace a newer warning cursor).
  // `checkpointAfter = NULL` is the initial/empty cursor representation, so
  // compare it as `{}` to match cursorFrom().
  const cursorCas = sql`(
    SELECT latest.id
    FROM ${sourceRuns} AS latest
    WHERE latest.source_id = ${source.id}
      AND latest.status IN ('succeeded', 'warning')
    ORDER BY latest.started_at DESC, latest.id DESC
    LIMIT 1
  ) IS NOT DISTINCT FROM ${latestRunId}
  AND COALESCE((
    SELECT latest.checkpoint_after
    FROM ${sourceRuns} AS latest
    WHERE latest.source_id = ${source.id}
      AND latest.status IN ('succeeded', 'warning')
    ORDER BY latest.started_at DESC, latest.id DESC
    LIMIT 1
  ), '{}'::jsonb) IS NOT DISTINCT FROM ${JSON.stringify(before)}::jsonb`
  const completed = await db.update(sourceRuns).set({
    status: failures.length ? 'warning' : 'succeeded',
    checkpointAfter: after,
    itemsSeen: found.length,
    itemsAccepted: created,
    latencyMs: Math.max(0, Date.now() - now.getTime()),
    error: failures.length ? failures.slice(0, 10).join('\n').slice(0, 2_000) : null,
    finishedAt: new Date(),
  }).where(and(eq(sourceRuns.id, run.id), cursorCas)).returning({ id: sourceRuns.id })

  if (!completed.length) {
    // Keep the losing run auditable. Its candidates remain idempotent, while
    // the winner's checkpoint is left untouched and will be used next time.
    await db.update(sourceRuns).set({
      status: 'warning',
      checkpointAfter: null,
      error: [...failures.slice(0, 9), 'cursor CAS conflict: a newer discovery cursor won'].join('\n').slice(0, 2_000),
      finishedAt: new Date(),
    }).where(eq(sourceRuns.id, run.id))
  }

  return {
    skipped: false,
    queried: seeds.rows.length,
    resultsSeen: found.length,
    candidateTargets: candidates.length,
    created,
    existing,
    failedQueries: failures.length,
    wrapped: seeds.wrapped,
  }
  } catch (error) {
    await db.update(sourceRuns).set({
      status: 'failed',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      finishedAt: new Date(),
    }).where(eq(sourceRuns.id, run.id)).catch(() => undefined)
    throw error
  }
}
