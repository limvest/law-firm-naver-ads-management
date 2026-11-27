import { describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firmAccounts, firms, firmKeywords, keywords } from '@/lib/db/schema'
import { firmIdFromSlug, firmPublicReadinessErrors, listProvisionedFirms, provisionFirm, setFirmPublicReady, validateProvisionInput } from '@/lib/engine/provision'

const input = {
  slug: 'new-law', name: '법률사무소 신규', adLawyerName: '김변호',
  phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000',
  address: '서초대로 1', addressRegion: '서울특별시', addressLocality: '서초구',
  kakaoUrl: null, domain: 'new-law.example.com', status: 'pilot', lawyers: [],
  wordmark: 'NEW LAW', siteTemplate: 'case-brief' as const, adConfig: null,
  loginId: 'new-law', password: '0000',
}

describe('총운영자 원클릭 사무소 개설', () => {
  it('입력 유효성을 검사한다', () => {
    expect(validateProvisionInput(input)).toEqual([])
    expect(validateProvisionInput({ ...input, slug: '잘못된 슬러그', domain: 'bad domain' })).toEqual(expect.arrayContaining(['slug', 'domain']))
    expect(firmIdFromSlug('new-law')).toBe(firmIdFromSlug('new-law'))
    expect(firmIdFromSlug('new-law')).toBeGreaterThanOrEqual(10_000)
  })

  it('firm·ID 로그인·공개 키워드 전량을 한 흐름으로 만든다', async () => {
    const db = await createTestDb()
    await db.insert(keywords).values([
      { name: '사건A', slug: 'provision-a', scamType: 'coin', status: 'published' },
      { name: '사건B', slug: 'provision-b', scamType: 'leading', status: 'published' },
      { name: '미공개', slug: 'provision-c', scamType: 'coin', status: 'discovered' },
    ])
    const result = await provisionFirm(db, input)
    expect(result.firmId).toBe(firmIdFromSlug('new-law'))
    expect(result.enrolledKeywords).toBe(2)
    expect(result.dashboardPath).toBe('/workspace')
    expect(result.loginId).toBe('new-law')
    expect(result.previewPath).toContain('firm=new-law')
    expect(result.publicReady).toBe(false)

    const [firm] = await db.select().from(firms).where(eq(firms.id, result.firmId))
    expect(firm.siteTemplate).toBe('case-brief')
    expect(firm.landingReady).toBe(false)
    expect(await db.select().from(firmAccounts)).toHaveLength(1)
    expect(await db.select().from(firmKeywords)).toHaveLength(2)

    const second = await provisionFirm(db, { ...input, name: '법률사무소 신규(정보 갱신)' })
    expect(second.firmId).toBe(result.firmId)
    expect(second.loginId).toBe(result.loginId)
    expect(second.enrolledKeywords).toBe(0)
    expect(await db.select().from(firmKeywords)).toHaveLength(2)
  })

  it('사건명 편입 중 실패하면 신규 firm까지 전부 rollback한다', async () => {
    const db = await createTestDb()
    await db.insert(keywords).values({ name: 'rollback 사건', slug: 'provision-rollback', scamType: 'coin', status: 'published' })
    const id = firmIdFromSlug(input.slug)
    await db.execute(sql.raw(`alter table firm_keywords add constraint reject_provision_firm check (firm_id <> ${id})`))

    await expect(provisionFirm(db, input)).rejects.toThrow()
    expect(await db.select().from(firms).where(eq(firms.id, id))).toHaveLength(0)
    expect(await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, id))).toHaveLength(0)
  })

  it('안정 ID가 다른 firm에 이미 배정된 경우 기존 고객을 덮어쓰지 않는다', async () => {
    const db = await createTestDb()
    const id = firmIdFromSlug(input.slug)
    await db.insert(firms).values({
      id, slug: 'id-owner', name: '기존 법률사무소', adLawyerName: '이변호',
      phone: '1', phoneIntl: '1', address: '기존 주소', addressRegion: '서울', addressLocality: '강남구',
    })
    await expect(provisionFirm(db, input)).rejects.toThrow('firm id collision')
    const [owner] = await db.select().from(firms).where(eq(firms.id, id))
    expect(owner.slug).toBe('id-owner')
    expect(owner.name).toBe('기존 법률사무소')
  })

  it('실제 도메인·소개·변호사 이력이 준비된 고객만 공개한다', async () => {
    const db = await createTestDb()
    const created = await provisionFirm(db, input)
    const [incomplete] = await db.select().from(firms).where(eq(firms.id, created.firmId))
    expect(firmPublicReadinessErrors(incomplete)).toEqual(expect.arrayContaining(['사무소 소개', '변호사']))
    await expect(setFirmPublicReady(db, created.firmId, true)).rejects.toThrow('firm not ready')

    await db.update(firms).set({
      profileIntro: '사건 기록과 증거를 검토합니다.',
      lawyers: [{ name: '김변호', title: '대표변호사', badges: [], photo: null, career: ['법률사무소 신규 대표변호사'] }],
    }).where(eq(firms.id, created.firmId))
    const published = await setFirmPublicReady(db, created.firmId, true)
    expect(published.landingReady).toBe(true)
    expect(published.status).toBe('active')

    const stopped = await setFirmPublicReady(db, created.firmId, false)
    expect(stopped.landingReady).toBe(false)
    expect(stopped.status).toBe('pilot')
  })

  it('운영 고객 목록에서 내부·데모 테넌트를 제외한다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      { id: 2, slug: 'demo', name: '법률사무소 데모', adLawyerName: '데모', phone: '1', phoneIntl: '1', address: 'a', addressRegion: 'a', addressLocality: 'a' },
      { id: 3, slug: 'platform', name: '운영팀', adLawyerName: '운영', phone: '1', phoneIntl: '1', address: 'a', addressRegion: 'a', addressLocality: 'a', status: 'internal' },
      { id: 4, slug: 'real-law', name: '실고객', adLawyerName: '김변호', phone: '1', phoneIntl: '1', address: 'a', addressRegion: 'a', addressLocality: 'a' },
    ])
    expect((await listProvisionedFirms(db)).map((firm) => firm.slug)).toEqual(['real-law'])
  })
})
