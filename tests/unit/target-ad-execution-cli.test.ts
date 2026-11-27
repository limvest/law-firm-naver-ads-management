import { describe, expect, it, vi } from 'vitest'
import type { Db } from '@/lib/db/client'
import {
  main,
  type ExecuteApprovedTargetAdsCliOptions,
} from '../../scripts/agent/execute-approved-target-ads'
import { TARGET_AD_LIVE_CONFIRMATION } from '@/domains/advertising/execution-service'

type ExecuteService = NonNullable<ExecuteApprovedTargetAdsCliOptions['executeApprovedTargetAds']>

const fakeDb = {} as Db

function serviceResult(mode: 'dry-run' | 'live', overrides: Partial<{
  considered: number
  dryRun: number
  submitted: number
  skipped: number
  providerOutcomeUnknown: number
  failed: number
}> = {}) {
  return {
    mode,
    considered: overrides.considered ?? 1,
    dryRun: overrides.dryRun ?? (mode === 'dry-run' ? 1 : 0),
    submitted: overrides.submitted ?? (mode === 'live' ? 1 : 0),
    skipped: overrides.skipped ?? 0,
    providerOutcomeUnknown: overrides.providerOutcomeUnknown ?? 0,
    failed: overrides.failed ?? 0,
    items: [],
  }
}

function fakeRuntime() {
  const getDb = vi.fn(async () => fakeDb)
  const executeApprovedTargetAds = vi.fn<ExecuteService>(async (_db, options = {}) => (
    serviceResult(options.mode ?? 'dry-run')
  ))
  return { getDb, executeApprovedTargetAds }
}

describe('execute-approved-target-ads CLI', () => {
  it('defaults to dry-run and forwards firm/limit through injectable dependencies', async () => {
    const runtime = fakeRuntime()
    const logs: string[] = []

    const result = await main({
      env: {},
      argv: ['--firm', '17', '--limit', '12'],
      getDb: runtime.getDb,
      executeApprovedTargetAds: runtime.executeApprovedTargetAds,
      log: (message) => logs.push(message),
    })

    expect(result).toMatchObject({ status: 'completed', mode: 'dry-run', dryRun: 1 })
    expect(runtime.getDb).toHaveBeenCalledTimes(1)
    expect(runtime.executeApprovedTargetAds).toHaveBeenCalledWith(fakeDb, {
      mode: 'dry-run',
      firmIds: [17],
      limit: 12,
    })
    expect(JSON.parse(logs[0])).toMatchObject({ command: 'execute-approved-target-ads', status: 'completed' })
  })

  it('refuses --live when either environment guard is missing without opening the execution path', async () => {
    const runtime = fakeRuntime()
    const logs: string[] = []

    const result = await main({
      env: { DATABASE_URL: 'postgres://test-only', ENGINE_LIVE: '1' },
      argv: ['--live'],
      getDb: runtime.getDb,
      executeApprovedTargetAds: runtime.executeApprovedTargetAds,
      log: (message) => logs.push(message),
    })

    expect(result).toMatchObject({
      status: 'refused',
      mode: 'live',
      reasonCode: 'live-guard-missing',
      missingLiveGuards: ['TARGET_AD_AUTOMATION=1'],
    })
    expect(runtime.getDb).not.toHaveBeenCalled()
    expect(runtime.executeApprovedTargetAds).not.toHaveBeenCalled()
    expect(JSON.parse(logs[0])).toMatchObject({ status: 'refused', reasonCode: 'live-guard-missing' })
  })

  it('passes the confirmation token only when all live guards are present', async () => {
    const runtime = fakeRuntime()
    const result = await main({
      env: {
        DATABASE_URL: 'postgres://test-only',
        ENGINE_LIVE: '1',
        TARGET_AD_AUTOMATION: '1',
      },
      argv: ['--live', '--firm=19', '--limit=3'],
      getDb: runtime.getDb,
      executeApprovedTargetAds: runtime.executeApprovedTargetAds,
      log: () => undefined,
    })

    expect(result).toMatchObject({ status: 'completed', mode: 'live', submitted: 1 })
    expect(runtime.executeApprovedTargetAds).toHaveBeenCalledWith(fakeDb, {
      mode: 'live',
      liveConfirmation: TARGET_AD_LIVE_CONFIRMATION,
      firmIds: [19],
      limit: 3,
    })
  })

  it('fails closed when a live candidate is skipped by readiness or policy checks', async () => {
    const execute = vi.fn<ExecuteService>(async () => serviceResult('live', {
      considered: 1,
      submitted: 0,
      skipped: 1,
    }))
    const result = await main({
      env: {
        DATABASE_URL: 'postgres://test-only',
        ENGINE_LIVE: '1',
        TARGET_AD_AUTOMATION: '1',
      },
      argv: ['--live'],
      getDb: async () => fakeDb,
      executeApprovedTargetAds: execute,
      log: () => undefined,
    })

    expect(result).toMatchObject({
      status: 'failed',
      mode: 'live',
      submitted: 0,
      skipped: 1,
      reasonCode: 'live-candidates-skipped',
    })
  })

  it('safely skips dry-run and refuses live when DATABASE_URL is absent', async () => {
    const liveRuntime = fakeRuntime()
    const liveLogs: string[] = []
    const live = await main({
      env: { ENGINE_LIVE: '1', TARGET_AD_AUTOMATION: '1' },
      argv: ['--live'],
      executeApprovedTargetAds: liveRuntime.executeApprovedTargetAds,
      log: (message) => liveLogs.push(message),
    })
    expect(live).toMatchObject({ status: 'refused', mode: 'live', reasonCode: 'database-url-missing' })
    expect(liveLogs[0]).not.toContain('DATABASE_URL=')
    expect(liveRuntime.executeApprovedTargetAds).not.toHaveBeenCalled()

    const directDryLogs: string[] = []
    const directDry = await main({ env: {}, argv: [], log: (message) => directDryLogs.push(message) })
    expect(directDry).toMatchObject({ status: 'skipped', reasonCode: 'database-url-missing' })
    expect(JSON.parse(directDryLogs[0])).toMatchObject({ status: 'skipped', reasonCode: 'database-url-missing' })
  })

  it('refuses non-positive firms and out-of-range limits before resolving a database', async () => {
    const runtime = fakeRuntime()
    const logs: string[] = []

    const invalidFirm = await main({
      env: {},
      argv: ['--firm', '0'],
      getDb: runtime.getDb,
      executeApprovedTargetAds: runtime.executeApprovedTargetAds,
      log: (message) => logs.push(message),
    })

    const invalidLimit = await main({
      env: {},
      argv: ['--firm', '1', '--limit', '1001'],
      getDb: runtime.getDb,
      executeApprovedTargetAds: runtime.executeApprovedTargetAds,
      log: (message) => logs.push(message),
    })

    expect(invalidFirm).toMatchObject({ status: 'refused', reasonCode: 'invalid-arguments' })
    expect(invalidLimit).toMatchObject({ status: 'refused', reasonCode: 'invalid-arguments' })
    expect(runtime.getDb).not.toHaveBeenCalled()
    expect(runtime.executeApprovedTargetAds).not.toHaveBeenCalled()
    expect(JSON.parse(logs[0])).not.toHaveProperty('error')
    expect(JSON.parse(logs[1])).not.toHaveProperty('error')
  })

  it('maps an undefined target table to a safe skip/refusal without exposing the error body', async () => {
    const databaseError = Object.assign(new Error('secret connection details'), { code: '42P01' })
    const execute = vi.fn<ExecuteService>(async () => { throw databaseError })
    const logs: string[] = []

    const result = await main({
      env: {},
      argv: [],
      getDb: async () => fakeDb,
      executeApprovedTargetAds: execute,
      log: (message) => logs.push(message),
    })

    expect(result).toMatchObject({ status: 'skipped', reasonCode: 'target-schema-missing' })
    expect(logs[0]).not.toContain('secret connection details')
    expect(JSON.parse(logs[0])).toMatchObject({ reasonCode: 'target-schema-missing' })

    const liveLogs: string[] = []
    const live = await main({
      env: { ENGINE_LIVE: '1', TARGET_AD_AUTOMATION: '1' },
      argv: ['--live'],
      getDb: async () => fakeDb,
      executeApprovedTargetAds: execute,
      log: (message) => liveLogs.push(message),
    })
    expect(live).toMatchObject({ status: 'refused', mode: 'live', reasonCode: 'target-schema-missing' })
    expect(liveLogs[0]).not.toContain('secret connection details')
  })

  it('returns only an error code when the execution service fails and preserves failure counts', async () => {
    const execute = vi.fn<ExecuteService>(async () => { throw new Error('apiKey=do-not-print') })
    const logs: string[] = []
    const result = await main({
      env: {},
      argv: [],
      getDb: async () => fakeDb,
      executeApprovedTargetAds: execute,
      log: (message) => logs.push(message),
    })

    expect(result).toMatchObject({ status: 'failed', failed: 1, reasonCode: 'execution-error' })
    expect(logs[0]).not.toContain('apiKey=do-not-print')
    expect(JSON.parse(logs[0])).toMatchObject({ status: 'failed', failed: 1, reasonCode: 'execution-error' })
  })
})
