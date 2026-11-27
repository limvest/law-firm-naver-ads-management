import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms } from '@/lib/db/schema'
import { DEFAULT_FIRM, type Firm } from '@/lib/engine/firms'
import { saveSiteTemplateForFirm } from '@/lib/dashboard/site-settings'

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number, slug: string) {
  await db.insert(firms).values({
    id, slug, name: `법률사무소 ${slug}`, adLawyerName: '김변호',
    phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: '테스트로 1',
    addressRegion: '서울', addressLocality: '서초구', dashboardToken: `token-${slug}`,
  })
}

describe('고객 웹사이트 형식 저장', () => {
  it('허용된 형식을 해당 firm에만 저장한다', async () => {
    const db = await createTestDb()
    await seedFirm(db, 201, 'alpha')
    await seedFirm(db, 202, 'beta')
    const firm: Firm = { ...DEFAULT_FIRM, id: 201, slug: 'alpha', siteTemplate: 'response-room' }

    const result = await saveSiteTemplateForFirm(db, firm, 'counsel-note')
    expect(result).toEqual({ ok: true, template: 'counsel-note' })
    const [alpha] = await db.select().from(firms).where(eq(firms.id, 201))
    const [beta] = await db.select().from(firms).where(eq(firms.id, 202))
    expect(alpha.siteTemplate).toBe('counsel-note')
    expect(beta.siteTemplate).toBe('response-room')
  })

  it('알 수 없는 형식은 저장하지 않는다', async () => {
    const db = await createTestDb()
    await seedFirm(db, 203, 'gamma')
    const firm: Firm = { ...DEFAULT_FIRM, id: 203, slug: 'gamma' }

    const result = await saveSiteTemplateForFirm(db, firm, 'copied-competitor-theme')
    expect(result).toEqual({ ok: false, error: 'invalid-template' })
    const [row] = await db.select().from(firms).where(eq(firms.id, 203))
    expect(row.siteTemplate).toBe('response-room')
  })
})
