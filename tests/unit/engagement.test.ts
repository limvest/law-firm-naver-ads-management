import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting, type Db } from '@/lib/db/client'
import { engagementSessions, firms } from '@/lib/db/schema'
import { calculateInterestScore } from '@/lib/tracking/engagement'
import { POST } from '../../app/api/engagement/route'

let db: Db

beforeEach(async () => {
  db = await createTestDb()
  setDbForTesting(db)
  await db.insert(firms).values({
    id: 41, slug: 'engage-firm', name: '샘플원', adLawyerName: '김', phone: '010', phoneIntl: '+82',
    address: '서울', addressRegion: '서울', addressLocality: '서초', domain: 'engage.example', status: 'active',
  })
})

afterEach(() => setDbForTesting(null))

describe('engagement tracking', () => {
  it('관심도 점수를 단조 행동 신호로 계산한다', () => {
    expect(calculateInterestScore({ activeSeconds: 90, maxScroll: 80, pageViews: 2, lawyerViewed: true, processViewed: true, contactViewed: true, formStarted: true })).toBe(100)
    expect(calculateInterestScore({ activeSeconds: 14, maxScroll: 20, pageViews: 1, lawyerViewed: false, processViewed: false, contactViewed: false, formStarted: false })).toBe(0)
  })

  it('같은 세션의 누적값은 최대값·OR로 병합하고 페이지뷰만 증가시킨다', async () => {
    const send = (body: Record<string, unknown>) => POST(new Request('https://engage.example/api/engagement', {
      method: 'POST', headers: {
        host: 'engage.example', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0', cookie: 'sid=session-a',
        'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '203.0.113.9',
      }, body: JSON.stringify({ slug: 'mockshopa', ...body }),
    }))
    expect((await send({ activeSeconds: 20, maxScroll: 30, pageView: true })).status).toBe(204)
    expect((await send({ activeSeconds: 95, maxScroll: 80, contactViewed: true, formStarted: true })).status).toBe(204)
    expect((await send({ activeSeconds: 0, maxScroll: 0, pageView: true })).status).toBe(204)
    const [row] = await db.select().from(engagementSessions)
    expect(row).toMatchObject({ firmId: 41, slug: 'mockshopa', activeSeconds: 95, maxScroll: 80, pageViews: 2, contactViewed: true, formStarted: true, highIntent: true, ipAddress: '198.51.100.9' })
  })
})
