import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { ingestPendingSourceChanges } from '@/domains/intelligence/incremental-ingest'
import { syncLegacySourceRun } from '@/domains/intelligence/source-sync'
import { keywords, observations, sourceItems, type ObsFacts } from '@/lib/db/schema'
import * as schema from '@/lib/db/schema'
import type { Db } from '@/lib/db/client'
import { groupInboxRows, readInbox, type RegistrySource } from './sync-source-runs'

function option(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : ''
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const registryPath = option('--registry')
  const inboxPath = option('--inbox')
  const factsPath = option('--facts')
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as { sources?: RegistrySource[] }
  const rows = await readInbox(inboxPath)
  const facts = JSON.parse(await readFile(factsPath, 'utf8')) as Record<string, ObsFacts>

  const client = new PGlite()
  const local = drizzle(client, { schema })
  await migrate(local, { migrationsFolder: 'drizzle' })
  const db = local as unknown as Db
  const groups = groupInboxRows(registry.sources ?? [], rows, {
    file: inboxPath,
    day: '2026-08-29',
    lane: 'local-live-verification',
  })
  for (const group of groups.values()) {
    if (!group.items.length) continue
    await syncLegacySourceRun(db, {
      source: group.source,
      run: { runKey: 'local-live-verification', status: 'succeeded' },
      items: group.items,
    })
  }
  const result = await ingestPendingSourceChanges(db, { factsByUrl: facts })
  const [keywordRows, observationRows, itemRows] = await Promise.all([
    db.select().from(keywords),
    db.select().from(observations),
    db.select().from(sourceItems),
  ])
  const rawMetadataRows = itemRows.filter((item) => {
    const payload = item.payload as { raw?: { pageTitle?: unknown; extractionMethod?: unknown } } | null
    return typeof payload?.raw?.pageTitle === 'string'
      && typeof payload.raw.extractionMethod === 'string'
      && payload.raw.extractionMethod.startsWith('html-')
  })
  console.log(JSON.stringify({
    inputRows: rows.length,
    sourceGroups: [...groups.values()].filter((group) => group.items.length).length,
    keywords: keywordRows.length,
    observations: observationRows.length,
    observationsWithFacts: observationRows.filter((row) => row.facts).length,
    rawMetadataRows: rawMetadataRows.length,
    result,
    names: keywordRows.map((row) => row.name).sort(),
  }))
  await client.close()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
