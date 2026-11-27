import { describe, expect, it } from 'vitest'
import {
  SEO_CASES_PER_PAGE,
  caseIndexPath,
  getCategoryCounts,
  getPublicSeoCases,
  getRelatedSeoCases,
  getSeoCaseBySlug,
  getSeoCasePage,
} from '@/lib/scam/seo-index'

describe('SEO 사건 인덱스', () => {
  it('공개 스테이징 사건을 HTML 페이지네이션 단위로 제공한다', () => {
    const all = getPublicSeoCases()
    const first = getSeoCasePage({})
    expect(all.length).toBeGreaterThan(1000)
    expect(first.items).toHaveLength(SEO_CASES_PER_PAGE)
    expect(first.total).toBe(all.length)
    expect(first.totalPages).toBe(Math.ceil(all.length / SEO_CASES_PER_PAGE))
  })

  it('유형 허브 건수의 합이 전체 공개 사건 수와 같다', () => {
    const sum = getCategoryCounts().reduce((total, category) => total + category.count, 0)
    expect(sum).toBe(getPublicSeoCases().length)
  })

  it('상세 관련 링크는 같은 유형의 다른 사건으로 구성한다', () => {
    const current = getSeoCaseBySlug('mock-project-d')
    const related = getRelatedSeoCases('mock-project-d')
    expect(current).not.toBeNull()
    expect(related.length).toBeGreaterThan(0)
    expect(related.every((item) => item.slug !== current!.slug && item.category === current!.category)).toBe(true)
  })

  it('정적 페이지네이션 URL을 일관되게 생성한다', () => {
    expect(caseIndexPath(1)).toBe('/f')
    expect(caseIndexPath(2)).toBe('/f/page/2')
    expect(caseIndexPath(1, 'coin')).toBe('/f/type/coin')
    expect(caseIndexPath(3, 'coin')).toBe('/f/type/coin/page/3')
  })
})
