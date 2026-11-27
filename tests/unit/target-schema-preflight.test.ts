import { describe, expect, it, vi } from 'vitest'
import {
  assertTargetSchema,
  REQUIRED_TARGET_TABLES,
} from '../../scripts/agent/assert-target-schema'

describe('target schema daily preflight', () => {
  it('probes every required target table before reporting ready', async () => {
    const probe = vi.fn(async () => undefined)
    const log = vi.fn()
    await expect(assertTargetSchema({ env: {}, probe, log })).resolves.toEqual({
      status: 'ready',
      tables: REQUIRED_TARGET_TABLES.length,
    })
    expect(probe.mock.calls.map(([table]) => table)).toEqual([...REQUIRED_TARGET_TABLES])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"status":"ready"'))
  })

  it('fails closed on the first unavailable relation', async () => {
    const probe = vi.fn(async (table: string) => {
      if (table === 'publications') throw Object.assign(new Error('missing relation'), { code: '42P01' })
    })
    await expect(assertTargetSchema({ env: {}, probe, log: vi.fn() })).rejects.toMatchObject({ code: '42P01' })
    expect(probe).not.toHaveBeenCalledWith('ad_accounts')
  })

  it('requires a database for the real command path', async () => {
    await expect(assertTargetSchema({ env: {}, log: vi.fn() })).rejects.toThrow('database-required')
  })
})
