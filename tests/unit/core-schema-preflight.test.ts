import { describe, expect, it, vi } from 'vitest'
import { assertCoreSchema, REQUIRED_CORE_TABLES } from '../../scripts/agent/assert-core-schema'

describe('unified core schema preflight', () => {
  it('checks only the tables used by the live collection-to-page flow', async () => {
    const probe = vi.fn().mockResolvedValue(undefined)
    const result = await assertCoreSchema({ env: {}, probe, log: () => undefined })
    expect(result).toEqual({ status: 'ready', tables: REQUIRED_CORE_TABLES.length })
    expect(probe.mock.calls.map(([table]) => table)).toEqual([...REQUIRED_CORE_TABLES])
    expect(REQUIRED_CORE_TABLES).toContain('keywords')
    expect(REQUIRED_CORE_TABLES).toContain('observations')
    expect(REQUIRED_CORE_TABLES).toContain('scam_pages')
    expect(REQUIRED_CORE_TABLES).toContain('agent_action_proposals')
    expect(REQUIRED_CORE_TABLES).not.toContain('case_entities')
    expect(REQUIRED_CORE_TABLES).not.toContain('content_assets')
    expect(REQUIRED_CORE_TABLES).not.toContain('publications')
  })
})
