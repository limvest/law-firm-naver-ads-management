// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { AboutContent } from '../../app/about/page'
import { MembersContent } from '../../app/members/page'
import Criminal from '../../app/criminal/page'
import { findBannedTerms } from '@/lib/compliance/lexicon'

beforeEach(() => {
  window.dataLayer = []
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(), configurable: true })
})

describe('firm 서브페이지', () => {
  it('members: 구성원 4인 실명·직함', () => {
    const { getByText } = render(<MembersContent />)
    getByText(/김일번 변호사/); getByText(/이이번 변호사/); getByText(/박삼번 변호사/); getByText(/최사번 변호사/)
    getByText('대표변호사'); getByText('수석변호사')
  })
  it('전 페이지 firm 테마 + 금지어 0', () => {
    for (const Page of [AboutContent, MembersContent, Criminal]) {
      const { container, unmount } = render(<Page />)
      expect(container.querySelector('[data-vertical="firm"]')).toBeTruthy()
      expect(findBannedTerms(container.textContent ?? '')).toEqual([])
      unmount()
    }
  })
  it('criminal: 결과 단정·수임료 문구 없음, 상담 CTA 존재', () => {
    const { container, getAllByText } = render(<Criminal />)
    expect(container.textContent).not.toMatch(/집행유예를 받아드립니다|무죄를 만들어/)
    expect(getAllByText(/상담/).length).toBeGreaterThan(0)
  })
})
