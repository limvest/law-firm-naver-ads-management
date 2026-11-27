import { describe, expect, it, vi } from 'vitest'
import { enforceSampleoneAdHours, shouldSampleoneAdsRun } from '@/lib/engine/naver/ad-hours'

function seoul(value: string): Date {
  return new Date(value)
}

describe('Sampleone Naver ad hours', () => {
  it('runs only on weekdays from 08:00 through 21:59 KST', () => {
    expect(shouldSampleoneAdsRun(seoul('2026-09-07T07:59:59+09:00'))).toBe(false)
    expect(shouldSampleoneAdsRun(seoul('2026-09-07T08:00:00+09:00'))).toBe(true)
    expect(shouldSampleoneAdsRun(seoul('2026-09-07T21:59:59+09:00'))).toBe(true)
    expect(shouldSampleoneAdsRun(seoul('2026-09-07T22:00:00+09:00'))).toBe(false)
    expect(shouldSampleoneAdsRun(seoul('2026-09-06T12:00:00+09:00'))).toBe(false)
  })

  it('updates every non-deleted group in the campaign regardless of its name or count', async () => {
    const groups = [
      { nccAdgroupId: 'grp-1', nccCampaignId: 'cmp-1', name: '샘플원_사건명_01', status: 'ELIGIBLE', userLock: true },
      { nccAdgroupId: 'grp-2', nccCampaignId: 'cmp-1', name: '심사중_분리그룹', status: 'ELIGIBLE', userLock: false },
      { nccAdgroupId: 'grp-3', nccCampaignId: 'cmp-1', name: '향후_추가그룹', status: 'PAUSED', userLock: true },
      { nccAdgroupId: 'grp-4', nccCampaignId: 'cmp-1', name: '삭제그룹', status: 'DELETED', userLock: true },
    ]
    let reads = 0
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, unknown> }) => {
      if (path === '/ncc/campaigns') return [{ nccCampaignId: 'cmp-1', name: '파워링크#1' }]
      if (path === '/ncc/adgroups') {
        reads++
        return groups
      }
      if (method === 'PUT') {
        const id = path.split('/').pop()
        const group = groups.find((row) => row.nccAdgroupId === id)!
        group.userLock = Boolean(options?.body?.userLock)
        return group
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const result = await enforceSampleoneAdHours(
      { request } as never,
      seoul('2026-09-07T09:00:00+09:00'),
      0,
    )
    expect(result).toEqual({ active: true, groups: 3, changed: 2 })
    expect(groups[3].userLock).toBe(true)
    expect(reads).toBe(2)
  })
})
