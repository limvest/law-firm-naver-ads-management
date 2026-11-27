import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDb } from '@/lib/db/client'
import {
  reconcileAutoDiscoveredSourceFamilies,
  type SourceFamilyReconcileResult,
} from '@/domains/intelligence/source-family-reconcile'
import type { Db } from '@/lib/db/client'

export type SourceFamilyCliOptions = {
  readonly argv?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly db?: Db
  readonly getDb?: () => Db | Promise<Db>
  readonly log?: (message: string) => void
}

export type ParsedSourceFamilyCliOptions = {
  mode: 'dry-run' | 'apply'
  batchSize: number | undefined
  apply: boolean
  confirm: boolean
  help: boolean
}

const APPLY_FLAGS = new Set(['--apply', '--apply-source-family'])
const CONFIRM_FLAGS = new Set(['--confirm-source-family', '--confirm-apply', '--confirm'])
const BATCH_FLAGS = new Set(['--batch-size', '--batch', '--limit'])

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

/**
 * Parse the small, deliberately boring CLI surface.  Applying requires two
 * separate flags so a copied dry-run command cannot mutate the DB by accident.
 */
export function parseSourceFamilyCliArgs(argv: readonly string[] = process.argv.slice(2)): ParsedSourceFamilyCliOptions {
  const help = argv.includes('--help') || argv.includes('-h')
  const apply = argv.some((arg) => APPLY_FLAGS.has(arg))
  const confirm = argv.some((arg) => CONFIRM_FLAGS.has(arg))
  const explicitDryRun = argv.includes('--dry-run')
  if (apply !== confirm) {
    throw new Error('source-family apply requires both --apply and --confirm-source-family')
  }
  if (apply && explicitDryRun) {
    throw new Error('--dry-run cannot be combined with apply flags')
  }

  const batchFlag = argv.find((arg) => BATCH_FLAGS.has(arg))
  const rawBatchSize = batchFlag ? flagValue(argv, batchFlag) : undefined
  if (batchFlag && rawBatchSize === undefined) {
    throw new Error(`${batchFlag} requires a positive integer`)
  }
  if (rawBatchSize !== undefined && !/^\d+$/.test(rawBatchSize.trim())) {
    throw new Error('--batch-size must be a positive integer')
  }
  const batchSize = rawBatchSize === undefined ? undefined : Number(rawBatchSize)
  if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000)) {
    throw new Error('--batch-size must be between 1 and 5000')
  }

  const known = new Set(['--apply', '--apply-source-family', '--confirm-source-family', '--confirm-apply', '--confirm', '--dry-run', '--help', '-h', ...BATCH_FLAGS])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (known.has(arg)) {
      if (BATCH_FLAGS.has(arg)) index += 1
      continue
    }
    throw new Error(`unknown option: ${arg}`)
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    batchSize,
    apply,
    confirm,
    help,
  }
}

const HELP_TEXT = 'Usage: npm run agent:source-family -- [--dry-run] [--batch-size N]\n'
  + '       npm run agent:source-family -- --apply --confirm-source-family [--batch-size N]\n'
  + 'Default is dry-run. Apply requires both explicit flags and only updates source_family and config.sourceFamily.'

function report(result: SourceFamilyReconcileResult): string {
  // Keep the operator log compact even when a production DB contains tens of
  // thousands of rows.  The returned result still contains the full change
  // list for callers that need an export.
  return JSON.stringify({
    mode: result.mode,
    batchSize: result.batchSize,
    batches: result.batches,
    scanned: result.scanned,
    autoDiscovered: result.autoDiscovered,
    candidates: result.candidates,
    wouldUpdate: result.wouldUpdate,
    updated: result.updated,
    unchanged: result.unchanged,
    withoutCanonicalFamily: result.withoutCanonicalFamily,
    verification: result.verification,
  })
}

/**
 * Run source-family reconciliation.  Dependencies are injectable for tests;
 * no production DB operation is performed by this module during import.
 */
export async function main(options: SourceFamilyCliOptions = {}): Promise<SourceFamilyReconcileResult | undefined> {
  const log = options.log ?? console.log
  const argv = options.argv ?? process.argv.slice(2)
  const parsed = parseSourceFamilyCliArgs(argv)
  if (parsed.help) {
    log(HELP_TEXT)
    return undefined
  }
  const env = options.env ?? process.env
  const hasInjectedDb = options.db !== undefined || options.getDb !== undefined
  if (!hasInjectedDb && !env.DATABASE_URL) {
    log('source-family-reconcile: DATABASE_URL not configured — skip (dry-run; no changes)')
    return undefined
  }

  const db = options.db ?? await (options.getDb ?? getDb)()
  const result = await reconcileAutoDiscoveredSourceFamilies(db, {
    mode: parsed.mode,
    apply: parsed.apply,
    confirm: parsed.confirm,
    batchSize: parsed.batchSize,
  })
  log(`source-family-reconcile: ${report(result)}`)
  return result
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error('source-family-reconcile failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
