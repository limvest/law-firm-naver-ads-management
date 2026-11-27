/**
 * 구독 벌크 CLI — keywords.status='published'(+ --type 필터) 중 firm 미구독분을 firm_keywords에
 * 삽입한다(onConflictDoNothing). 전량 자동 등록이 정책이다(사건명별 구독 없음 — 스펙 2026-08-03 §A):
 * `--all-firms`가 기본 운영 경로이고, 개별 `--firm` 경로는 운영 예외(단일 firm 재정비 등)용이다.
 *
 * - DATABASE_URL 없으면 SKIP exit 0 (register-ads.ts/poll-reviews.ts 관행)
 *
 * 실행:
 *   DATABASE_URL=… ./node_modules/.bin/tsx scripts/engine/subscribe-keywords.ts --all-firms
 *   DATABASE_URL=… ./node_modules/.bin/tsx scripts/engine/subscribe-keywords.ts --firm 1 [--type coin] [--limit 50]
 */
import { existsSync, readFileSync } from 'node:fs'

type Args = { firm: number; type?: string; limit?: number; allFirms?: boolean }

function changedCaseIds(): string[] | undefined {
  const inboxKey = process.env.KEYWORD_INBOX_KEY || process.env.SYNC_SOURCE_DAY
  if (!inboxKey) return undefined
  const path = process.env.COLLECTION_MANIFEST_PATH || `data/keyword-inbox/${inboxKey}-collection-manifest.json`
  if (!existsSync(path)) return []
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { changedCaseIds?: unknown }
    return Array.isArray(manifest.changedCaseIds)
      ? [...new Set(manifest.changedCaseIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : []
  } catch { return [] }
}

function parseArgs(argv: string[]): Args {
  const out: Args = { firm: 1 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--firm') out.firm = Number(argv[++i])
    else if (a === '--type') out.type = argv[++i]
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--all-firms') out.allFirms = true
  }
  return out
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP: DATABASE_URL not set')
    return
  }

  const args = parseArgs(process.argv.slice(2))
  const keywordIds = changedCaseIds()

  if (args.allFirms) {
    const { getDb } = await import('@/lib/db/client')
    const { enrollAllFirms } = await import('@/lib/engine/onboard')
    const db = getDb()
    const r = await enrollAllFirms(db, { keywordIds })
    console.log(`enrolled: firms ${r.firms}, added ${r.added}`)
    return
  }

  if (!Number.isFinite(args.firm)) {
    console.error('REFUSED: invalid --firm value')
    process.exitCode = 1
    return
  }
  // register-ads.ts와 동일한 이유: --limit이 NaN이면 slice(0, NaN)이 빈 배열이 아니라 무제한으로
  // 작동할 수 있는 위험을 명시적으로 차단한다.
  if (args.limit !== undefined && !Number.isFinite(args.limit)) {
    console.error('REFUSED: invalid --limit value')
    process.exitCode = 1
    return
  }

  const { getDb } = await import('@/lib/db/client')
  const { firms } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const { DEFAULT_FIRM } = await import('@/lib/engine/firms')
  const { subscribeKeywords } = await import('@/lib/engine/onboard')

  const db = getDb()

  const [firmRow] = await db.select().from(firms).where(eq(firms.id, args.firm))
  const firm = firmRow ?? (args.firm === 1 ? DEFAULT_FIRM : null)
  if (!firm) {
    console.error(`REFUSED: firm ${args.firm} not found`)
    process.exitCode = 1
    return
  }

  const result = await subscribeKeywords(db, firm.id, { scamType: args.type, keywordIds, limit: args.limit })
  console.log(`subscribed: firm ${firm.id}, added ${result.added}`)
}

main().catch((e) => {
  console.error('subscribe-keywords failed:', e)
  process.exitCode = 1
})
