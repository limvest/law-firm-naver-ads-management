import { describe, expect, it } from 'vitest'
import { FRAUD_CINEMA_TEMPLATE } from '@/templates/fraud-cinema'
import { stabilizeCinemaScroll } from '@/lib/engine/cinema-scroll-stability'

describe('시네마 V1/V2 스크롤 안정화', () => {
  it('모바일 Lenis 충돌과 뷰포트·폰트 로딩에 따른 스크롤 보정을 막는다', () => {
    const html = stabilizeCinemaScroll(FRAUD_CINEMA_TEMPLATE)

    expect(html).toContain('html{overflow-anchor:none}')
    expect(html).toContain("const stageHeight=cinema.querySelector('.stage')?.clientHeight||innerHeight;")
    expect(html).toContain('const span=cinema.offsetHeight-stageHeight;')
    expect(html).toContain('if (!REDUCED && !MOBILE && window.Lenis){')
    expect(html).not.toContain('const span = cinema.offsetHeight - innerHeight;')
    expect(html).not.toContain('if (!REDUCED && window.Lenis){')
  })
})
