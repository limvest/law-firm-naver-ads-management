// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { ProductHome } from '../../app/page'
import { TypeReveal } from '@/components/scenes/type-reveal'
import { findBannedTerms } from '@/lib/compliance/lexicon'

beforeEach(() => {
  window.dataLayer = []
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(), configurable: true })
})

describe('제품 홈', () => {
  it('고객이 제품과 핵심 흐름을 첫 화면에서 이해할 수 있다', () => {
    const { container } = render(<ProductHome />)
    expect(container.querySelector('.product-landing')).toBeTruthy()
    expect(container.textContent).toContain('법률사무소 전용')
    for (const text of ['필요할 때 사건명을 찾습니다', '검색 의도에 맞는 페이지를 엽니다', '검색광고 파이프라인에 연결합니다', '상담으로 이어진 흐름을 봅니다']) {
      expect(container.textContent).toContain(text)
    }
  })
  it('금지어 0건', () => {
    const { container } = render(<ProductHome />)
    expect(findBannedTerms(container.textContent ?? '')).toEqual([])
  })
})

describe('<TypeReveal />', () => {
  it('reduced-motion이면 즉시 전체 텍스트', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const { getByText } = render(<TypeReveal text="기록으로 증명하는 변호" />)
    getByText('기록으로 증명하는 변호')
  })
  it('일반 모드면 점진 타이핑 후 완성', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    const { container } = render(<TypeReveal text="샘플투" />)
    await waitFor(() => expect(container.textContent).toContain('샘플투'), { timeout: 2000 })
  })
})
