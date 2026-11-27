// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { CinematicFirmHome } from '@/components/firm/cinematic-firm-home'
import type { Firm } from '@/lib/engine/firms'

const firm: Firm = {
  id: 289283342,
  slug: 'sampleone',
  name: '법무법인 샘플원',
  adLawyerName: '정오번',
  phone: '010-0000-0009',
  phoneIntl: '+82-10-0000-0009',
  address: '샘플로 2, 샘플빌딩 9층',
  addressRegion: '서울특별시',
  addressLocality: '서초구',
  kakaoUrl: null,
  domain: 'sampleone.attorney',
  domainAliases: null,
  status: 'active',
  lawyers: ['정오번', '강육번', '조칠번', '윤팔번'].map((name, index) => ({
    id: `lawyer-${index}`,
    name: `${name} 변호사`,
    title: index === 0 ? '대표변호사' : '변호사',
    badges: ['사건을 직접 검토합니다.'],
    photo: `/lawyer-${index}.jpg`,
    practiceAreas: ['금융사기', '재산범죄'],
    career: [`${name} 주요 경력`],
    education: [`${name} 법학전문대학원`],
  })),
  wordmark: '법무법인 샘플원',
  landingReady: true,
  dashboardToken: null,
  siteTemplate: 'response-room',
  profileIntro: '금융사기 피해 사건의 사실관계와 가능한 절차를 검토합니다.',
  officeHistory: null,
  adConfig: null,
}

describe('법무법인 샘플원 시네마틱 홈', () => {
  it('특정 사건이 아니라 사무소 브랜드와 자체 관측 현황을 보여준다', () => {
    const { container } = render(<CinematicFirmHome
      firm={firm}
      results={[]}
      signals={{
        caseCount: 1786,
        trackedCaseCount: 1650,
        observationCount: 1657,
        livePageCount: 1266,
        recent: [{ name: '테스트 사건', slug: 'test-case', scamType: 'leading', observationCount: 24 }],
      }}
    />)
    expect(container.querySelector('[data-home-template="cinematic"]')).toBeTruthy()
    expect(container.textContent).toContain('법무법인 샘플원')
    expect(container.textContent).toContain('기록이 사라지기 전에,먼저 지킵니다.')
    expect(container.textContent).toContain('회수와 처벌을,처음부터 함께 봅니다.')
    expect(container.textContent).toContain('스크롤하여 대응 과정을 확인하세요')
    expect(container.textContent).not.toContain('SCROLL TO RESPOND')
    expect(container.querySelectorAll('.cinematic-story-layer')).toHaveLength(4)
    expect(container.querySelector('canvas[data-sequence="br3"]')).toBeTruthy()
    expect(container.textContent).toContain('당신의 일상을 지킵니다')
    expect(container.querySelector('.sampleone-original-hero-copy p')?.textContent).toBe('법무법인 샘플원')
    expect(container.querySelector('.sampleone-hero-practice-fan')?.textContent).toContain('업무분야')
    expect([...container.querySelectorAll('.sampleone-hero-practice-fan strong')].map((node) => node.textContent)).toEqual(['형사사건', '가상자산', '기업법무', '조세'])
    expect(container.querySelector('.cinematic-home-header')).toBeNull()
    expect(container.querySelector('.cinematic-home-footer')).toBeNull()
    expect(container.textContent).toContain('05 — 상담 신청')
    expect(container.querySelector('.cinematic-home-call')?.getAttribute('href')).toBe('tel:01000000009')
    expect(container.querySelector('.cinematic-home-call')?.textContent).toContain('010-0000-0009')
    expect(container.textContent).not.toContain('PRIVATE CONSULTATION')
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('a[href="https://map.naver.com/p/entry/place/2057997354"]')?.textContent).toContain('NAVER MAP')
    expect(container.querySelector('.cinematic-home-map-pin')?.textContent).toContain('법무법인 샘플원샘플빌딩 9층')
    expect(container.querySelector('a[href*="map.naver.com/p/directions"]')?.textContent).toBe('네이버 지도에서 길찾기')
    expect(container.querySelector('#lf-direct-name')).toBeTruthy()
    expect(container.querySelector('#lf-direct-phone')).toBeTruthy()
    expect(container.querySelector('#lf-direct-type')).toBeTruthy()
    expect(container.querySelector('#lf-direct-amount')).toBeTruthy()
    expect(container.querySelector('#lead-form.direct-lead-form')).toBeTruthy()
    expect(container.querySelector('.sampleone-hero-brand img')?.getAttribute('src')).toBe('/assets/sampleone-original/logo-header-inverse.png')
    expect(container.querySelectorAll('.sampleone-original-hero-slides > i')).toHaveLength(3)
    expect(container.querySelectorAll('.sampleone-original-hero-dots > i')).toHaveLength(3)
    expect(container.querySelector('.cinematic-firm-hero-3d')).toBeNull()
    expect(container.querySelector('.cinematic-home-hero-image')).toBeNull()
    expect(container.textContent).toContain('02 — 피해자 센터')
    expect(container.textContent).not.toContain('Neon DB')
    expect(container.textContent).toContain('DB 등록 사건 수')
    expect(container.textContent).toContain('추적 사건 수')
    expect(container.textContent).toContain('1,786건')
    expect(container.textContent).toContain('1,650건')
    expect(container.textContent).not.toContain('관측 기록')
    expect(container.textContent).toContain('정오번 변호사')
    expect(container.textContent).not.toContain('03 — CASE INDEX')
    expect(container.textContent).toContain('03 — COUNSEL')
    expect(container.textContent).not.toContain('샘플원의 네 변호사를 순서대로 소개합니다.')
    expect(container.querySelectorAll('.cinematic-lawyer-fan button')).toHaveLength(4)
    expect([...container.querySelectorAll<HTMLElement>('.cinematic-lawyer-fan button')].map((node) => node.style.getPropertyValue('--fan-slot'))).toEqual(['3', '2', '1', '0'])
    expect([...container.querySelectorAll<HTMLElement>('.cinematic-lawyer-fan button')].map((node) => node.style.getPropertyValue('--fan-z'))).toEqual(['4', '3', '2', '1'])
    expect([...container.querySelectorAll('.cinematic-lawyer-detail h3')].map((node) => node.textContent)).toEqual(['정오번 변호사', '강육번 변호사', '조칠번 변호사', '윤팔번 변호사'])
    fireEvent.click(container.querySelectorAll('.cinematic-lawyer-fan button')[2])
    expect(container.querySelector('.cinematic-lawyer-fan button.is-active')?.getAttribute('aria-label')).toBe('조칠번 변호사 상세정보 보기')
    expect(container.querySelector('.cinematic-lawyer-detail.is-active h3')?.textContent).toBe('조칠번 변호사')
    expect(container.textContent).toContain('정오번 주요 경력')
    expect(container.textContent).toContain('정오번 법학전문대학원')
    expect(container.textContent).toContain('대한변협 인증 형사전문 · 군검사 출신')
    expect(container.textContent).toContain('기업법무 · 조세 · 복잡한 거래구조 분석')
    expect(container.textContent).toContain('금융결제원 · 카카오뱅크 법무 출신 · 금융거래 분석')
    expect(container.textContent).toContain('형사전문 · 피해 자료 정리 · 수사 절차 대응')
    expect(container.textContent).not.toContain('테스트 사건')
    expect(container.textContent).not.toContain('가상프로젝트D')
    expect(container.querySelector('a[href="/f/test-case"]')).toBeNull()
    expect(container.querySelector('a[href="/lawyers"]')).toBeNull()
    expect(container.querySelector('a[href="/results"]')).toBeNull()
  })
})
