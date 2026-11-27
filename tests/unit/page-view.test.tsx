// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { PageViewTracker } from '@/components/page-view-tracker'

beforeEach(() => {
  window.dataLayer = []
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(), configurable: true })
})

// `app/scam/page.tsx`의 "scam 랜딩 렌더 시 page_view(slug=scam) 발사" 케이스는 T7에서
// 페이지가 async 서버 컴포넌트(허브, DB 조회)가 되어 RTL 직접 렌더 불가 — 제거한다.
// <PageViewTracker slug="scam" /> 마운트 시 발사되는 일반 동작은 바로 아래 테스트가
// 이미 커버하며, ScamHubPage가 고정 문자열 slug="scam"을 넘기는 배선 자체는
// about/members/criminal 등 다른 페이지와 동일한 패턴(전용 테스트 없이 코드로 확인)이다.
describe('page_view 배선', () => {
  it('PageViewTracker 마운트 시 page_view 발사', () => {
    render(<PageViewTracker slug="test" />)
    expect(window.dataLayer).toContainEqual({ event: 'page_view', slug: 'test' })
  })
})
