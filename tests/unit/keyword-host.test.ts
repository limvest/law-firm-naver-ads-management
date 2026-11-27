import { describe, expect, it } from 'vitest'
import { keywordChildLabel, keywordHostLabel, matchingKeywordHost } from '@/lib/engine/keyword-host'

describe('사건명 서브도메인', () => {
  const secret = 'test-secret-that-is-long-enough-for-hmac-key'

  it('firm·keyword별 결정적이면서 추측 불가능한 DNS label을 만든다', () => {
    const a = keywordHostLabel({ firmId: 289283342, keywordId: '11111111-1111-4111-8111-111111111111', slug: 'mockf', secret })
    const b = keywordHostLabel({ firmId: 289283342, keywordId: '22222222-2222-4222-8222-222222222222', slug: 'mockf', secret })
    expect(a).toMatch(/^mockf-[a-z2-7]{10}$/)
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(59)
  })

  it('직계 사건 호스트만 받고 예약·다단계 호스트를 거부한다', () => {
    expect(keywordChildLabel('mockf-abcdefghij.sampleone.attorney')).toBe('mockf-abcdefghij')
    expect(keywordChildLabel('fintech.sampleone.attorney')).toBeNull()
    expect(keywordChildLabel('x.y.sampleone.attorney')).toBeNull()
    expect(keywordChildLabel('evilsampleone.attorney')).toBeNull()
  })

  it('내부 rewrite 호스트보다 요청한 사건 라벨과 일치하는 Host를 선택한다', () => {
    expect(matchingKeywordHost('case-abcdefghij', [
      '0.0.0.0:3000',
      'case-abcdefghij.sampleone.attorney',
    ])).toBe('case-abcdefghij.sampleone.attorney')
  })
})
