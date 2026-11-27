// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import { siteConfig } from '@/config/site'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

describe('컴플라이언스 셸 (규정 §3②, §5③)', () => {
  it('푸터: 광고책임변호사·사무소명·주소·연락처·개인정보방침 링크', () => {
    const { container, getByText, getAllByText } = render(<SiteFooter firm={DEFAULT_FIRM} />)
    getByText(new RegExp(`광고책임변호사[: ]*${siteConfig.adLawyerName}`))
    getAllByText(new RegExp(siteConfig.firmName))
    expect(container.textContent).toContain(siteConfig.address)
    expect(container.querySelector('a[href="/privacy"]')).toBeTruthy()
    expect(container.textContent).toContain(siteConfig.phone)
  })
  it('헤더: 사무소 명칭 표시', () => {
    const { getByText } = render(<SiteHeader firm={DEFAULT_FIRM} />)
    getByText(new RegExp(siteConfig.firmName))
  })
  it('셸 텍스트에 금지어 없음', () => {
    const { container: f } = render(<SiteFooter firm={DEFAULT_FIRM} />)
    const { container: h } = render(<SiteHeader firm={DEFAULT_FIRM} />)
    expect(findBannedTerms(f.textContent ?? '')).toEqual([])
    expect(findBannedTerms(h.textContent ?? '')).toEqual([])
  })
})
