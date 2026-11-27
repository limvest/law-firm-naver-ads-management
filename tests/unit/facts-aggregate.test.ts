import { describe, it, expect } from 'vitest'
import { aggregateFacts } from '@/lib/scam/facts'

const F = (m: string[], i: { type: string; value: string }[] = [], a: string[] = []) =>
  ({ method: m, infra: i, amounts: a })

describe('aggregateFacts', () => {
  it('빈 입력·전부 빈 facts → null (F-FALL 유지)', () => {
    expect(aggregateFacts([])).toBeNull()
    expect(aggregateFacts([null, undefined, F([], [], [])])).toBeNull()
  })

  it('수법 태그 빈도 내림차순 집계', () => {
    const agg = aggregateFacts([F(['리딩방', '선입금요구']), F(['리딩방']), F(['텔레그램유인', '리딩방'])])!
    expect(agg.methodCounts[0]).toEqual({ tag: '리딩방', count: 3 })
    expect(agg.methodCounts.map((m) => m.tag)).toContain('선입금요구')
    expect(agg.factCount).toBe(3)
  })

  it('인프라 유형별 그룹 — 값 중복 제거(대소문자 무시), 언급 횟수 보존', () => {
    const agg = aggregateFacts([
      F([], [{ type: 'telegram', value: '@Sampletg124' }, { type: 'telegram', value: '@sampletg124' }]),
      F([], [{ type: 'telegram', value: '@Sampletg122' }, { type: 'bank', value: '국민은행' }]),
      F([], [{ type: 'bank', value: '국민은행' }]),
    ])!
    const tg = agg.infraByType.find((i) => i.type === 'telegram')!
    expect(tg.values).toEqual(['@Sampletg124', '@Sampletg122']) // 첫 표기 유지
    expect(tg.count).toBe(3)                                   // 원 언급 횟수
    const bank = agg.infraByType.find((i) => i.type === 'bank')!
    expect(bank.values).toEqual(['국민은행'])
    expect(bank.count).toBe(2)
  })

  it('인프라 유형 고정 순서: telegram→kakao→site→app→bank→wallet→company→기타', () => {
    const agg = aggregateFacts([F([], [
      { type: 'bank', value: 'A은행' }, { type: 'telegram', value: '@x' }, { type: 'site', value: 'x.com' },
    ])])!
    expect(agg.infraByType.map((i) => i.type)).toEqual(['telegram', 'site', 'bank'])
  })

  it('금액 원문 그대로 중복 제거, 순서 보존', () => {
    const agg = aggregateFacts([F([], [], ['6천만원', '1억8600만원']), F([], [], ['6천만원'])])!
    expect(agg.amounts).toEqual(['6천만원', '1억8600만원'])
  })

  it('부분 결손 facts (method 키 없음 등) 방어', () => {
    const agg = aggregateFacts([{ infra: [{ type: 'site', value: 'x.com' }] } as never])!
    expect(agg.methodCounts).toEqual([])
    expect(agg.infraByType[0].values).toEqual(['x.com'])
  })
})
