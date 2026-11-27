import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import { getDb, type Db } from '@/lib/db/client'

export const REQUIRED_CORE_TABLES = [
  'firms',
  'firm_accounts',
  'intelligence_sources',
  'source_collection_requests',
  'firm_source_grants',
  'source_runs',
  'source_items',
  'source_item_changes',
  'agent_action_proposals',
  'keywords',
  'observations',
  'scam_pages',
  'firm_keywords',
  'events',
  'leads',
  'operation_jobs',
  'operation_job_attempts',
  'firm_collection_runs',
  'keyword_search_coverage_runs',
  'keyword_search_coverage_batches',
  'keyword_search_coverage_attempts',
] as const

export type CoreSchemaPreflightOptions = {
  env?: NodeJS.ProcessEnv
  db?: Db
  getDb?: () => Db | Promise<Db>
  probe?: (table: string) => Promise<void>
  log?: (message: string) => void
}

export async function assertCoreSchema(
  options: CoreSchemaPreflightOptions = {},
): Promise<{ status: 'ready'; tables: number }> {
  const env = options.env ?? process.env
  const injected = options.db !== undefined || options.getDb !== undefined || options.probe !== undefined
  if (!injected && !env.DATABASE_URL?.trim()) throw new Error('database-required')
  const db = options.probe ? null : options.db ?? await (options.getDb ?? getDb)()
  const probe = options.probe ?? (async (table: string) => {
    await db!.execute(sql.raw(`select 1 from "${table}" limit 0`))
  })
  for (const table of REQUIRED_CORE_TABLES) await probe(table)
  const result = { status: 'ready' as const, tables: REQUIRED_CORE_TABLES.length }
  ;(options.log ?? console.log)(`core-schema-preflight: ${JSON.stringify(result)}`)
  return result
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  assertCoreSchema().catch(() => {
    console.error('core-schema-preflight failed: required unified schema is unavailable')
    process.exitCode = 1
  })
}
