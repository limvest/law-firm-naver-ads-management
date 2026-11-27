import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import type { Db } from '@/lib/db/client'
import { engagementSessions, firms } from '@/lib/db/schema'
import { leadEngagementContext } from '@/lib/leads/engagement-context'

let db: Db

beforeEach(async () => { db = await createTestDb() })

describe('leadEngagementContext', () => {
  it('문의의 firm·sid·slug와 일치하는 관심도만 반환한다', async () => {
    await db.insert(firms).values({ id: 1, slug: 'test', name: '테스트', adLawyerName: '김', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'x', addressLocality: 'x', status: 'active' })
    await db.insert(engagementSessions).values({
      firmId: 1, sessionId: 'session-a', slug: 'mockshopa', activeSeconds: 134,
      maxScroll: 87, pageViews: 2, lawyerViewed: true, processViewed: true,
      contactViewed: true, formStarted: true, interestScore: 100, highIntent: true,
    })
    await expect(leadEngagementContext(db, 1, 'session-a', 'mockshopa')).resolves.toMatchObject({
      activeSeconds: 134, maxScroll: 87, pageViews: 2, interestScore: 100, highIntent: true,
    })
    await expect(leadEngagementContext(db, 1, 'different', 'mockshopa')).resolves.toBeNull()
  })
})
