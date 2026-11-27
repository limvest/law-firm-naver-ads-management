import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { caseEntities, contentAssets, firmDomains, firms, publications } from '@/lib/db/schema'
import { GET as getCase } from '../../app/case/[slug]/route'
import { GET as getResponse } from '../../app/response/[slug]/route'

const SLUG = 'shared-case'
const PASSING_QUALITY = {
  evidenceReady: true,
  placeholderFree: true,
  linksReady: true,
  brandReady: true,
  complianceReady: true,
  uniqueFacts: 3,
  issues: [],
}

async function seedTargetDb() {
  const db = await createTestDb()
  const [alpha, beta] = await db.insert(firms).values([
    {
      id: 61,
      slug: 'alpha-firm',
      name: '알파 법률사무소',
      adLawyerName: '김알파',
      phone: '02-1111-1111',
      phoneIntl: '+82-2-1111-1111',
      address: '서울시 알파구 알파로 1',
      addressRegion: '서울',
      addressLocality: '알파구',
      kakaoUrl: 'https://pf.kakao.com/alpha',
      domain: 'alpha.example',
      domainAliases: ['alias.alpha.example'],
      status: 'active',
      landingReady: true,
    },
    {
      id: 62,
      slug: 'beta-firm',
      name: '베타 법률사무소',
      adLawyerName: '이베타',
      phone: '02-2222-2222',
      phoneIntl: '+82-2-2222-2222',
      address: '서울시 베타구 베타로 2',
      addressRegion: '서울',
      addressLocality: '베타구',
      kakaoUrl: 'https://pf.kakao.com/beta',
      domain: 'beta.example',
      status: 'active',
      landingReady: true,
    },
  ]).returning()
  const [caseEntity] = await db.insert(caseEntities).values({
    canonicalName: '공유 사건',
    slug: SLUG,
    category: 'coin',
    status: 'approved',
  }).returning()

  const assets = await db.insert(contentAssets).values([
    {
      firmId: alpha.id,
      caseEntityId: caseEntity.id,
      assetType: 'seo_page',
      status: 'published',
      templateVersion: 'seo-v1',
      contentVersion: 1,
      content: {
        assetType: 'seo_page',
        caseName: caseEntity.canonicalName,
        title: '알파의 공유 사건 정보',
        description: '알파 법률사무소가 보관한 사건 관측과 대응 자료입니다.',
        sections: [{ heading: '알파가 확인한 자료', body: '송금 기록과 대화 기록을 함께 확인합니다.' }],
        evidence: { methods: ['출금 지연'], infrastructure: [], amounts: ['300만원'] },
        cta: { label: '알파 상담 요청' },
      },
      qualityReport: PASSING_QUALITY,
    },
    {
      firmId: alpha.id,
      caseEntityId: caseEntity.id,
      assetType: 'ad_landing',
      status: 'published',
      templateVersion: 'ad-v1',
      contentVersion: 1,
      content: {
        assetType: 'ad_landing',
        caseName: caseEntity.canonicalName,
        eyebrow: '알파 상담 안내',
        headline: '알파의 공유 사건 상담',
        subheadline: '현재 남아 있는 기록부터 확인합니다.',
        cta: { primary: '알파 상담 요청' },
      },
      qualityReport: PASSING_QUALITY,
    },
    {
      firmId: beta.id,
      caseEntityId: caseEntity.id,
      assetType: 'seo_page',
      status: 'published',
      templateVersion: 'seo-v1',
      contentVersion: 1,
      content: {
        assetType: 'seo_page',
        caseName: caseEntity.canonicalName,
        title: '베타의 공유 사건 정보',
        description: '베타 법률사무소가 보관한 사건 관측과 대응 자료입니다.',
        sections: [{ heading: '베타가 확인한 자료', body: '베타의 검토 범위를 안내합니다.' }],
        evidence: { methods: ['추가 입금 요구'], infrastructure: [], amounts: [] },
      },
      qualityReport: PASSING_QUALITY,
    },
  ]).returning()

  await db.insert(publications).values([
    {
      firmId: alpha.id,
      contentAssetId: assets[0].id,
      domain: alpha.domain!,
      url: `https://${alpha.domain}/case/${SLUG}`,
      canonicalUrl: `https://${alpha.domain}/case/${SLUG}`,
      indexPolicy: 'index',
      status: 'live',
      deployedVersion: '1',
    },
    {
      firmId: alpha.id,
      contentAssetId: assets[1].id,
      domain: alpha.domain!,
      url: `https://${alpha.domain}/response/${SLUG}`,
      canonicalUrl: `https://${alpha.domain}/response/${SLUG}`,
      indexPolicy: 'noindex',
      status: 'live',
      deployedVersion: '1',
    },
    {
      firmId: beta.id,
      contentAssetId: assets[2].id,
      domain: beta.domain!,
      url: `https://${beta.domain}/case/${SLUG}`,
      canonicalUrl: `https://${beta.domain}/case/${SLUG}`,
      indexPolicy: 'index',
      status: 'live',
      deployedVersion: '1',
    },
  ])

  return { db, alpha, beta, caseEntity, assets }
}

function request(url: string, host: string) {
  return new Request(url, { headers: { host } })
}

describe('target publication runtime routes', () => {
  beforeEach(() => {
    setDbForTesting(null)
  })

  afterEach(() => {
    setDbForTesting(null)
  })

  it('isolates the target asset chain by the Host-resolved firm', async () => {
    const { db } = await seedTargetDb()
    setDbForTesting(db)

    const alphaResponse = await getCase(
      request(`https://alpha.example/case/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    const alphaHtml = await alphaResponse.text()
    expect(alphaResponse.status).toBe(200)
    expect(alphaResponse.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(alphaHtml).toContain('알파의 공유 사건 정보')
    expect(alphaHtml).toContain('알파 법률사무소')
    expect(alphaHtml).not.toContain('베타의 공유 사건 정보')

    const betaResponse = await getCase(
      request(`https://beta.example/case/${SLUG}`, 'beta.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    const betaHtml = await betaResponse.text()
    expect(betaResponse.status).toBe(200)
    expect(betaHtml).toContain('베타의 공유 사건 정보')
    expect(betaHtml).toContain('베타 법률사무소')
    expect(betaHtml).not.toContain('알파의 공유 사건 정보')
    expect(betaResponse.headers.get('Vary')).toBe('Host')
  })

  it('keeps SEO evidence and ad landing assets on distinct routes', async () => {
    const { db } = await seedTargetDb()
    setDbForTesting(db)

    const seo = await getCase(
      request(`https://alpha.example/case/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    const seoHtml = await seo.text()
    expect(seoHtml).toContain('알파의 공유 사건 정보')
    expect(seoHtml).not.toContain('알파의 공유 사건 상담')

    const ad = await getResponse(
      request(`https://alpha.example/response/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    const adHtml = await ad.text()
    expect(ad.status).toBe(200)
    expect(adHtml).toContain('알파의 공유 사건 상담')
    expect(adHtml).not.toContain('알파의 공유 사건 정보')
  })

  it('renders the JSON API consultation contract with consent, validation, tracking, and no-JS phone fallback', async () => {
    const { db } = await seedTargetDb()
    setDbForTesting(db)

    const response = await getResponse(
      request(`https://alpha.example/response/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    const html = await response.text()

    expect(html).toContain('<form action="/api/leads" method="post"')
    expect(html).toContain('name="slug" value="shared-case"')
    expect(html).toContain('name="firmId" value="61"')
    expect(html).toContain('name="consent" type="checkbox"')
    expect(html).toContain('pattern="0[0-9]{1,2}-?[0-9]{3,4}-?[0-9]{4}"')
    expect(html).toContain("'/api/events'")
    expect(html).toContain("'/api/leads'")
    expect(html).toContain("'page_view','call_click','kakao_click','form_submit'")
    expect(html).toContain('data-track="call_click"')
    expect(html).toContain('data-track="kakao_click"')
    expect(html).toContain('<noscript>')
    expect(html).toContain('href="tel:0211111111"')
    expect(html).toContain('JSON.stringify')
    expect(html).not.toContain('href="#"')
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })

  it('sends firm-scoped event and lead payloads and shows the success state', async () => {
    const { db } = await seedTargetDb()
    setDbForTesting(db)
    const html = await (await getResponse(
      request(`https://alpha.example/response/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )).text()
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', {
          configurable: true,
          value: (path: string, init?: RequestInit) => {
            calls.push({ path, init })
            return Promise.resolve({
              ok: true,
              json: async () => ({ ok: true }),
            })
          },
        })
      },
    })
    try {
      const form = dom.window.document.querySelector('[data-consultation-form]') as HTMLFormElement
      const phone = form.elements.namedItem('phone') as HTMLInputElement
      const consent = form.elements.namedItem('consent') as HTMLInputElement
      phone.value = '010-1234-5678'
      consent.checked = true
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0))

      const payloads = calls
        .filter((call) => call.init?.body)
        .map((call) => JSON.parse(String(call.init?.body)))
      expect(payloads).toEqual(expect.arrayContaining([
        { type: 'page_view', slug: SLUG, firmId: 61, variant: 'ad_landing' },
        {
          vertical: 'scam',
          phone: '010-1234-5678',
          slug: SLUG,
          firmId: 61,
          consent: true,
        },
        { type: 'form_submit', slug: SLUG, firmId: 61, variant: 'ad_landing' },
      ]))
      expect(form.hidden).toBe(true)
      expect((form.parentElement?.querySelector('[data-form-success]') as HTMLElement).hidden).toBe(false)
    } finally {
      dom.window.close()
    }
  })

  it('emits the stored canonical and only indexes a canonical live SEO host', async () => {
    const { db } = await seedTargetDb()
    setDbForTesting(db)

    const canonical = await getCase(
      request(`https://alpha.example/case/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    const canonicalHtml = await canonical.text()
    expect(canonicalHtml).toContain('<link rel="canonical" href="https://alpha.example/case/shared-case">')
    expect(canonical.headers.get('X-Robots-Tag')).toBeNull()
    expect(canonicalHtml).not.toContain('name="robots"')

    const alias = await getCase(
      request(`https://alias.alpha.example/case/${SLUG}`, 'alias.alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(alias.status).toBe(200)
    expect(alias.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    expect(await alias.text()).toContain('href="https://alpha.example/case/shared-case"')

    const preview = await getCase(
      request(`https://alpha.example/case/${SLUG}?preview=1`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')

    const ad = await getResponse(
      request(`https://alpha.example/response/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(ad.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    expect(await ad.text()).toContain('name="robots" content="noindex,nofollow"')
  })

  it('uses an active verified custom canonical domain and rejects the stale or unknown Host', async () => {
    const { db, alpha, assets } = await seedTargetDb()
    const customDomain = 'custom.alpha.example'
    await db.insert(firmDomains).values({
      firmId: alpha.id,
      hostname: customDomain,
      isCanonical: true,
      status: 'active',
      tlsStatus: 'valid',
    })
    await db.update(firms).set({
      domain: 'legacy.alpha.example',
      domainAliases: ['alias.alpha.example'],
    }).where(eq(firms.id, alpha.id))
    const alphaPublications = await db.select().from(publications).where(eq(publications.firmId, alpha.id))
    for (const publication of alphaPublications) {
      const path = publication.url.split('.example').at(-1) ?? ''
      await db.update(publications).set({
        domain: customDomain,
        url: `https://${customDomain}${path}`,
        canonicalUrl: `https://${customDomain}${path}`,
      }).where(eq(publications.id, publication.id))
    }
    setDbForTesting(db)

    const custom = await getCase(
      request(`https://${customDomain}/case/${SLUG}`, customDomain),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(custom.status).toBe(200)
    expect(await custom.text()).toContain(`href="https://${customDomain}/case/${SLUG}"`)

    const stale = await getCase(
      request(`https://legacy.alpha.example/case/${SLUG}`, 'legacy.alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(stale.status).toBe(404)

    const unknown = await getCase(
      request(`https://unknown.example/case/${SLUG}`, 'unknown.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(unknown.status).toBe(404)

    const alias = await getResponse(
      request(`https://alias.alpha.example/response/${SLUG}`, 'alias.alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(alias.status).toBe(200)
    expect(alias.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    expect((await alias.text())).not.toContain(assets[1].id)
  })

  it('never emits placeholder links, IDs, or incomplete quality content', async () => {
    const { db, assets } = await seedTargetDb()
    setDbForTesting(db)

    const html = await (await getCase(
      request(`https://alpha.example/case/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )).text()
    expect(html).not.toContain('href="#"')
    expect(html).not.toContain('content_assets')
    expect(html).not.toContain('publications')
    expect(html).not.toContain(assets[0].id)
    expect(html).not.toContain('data-firm-id')
    expect(html).not.toContain('data-case-entity-id')
    expect(html).not.toContain('data-content-asset-id')

    await db.update(contentAssets)
      .set({ qualityReport: { ...PASSING_QUALITY, placeholderFree: false } })
      .where(eq(contentAssets.id, assets[0].id))
    const blocked = await getCase(
      request(`https://alpha.example/case/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(blocked.status).toBe(404)
    expect(blocked.headers.get('Vary')).toBe('Host')
  })

  it('escapes content and script configuration without producing executable or placeholder links', async () => {
    const { db, assets } = await seedTargetDb()
    await db.update(contentAssets).set({
      content: {
        assetType: 'seo_page',
        caseName: '공유 사건',
        title: '<img src=x onerror=alert(1)>',
        description: '</script><script>alert(2)</script>',
        sections: [{ heading: '검토', body: '기록을 확인합니다.' }],
        cta: { label: '상담' },
      },
    }).where(eq(contentAssets.id, assets[0].id))
    setDbForTesting(db)

    const html = await (await getCase(
      request(`https://alpha.example/case/${SLUG}`, 'alpha.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )).text()
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('href="#"')
    expect(html).not.toContain('javascript:')
  })

  it('does not let preview bypass a paused firm', async () => {
    const { db } = await seedTargetDb()
    await db.insert(firms).values({
      id: 63,
      slug: 'paused-firm',
      name: '중지 법률사무소',
      adLawyerName: '박중지',
      phone: '02-3333-3333',
      phoneIntl: '+82-2-3333-3333',
      address: '서울시 중지구',
      addressRegion: '서울',
      addressLocality: '중지구',
      domain: 'paused.example',
      status: 'paused',
      landingReady: true,
    })
    setDbForTesting(db)

    const response = await getCase(
      request(`https://paused.example/case/${SLUG}?preview=1`, 'paused.example'),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })
})
