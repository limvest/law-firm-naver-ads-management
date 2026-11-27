import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { observations } from '@/lib/db/schema'
import { refreshScamPages } from '@/lib/scam/content-pipeline'

function collectionLinks(): string[] {
  const inboxKey = process.env.KEYWORD_INBOX_KEY || process.env.SYNC_SOURCE_DAY
  if (!inboxKey) return []
  const path = `data/keyword-inbox/${inboxKey}.ndjson`
  if (!existsSync(path)) return []
  const links = new Set<string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const link = JSON.parse(line).link
      if (typeof link === 'string' && link.trim()) links.add(link.trim())
    } catch { /* 잘못된 행은 ingest 단계에서 이미 제외된다. */ }
  }
  return [...links]
}

function recordChangedCaseIds(ids: string[]): void {
  const inboxKey = process.env.KEYWORD_INBOX_KEY || process.env.SYNC_SOURCE_DAY
  if (!inboxKey) return
  const path = process.env.COLLECTION_MANIFEST_PATH || `data/keyword-inbox/${inboxKey}-collection-manifest.json`
  if (!existsSync(path)) return
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, `${JSON.stringify({ ...manifest, changedCaseIds: ids }, null, 2)}\n`, 'utf8')
  } catch { /* 실행 원장 보강 실패가 페이지 갱신 성공을 뒤집지는 않는다. */ }
}

function manifestChangedKeywordIds(): string[] | null {
  const inboxKey = process.env.KEYWORD_INBOX_KEY || process.env.SYNC_SOURCE_DAY
  if (!inboxKey) return null
  const path = process.env.COLLECTION_MANIFEST_PATH || `data/keyword-inbox/${inboxKey}-collection-manifest.json`
  if (!existsSync(path)) return []
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { changedCaseIds?: unknown }
    return Array.isArray(value.changedCaseIds)
      ? [...new Set(value.changedCaseIds.filter((item): item is string => typeof item === 'string' && item.length > 0))]
      : []
  } catch { return [] }
}

async function collectionKeywordIds(db: ReturnType<typeof getDb>): Promise<string[]> {
  const manifestIds = manifestChangedKeywordIds()
  if (manifestIds !== null) return manifestIds
  const ids = new Set<string>()
  const links = collectionLinks()
  for (let offset = 0; offset < links.length; offset += 1_000) {
    const rows = await db.select({ keywordId: observations.keywordId }).from(observations)
      .where(inArray(observations.sourceUrl, links.slice(offset, offset + 1_000)))
    for (const row of rows) ids.add(row.keywordId)
  }
  return [...ids]
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('generate-scam-pages: DATABASE_URL 미설정 — 스킵')
    return
  }
  const db = getDb()
  const incremental = Boolean(process.env.KEYWORD_INBOX_KEY || process.env.SYNC_SOURCE_DAY || process.env.COLLECTION_RUN_ID)
  const ids = incremental ? await collectionKeywordIds(db) : undefined
  if (ids) recordChangedCaseIds(ids)
  const result = await refreshScamPages(db, { keywordIds: ids })
  console.log(`generate-scam-pages: ${JSON.stringify(result)}`)
}

main().catch((error) => {
  console.error('generate-scam-pages failed:', error)
  process.exit(1)
})
