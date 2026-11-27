import { describe, it, expect, afterEach } from 'vitest'
import { FRAUD_CINEMA_TEMPLATE } from '@/templates/fraud-cinema'
import {
  renderFirmBlocks, RAIL_IMG_LITERAL, TICKER_KIMCHANG_LITERAL,
  LFAN_ARIA_LITERAL, DL_FACT_CLAIM_LITERALS,
} from '@/lib/engine/firm-render'
import { DEFAULT_FIRM, type Firm } from '@/lib/engine/firms'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { SCAM_TYPE_SEEDS } from '@/lib/scam/seed-data'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { firmKeywords, firms, keywords, observations, scamPages } from '@/lib/db/schema'
import { GET } from '../../app/f/[slug]/route'

const MARKERS = ['LFAN', 'LCARDS', 'LAWJS', 'CRED', 'FOOTER'] as const

describe('production placeholder fallbacks', () => {
  it('비기본 firm은 02 FACTS를 자체 관측 건수 전용으로 유지하고 카카오 URL은 렌더 시 주입한다', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, { ...DEMO, kakaoUrl: 'https://pf.kakao.com/demo' })
    expect(out).not.toContain('—건')
    expect(out).not.toContain('{경찰청 범죄통계 · 연도}')
    expect(out).not.toContain('{성명 — 발주자 확정 필요}')
    expect(out).not.toContain('href="#"')
    expect(out).toContain('해당 사건과 관련된 피해접수기록')
    expect(out).toContain('계속 증가 중입니다.')
    expect(out).toContain('<span id="fnum">0</span><span class="unit">건</span>')
    expect(out).not.toContain('수집 채널')
    expect(out).not.toContain('sourceBreakdown.map')
    expect(out).toContain('광고책임변호사 김데모')
    expect(out).toContain('id="lfkko" href="https://pf.kakao.com/demo"')
    expect(out).toContain('const KAKAO_URL="https://pf.kakao.com/demo";')
    expect(out).toContain('href="https://sampleone.attorney/privacy"')
  })
})

describe('firm 마커 블록', () => {
  it('마커 쌍 5개가 각 1회씩 존재', () => {
    for (const m of MARKERS) {
      expect(FRAUD_CINEMA_TEMPLATE.split(`<!--FIRM:${m}-->`).length - 1).toBe(1)
      expect(FRAUD_CINEMA_TEMPLATE.split(`<!--/FIRM:${m}-->`).length - 1).toBe(1)
    }
  })
  it('마커가 감싸는 내용에 실자산이 들어 있다 (감쌈 범위 검증)', () => {
    const block = (m: string) =>
      FRAUD_CINEMA_TEMPLATE.split(`<!--FIRM:${m}-->`)[1].split(`<!--/FIRM:${m}-->`)[0]
    expect(block('LFAN')).toContain('lawyer-lawyera-graded.png')
    expect(block('LCARDS')).toContain('이이번 변호사')
    expect(block('LAWJS')).toContain('const LAW=')
    expect(block('LAWJS')).toContain('const LSUM=')
    expect(block('CRED')).toContain('031-000-0000')
    expect(block('FOOTER')).toContain('000-00-00001')
  })
  // 마커도, applyFirmBranding의 리터럴 목록에도 안 걸리는 리터럴 치환(rail 사진·배너 카피)은
  // fraud-v2 카피가 바뀌면 조용히 no-op될 수 있다 — canary로 원본에 리터럴이 여전히 있는지 직접 검증
  it('canary: RAIL/TICKER 리터럴 치환 대상이 템플릿에 존재 (fraud-v2 카피 변경 감지)', () => {
    expect(FRAUD_CINEMA_TEMPLATE).toContain(RAIL_IMG_LITERAL)
    expect(FRAUD_CINEMA_TEMPLATE).toContain(TICKER_KIMCHANG_LITERAL)
  })
  // 최종 리뷰 F1 — 샘플투 전용 자격·경력 "사실 주장" 리터럴이 (a) 원본 템플릿에는 존재하고(canary,
  // 카피 변경 시 이 로직이 조용히 no-op되는 걸 감지) (b) renderFirmBlocks가 비기본 firm에
  // 재생성한 출력에는 완전히 부재하는지 한 쌍으로 단언한다.
  it('canary+중립화 쌍: 샘플투 고유 자격·경력 주장 문구는 템플릿엔 존재, 비기본 firm 출력엔 부재', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, DEMO)
    for (const claim of DL_FACT_CLAIM_LITERALS) {
      expect(FRAUD_CINEMA_TEMPLATE).toContain(claim)
      expect(out).not.toContain(claim)
    }
  })
  // 최종 리뷰 F6 — #lfan aria-label의 "전담변호사 4인" 인원수 단정도 같은 패턴으로 봉인
  it('canary+중립화 쌍: #lfan aria-label 인원수 단정은 템플릿엔 존재, 비기본 firm 출력엔 부재', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, DEMO)
    expect(FRAUD_CINEMA_TEMPLATE).toContain(LFAN_ARIA_LITERAL)
    expect(out).not.toContain(LFAN_ARIA_LITERAL)
    expect(out).not.toContain('전담변호사 4인')
  })
})

const DEMO: Firm = {
  id: 2, slug: 'demo', name: '법률사무소 데모', adLawyerName: '김데모',
  phone: '02-000-0000', phoneIntl: '+82-2-000-0000', address: '데모로 1', addressRegion: '서울',
  addressLocality: '서초구', kakaoUrl: null, domain: null, status: 'active',
  lawyers: [{ name: '김데모 변호사', title: '대표변호사 (가상 인물)', badges: ['제품 데모용 가상 프로필'], photo: null }],
  wordmark: 'DEMO', landingReady: false, dashboardToken: 'demo-tok', adConfig: null,
}

describe('renderFirmBlocks', () => {
  it('firm 1 → 입력 그대로(===)', () => {
    expect(renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, DEFAULT_FIRM)).toBe(FRAUD_CINEMA_TEMPLATE)
  })
  it('타 firm → 샘플투 실자산 흔적 0 + firm 변호사 렌더 + 금지어 0', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, DEMO)
    for (const trace of ['lawyer-lawyera', 'lawyer-lawyerb', 'lawyer-lawyerc',
      'lawyer-lawyerd', '이이번', '박삼번', '최사번', '대형로펌', 'BIGLAW',
      '000-00-00001', '샘플시']) {
      expect(out).not.toContain(trace)
    }
    expect(out).toContain('김데모 변호사')
    expect(out).toContain('가상 프로필')
    expect(out).toContain('const LAW=')          // LAWJS 재주입 형태 유지 (기존 JS가 소비)
    // 푸터가 firm 자신의 지역·상호로 재생성됐는지 (사업자등록번호는 위에서 부재를 확인)
    expect(out).toContain('서울')
    expect(out).toContain('서초구')
    expect(out).toContain('법률사무소 데모')
    const visible = out.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
    expect(findBannedTerms(visible)).toEqual([])
  })
  it('lawyers 빈 배열 → LCARDS 안내문 + LAW=[]', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, { ...DEMO, lawyers: [] })
    expect(out).toContain('const LAW=[]')
    expect(out).not.toContain('김일번')
  })
  it('마커 자체는 출력에서 제거된다', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, DEMO)
    expect(out).not.toContain('<!--FIRM:')
  })
  // 최종 리뷰 F2 — firms.wordmark가 지금까지 어디에도 렌더되지 않던 데드 컬럼이었다.
  // LFAN 자리(원래 "SAMPLE:2" 워드마크가 있던 자리)에 firm.wordmark를 렌더하는지 봉인.
  it('firm.wordmark → LFAN 자리에 렌더 (데드 컬럼 F2)', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, DEMO)
    expect(out).toContain('<text class="hubt" x="288" y="326">DEMO</text>')
  })
  it('firm.wordmark null → firm.name으로 폴백', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, { ...DEMO, wordmark: null })
    expect(out).toContain('<text class="hubt" x="288" y="326">법률사무소 데모</text>')
  })
  it('검증된 4인 실사진 → 시네마틱 오른쪽 호버 부채꼴을 firm 자산으로 재생성', () => {
    const lawyers = ['김대표', '강육번', '조칠번', '윤팔번'].map((name, index) => ({
      name: `${name} 변호사`, title: index === 0 ? '대표변호사' : '변호사',
      badges: [`공식 이력 ${index + 1}`], photo: `https://cdn.example.test/lawyer-${index + 1}.jpg`,
    }))
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, { ...DEMO, lawyers })
    expect(out.match(/class="wedge furl"/g)).toHaveLength(4)
    expect(out).toContain('href="https://cdn.example.test/lawyer-1.jpg"')
    expect(out).toContain('x="107.87" y="20" width="212.13" height="300" preserveAspectRatio="xMidYMin slice"')
    expect(out).toContain('x="-20" y="107.87" width="375" height="212.13" preserveAspectRatio="xMidYMin slice"')
    expect(out).toContain('x="20" y="320" width="300" height="212.13" preserveAspectRatio="xMidYMin slice"')
    expect(out).toContain('x="107.87" y="320" width="375" height="300" preserveAspectRatio="xMidYMin slice"')
    expect(out).toContain('<text class="wnm" x="248" y="52">김대표 대표</text>')
    expect(out).toContain('<text class="wnm" x="248" y="598">윤팔번</text>')
    expect(out).toContain('<text class="hubt2" x="288" y="334">전담변호사 4인</text>')
    expect(out).not.toContain('class="wimg-bg"')
    expect(out.match(/class="wimg-person"/g)).toHaveLength(4)
    expect(out).toContain('preserveAspectRatio="xMidYMin slice"')
    expect(out).not.toContain('lawyer-lawyera-graded.png')
  })
  it('샘플원 프로필은 군검사·형사전문·금융 법무 경력을 전역 신뢰 문구에 반영', () => {
    const lawyers = [
      { name: '정오번 변호사', title: '대표변호사', badges: ['대한변호사협회 인증 형사 전문 변호사'], career: ['군검사', '법무법인 경쟁사V', '법무법인 경쟁사W'], photo: 'https://cdn.example.test/kim.jpg' },
      ...['강육번', '조칠번', '윤팔번'].map((name) => ({ name: `${name} 변호사`, title: '변호사', badges: ['공개 경력'], photo: `https://cdn.example.test/${name}.jpg` })),
    ]
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, { ...DEMO, slug: 'sampleone', name: '법무법인 샘플원', wordmark: '법무법인 샘플원', adLawyerName: '정오번', lawyers, profileIntro: '금융거래 흐름을 함께 검토합니다.' })
    expect(out).toContain('군검사 출신 정오번 대표변호사')
    expect(out).toContain('대한변호사협회 인증 형사 전문 변호사')
    expect(out).toContain('군검사')
    expect(out).toContain('법무법인 경쟁사V')
    expect(out).toContain('법무법인 경쟁사W')
    expect(out).toContain('class="tbbrand"')
    expect(out).toContain('src="/assets/sampleone-original/logo-header-inverse.png"')
    expect(out).not.toContain('<span class="tbfirm">법무법인 샘플원</span>')
    expect(out).toContain(`전화 상담 ${DEMO.phone}`)
    expect(out).toContain('카톡으로 상담')
    expect(out).toContain('온라인으로 접수하기')
    expect(out).toContain('상담은 무료입니다.')
    expect(out).toContain('금융결제원·카카오뱅크 법무 경험 변호사 참여')
    expect(out).toContain('군검사 출신 대표변호사가 초기 대응을 검토합니다')
    expect(out).toContain('광고책임변호사 정오번')
    expect(out).not.toContain('광고문의')
    expect(out).toContain('<text class="hubt" x="288" y="316">샘플원</text>')
    expect(out).toContain('전담변호사 보기')
    expect(out).toContain('전담변호사 4인')
    expect(out).not.toContain('변호사단')
    expect(out).not.toContain('rotate(-90')
  })
  // 최종 리뷰 F3 — photo:null 변호사는 .lcard-init(이니셜 박스)로 렌더되고, 데스크톱 상시 레일도
  // 같은 클래스를 쓴다(각각 fraud-v2.html의 .lcard .lcard-init / #rail .lcard-init 스타일로 커버).
  it('lawyer.photo null → .lcard-init 이니셜 박스로 렌더 (LCARDS + rail 둘 다)', () => {
    const out = renderFirmBlocks(FRAUD_CINEMA_TEMPLATE, DEMO)
    expect(out).toContain('<div class="lcard-init" aria-hidden="true">김</div>')
    // rail은 lawyers[0](= 김데모 변호사, photo:null)을 대표변호사 자리로 재사용
    expect(out.match(/class="lcard-init"/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('/f/[slug] preview firm 오버라이드', () => {
  afterEach(() => {
    setDbForTesting(null)
    delete process.env.DATABASE_URL
    delete process.env.KEYWORD_SUBDOMAIN_MODE
    delete process.env.LEAD_ROUTING_SECRET
  })

  it('preview=1&firm=demo → landingReady=false여도 200 + 데모 렌더 + no-store', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 9, slug: 'demo', name: DEMO.name, adLawyerName: DEMO.adLawyerName,
      phone: DEMO.phone, phoneIntl: DEMO.phoneIntl, address: DEMO.address,
      addressRegion: DEMO.addressRegion, addressLocality: DEMO.addressLocality,
      domain: null, status: 'active', lawyers: DEMO.lawyers, wordmark: DEMO.wordmark,
      landingReady: false,
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const slug = SCAM_TYPE_SEEDS[0].slug
    const res = await GET(new Request(`https://lawfirm-ads.vercel.app/f/${slug}?preview=1&firm=demo`),
      { params: Promise.resolve({ slug }) })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('법률사무소 데모')
    expect(html).not.toContain('김일번')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex')
    // demo firm은 domain: null — canon이 https://null/... 로 새지 않고 SITE 기반으로 폴백해야 한다
    // (코드 리뷰 Important 1 — preview 오버라이드가 이 경로에 처음 실도달했다)
    expect(html).not.toContain('https://null')
    expect(html).toContain(`<link rel="canonical" href="https://lawfirm-ads.vercel.app/f/${slug}">`)
  })

  it('02 FACTS → 자체 관측 건수만 클라이언트에 전달하고 수집 메타는 노출하지 않는다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 10, slug: 'demo', name: DEMO.name, adLawyerName: DEMO.adLawyerName,
      phone: DEMO.phone, phoneIntl: DEMO.phoneIntl, address: DEMO.address,
      addressRegion: DEMO.addressRegion, addressLocality: DEMO.addressLocality,
      domain: null, status: 'active', lawyers: DEMO.lawyers, wordmark: DEMO.wordmark,
      landingReady: false,
    })
    const [keyword] = await db.insert(keywords).values({
      firmId: 10, name: '관측 테스트', normalizedName: '관측테스트', slug: 'facts-count-only',
      scamType: 'leading', status: 'published', firstSeenAt: new Date('2026-08-01T00:00:00Z'),
    }).returning()
    await db.insert(observations).values([
      { keywordId: keyword.id, sourceType: 'community', sourceUrl: 'https://example.test/1' },
      { keywordId: keyword.id, sourceType: 'news', sourceUrl: 'https://example.test/2' },
    ])
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const res = await GET(new Request('https://lawfirm-ads.vercel.app/f/facts-count-only?preview=1&firm=demo'),
      { params: Promise.resolve({ slug: 'facts-count-only' }) })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('"facts":{"observationCount":2}')
    expect(html).toContain('해당 사건과 관련된 피해접수기록')
    expect(html).toContain('계속 증가 중입니다.')
    expect(html).toContain('KW_NAME + \'-관련사건 \'')
    expect(html).not.toContain('관련내용 ')
    expect(html).not.toContain('건 수집·관측')
    expect(html).not.toContain('접수 내용은 담당 변호사만 열람합니다')
    expect(html).not.toContain('초기 상담 정책 — 사무실 확정 필요')
    expect(html).toContain('상담 비용은 상담 시 안내합니다.')
    expect(html).not.toContain('sourceBreakdown')
    expect(html).not.toContain('firstSeenAt')
    expect(html).not.toContain('recentObservations')
    expect(html).not.toContain('pageVisits')
    expect(html).not.toContain('출처: 경찰청 범죄통계')
    expect(html).not.toContain('id="fsrc"')
  })

  it('운영 사건 페이지는 사건명 자체를 title·H1·description·OG·구조화데이터의 주 키워드로 사용한다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 11, slug: 'sampleone', name: '법무법인 샘플원', adLawyerName: '정오번',
      phone: '010-0000-0009', phoneIntl: '+82-10-0000-0009', address: '샘플로 2, 9층',
      addressRegion: '서울특별시', addressLocality: '서초구', domain: 'sampleone.attorney',
      status: 'active', lawyers: DEMO.lawyers, wordmark: '법무법인 샘플원',
      siteTemplate: 'response-room', landingReady: true,
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const slug = SCAM_TYPE_SEEDS[0].slug
    const keyword = SCAM_TYPE_SEEDS[0].name
    const canonical = `https://sampleone.attorney/f/${slug}`
    const res = await GET(new Request(canonical, { headers: { host: 'sampleone.attorney' } }),
      { params: Promise.resolve({ slug }) })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Robots-Tag')).toBeNull()
    expect(html).toContain('class="ref-v3"')
    expect(html).toContain(`<title>${keyword} 피해 대응 전담센터 | 법무법인 샘플원</title>`)
    expect(html).toContain(`<h1 id="case-hero-title"><span class="case-focus-name">${keyword}</span><span>사기피해 전담센터</span></h1>`)
    expect(html).toContain(`<meta name="description" content="${keyword} 관련 사건 개요`)
    expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">')
    expect(html).toContain(`<link rel="canonical" href="${canonical}">`)
    expect(html).toContain(`<meta property="og:url" content="${canonical}">`)
    expect(html).toContain('<meta property="og:image" content="https://sampleone.attorney/assets/sampleone-original/og-sampleone-logo.png">')
    expect(html).toContain('<link rel="icon" href="/assets/sampleone-original/icon-sampleone.png">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain(`"headline":"${keyword}"`)
    expect(html).toContain("variant:'km-based-v3'")

    const cleanRes = await GET(new Request(`${canonical}?layout=clean`, { headers: { host: 'sampleone.attorney' } }),
      { params: Promise.resolve({ slug }) })
    const cleanHtml = await cleanRes.text()
    expect(cleanRes.status).toBe(200)
    expect(cleanRes.headers.get('X-Robots-Tag')).toContain('noindex')
    expect(cleanHtml).toContain('CASE INFORMATION')
    expect(cleanHtml).toContain(`${keyword}<span>피해 대응 안내</span>`)
    expect(cleanHtml).toContain('법무법인 샘플원<br>변호사 직접 검토')
    expect(cleanHtml).toContain('data-clean-lead')
    expect(cleanHtml).not.toContain('같은 유형의 다른 사건 안내')
    expect(cleanHtml).not.toContain('10분 이내')
    expect(cleanHtml).not.toContain('회수 가능 사건')
  })

  it('DB 사건 서브도메인의 기본 URL도 V3로 렌더하고 관측 수·상담 라우팅·SEO를 유지한다', async () => {
    const db = await createTestDb()
    const firmId = 289283342
    const label = 'db-case-v3-abcdefghij'
    const keywordSlug = 'db-case-v3-source'
    await db.insert(firms).values({
      id: firmId, slug: 'sampleone', name: '법무법인 샘플원', adLawyerName: '정오번',
      phone: '010-0000-0009', phoneIntl: '+82-10-0000-0009', address: '샘플로 2, 9층',
      addressRegion: '서울특별시', addressLocality: '서초구', domain: 'sampleone.attorney',
      status: 'active', lawyers: DEMO.lawyers, wordmark: '법무법인 샘플원',
      siteTemplate: 'response-room', landingReady: true,
    })
    const [keyword] = await db.insert(keywords).values({
      firmId, name: 'DB 호환 사건', normalizedName: 'DB호환사건', slug: keywordSlug,
      scamType: 'leading', status: 'published', firstSeenAt: new Date('2026-08-01T00:00:00Z'),
    }).returning()
    await db.insert(observations).values([
      { keywordId: keyword.id, sourceType: 'community', sourceUrl: 'https://example.test/1' },
      { keywordId: keyword.id, sourceType: 'news', sourceUrl: 'https://example.test/2' },
      { keywordId: keyword.id, sourceType: 'blog', sourceUrl: 'https://example.test/3' },
    ])
    await db.insert(scamPages).values({
      keywordId: keyword.id,
      lintPassed: true,
      content: {
        intro: 'DB에서 승인된 사건 소개 문장입니다.',
        sections: [
          { heading: 'DB 수집 자료 확인 항목', body: '승인된 수집 자료와 실제 상담 자료를 함께 대조합니다.' },
        ],
        contentDegree: 2,
        observationCount: 3,
        independentSourceCount: 3,
        generatedAt: '2026-09-04T00:00:00.000Z',
      },
    })
    await db.insert(firmKeywords).values({ firmId, keywordId: keyword.id, publicHostLabel: label, hostStatus: 'public' })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'
    process.env.KEYWORD_SUBDOMAIN_MODE = 'canonical'
    process.env.LEAD_ROUTING_SECRET = 'test-routing-secret'

    const host = `${label}.sampleone.attorney`
    const res = await GET(new Request(`https://${host}/f/${label}?__keyword_host=1`, { headers: { host } }),
      { params: Promise.resolve({ slug: label }) })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Robots-Tag')).toBeNull()
    expect(html).toContain('class="ref-v3"')
    expect(html).toContain('<h1 id="case-hero-title"><span class="case-focus-name">DB 호환 사건</span><span>사기피해 전담센터</span></h1>')
    expect(html).toContain('해당 사건과 관련된 피해접수기록 <strong>3건</strong>. 계속 증가 중입니다.')
    expect(html).toContain(`<link rel="canonical" href="https://${host}/">`)
    expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">')
    expect(html).toContain('"headline":"DB 호환 사건"')
    expect(html).toContain('DB 호환 사건 피해라면,<br><em>다음 행동은 달라야 합니다.</em>')
    expect(html).toContain('DB 호환 사건 · DAMAGE FLOW')
    expect(html).toContain('class="case-db-article reveal"')
    expect(html).toContain('DB에서 승인된 사건 소개 문장입니다.')
    expect(html).toContain('DB 수집 자료 확인 항목')
    expect(html).toContain('DB 호환 사건 피해 상담 전,<em>이 자료를 보전하세요.</em>')
    expect(html).toContain('07 · DB 호환 사건 FAQ')
    expect(html).toContain('"@type":"FAQPage"')
    expect(html).toContain('"contactType":"법률상담"')
    expect(html).toContain('"@type":"AdministrativeArea","name":"서울특별시"')
    expect(html).toContain('"@type":"City","name":"서초구"')
    expect(html).toContain('<meta name="geo.region" content="KR">')
    expect(html).toContain('<meta name="geo.placename" content="서울특별시 서초구">')
    expect(html).toContain(`slug:"${keywordSlug}"`)
    expect(html).toContain(`firmId:${firmId},routeToken:`)
    expect(html).toContain('/api/leads')
    expect(html).toContain('/api/engagement')
    expect(html).toContain('/api/events')
  })

  it('고객이 선택한 사이트 형식이 공개 사건 페이지의 실제 문서 구조를 결정한다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 9, slug: 'demo', name: DEMO.name, adLawyerName: DEMO.adLawyerName,
      phone: DEMO.phone, phoneIntl: DEMO.phoneIntl, address: DEMO.address,
      addressRegion: DEMO.addressRegion, addressLocality: DEMO.addressLocality,
      domain: null, status: 'active', lawyers: DEMO.lawyers, wordmark: DEMO.wordmark,
      siteTemplate: 'case-brief', landingReady: false,
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const slug = SCAM_TYPE_SEEDS[0].slug
    const briefRes = await GET(new Request(`https://lawfirm-ads.vercel.app/f/${slug}?preview=1&firm=demo`),
      { params: Promise.resolve({ slug }) })
    const briefHtml = await briefRes.text()
    expect(briefHtml).toContain('data-site-template="case-brief"')
    expect(briefHtml).toContain('CASE INFORMATION BRIEF')
    expect(briefHtml).toContain('data-case-lead')
    expect(briefHtml).not.toContain('같은 유형의 다른 사건 안내')
    expect(briefHtml).not.toContain('04-3</b> — RELATED')

    await db.update(firms).set({ siteTemplate: 'counsel-note' })
    const counselRes = await GET(new Request(`https://lawfirm-ads.vercel.app/f/${slug}?preview=1&firm=demo`),
      { params: Promise.resolve({ slug }) })
    const counselHtml = await counselRes.text()
    expect(counselHtml).toContain('data-site-template="counsel-note"')
    expect(counselHtml).toContain('COUNSEL · CASE NOTE')
    expect(counselHtml).toContain('사건 기록과 대응 순서')
    expect(counselHtml).not.toBe(briefHtml)
  })

  it('preview 오버라이드 — paused firm은 조회 자체가 실패로 취급되어 기본(샘플투) 폴백', async () => {
    // resolveFirmByHost(firms.ts)는 paused를 제외하는데 오버라이드 쿼리가 그 정책을 안 따르면
    // 계약 해지·정지된 firm의 실브랜딩이 인증 없는 preview로 무기한 렌더될 수 있다 (코드 리뷰 Important 2).
    // landingReady: true로 시드해도 override 자체가 막혀야 한다 — landingReady 우회는 별개 관문이다.
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 9, slug: 'demo', name: DEMO.name, adLawyerName: DEMO.adLawyerName,
      phone: DEMO.phone, phoneIntl: DEMO.phoneIntl, address: DEMO.address,
      addressRegion: DEMO.addressRegion, addressLocality: DEMO.addressLocality,
      domain: null, status: 'paused', lawyers: DEMO.lawyers, wordmark: DEMO.wordmark,
      landingReady: true,
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const slug = SCAM_TYPE_SEEDS[0].slug
    const res = await GET(new Request(`https://lawfirm-ads.vercel.app/f/${slug}?preview=1&firm=demo`),
      { params: Promise.resolve({ slug }) })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('법률사무소 ○○')
    expect(html).not.toContain('법률사무소 샘플투')
    expect(html).not.toContain('법률사무소 데모')
  })

  it('active+landingReady firm은 preview 플래그 없는 운영 URL에서 렌더된다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 9, slug: 'demo', name: DEMO.name, adLawyerName: DEMO.adLawyerName,
      phone: DEMO.phone, phoneIntl: DEMO.phoneIntl, address: DEMO.address,
      addressRegion: DEMO.addressRegion, addressLocality: DEMO.addressLocality,
      domain: null, status: 'active', lawyers: DEMO.lawyers, wordmark: DEMO.wordmark,
      landingReady: true,
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const slug = SCAM_TYPE_SEEDS[0].slug
    const res = await GET(new Request(`https://lawfirm-ads.vercel.app/f/${slug}?firm=demo`),
      { params: Promise.resolve({ slug }) })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('법률사무소 데모')
    expect(html).not.toContain('법률사무소 ○○')
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400')
  })
})
