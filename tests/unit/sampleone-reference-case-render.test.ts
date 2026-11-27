import { describe, expect, it } from 'vitest'
import { renderSampleoneReferenceCase } from '@/lib/engine/sampleone-reference-case-render'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'

describe('샘플원 레퍼런스 구조 검수판', () => {
  it('자체 자산으로 긴 광고 랜딩 구조와 기존 기능을 유지한다', () => {
    const html = renderSampleoneReferenceCase({
      firm: SAMPLEONE_LOCAL_PREVIEW_FIRM,
      caseName: '가상프로젝트A',
      slug: '12-4a605cb62d-lcrxobkg25',
      canonical: 'https://12-4a605cb62d-lcrxobkg25.sampleone.attorney/',
      description: '피해 대응 안내',
      observationCount: 11,
      leadRoute: { firmId: 289283342, routeToken: 'test-route' },
    })
    expect(html).toContain('reference-structure')
    expect(html).toContain('reference-hero')
    expect(html).toContain('SAMPLEONE FRAUD RESPONSE')
    expect(html).toContain('/assets/seq/act0/d/f_088.webp')
    expect(html).toContain('/assets/sampleone-campaign-v3/people/lawyere-card.webp')
    expect(html).toContain('class="stop"')
    expect(html).toContain('class="decision"')
    expect(html).toContain('class="signals"')
    expect(html).toContain('/api/leads')
    expect(html).toContain('/api/engagement')
    expect(html).toContain("variant:'reference-structure'")
    expect(html).not.toContain('competitor-e-scam.example.com')
    expect(html).not.toContain('법률사무소 경쟁사E')
  })
})
