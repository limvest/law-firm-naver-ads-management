import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { caseEntities, contentAssets, firmKeywords, firms, keywords, publications, scamPages } from '@/lib/db/schema'
import { buildSeedContent, SCAM_TYPE_SEEDS } from '@/lib/scam/seed-data'
import { sitemapForFirm } from '../../app/sitemap'
import { DEFAULT_FIRM } from '@/lib/engine/firms'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'

afterEach(() => setDbForTesting(null))

describe('sitemap', () => {
  it('live target SEO publication을 우선하고 같은 사건의 legacy /f 중복을 제외한다', async () => {
    const db = await createTestDb()
    setDbForTesting(db)
    await db.insert(firms).values({
      ...DEFAULT_FIRM,
      lawyers: DEFAULT_FIRM.lawyers,
      landingReady: true,
    })
    await db.insert(keywords).values({ name: 'Canonical Case', slug: 'canonical-case', scamType: 'coin', status: 'published' })
    const [caseEntity] = await db.insert(caseEntities).values({
      canonicalName: 'Canonical Case', slug: 'canonical-case', category: 'coin', status: 'approved',
    }).returning()
    const [asset] = await db.insert(contentAssets).values({
      firmId: DEFAULT_FIRM.id,
      caseEntityId: caseEntity.id,
      assetType: 'seo_page',
      status: 'published',
      templateVersion: 'seo-v1',
      content: {},
    }).returning()
    await db.insert(publications).values({
      firmId: DEFAULT_FIRM.id,
      contentAssetId: asset.id,
      domain: DEFAULT_FIRM.domain!,
      url: `https://${DEFAULT_FIRM.domain}/case/canonical-case`,
      canonicalUrl: `https://${DEFAULT_FIRM.domain}/case/canonical-case`,
      indexPolicy: 'index',
      status: 'live',
    })

    const urls = (await sitemapForFirm(DEFAULT_FIRM)).map((entry) => entry.url)
    expect(urls).toContain(`https://${DEFAULT_FIRM.domain}/case/canonical-case`)
    expect(urls).not.toContain(`https://${DEFAULT_FIRM.domain}/f/canonical-case`)
    expect(urls.some((url) => url.includes('/response/'))).toBe(false)
  })

  it('정적 라우트 + published scam slug 포함', async () => {
    const db = await createTestDb()
    setDbForTesting(db)
    const [k] = await db.insert(keywords).values({ name: 'x 사기', slug: 'x-type', scamType: 't', status: 'published' }).returning()
    await db.insert(scamPages).values({ keywordId: k.id, content: buildSeedContent(SCAM_TYPE_SEEDS[0]), lintPassed: true })
    const entries = await sitemapForFirm(DEFAULT_FIRM)
    const urls = entries.map((e) => e.url)
    expect(urls.some((u) => u.endsWith('/f/x-type'))).toBe(true)
    expect(urls.some((u) => u.includes('/scam/x-type'))).toBe(false)
    expect(urls.some((u) => u.endsWith('/f/type/coin'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/about'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/members'))).toBe(true)
  })
  it('DB 실패 시 정적 라우트만 반환 (빌드 불사)', async () => {
    setDbForTesting(null)
    delete process.env.DATABASE_URL
    const entries = await sitemapForFirm(DEFAULT_FIRM)
    expect(entries.length).toBeGreaterThanOrEqual(7)
  })
  it('제품 호스트 sitemap에는 고객 사건 URL을 섞지 않는다', async () => {
    const entries = await sitemapForFirm(null)
    expect(entries).toHaveLength(1)
    expect(entries[0].url).toContain('lawfirm-ads')
  })

  it('샘플원 루트 sitemap은 사건 목록을 노출하지 않고 홈·개인정보만 포함한다', async () => {
    setDbForTesting(null)
    delete process.env.DATABASE_URL
    const entries = await sitemapForFirm(SAMPLEONE_LOCAL_PREVIEW_FIRM)
    const urls = entries.map((entry) => entry.url)
    expect(urls).toEqual([
      'https://sampleone.attorney',
      'https://sampleone.attorney/privacy',
    ])
  })

  it('샘플원 핀테크 sitemap은 허브만 포함하고 DB 사건 slug를 열거하지 않는다', async () => {
    const db = await createTestDb()
    setDbForTesting(db)
    await db.insert(firms).values({
      id: SAMPLEONE_LOCAL_PREVIEW_FIRM.id,
      slug: 'sampleone', name: '법무법인 샘플원', adLawyerName: '정오번',
      phone: '010-0000-0009', phoneIntl: '+82-10-0000-0009', address: '서울',
      addressRegion: '서울', addressLocality: '서초구', domain: 'sampleone.attorney',
    })
    const inserted = await db.insert(keywords).values([
      { name: '첫 사건', slug: 'case-000b457fe6', scamType: 'other', status: 'published' },
      { name: '둘 사건', slug: 'case-000cb07dab', scamType: 'other', status: 'published' },
    ]).returning()
    await db.insert(firmKeywords).values(inserted.map((keyword) => ({
      firmId: SAMPLEONE_LOCAL_PREVIEW_FIRM.id,
      keywordId: keyword.id,
    })))
    const urls = (await sitemapForFirm(SAMPLEONE_LOCAL_PREVIEW_FIRM, true)).map((entry) => entry.url)
    expect(urls).toEqual([
      'https://fintech.sampleone.attorney',
      'https://fintech.sampleone.attorney/fraud',
    ])
    expect(urls.some((url) => url.includes('/fraud/'))).toBe(false)
    expect(urls.some((url) => url.includes('/f/'))).toBe(false)
  })
})
