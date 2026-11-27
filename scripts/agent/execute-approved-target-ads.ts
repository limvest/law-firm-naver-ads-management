import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDb, type Db } from '@/lib/db/client'
import {
  executeApprovedTargetAds,
  TARGET_AD_LIVE_CONFIRMATION,
  type ExecuteApprovedTargetAdsOptions,
  type ExecuteApprovedTargetAdsResult,
  type TargetAdExecutionMode,
} from '@/domains/advertising/execution-service'

type ExecuteTargetAdsService = typeof executeApprovedTargetAds

type CliStatus = 'completed' | 'skipped' | 'refused' | 'failed'

export interface ExecuteApprovedTargetAdsCliResult {
  readonly command: 'execute-approved-target-ads'
  readonly status: CliStatus
  readonly mode: TargetAdExecutionMode
  readonly requestedLive: boolean
  readonly considered: number
  readonly dryRun: number
  readonly submitted: number
  readonly skipped: number
  readonly providerOutcomeUnknown: number
  readonly failed: number
  readonly reasonCode: string | null
  readonly missingLiveGuards: readonly string[]
}

export interface ExecuteApprovedTargetAdsCliDependencies {
  readonly getDb?: () => Db | Promise<Db>
  readonly executeApprovedTargetAds?: ExecuteTargetAdsService
  readonly execute?: ExecuteTargetAdsService
}

export interface ExecuteApprovedTargetAdsCliOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly argv?: readonly string[]
  readonly db?: Db
  readonly getDb?: () => Db | Promise<Db>
  readonly executeApprovedTargetAds?: ExecuteTargetAdsService
  readonly executeService?: ExecuteTargetAdsService
  readonly execute?: ExecuteTargetAdsService
  readonly dependencies?: ExecuteApprovedTargetAdsCliDependencies
  readonly now?: Date
  readonly actor?: string
  readonly log?: (message: string) => void
}

export interface ParsedExecuteApprovedTargetAdsArgs {
  readonly live: boolean
  readonly firmId?: number
  readonly limit?: number
}

class CliArgumentError extends Error {
  readonly reasonCode = 'invalid-arguments'

  constructor() {
    super('invalid target ad execution arguments')
    this.name = 'CliArgumentError'
  }
}

function parsePositiveInteger(value: string | undefined, maximum?: number): number {
  if (!value || !/^[0-9]+$/.test(value)) throw new CliArgumentError()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (maximum !== undefined && parsed > maximum)) {
    throw new CliArgumentError()
  }
  return parsed
}

function nextValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new CliArgumentError()
  return value
}

export function parseExecuteApprovedTargetAdsArgs(
  argv: readonly string[] = [],
): ParsedExecuteApprovedTargetAdsArgs {
  let live = false
  let firmId: number | undefined
  let limit: number | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--live') {
      live = true
      continue
    }
    if (argument === '--firm') {
      if (firmId !== undefined) throw new CliArgumentError()
      firmId = parsePositiveInteger(nextValue(argv, index))
      index += 1
      continue
    }
    if (argument.startsWith('--firm=')) {
      if (firmId !== undefined) throw new CliArgumentError()
      firmId = parsePositiveInteger(argument.slice('--firm='.length))
      continue
    }
    if (argument === '--limit') {
      if (limit !== undefined) throw new CliArgumentError()
      limit = parsePositiveInteger(nextValue(argv, index), 1_000)
      index += 1
      continue
    }
    if (argument.startsWith('--limit=')) {
      if (limit !== undefined) throw new CliArgumentError()
      limit = parsePositiveInteger(argument.slice('--limit='.length), 1_000)
      continue
    }
    throw new CliArgumentError()
  }

  return { live, firmId, limit }
}

function emptyCounts(): Pick<ExecuteApprovedTargetAdsCliResult,
  'considered' | 'dryRun' | 'submitted' | 'skipped' | 'providerOutcomeUnknown' | 'failed'> {
  return {
    considered: 0,
    dryRun: 0,
    submitted: 0,
    skipped: 0,
    providerOutcomeUnknown: 0,
    failed: 0,
  }
}

function count(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function result(
  input: Pick<ExecuteApprovedTargetAdsCliResult, 'status' | 'mode' | 'requestedLive'>
    & Partial<Pick<ExecuteApprovedTargetAdsCliResult, 'reasonCode' | 'missingLiveGuards'>>,
  counts: Partial<Pick<ExecuteApprovedTargetAdsCliResult,
    'considered' | 'dryRun' | 'submitted' | 'skipped' | 'providerOutcomeUnknown' | 'failed'>> = {},
): ExecuteApprovedTargetAdsCliResult {
  const defaults = emptyCounts()
  return {
    command: 'execute-approved-target-ads',
    status: input.status,
    mode: input.mode,
    requestedLive: input.requestedLive,
    considered: count(counts.considered ?? defaults.considered),
    dryRun: count(counts.dryRun ?? defaults.dryRun),
    submitted: count(counts.submitted ?? defaults.submitted),
    skipped: count(counts.skipped ?? defaults.skipped),
    providerOutcomeUnknown: count(counts.providerOutcomeUnknown ?? defaults.providerOutcomeUnknown),
    failed: count(counts.failed ?? defaults.failed),
    reasonCode: input.reasonCode ?? null,
    missingLiveGuards: input.missingLiveGuards ?? [],
  }
}

function summary(value: ExecuteApprovedTargetAdsCliResult): string {
  return JSON.stringify(value)
}

function undefinedTable(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current)
    const value = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (value.code === '42P01') return true
    if (typeof value.message === 'string' && /relation .* does not exist/i.test(value.message)) return true
    current = value.cause
  }
  return false
}

function liveGuards(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = []
  if (env.ENGINE_LIVE !== '1') missing.push('ENGINE_LIVE=1')
  if (env.TARGET_AD_AUTOMATION !== '1') missing.push('TARGET_AD_AUTOMATION=1')
  return missing
}

function injectedDb(options: ExecuteApprovedTargetAdsCliOptions): boolean {
  return options.db !== undefined
    || options.getDb !== undefined
    || options.dependencies?.getDb !== undefined
}

function executionService(options: ExecuteApprovedTargetAdsCliOptions): ExecuteTargetAdsService {
  return options.executeApprovedTargetAds
    ?? options.executeService
    ?? options.execute
    ?? options.dependencies?.executeApprovedTargetAds
    ?? options.dependencies?.execute
    ?? executeApprovedTargetAds
}

function databaseFactory(options: ExecuteApprovedTargetAdsCliOptions): () => Db | Promise<Db> {
  return options.getDb
    ?? options.dependencies?.getDb
    ?? getDb
}

function serviceOptions(
  args: ParsedExecuteApprovedTargetAdsArgs,
  options: ExecuteApprovedTargetAdsCliOptions,
): ExecuteApprovedTargetAdsOptions {
  const mode: TargetAdExecutionMode = args.live ? 'live' : 'dry-run'
  return {
    mode,
    ...(args.firmId === undefined ? {} : { firmIds: [args.firmId] }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.live ? { liveConfirmation: TARGET_AD_LIVE_CONFIRMATION } : {}),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  }
}

function completedResult(
  mode: TargetAdExecutionMode,
  execution: ExecuteApprovedTargetAdsResult,
): ExecuteApprovedTargetAdsCliResult {
  const liveSkipped = mode === 'live' && execution.skipped > 0
  return result({
    status: liveSkipped ? 'failed' : 'completed',
    mode,
    requestedLive: mode === 'live',
    reasonCode: liveSkipped ? 'live-candidates-skipped' : null,
  }, {
    considered: execution.considered,
    dryRun: execution.dryRun,
    submitted: execution.submitted,
    skipped: execution.skipped,
    providerOutcomeUnknown: execution.providerOutcomeUnknown,
    failed: execution.failed,
  })
}

function guardResult(
  args: ParsedExecuteApprovedTargetAdsArgs,
  status: 'skipped' | 'refused',
  reasonCode: string,
  missingLiveGuards: readonly string[] = [],
): ExecuteApprovedTargetAdsCliResult {
  return result({
    status,
    mode: args.live ? 'live' : 'dry-run',
    requestedLive: args.live,
    reasonCode,
    missingLiveGuards,
  })
}

/**
 * Injectable command entry point. The default path is a database-backed dry run;
 * callers must explicitly request live mode and satisfy both environment guards.
 */
export async function main(
  options: ExecuteApprovedTargetAdsCliOptions = {},
): Promise<ExecuteApprovedTargetAdsCliResult> {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)
  const log = options.log ?? console.log
  let args: ParsedExecuteApprovedTargetAdsArgs

  try {
    args = parseExecuteApprovedTargetAdsArgs(argv)
  } catch {
    const invalid = result({
      status: 'refused',
      mode: 'dry-run',
      requestedLive: false,
      reasonCode: 'invalid-arguments',
    })
    log(summary(invalid))
    return invalid
  }

  if (args.live) {
    const missing = liveGuards(env)
    if (missing.length) {
      const refused = guardResult(args, 'refused', 'live-guard-missing', missing)
      log(summary(refused))
      return refused
    }
  }

  if (!injectedDb(options) && !env.DATABASE_URL?.trim()) {
    const missingDatabase = guardResult(
      args,
      args.live ? 'refused' : 'skipped',
      'database-url-missing',
    )
    log(summary(missingDatabase))
    return missingDatabase
  }

  try {
    const db = options.db ?? await databaseFactory(options)()
    const execution = await executionService(options)(db, serviceOptions(args, options))
    const completed = completedResult(args.live ? 'live' : 'dry-run', execution)
    log(summary(completed))
    return completed
  } catch (error) {
    const schemaMissing = undefinedTable(error)
    if (schemaMissing) {
      const safeSchemaResult = guardResult(
        args,
        args.live ? 'refused' : 'skipped',
        'target-schema-missing',
      )
      log(summary(safeSchemaResult))
      return safeSchemaResult
    }
    const failed = result({
      status: 'failed',
      mode: args.live ? 'live' : 'dry-run',
      requestedLive: args.live,
      reasonCode: 'execution-error',
    }, { failed: 1 })
    log(summary(failed))
    return failed
  }
}

function shouldFailProcess(value: ExecuteApprovedTargetAdsCliResult): boolean {
  return value.status === 'refused'
    || value.status === 'failed'
    || value.failed > 0
    || value.providerOutcomeUnknown > 0
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().then((value) => {
    if (shouldFailProcess(value)) process.exitCode = 1
  }).catch(() => {
    console.log(JSON.stringify({
      command: 'execute-approved-target-ads',
      status: 'failed',
      mode: 'dry-run',
      requestedLive: false,
      ...emptyCounts(),
      failed: 1,
      reasonCode: 'execution-error',
      missingLiveGuards: [],
    }))
    process.exitCode = 1
  })
}
