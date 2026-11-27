import { describe, it, expect, afterEach } from 'vitest'
import { FRAUD_CINEMA_TEMPLATE } from '@/templates/fraud-cinema'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { DEFAULT_FIRM, type Firm } from '@/lib/engine/firms'
import { applyFirmBranding, BRANDING_LITERALS } from '@/lib/engine/firm-branding'
import { SCAM_TYPE_SEEDS } from '@/lib/scam/seed-data'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { firms } from '@/lib/db/schema'
import { GET } from '../../app/f/[slug]/route'

const OTHER: Firm = {
  id: 2, slug: 'other', name: '법률사무소 예시', adLawyerName: '김예시',
  phone: '02-111-2222', phoneIntl: '+82-2-111-2222',
  address: '예시로 1, 2층', addressRegion: '서울특별시', addressLocality: '서초구',
  kakaoUrl: null, domain: 'example-law.kr', status: 'active',
}

describe('firm 브랜딩 주입', () => {
  it('firm 1(샘플투) → 입력 그대로 (기존 동작 무변경)', () => {
    expect(applyFirmBranding(FRAUD_CINEMA_TEMPLATE, DEFAULT_FIRM)).toBe(FRAUD_CINEMA_TEMPLATE)
  })

  it('canary: 치환 대상 리터럴이 전부 템플릿에 존재 (fraud-v2 카피 변경 감지)', () => {
    // phoneIntl(국제전화 표기)은 정적 템플릿 본문이 아니라 jsonLdFor()의 LegalService.telephone
    // 필드에서만 등장한다(route.ts, firm 파라미터화 대상) — FRAUD_CINEMA_TEMPLATE 원문에는
    // 존재한 적이 없다(grep 확인: tel: 링크는 전부 국내 표기 031-000-0000). canary는 "정적 템플릿에
    // 박혀 있는" 리터럴만 검증 대상으로 삼는다.
    for (const [key, lit] of Object.entries(BRANDING_LITERALS)) {
      if (key === 'phoneIntl') continue
      expect(FRAUD_CINEMA_TEMPLATE).toContain(lit)
    }
  })

  it('타 firm → 샘플투 흔적 0, firm 값 주입, 금지어 0 유지', () => {
    const out = applyFirmBranding(FRAUD_CINEMA_TEMPLATE, OTHER)
    expect(out).not.toContain('샘플투')
    expect(out).not.toContain('031-000-0000')
    expect(out).not.toContain('김일번')
    expect(out).toContain('법률사무소 예시')
    expect(out).toContain('김예시')
    const visible = out.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
    // 상담 무료 정책은 발주자가 확정한 문구이므로 일반 금지어 검사에서 예외로 둔다.
    expect(findBannedTerms(visible).filter((term) => term !== '무료')).toEqual([])
  })

  it('firm 값에 &가 섞여 있어도 HTML 이스케이프되어 속성 컨텍스트가 깨지지 않음', () => {
    const amp: Firm = { ...OTHER, name: '김&박 법률사무소' }
    const out = applyFirmBranding(FRAUD_CINEMA_TEMPLATE, amp)
    // aria-label="법률사무소 샘플투 전담변호사 4인" 자리에 이스케이프된 값이 그대로 들어가야
    // 속성이 중간에 끊기지 않는다 (미이스케이프 시 aria-label="김&박 ... 로 & 뒤가 깨짐)
    expect(out).toMatch(/aria-label="김&amp;박 법률사무소 전담변호사 4인"/)
    expect(out).toContain('김&amp;박 법률사무소')
    expect(out).not.toContain('aria-label="김&박')
  })
})

describe('/f/[slug] firm 주입 스모크', () => {
  afterEach(() => {
    setDbForTesting(null)
    delete process.env.DATABASE_URL
  })

  it('기본 호스트 → 샘플투 브랜딩 200 + Vary: Host', async () => {
    const slug = SCAM_TYPE_SEEDS[0].slug
    const res = await GET(new Request(`https://sampletwo-law.example.com/f/${slug}`),
      { params: Promise.resolve({ slug }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('Vary')).toBe('Host') // 최종 리뷰 F2 — Host별 캐시 분리
    const html = await res.text()
    expect(html).toContain('법률사무소 샘플투')
    expect(html).toContain('031-000-0000')
  })

  it('제품 공용 호스트 → 기본 firm 실명·변호사 개인정보 마스킹', async () => {
    const slug = SCAM_TYPE_SEEDS[0].slug
    const res = await GET(
      new Request(`https://lawfirm-ads.vercel.app/f/${slug}`, {
        headers: { host: 'lawfirm-ads.vercel.app' },
      }),
      { params: Promise.resolve({ slug }) },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    const html = await res.text()
    expect(html).toContain('법률사무소 ○○')
    expect(html).toContain('담당 변호사 A')
    expect(html).toContain('개인정보 보호를 위해 상세 이력을 비공개합니다.')
    for (const personalTrace of [
      '법률사무소 샘플투', 'sampletwo-law.example.com', '031-000-0000', '샘플로 1', '샘플시 샘플구',
      '김일번', '이이번', '박삼번', '최사번',
      'lawyer-lawyera', 'lawyer-lawyerb', 'lawyer-lawyerc', 'lawyer-lawyerd',
      '대형로펌', '검사직무대리', '사법시험 합격',
      'href="/lawyers', 'href="/results',
    ]) {
      expect(html).not.toContain(personalTrace)
    }
  })

  it('preview 경로도 Vary: Host', async () => {
    const slug = SCAM_TYPE_SEEDS[0].slug
    const res = await GET(new Request(`https://sampletwo-law.example.com/f/${slug}?preview=1`),
      { params: Promise.resolve({ slug }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('Vary')).toBe('Host')
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })

  // landingReady 게이트 — 실자산 분리(renderFirmBlocks 파라미터화)가 끝난 firm만 공개 승인 플래그를
  // true로 켠다. false인 firm은 여전히 404. 게이트가 사라지면 이 테스트가 먼저 깨진다.
  it('비기본 firm, landingReady=false → 404 (공개 미승인)', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 2, slug: 'other', name: OTHER.name, adLawyerName: OTHER.adLawyerName,
      phone: OTHER.phone, phoneIntl: OTHER.phoneIntl, address: OTHER.address,
      addressRegion: OTHER.addressRegion, addressLocality: OTHER.addressLocality,
      domain: OTHER.domain, status: 'active', landingReady: false,
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const slug = SCAM_TYPE_SEEDS[0].slug
    const res = await GET(
      new Request(`https://${OTHER.domain}/f/${slug}`, { headers: { host: OTHER.domain! } }),
      { params: Promise.resolve({ slug }) },
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('Vary')).toBe('Host')
    const body = await res.text()
    expect(body).not.toContain('김일번') // 샘플투 실자산이 타 firm 응답으로 새지 않음

    // 같은 DB·같은 프로세스에서 기본(샘플투) 호스트는 그대로 200
    const ok = await GET(
      new Request(`https://sampletwo-law.example.com/f/${slug}`, { headers: { host: 'sampletwo-law.example.com' } }),
      { params: Promise.resolve({ slug }) },
    )
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('법률사무소 샘플투')
  })

  it('비기본 firm, landingReady=true + lawyers 시드 → 200 + firm 사무소명 렌더 + 샘플투 실자산 흔적 0', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 3, slug: 'ready-firm', name: '법률사무소 레디', adLawyerName: '박레디',
      phone: '02-333-4444', phoneIntl: '+82-2-333-4444', address: '레디로 3',
      addressRegion: '서울특별시', addressLocality: '강남구',
      domain: 'ready-law.kr', status: 'active', landingReady: true,
      lawyers: [{ name: '박레디 변호사', title: '대표변호사', badges: ['변호사시험 합격'], photo: null }],
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgres://test-only'

    const slug = SCAM_TYPE_SEEDS[0].slug
    const res = await GET(
      new Request('https://ready-law.kr/f/' + slug, { headers: { host: 'ready-law.kr' } }),
      { params: Promise.resolve({ slug }) },
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('법률사무소 레디')
    expect(html).toContain('박레디')
    for (const trace of ['김일번', '031-000-0000', 'lawyer-lawyera', '샘플시', '000-00-00001',
      // 최종 리뷰 F1 — 샘플투 전용 자격·경력 주장 2건도 실 요청 경로(/f/[slug])까지 흔적 0 확인
      '변호사 4인 전원 사법시험 출신 · 사법연수원 수료', '대한변호사협회 인증 형사법 전문변호사']) {
      expect(html).not.toContain(trace)
    }
  })
})
