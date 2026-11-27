import { describe, it, expect } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { firms } from '@/lib/db/schema'
import { resolveFirmByToken } from '@/lib/dashboard/auth'

describe('resolveFirmByToken', () => {
  it('매칭 firm 반환, 미스매치 null, paused null', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      { id: 2, slug: 'a', name: 'A', adLawyerName: 'x', phone: '1', phoneIntl: '1',
        address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-live', status: 'active' },
      { id: 3, slug: 'b', name: 'B', adLawyerName: 'x', phone: '1', phoneIntl: '1',
        address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-paused', status: 'paused' },
    ])
    expect((await resolveFirmByToken(db, 'tok-live'))?.id).toBe(2)
    expect(await resolveFirmByToken(db, 'nope')).toBe(null)
    expect(await resolveFirmByToken(db, 'tok-paused')).toBe(null)
  })
})
