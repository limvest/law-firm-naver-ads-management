import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import { getDb, type Db } from '@/lib/db/client'

export const REQUIRED_TARGET_TABLES = [
  'case_entities',
  'case_evidence_snapshots',
  'case_opportunities',
  'content_assets',
  'publications',
  'publication_checks',
  'firm_domains',
  'firm_policies',
  'ad_accounts',
  'ad_executions',
  'ad_review_events',
  'ad_daily_stats_v2',
  'search_integrations',
  'search_url_statuses',
  'search_query_stats',
  'visitor_sessions',
  'touchpoints',
  'lead_status_history',
  'lead_qualifications',
  'consultations',
  'matter_outcomes',
  'operation_jobs',
  'operation_job_attempts',
  'firm_collection_runs',
  'approval_tasks',
  'operation_alerts',
  'daily_reports',
  'outbox_events',
  'product_lead_profiles',
  'product_lead_stage_history',
] as const

export type TargetSchemaPreflightOptions = {
  env?: NodeJS.ProcessEnv
  db?: Db
  getDb?: () => Db | Promise<Db>
  probe?: (table: string) => Promise<void>
  log?: (message: string) => void
}

/**
 * Daily production runs require the additive target model. Standalone bridge
 * CLIs may still skip for legacy development, but this preflight prevents a
 * scheduled run from recording success when a required relation is absent.
 */
export async function assertTargetSchema(
  options: TargetSchemaPreflightOptions = {},
): Promise<{ status: 'ready'; tables: number }> {
  const env = options.env ?? process.env
  const injected = options.db !== undefined || options.getDb !== undefined || options.probe !== undefined
  if (!injected && !env.DATABASE_URL?.trim()) throw new Error('database-required')

  const db = options.probe ? null : options.db ?? await (options.getDb ?? getDb)()
  const probe = options.probe ?? (async (table: string) => {
    // Table names come only from REQUIRED_TARGET_TABLES, never from input.
    await db!.execute(sql.raw(`select 1 from "${table}" limit 0`))
  })

  for (const table of REQUIRED_TARGET_TABLES) await probe(table)
  const result = { status: 'ready' as const, tables: REQUIRED_TARGET_TABLES.length }
  ;(options.log ?? console.log)(`target-schema-preflight: ${JSON.stringify(result)}`)
  return result
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  assertTargetSchema().catch(() => {
    console.error('target-schema-preflight failed: required target schema is unavailable')
    process.exitCode = 1
  })
}
