/**
 * DB(events/leads) → data/traffic.json 내보내기 — 대시보드의 URL 퍼널 데이터 소스.
 * DATABASE_URL 없으면 스킵 (대시보드는 "수집 대기/유실 중" 표시).
 * slug 별: page_view / call_click / kakao_click / form_submit / leads 수.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('export-traffic: DATABASE_URL 미설정 — 스킵')
    return
  }
  const { getDb } = await import('../../src/lib/db/client')
  const { sql } = await import('drizzle-orm')
  const db = getDb()

  const events = await db.execute(sql`
    select slug, type, count(*)::int as n, min(created_at) as first, max(created_at) as last
    from events where slug is not null group by slug, type`)
  const leads = await db.execute(sql`
    select slug, count(*)::int as n, max(created_at) as last from leads group by slug`)

  const out = { exportedAt: new Date().toISOString(), events: events.rows, leads: leads.rows }
  writeFileSync(join(ROOT, 'data/traffic.json'), JSON.stringify(out, null, 1))
  console.log(`export-traffic: events ${events.rows.length}행, leads ${leads.rows.length}행`)
}

main().catch((e) => { console.error('export-traffic failed:', e); process.exit(1) })
