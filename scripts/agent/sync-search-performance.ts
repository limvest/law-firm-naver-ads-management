import { readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getDb } from '@/lib/db/client'
import {
  importSearchPerformanceSnapshot,
  type SearchPerformanceImportResult,
} from '@/platform/integrations/search-performance'
import type { Db } from '@/lib/db/client'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SNAPSHOT_PATH_ENV_KEYS = [
  'SEARCH_PERFORMANCE_SNAPSHOT_PATH',
  'SEARCH_PERFORMANCE_SNAPSHOT_FILE',
  'SEARCH_SNAPSHOT_PATH',
] as const

export type SearchPerformanceSyncMainOptions = {
  readonly env?: NodeJS.ProcessEnv
  readonly argv?: readonly string[]
  readonly snapshotPath?: string | null
  readonly db?: Db
  readonly getDb?: () => Db | Promise<Db>
  readonly readSnapshot?: (path: string) => Promise<string>
  /** Alias kept for small script-level fakes. */
  readonly readFile?: (path: string) => Promise<string>
  readonly importSnapshot?: (db: Db, snapshot: unknown) => Promise<SearchPerformanceImportResult>
  /** Alias kept for small script-level fakes. */
  readonly importer?: (db: Db, snapshot: unknown) => Promise<SearchPerformanceImportResult>
  readonly log?: (message: string) => void
}

function configuredSnapshotPath(options: SearchPerformanceSyncMainOptions): string | null {
  const env = options.env ?? process.env
  const configured = options.snapshotPath
    ?? SNAPSHOT_PATH_ENV_KEYS.map((key) => env[key]).find((value) => value !== undefined)
    ?? (options.argv ?? process.argv)[2]
  if (typeof configured !== 'string' || configured.trim() === '') return null
  return configured.trim()
}

function projectPath(path: string): string {
  return resolve(ROOT, path)
}

function resultMessage(result: SearchPerformanceImportResult): string {
  return JSON.stringify({
    provider: result.provider,
    firmId: result.firmId,
    day: result.day,
    urls: result.urls,
    queries: result.queries,
  })
}

/**
 * Import a configured local JSON snapshot.  Dependencies are injectable so
 * tests never need credentials, a network, or a process-level DB singleton.
 */
export async function main(
  options: SearchPerformanceSyncMainOptions = {},
): Promise<SearchPerformanceImportResult | undefined> {
  const log = options.log ?? console.log
  const configuredPath = configuredSnapshotPath(options)
  if (!configuredPath) {
    log('sync-search-performance: snapshot path not configured — skip')
    return undefined
  }

  const env = options.env ?? process.env
  const hasInjectedDb = options.db !== undefined || options.getDb !== undefined
  if (!hasInjectedDb && !env.DATABASE_URL) {
    log('sync-search-performance: DATABASE_URL not configured — skip')
    return undefined
  }

  const snapshotPath = projectPath(configuredPath)
  const read = options.readSnapshot ?? options.readFile ?? ((path: string) => readFile(path, 'utf8'))
  const raw = await read(snapshotPath)
  const parsed: unknown = JSON.parse(raw)
  const db = options.db ?? await (options.getDb ?? getDb)()
  const importer = options.importSnapshot ?? options.importer
    ?? ((targetDb: Db, snapshot: unknown) => importSearchPerformanceSnapshot(targetDb, snapshot))
  const result = await importer(db, parsed)
  log(`sync-search-performance: ${resultMessage(result)}`)
  return result
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error('sync-search-performance failed:', error)
    process.exit(1)
  })
}
