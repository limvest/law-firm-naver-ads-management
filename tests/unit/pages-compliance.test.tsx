// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ProductHome } from '../../app/page'
import Rehab from '../../app/rehab/page'
import Bankruptcy from '../../app/bankruptcy/page'
import { PrivacyContent } from '../../app/privacy/page'
import { AboutContent } from '../../app/about/page'
import { MembersContent } from '../../app/members/page'
import Criminal from '../../app/criminal/page'
import { findBannedTerms } from '@/lib/compliance/lexicon'

// scam(`app/scam/page.tsx`)은 T7에서 async 서버 컴포넌트(허브, DB 조회)가 되어 RTL
// 직접 렌더 불가 — pages 배열에서 제외한다. 이 허브의 정적 카피·단정 표현 없음·상담
// CTA 검증은 동일 카피를 쓰는 `tests/unit/scam-page.test.tsx`의 <ScamLanding /> 테스트
// (T6)와 `tests/unit/metadata-compliance.test.ts`의 scamHub metadata 테스트(T8)가 커버한다.
const pages: [string, () => React.ReactElement][] = [
  ['home', ProductHome], ['rehab', Rehab],
  ['bankruptcy', Bankruptcy], ['privacy', PrivacyContent],
  ['about', AboutContent], ['members', MembersContent], ['criminal', Criminal],
]

describe('페이지 컴플라이언스 (스펙 §5.3 금지어)', () => {
  for (const [name, Page] of pages) {
    it(`${name}: 금지어 0건`, () => {
      const { container } = render(<Page />)
      expect(findBannedTerms(container.textContent ?? '')).toEqual([])
    })
  }
})
