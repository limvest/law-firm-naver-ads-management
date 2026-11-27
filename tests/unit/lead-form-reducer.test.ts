import { describe, it, expect } from 'vitest'
import { formReducer, initialState } from '@/components/lead-form/reducer'

describe('formReducer', () => {
  it('scam: 유형 선택 → 금액 스텝', () => {
    const s1 = formReducer(initialState('scam'), { type: 'SELECT_TYPE', value: '리딩방' })
    expect(s1.step).toBe('amount')
    expect(s1.damageType).toBe('리딩방')
  })
  it('rehab: 유형 스텝 없이 금액부터 시작', () => {
    expect(initialState('rehab').step).toBe('amount')
  })
  it('금액 선택 → 연락처 스텝', () => {
    const s = formReducer(
      { ...initialState('scam'), step: 'amount', damageType: '리딩방' },
      { type: 'SELECT_AMOUNT', value: '1천만~5천만' },
    )
    expect(s.step).toBe('contact')
  })
  it('SUBMIT_OK → done', () => {
    const s = formReducer(
      { ...initialState('scam'), step: 'contact' },
      { type: 'SUBMIT_OK' },
    )
    expect(s.done).toBe(true)
  })
  it('BACK은 이전 스텝으로', () => {
    const s = formReducer(
      { ...initialState('scam'), step: 'amount' },
      { type: 'BACK' },
    )
    expect(s.step).toBe('type')
  })
})
