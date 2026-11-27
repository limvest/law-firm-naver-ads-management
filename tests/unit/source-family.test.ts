import { describe, expect, it } from 'vitest'
import {
  isAutoDiscoveredSource,
  normalizeSourceFamily,
  sourceFamilyForCollector,
} from '@/domains/intelligence/source-family'

describe('source family safety gate', () => {
  it('keeps Naver blogs separate by blogId while preserving the reviewed 경쟁사B mirror', () => {
    expect(sourceFamilyForCollector({ type: 'naver_blog', blogId: 'sampleblog1' })).toBe('competitorb-law')
    expect(sourceFamilyForCollector({ type: 'naver_blog', blogId: 'sampleblog2' })).toBe('naver-blog:sampleblog2')
    expect(sourceFamilyForCollector({ type: 'naver_blog', blogId: 'sampleblog3' })).toBe('naver-blog:sampleblog3')
    expect(sourceFamilyForCollector({ type: 'naver_blog', blogId: 'sampleblog2', sourceFamily: 'competitorb-law' }))
      .toBe('naver-blog:sampleblog2')
  })

  it('merges only exact reviewed mirrors and leaves unsupported domains independent', () => {
    expect(sourceFamilyForCollector({ url: 'https://www.competitor-b-office.co.example.com/sitemap.xml' })).toBe('competitorb-law')
    expect(sourceFamilyForCollector({ url: 'https://competitor-d-1.example.com/cases' })).toBe('competitord-law')
    expect(sourceFamilyForCollector({ url: 'https://competitor-a-light.example.com/sitemap.xml' })).toBe('competitora-law')
    expect(sourceFamilyForCollector({ url: 'https://competitor-c-crimes.example.com/cases' })).toBe('competitorc-law')
    expect(sourceFamilyForCollector({ url: 'https://competitor-c-alt.example.com/cases' })).toBe('competitor-c-alt.example.com')
    expect(sourceFamilyForCollector({ url: 'https://unknown-mirror.example/cases' })).toBe('unknown-mirror.example')
  })

  it('recognizes review-only discovery metadata, not a shared family alone', () => {
    expect(isAutoDiscoveredSource({
      name: '자동발견 · new-law.example',
      config: { discovery: { method: 'naver-web-search' } },
    })).toBe(true)
    expect(isAutoDiscoveredSource({ name: '검토 완료 소스', sourceFamily: 'competitord-law' })).toBe(false)
    expect(isAutoDiscoveredSource({
      name: '자동발견 · reviewed.example',
      config: {
        onboardingStatus: 'ready', autoDiscovered: true,
        collectionBlocked: 'auto-discovery', approvalStatus: 'approved',
      },
    })).toBe(false)
  })

  it('normalizes family aliases and gives non-URL collectors a stable identity', () => {
    expect(normalizeSourceFamily('competitorb')).toBe('competitorb-law')
    expect(normalizeSourceFamily('competitord')).toBe('competitord-law')
    expect(sourceFamilyForCollector({ type: 'naver_cafe', id: 'community-cafe' })).toBe('community-cafe')
    expect(sourceFamilyForCollector({
      type: 'naver_cafe', id: 'community-cafe', url: 'https://cafe.naver.com/samplecafe',
    })).toBe('community-cafe')
  })
})
