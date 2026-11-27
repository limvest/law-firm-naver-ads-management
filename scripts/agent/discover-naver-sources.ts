import { getDb } from '@/lib/db/client'
import { discoverNaverCollectorSources } from '@/domains/intelligence/naver-source-discovery'
import { createNaverHtmlSearchClient, naverHtmlSearchOptedIn } from '@/domains/intelligence/naver-web-search'

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

async function main(): Promise<void> {
  const optedIn = naverHtmlSearchOptedIn(process.env.NAVER_PUBLIC_SEARCH_ENABLED)
  if (!optedIn) {
    console.log('source-discovery: skipped — NAVER_PUBLIC_SEARCH_ENABLED=1 opt-in 필요')
    return
  }
  const excludedHosts = (process.env.SOURCE_DISCOVERY_EXCLUDED_HOSTS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean)
  const client = createNaverHtmlSearchClient({
    optIn: true,
    maxConcurrent: positiveInt(process.env.NAVER_PUBLIC_SEARCH_CONCURRENCY, 1, 2),
    minIntervalMs: positiveInt(process.env.NAVER_PUBLIC_SEARCH_INTERVAL_MS, 3_000, 60_000),
  })
  const result = await discoverNaverCollectorSources(getDb(), {
    search: client.search,
    batchSize: positiveInt(process.env.NAVER_SOURCE_DISCOVERY_BATCH, 100, 500),
    minDistinctSeeds: positiveInt(process.env.NAVER_SOURCE_DISCOVERY_MIN_SEEDS, 2, 20),
    excludedHosts,
  })
  console.log(`source-discovery: ${JSON.stringify(result)}`)
  if (result.failedQueries) {
    console.log(`WARN: 네이버 신규 소스 탐색 중 검색 실패 ${result.failedQueries}/${result.queried}건`)
  }
  if (client.halted) console.log('WARN: CAPTCHA/403/429 신호로 공개 검색 회로 중단')
}

main().catch((error) => {
  console.error('source-discovery failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
