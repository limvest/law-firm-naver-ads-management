import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { keywords, observations } from '@/lib/db/schema'
import { fetchPublicSourceSample } from '@/domains/intelligence/source-analyzer'
import {
  runNaverPublicDiscovery,
  type NaverDiscoverySeed,
} from '@/domains/intelligence/naver-public-discovery'
import { createNaverHtmlSearchClient, naverHtmlSearchOptedIn } from '@/domains/intelligence/naver-web-search'

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

function valuesAfter(flag: string): string[] {
  const values: string[] = []
  process.argv.slice(2).forEach((value, index, all) => {
    if (value === flag && all[index + 1] && !all[index + 1].startsWith('--')) values.push(all[index + 1])
  })
  return values
}

function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function namedSeeds(names: readonly string[]): Promise<NaverDiscoverySeed[]> {
  const db = getDb()
  const found: NaverDiscoverySeed[] = []
  for (const name of names) {
    const [row] = await db.select({
      id: keywords.id,
      name: keywords.name,
      observationCount: sql<number>`count(${observations.id})`,
    }).from(keywords)
      .innerJoin(observations, sql`${observations.keywordId} = ${keywords.id}`)
      .where(sql`lower(${keywords.name}) = lower(${name.normalize('NFKC').trim()})`)
      .groupBy(keywords.id, keywords.name)
      .limit(1)
    if (!row) throw new Error(`DB에 관측 근거가 있는 사건명을 찾지 못했습니다: ${name}`)
    found.push({ ...row, observationCount: Number(row.observationCount) })
  }
  return found
}

async function main(): Promise<void> {
  if (!naverHtmlSearchOptedIn(process.env.NAVER_PUBLIC_SEARCH_ENABLED)) {
    console.log('naver-public-discovery: skipped — NAVER_PUBLIC_SEARCH_ENABLED=1 opt-in 필요')
    return
  }
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required')

  const persistRequested = process.argv.includes('--persist-ledger')
  if (persistRequested && process.env.NAVER_DISCOVERY_LEDGER_WRITE !== '1') {
    throw new Error('--persist-ledger는 NAVER_DISCOVERY_LEDGER_WRITE=1 이중 승인이 필요합니다')
  }
  if (persistRequested && process.env.LAWFIRM_TRANSACTIONAL_DB !== '1') {
    throw new Error('원장 쓰기는 LAWFIRM_TRANSACTIONAL_DB=1이 필요합니다')
  }

  const seedNames = valuesAfter('--seed')
  const seeds = seedNames.length ? await namedSeeds(seedNames) : undefined
  const client = createNaverHtmlSearchClient({
    optIn: true,
    maxConcurrent: positiveInt(process.env.NAVER_PUBLIC_SEARCH_CONCURRENCY, 1, 2),
    minIntervalMs: positiveInt(process.env.NAVER_PUBLIC_SEARCH_INTERVAL_MS, 3_000, 60_000),
  })
  const result = await runNaverPublicDiscovery(getDb(), {
    search: client.search,
    fetchLanding: fetchPublicSourceSample,
    seeds,
    seedLimit: positiveInt(flagValue('--seed-limit'), 5, 100),
    maxLandings: positiveInt(flagValue('--max-landings'), 10, 50),
    persistLedger: persistRequested,
  })

  const candidates = result.rows.flatMap((row) => row.verdict?.decision === 'accept' ? [{
    seed: row.seedName,
    rank: row.rank,
    url: row.landingUrl ?? row.searchUrl,
    pageType: row.verdict.pageType,
    confidence: row.verdict.confidence,
    caseName: row.verdict.caseNameCandidate?.value ?? null,
    methods: row.verdict.observations.method,
  }] : []).slice(0, 30)
  console.log(JSON.stringify({
    summary: {
      seeds: result.seeds,
      queriesSucceeded: result.queriesSucceeded,
      queriesFailed: result.queriesFailed,
      resultsSeen: result.resultsSeen,
      uniqueResults: result.uniqueResults,
      landingsAttempted: result.landingsAttempted,
      landingsFetched: result.landingsFetched,
      accepted: result.accepted,
      needsReview: result.needsReview,
      rejected: result.rejected,
      persisted: result.persisted,
      ledgerInserted: result.ledgerInserted,
      ledgerUpdated: result.ledgerUpdated,
      ledgerUnchanged: result.ledgerUnchanged,
      halted: client.halted,
    },
    candidates,
    errors: result.errors,
  }, null, 2))
}

main().catch((error) => {
  console.error('naver-public-discovery failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
