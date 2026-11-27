// app/d/[token]/keywords/page.tsx의 순수 배지 판정 함수 3종 — 최종 리뷰 I4(a)·I4(b) 회귀.
// 페이지 컴포넌트 자체(DB·인증·렌더)는 건드리지 않고, 상태 판정 로직만 직접 단위 테스트한다
// (dashboard-ads.test.ts의 "authored copy" 관행과 별개 — 여기는 분기 로직 자체를 검증).
import { describe, it, expect } from 'vitest'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { badgeLabel, badgeStyle, pendingBadgeLabel } from '../../app/d/[token]/keywords/page'

describe('badgeLabel — 최종 리뷰 I4(a)', () => {
  it('adStage null(미등록) → 등록 예정', () => {
    expect(badgeLabel(null, undefined)).toBe('등록 예정')
  })

  it('subscribed∧desired=false → 제외됨(내림) — registration-plan adDesired 필터로 영구 제외', () => {
    expect(badgeLabel('subscribed', false)).toBe('제외됨(내림)')
  })

  it('subscribed∧desired=true → 등록 진행 중(정상 파이프라인 진행)', () => {
    expect(badgeLabel('subscribed', true)).toBe('등록 진행 중')
  })

  it('subscribed∧desired=undefined(행은 있으나 맵 조회 실패 등 방어) → 등록 진행 중(기존 폴백 유지)', () => {
    expect(badgeLabel('subscribed', undefined)).toBe('등록 진행 중')
  })

  it('ad_registered/live/rejected는 desired 무관하게 확정 단계 라벨', () => {
    expect(badgeLabel('ad_registered', false)).toBe('심사 중')
    expect(badgeLabel('live', false)).toBe('라이브')
    expect(badgeLabel('rejected', true)).toBe('보완 필요')
  })

  it('제외됨(내림) 라벨은 findBannedTerms 클린 + "구독" 미포함(브리프 어휘 지시)', () => {
    const label = badgeLabel('subscribed', false)
    expect(findBannedTerms(label)).toEqual([])
    expect(label).not.toContain('구독')
  })
})

describe('badgeStyle — subscribed∧desired=false는 진행 중류 강조색이 아니라 중립색', () => {
  it('subscribed∧desired=false는 null(미등록)과 동일한 중립 스타일', () => {
    expect(badgeStyle('subscribed', false)).toEqual(badgeStyle(null, undefined))
  })

  it('subscribed∧desired=true는 여전히 진행 중 강조색(회귀 없음)', () => {
    const style = badgeStyle('subscribed', true)
    expect(style).not.toEqual(badgeStyle(null, undefined))
  })
})

describe('pendingBadgeLabel — 최종 리뷰 I4(b)', () => {
  it('paused∧desired=true∧naverAdgroupId 존재 → 올림(반영 대기)', () => {
    expect(pendingBadgeLabel('paused', true, true)).toBe('올림(반영 대기)')
  })

  it('paused∧desired=true∧naverAdgroupId 없음 → 배지 억제(null) — reconcileAds가 영구 skip하는 조합', () => {
    expect(pendingBadgeLabel('paused', true, false)).toBeNull()
  })

  it('paused∧desired=false는 naverAdgroupId 유무와 무관하게 내려짐', () => {
    expect(pendingBadgeLabel('paused', false, true)).toBe('내려짐')
    expect(pendingBadgeLabel('paused', false, false)).toBe('내려짐')
  })

  it('desired=false ∧ status∈{ad_registered, live} → 내림(반영 대기)', () => {
    expect(pendingBadgeLabel('ad_registered', false, true)).toBe('내림(반영 대기)')
    expect(pendingBadgeLabel('live', false, true)).toBe('내림(반영 대기)')
  })

  it('그 외 정합 조합은 배지 없음(null)', () => {
    expect(pendingBadgeLabel('ad_registered', true, true)).toBeNull()
    expect(pendingBadgeLabel('subscribed', true, false)).toBeNull()
  })
})
