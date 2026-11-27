import { createHash } from 'node:crypto'
import { asc, desc, ne, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { keywords, observations } from '@/lib/db/schema'
import type { SourceSampleFetcher } from './source-analyzer'
import type { NaverWebSearchItem } from './naver-web-search'
import { classifyNaverResult, type NaverClassificationVerdict } from './naver-result-classifier'
import { syncLegacySourceRun } from './source-sync'

const LEDGER_SOURCE_KEY = 'system:naver-public-search-ledger'
const DEFAULT_SELF_HOSTS = new Set([
  'competitor-f-fintech.example.com', 'fintech.sampleone.attorney', 'sampleone.attorney', 'lawfirm-ads.vercel.app',
])
const INSPECTION_PATH = /\/(?:fraud|scam|case|cases|recovery|victim|powerlink|trading)(?:\/|$)/i
const LEGAL_OR_CASE_SIGNAL = /법무법인|법률사무소|변호사|피해구제|피해회복|사기|피해|먹튀|사칭|출금|리딩|투자/i

export type NaverDiscoverySeed = { id: string; name: string; observationCount: number }
export type NaverPublicSearch = (query: string) => Promise<readonly NaverWebSearchItem[]>

export type NaverDiscoveryLedgerRow = {
  sourceItemKey: string
  seedId: string
  seedName: string
  query: string
  rank: number
  title: string
  description: string
  searchUrl: string
  landingUrl: string | null
  landingFetchError: string | null
  verdict: NaverClassificationVerdict | null
}

export type NaverPublicDiscoveryResult = {
  seeds: number
  queriesSucceeded: number
  queriesFailed: number
  resultsSeen: number
  uniqueResults: number
  landingsAttempted: number
  landingsFetched: number
  accepted: number
  needsReview: number
  rejected: number
  persisted: boolean
  ledgerInserted: number
  ledgerUpdated: number
  ledgerUnchanged: number
  rows: NaverDiscoveryLedgerRow[]
  errors: string[]
}

function normalizeHost(value: string): string {
  try { return new URL(value).hostname.toLocaleLowerCase('en-US').replace(/^www\./, '') } catch { return '' }
}

function stableItemKey(seedId: string, query: string, url: string): string {
  return `naver:${createHash('sha256').update(`${seedId}\u0000${query.normalize('NFKC')}\u0000${url}`).digest('hex')}`
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 500)
}

export function shouldInspectNaverResult(
  item: Pick<NaverWebSearchItem, 'title' | 'description' | 'link'>,
  excludedHosts: ReadonlySet<string> = DEFAULT_SELF_HOSTS,
): boolean {
  const host = normalizeHost(item.link)
  if (!host || excludedHosts.has(host)) return false
  let path = ''
  try { path = new URL(item.link).pathname } catch { return false }
  const text = `${item.title} ${item.description}`
  return LEGAL_OR_CASE_SIGNAL.test(text) && (INSPECTION_PATH.test(path) || /법무법인|법률사무소|변호사|피해구제|피해회복/i.test(text))
}

export async function selectNaverDiscoverySeeds(db: Db, limit = 5): Promise<NaverDiscoverySeed[]> {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 100))
  const observationCount = sql<number>`count(${observations.id})`
  const rows = await db.select({
    id: keywords.id,
    name: keywords.name,
    observationCount,
  }).from(keywords)
    .innerJoin(observations, sql`${observations.keywordId} = ${keywords.id}`)
    .where(ne(keywords.status, 'blocked'))
    .groupBy(keywords.id, keywords.name, keywords.createdAt)
    .orderBy(desc(observationCount), asc(keywords.createdAt), asc(keywords.id))
    .limit(bounded)
  return rows.map((row) => ({ ...row, observationCount: Number(row.observationCount) }))
}

export async function runNaverPublicDiscovery(
  db: Db,
  options: {
    search: NaverPublicSearch
    fetchLanding: SourceSampleFetcher
    seeds?: readonly NaverDiscoverySeed[]
    seedLimit?: number
    maxLandings?: number
    excludedHosts?: readonly string[]
    persistLedger?: boolean
    now?: Date
  },
): Promise<NaverPublicDiscoveryResult> {
  const now = options.now ?? new Date()
  const seeds = options.seeds?.length ? [...options.seeds] : await selectNaverDiscoverySeeds(db, options.seedLimit)
  const excludedHosts = new Set([...DEFAULT_SELF_HOSTS, ...(options.excludedHosts ?? [])]
    .map((host) => host.toLocaleLowerCase('en-US').replace(/^www\./, '')))
  const maxLandings = Math.max(0, Math.min(options.maxLandings ?? 10, 50))
  const rows: NaverDiscoveryLedgerRow[] = []
  const errors: string[] = []
  let queriesSucceeded = 0
  let queriesFailed = 0

  for (const seed of seeds) {
    const query = `${seed.name} 사기 피해`
    try {
      const items = await options.search(query)
      queriesSucceeded += 1
      items.forEach((item, index) => rows.push({
        sourceItemKey: stableItemKey(seed.id, query, item.link),
        seedId: seed.id,
        seedName: seed.name,
        query,
        rank: index + 1,
        title: item.title,
        description: item.description,
        searchUrl: item.link,
        landingUrl: null,
        landingFetchError: null,
        verdict: null,
      }))
    } catch (error) {
      queriesFailed += 1
      errors.push(`${seed.id}:${errorText(error)}`)
    }
  }

  const uniqueByUrl = new Map<string, NaverDiscoveryLedgerRow>()
  for (const row of rows) {
    const current = uniqueByUrl.get(row.searchUrl)
    // The same URL can be returned for multiple seeds. If the first hit is a
    // weak/non-inspectable snippet but a later seed supplies legal/case
    // context, retain the stronger representative so the URL is not skipped
    // before its landing page can be classified.
    const rowInspectable = shouldInspectNaverResult(
      { title: row.title, description: row.description, link: row.searchUrl }, excludedHosts,
    )
    const currentInspectable = current && shouldInspectNaverResult(
      { title: current.title, description: current.description, link: current.searchUrl }, excludedHosts,
    )
    if (!current || (!currentInspectable && rowInspectable)) {
      uniqueByUrl.set(row.searchUrl, row)
    }
  }
  const inspectablePool = [...uniqueByUrl.values()]
    .filter((row) => shouldInspectNaverResult({ title: row.title, description: row.description, link: row.searchUrl }, excludedHosts))
  const poolBySeed = seeds.map((seed) => inspectablePool
    .filter((row) => row.seedId === seed.id)
    .sort((left, right) => left.rank - right.rank))
  const inspectable: NaverDiscoveryLedgerRow[] = []
  // 첫 seed의 관련글 묶음이 전체 랜딩 예산을 독점하지 않도록
  // seed별 1건씩 순환하며 검사한다.
  for (let rankIndex = 0; inspectable.length < maxLandings; rankIndex += 1) {
    let added = false
    for (const pool of poolBySeed) {
      const row = pool[rankIndex]
      if (!row) continue
      inspectable.push(row)
      added = true
      if (inspectable.length === maxLandings) break
    }
    if (!added) break
  }

  for (const row of inspectable) {
    try {
      const sample = await options.fetchLanding(row.searchUrl)
      row.landingUrl = sample.url
      row.verdict = classifyNaverResult(
        { title: row.title, description: row.description, link: row.searchUrl },
        { url: sample.url, html: sample.body },
      )
    } catch (error) {
      row.landingFetchError = errorText(error)
    }
  }

  // 동일 URL이 여러 seed에 노출되면 랜딩 판정을 각 원장 행에 복사해
  // 독립 seed 근거를 잃지 않는다.
  for (const row of rows) {
    const inspected = uniqueByUrl.get(row.searchUrl)
    if (!inspected || inspected === row) continue
    row.landingUrl = inspected.landingUrl
    row.landingFetchError = inspected.landingFetchError
    row.verdict = inspected.verdict
  }

  let ledgerInserted = 0
  let ledgerUpdated = 0
  let ledgerUnchanged = 0
  if (options.persistLedger) {
    const sync = await syncLegacySourceRun(db, {
      source: {
        sourceKey: LEDGER_SOURCE_KEY,
        name: '네이버 공개 검색결과 후보 원장',
        sourceType: 'search-discovery',
        sourceFamily: 'naver-public-html',
        baseUrl: 'https://search.naver.com/search.naver',
        enabled: true,
        cadenceMinutes: 1_440,
        config: { publicHtml: true, candidateOnly: true, autoPublish: false },
      },
      run: {
        runKey: `naver-public:${now.toISOString()}:${createHash('sha256').update(seeds.map((seed) => seed.id).join(',')).digest('hex').slice(0, 12)}`,
        trigger: 'naver-public-discovery',
        attempted: true,
        collectorMethod: 'naver-public-html-search',
        status: queriesFailed ? 'warning' : 'succeeded',
        itemsSeen: rows.length,
        itemsAccepted: rows.filter((row) => row.verdict?.decision !== 'reject').length,
        error: errors.length ? errors.join('\n') : null,
        startedAt: now,
        finishedAt: now,
      },
      items: rows.map((row) => ({
        sourceItemKey: row.sourceItemKey,
        sourceUrl: row.landingUrl ?? row.searchUrl,
        title: row.title,
        payload: {
          seedId: row.seedId,
          seedName: row.seedName,
          query: row.query,
          rank: row.rank,
          searchUrl: row.searchUrl,
          landingUrl: row.landingUrl,
          landingFetchError: row.landingFetchError,
          verdict: row.verdict,
        },
        observedAt: now,
        parserVersion: 'naver-public-discovery-v1',
      })),
    }, { mode: 'summary' })
    ledgerInserted = sync.itemsInserted
    ledgerUpdated = sync.itemsUpdated
    ledgerUnchanged = sync.itemsUnchanged
  }

  return {
    seeds: seeds.length,
    queriesSucceeded,
    queriesFailed,
    resultsSeen: rows.length,
    uniqueResults: uniqueByUrl.size,
    landingsAttempted: inspectable.length,
    landingsFetched: inspectable.filter((row) => row.landingUrl).length,
    accepted: rows.filter((row) => row.verdict?.decision === 'accept').length,
    needsReview: rows.filter((row) => row.verdict?.decision === 'review').length,
    rejected: rows.filter((row) => row.verdict?.decision === 'reject').length,
    persisted: Boolean(options.persistLedger),
    ledgerInserted,
    ledgerUpdated,
    ledgerUnchanged,
    rows,
    errors,
  }
}
