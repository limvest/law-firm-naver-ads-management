import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { firms } from '@/lib/db/schema'
import {
  listSourceRequestsForFirm,
  listSourceRequestsForOperator,
  normalizeSourceRequestUrl,
  reviewSourceRequest,
  submitSourceRequestForFirm,
} from '@/lib/dashboard/source-requests'

async function seedFirms(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values([2, 3].map((id) => ({
    id, slug: `source-firm-${id}`, name: `법률사무소 ${id}`, adLawyerName: '김변호',
    phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: '주소',
    addressRegion: '서울', addressLocality: '서초구',
  })))
}

describe('source collection request queue', () => {
  it('normalizes only safe HTTP(S) URLs without fetching them', () => {
    expect(normalizeSourceRequestUrl(' https://Example.com/board?q=1#section ')).toBe('https://example.com/board?q=1')
    expect(normalizeSourceRequestUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeSourceRequestUrl('https://user:secret@example.com/')).toBeNull()
    expect(normalizeSourceRequestUrl(`https://example.com/${'가'.repeat(2_048)}`)).toBeNull()
  })

  it('keeps requests firm-scoped, idempotent per firm, and operator-reviewable', async () => {
    const db = await createTestDb()
    await seedFirms(db)

    expect(await submitSourceRequestForFirm(db, { id: 2 }, 'https://example.com/board#one')).toBe('created')
    expect(await submitSourceRequestForFirm(db, { id: 2 }, 'https://example.com/board#two')).toBe('duplicate')
    expect(await submitSourceRequestForFirm(db, { id: 3 }, 'https://example.com/board')).toBe('created')
    expect(await submitSourceRequestForFirm(db, { id: 2 }, 'javascript:alert(1)')).toBe('invalid')

    const firm2 = await listSourceRequestsForFirm(db, { id: 2 })
    const firm3 = await listSourceRequestsForFirm(db, { id: 3 })
    expect(firm2).toHaveLength(1)
    expect(firm3).toHaveLength(1)
    expect(firm2[0].sourceUrl).toBe('https://example.com/board')

    const operator = await listSourceRequestsForOperator(db)
    expect(operator).toHaveLength(2)
    expect(operator.map((row) => row.firmName).sort()).toEqual(['법률사무소 2', '법률사무소 3'])

    expect(await reviewSourceRequest(db, { id: firm2[0].id, status: 'registered', operatorNote: 'sitemap으로 등록' })).toBe(true)
    expect(await reviewSourceRequest(db, { id: firm2[0].id, status: 'rejected' })).toBe(false)
    const [reviewed] = await listSourceRequestsForFirm(db, { id: 2 })
    expect(reviewed.status).toBe('registered')
    expect(reviewed.operatorNote).toBe('sitemap으로 등록')
    expect(reviewed.reviewedAt).toBeInstanceOf(Date)
  })
})
