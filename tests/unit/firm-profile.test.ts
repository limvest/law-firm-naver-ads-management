import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { firmCaseResults, firmKeywords, firms, keywords } from '@/lib/db/schema'
import { clearFirmCache, DEFAULT_FIRM, DEMO_FIRM, type Firm } from '@/lib/engine/firms'
import { resolveFirmForSubmission, resolvePublicFirm } from '@/lib/engine/public-firm'
import {
  addCaseResultForFirm,
  addLawyerForFirm,
  caseResultsForFirm,
  saveFirmProfileForFirm,
  setCaseResultPublishedForFirm,
} from '@/lib/dashboard/firm-profile'
import { firmProfileResponse } from '@/lib/engine/firm-profile-route'

function firm(id = 2): Firm {
  return {
    id, slug: 'demo', name: '법률사무소 데모', adLawyerName: '김데모',
    phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: '데모로 1',
    addressRegion: '서울', addressLocality: '서초구', kakaoUrl: null, domain: null,
    status: 'active', lawyers: [], wordmark: 'DEMO', landingReady: false,
    dashboardToken: 'demo-token', siteTemplate: 'case-brief', profileIntro: null,
    officeHistory: null, adConfig: null,
  }
}

describe('법률사무소 공개 프로필 DB', () => {
  afterEach(() => {
    setDbForTesting(null)
    clearFirmCache()
    delete process.env.DATABASE_URL
  })

  it('사무소 소개·변호사 이력·사건 수행내역을 firm별로 저장하고 공개 항목만 조회한다', async () => {
    const db = await createTestDb()
    const f = firm()
    await db.insert(firms).values(f)
    expect(await saveFirmProfileForFirm(db, f, { intro: '직접 검토합니다.', history: '2025 대응팀 운영\n2026 상담 체계 개편' })).toBe(true)
    expect(await addLawyerForFirm(db, f, {
      name: '김데모 변호사', title: '대표변호사', photo: '', bio: '증거를 검토합니다.',
      badges: '금융사기', career: '피해자 상담\n민사 절차 검토', education: '', practiceAreas: '금융사기, 손해배상',
    })).toBe(true)
    expect(await addCaseResultForFirm(db, f, {
      category: '투자리딩방', title: '추가입금 요구 사건', summary: '송금 자료를 정리했습니다.',
      outcome: '추가입금을 중단하고 신고 절차를 검토했습니다.', handledAt: '2026.08', published: false,
    })).toBe(true)

    const [savedFirm] = await db.select().from(firms)
    expect(savedFirm.profileIntro).toBe('직접 검토합니다.')
    expect(savedFirm.officeHistory).toEqual(['2025 대응팀 운영', '2026 상담 체계 개편'])
    expect(savedFirm.lawyers?.[0].career).toEqual(['피해자 상담', '민사 절차 검토'])
    expect(await caseResultsForFirm(db, f.id, true)).toHaveLength(0)

    const [result] = await db.select().from(firmCaseResults)
    await setCaseResultPublishedForFirm(db, f, result.id, true)
    expect(await caseResultsForFirm(db, f.id, true)).toHaveLength(1)
  })

  it('공개 변호사·수행내역 페이지는 DB 내용, 내부링크, preview 색인 차단을 함께 렌더한다', async () => {
    const db = await createTestDb()
    const f = { ...firm(), lawyers: [{ name: '김데모 변호사', title: '대표변호사', photo: null, badges: ['금융사기'], career: ['피해자 상담'], practiceAreas: ['손해배상'] }] }
    await db.insert(firms).values(f)
    await db.insert(firmCaseResults).values({
      firmId: f.id, category: '리딩방', title: '출금거절 대응', summary: '대화와 이체내역을 정리했습니다.',
      outcome: '증거보전과 신고 절차를 검토했습니다.', published: true,
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const lawyers = await firmProfileResponse(new Request('https://x.kr/lawyers?preview=1&firm=demo', { headers: { host: 'x.kr' } }), 'lawyers')
    const lawyerHtml = await lawyers.text()
    expect(lawyerHtml).toContain('김데모 변호사')
    expect(lawyerHtml).toContain('피해자 상담')
    expect(lawyerHtml).toContain('/results?preview=1&amp;firm=demo')
    expect(lawyers.headers.get('X-Robots-Tag')).toContain('noindex')

    const results = await firmProfileResponse(new Request('https://x.kr/results?preview=1&firm=demo', { headers: { host: 'x.kr' } }), 'results')
    const resultHtml = await results.text()
    expect(resultHtml).toContain('출금거절 대응')
    expect(resultHtml).toContain('증거보전과 신고 절차')
    expect(resultHtml).toContain('동일한 결과를 보장하지 않습니다')
  })

  it('DB 없이도 preview=1&firm=demo는 결정적 데모 프로필을 사용한다', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL
    delete process.env.DATABASE_URL

    try {
      expect(await resolvePublicFirm(null, 'lawfirm-ads.vercel.app', 'demo')).toBe(DEMO_FIRM)

      const response = await firmProfileResponse(
        new Request('https://lawfirm-ads.vercel.app/lawyers?preview=1&firm=demo', {
          headers: { host: 'lawfirm-ads.vercel.app' },
        }),
        'lawyers',
      )
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('법률사무소 데모')
      expect(html).toContain('김데모')
      expect(html).not.toContain(DEFAULT_FIRM.name)
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = originalDatabaseUrl
    }
  })

  it('DB 없이 demo 외 preview slug는 데모 tenant로 승격되지 않는다', async () => {
    expect(await resolvePublicFirm(null, 'lawfirm-ads.vercel.app', 'other-tenant')).toBe(DEFAULT_FIRM)
  })

  it('DB에 paused demo가 있으면 DB-free fixture가 paused tenant 정책을 우회하지 않는다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({ ...firm(), status: 'paused' })

    expect(await resolvePublicFirm(db, 'lawfirm-ads.vercel.app', 'demo')).toBe(DEFAULT_FIRM)
  })

  it('사건명 서브도메인의 문의·방문 추적은 샘플원 DB firm으로 귀속한다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      ...firm(42), slug: 'sampleone', name: '법무법인 샘플원', domain: 'sampleone.attorney', landingReady: true,
    })
    const [keyword] = await db.insert(keywords).values({
      firmId: 42, name: '가상샵A', normalizedName: '가상샵A', slug: 'mockshopa-case',
      scamType: 'other', status: 'published',
    }).returning()
    await db.insert(firmKeywords).values({
      firmId: 42, keywordId: keyword.id, publicHostLabel: 'mockshopa-case', hostStatus: 'public',
    })
    const resolved = await resolveFirmForSubmission(
      db,
      new Request('https://mockshopa-case.sampleone.attorney/api/engagement', { headers: { host: 'mockshopa-case.sampleone.attorney' } }),
    )
    expect(resolved.id).toBe(42)
    expect(resolved.slug).toBe('sampleone')
  })

  it('미등록 Host의 문의는 기본 firm으로 폴백하지 않는다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values(firm(42))
    await expect(resolveFirmForSubmission(
      db,
      new Request('https://attacker.invalid/api/leads', { headers: { host: 'attacker.invalid' } }),
    )).rejects.toThrow('unrecognized intake host')
  })
})
