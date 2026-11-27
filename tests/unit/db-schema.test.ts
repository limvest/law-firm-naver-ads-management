import { describe, it, expect } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { leads, events } from '@/lib/db/schema'

describe('db schema', () => {
  it('lead insert/select 라운드트립', async () => {
    const db = await createTestDb()
    const [row] = await db
      .insert(leads)
      .values({
        vertical: 'scam',
        nameEnc: 'enc:name',
        phoneEnc: 'enc:phone',
        utm: { utm_source: 'naver' },
      })
      .returning()
    expect(row.id).toBeTruthy()
    expect(row.firmId).toBe(1)
    expect(row.status).toBe('new')
    expect(row.utm).toEqual({ utm_source: 'naver' })
  })
  it('event insert는 type을 보존한다', async () => {
    const db = await createTestDb()
    const [row] = await db
      .insert(events)
      .values({ type: 'call_click', sessionId: 's1', slug: 'home' })
      .returning()
    expect(row.type).toBe('call_click')
    expect(row.createdAt).toBeInstanceOf(Date)
  })
})
