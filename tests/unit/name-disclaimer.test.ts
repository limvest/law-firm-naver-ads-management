import { describe, expect, it } from 'vitest'
import { THIRD_PARTY_NAME_DISCLAIMER } from '@/lib/compliance/name-disclaimer'

describe('사건명 권리·사칭 고지문', () => {
  it('제3자 명칭 도용과 정식 등록 업체를 구분한다', () => {
    expect(THIRD_PARTY_NAME_DISCLAIMER).toContain('제3자 불법 업체')
    expect(THIRD_PARTY_NAME_DISCLAIMER).toContain('정식 등록 업체와는 무관')
  })
})
