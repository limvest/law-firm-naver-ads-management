// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { Analytics } from '@/components/analytics'

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_GTM_ID
  delete process.env.NEXT_PUBLIC_NAVER_WCS_ID
})

describe('<Analytics />', () => {
  it('env 없으면 아무것도 렌더하지 않는다', () => {
    const { container } = render(<Analytics />)
    expect(container.innerHTML).toBe('')
  })
  it('GTM ID 있으면 gtm.js 스니펫 렌더', () => {
    process.env.NEXT_PUBLIC_GTM_ID = 'GTM-TEST1'
    const { container } = render(<Analytics />)
    expect(container.innerHTML).toContain('GTM-TEST1')
    expect(container.innerHTML).toContain('googletagmanager.com/gtm.js')
  })
  it('네이버 WCS ID 있으면 wcslog 스니펫 렌더', () => {
    process.env.NEXT_PUBLIC_NAVER_WCS_ID = 'na-1234'
    const { container } = render(<Analytics />)
    expect(container.innerHTML).toContain('na-1234')
    expect(container.innerHTML).toContain('wcslog.js')
  })
})
