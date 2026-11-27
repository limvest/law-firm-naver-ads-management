import { describe, expect, it } from 'vitest'
import { centralCaseTrackingCounts } from '@/lib/engine/firm-home-data'

describe('피해자 센터 중앙 DB 수치', () => {
  it('DB 사건 수와 관측이 연결된 추적 사건 수를 그대로 반환한다', async () => {
    const db = {
      execute: async () => ({ rows: [{ case_count: '27541', tracked_case_count: '27526' }] }),
    }
    await expect(centralCaseTrackingCounts(db as never)).resolves.toEqual({
      caseCount: 27_541,
      trackedCaseCount: 27_526,
    })
  })
})
