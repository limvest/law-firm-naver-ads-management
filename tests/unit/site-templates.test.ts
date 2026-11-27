import { describe, expect, it } from 'vitest'
import {
  isSiteTemplateKey,
  normalizeSiteTemplate,
  SITE_TEMPLATES,
} from '@/lib/site-templates'
import { renderAlternateCaseTemplate } from '@/lib/engine/case-site-render'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

describe('법률사무소 사이트 템플릿', () => {
  it('서로 다른 4종과 고유 데모 경로를 제공한다', () => {
    expect(SITE_TEMPLATES).toHaveLength(4)
    expect(new Set(SITE_TEMPLATES.map((item) => item.key)).size).toBe(4)
    expect(SITE_TEMPLATES.map((item) => item.key)).toContain('fintech-center')
    expect(SITE_TEMPLATES.every((item) => item.trustFocus.length > 0)).toBe(true)
  })

  it('허용 키만 통과시키고 알 수 없는 값은 기존 대응 상황실로 정규화한다', () => {
    expect(isSiteTemplateKey('case-brief')).toBe(true)
    expect(isSiteTemplateKey('unknown')).toBe(false)
    expect(normalizeSiteTemplate('unknown')).toBe('response-room')
  })

  it('사건 브리프와 사건노트는 색상뿐 아니라 정보 순서가 다른 완성 HTML을 만든다', () => {
    const base = {
      firm: { ...DEFAULT_FIRM, id: 2, name: '법률사무소 데모', siteTemplate: 'case-brief' },
      title: '사건 피해 대응 안내', description: '사건 개요와 대응 순서', canonical: 'https://example.com/f/case',
      caseName: '테스트 사건', caseType: '투자 사칭', slug: 'case', jsonLd: '<script type="application/ld+json">{}</script>',
      articleHtml: '<section><h2>수집 데이터 기반 사건 개요</h2></section>',
      profileQuery: '?preview=1&firm=demo',
      leadRoute: { firmId: 2, routeToken: 'demo-route-token' },
    }
    const brief = renderAlternateCaseTemplate({ ...base, template: 'case-brief' })
    const counsel = renderAlternateCaseTemplate({ ...base, template: 'counsel-note' })
    for (const html of [brief, counsel]) {
      expect(html).toContain('수집 데이터 기반 사건 개요')
      expect(html).toContain('data-case-lead')
      expect(html).toContain("type:'page_view'")
      expect(html).toContain('firmId:2')
      expect(html).toContain('demo-route-token')
      expect(html).toContain('사건을 검토하는 순서')
    }
    expect(brief).toContain('송금 전')
    expect(brief).toContain('data-site-template="case-brief"')
    expect(counsel).toContain('처음 연락받은 시점')
    expect(counsel).toContain('data-site-template="counsel-note"')
    expect(brief).not.toBe(counsel)
  })
})
