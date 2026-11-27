/**
 * 경쟁사 누적 합집합을 데모 법무법인에만 배포한다.
 *
 * 중앙 keyword의 공개 상태는 변경하지 않는다. firm_keywords에만 연결하고
 * adDesired=false로 고정해 미리보기 페이지 검수와 실제 광고 집행을 분리한다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPORT = join(ROOT, 'data', 'competitor-keyword-promotions.json')
const CHUNK_SIZE = 500

function chunks<T>(values: T[]): T[][] {
  const result: T[][] = []
  for (let i = 0; i < values.length; i += CHUNK_SIZE) result.push(values.slice(i, i + CHUNK_SIZE))
  return result
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('demo-deploy: DATABASE_URL 미설정 — 스킵')
    return
  }
  if (!existsSync(REPORT)) throw new Error('promotion report not found')

  const report = JSON.parse(readFileSync(REPORT, 'utf8')) as { demoSlugs?: unknown; demoAll?: boolean }
  if (!report.demoAll || !Array.isArray(report.demoSlugs)) {
    throw new Error('REFUSED: run promote_competitor_keywords.py --demo-all first')
  }
  const slugs = [...new Set(report.demoSlugs.filter((value): value is string => typeof value === 'string' && value.length > 0))]
  if (!slugs.length) throw new Error('REFUSED: demo corpus is empty')
  const skipUnchanged = process.argv.includes('--skip-unchanged')
  const pending = (report as { pendingSlugs?: unknown }).pendingSlugs
  if (skipUnchanged && Array.isArray(pending) && pending.length === 0) {
    console.log(`demo-deploy: unchanged ${slugs.length}/${slugs.length} · added 0 · adEnabled 0`)
    return
  }

  const { getDb } = await import('@/lib/db/client')
  const { firms, firmKeywords, keywords } = await import('@/lib/db/schema')
  const { and, eq, inArray } = await import('drizzle-orm')
  const db = getDb()
  const [firm] = await db.select().from(firms).where(eq(firms.slug, 'demo')).limit(1)
  if (!firm || firm.status === 'paused') throw new Error('REFUSED: active demo firm not found')

  const keywordRows: Array<{ id: string; slug: string }> = []
  for (const slugChunk of chunks(slugs)) {
    keywordRows.push(...await db.select({ id: keywords.id, slug: keywords.slug })
      .from(keywords).where(inArray(keywords.slug, slugChunk)))
  }
  const foundSlugs = new Set(keywordRows.map((row) => row.slug))
  const missing = slugs.filter((slug) => !foundSlugs.has(slug))
  if (missing.length) throw new Error(`REFUSED: ${missing.length} demo keywords are not synced to DB (sample: ${missing.slice(0, 5).join(', ')})`)

  let added = 0
  for (const rowChunk of chunks(keywordRows)) {
    const inserted = await db.insert(firmKeywords).values(rowChunk.map((row) => ({
      firmId: firm.id,
      keywordId: row.id,
      status: 'subscribed',
      adDesired: false,
    }))).onConflictDoNothing({ target: [firmKeywords.firmId, firmKeywords.keywordId] }).returning({ id: firmKeywords.id })
    added += inserted.length
    await db.update(firmKeywords).set({ adDesired: false, updatedAt: new Date() }).where(and(
      eq(firmKeywords.firmId, firm.id),
      inArray(firmKeywords.keywordId, rowChunk.map((row) => row.id)),
    ))
  }

  let subscribed = 0
  for (const rowChunk of chunks(keywordRows)) {
    const rows = await db.select({ id: firmKeywords.id }).from(firmKeywords).where(and(
      eq(firmKeywords.firmId, firm.id),
      inArray(firmKeywords.keywordId, rowChunk.map((row) => row.id)),
    ))
    subscribed += rows.length
  }
  if (subscribed !== keywordRows.length) throw new Error(`demo deployment verification failed: ${subscribed}/${keywordRows.length}`)

  console.log(JSON.stringify({ firm: firm.slug, unionRecords: report.demoSlugs.length, uniqueKeywords: keywordRows.length, added, subscribed, adDesired: false }, null, 2))
  console.log(`demo-deploy: subscribed ${subscribed}/${keywordRows.length} · added ${added} · adEnabled 0`)
}

main().catch((error) => {
  console.error('demo-deploy failed:', error)
  process.exitCode = 1
})
