import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { sourceItemChanges } from '@/lib/db/schema'

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const day = process.env.SOURCE_RUN_DAY || process.argv[2]
    || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())
  const inboxKey = process.env.KEYWORD_INBOX_KEY || day
  const path = process.env.COLLECTION_MANIFEST_PATH || `data/keyword-inbox/${inboxKey}-collection-manifest.json`
  if (!existsSync(path)) throw new Error(`collection manifest not found: ${path}`)
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { changeEventIds?: unknown }
  const ids = Array.isArray(manifest.changeEventIds)
    ? [...new Set(manifest.changeEventIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  let processed = 0
  const now = new Date()
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await getDb().update(sourceItemChanges).set({
      status: 'processed', error: null, processedAt: now,
    }).where(inArray(sourceItemChanges.id, ids.slice(offset, offset + 500)))
      .returning({ id: sourceItemChanges.id })
    processed += rows.length
  }
  console.log(`incremental-complete: ${JSON.stringify({ events: ids.length, processed })}`)
}

main().catch((error) => {
  console.error('incremental-complete failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
