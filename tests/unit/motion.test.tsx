// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { prefersReducedMotion, MOTION } from '@/lib/motion'
import { Reveal } from '@/components/reveal'

describe('motion 유틸', () => {
  it('reduced-motion 매치 시 true', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    expect(prefersReducedMotion()).toBe(true)
  })
  it('공통 리듬 상수 (스펙 §2.1)', () => {
    expect(MOTION.dur).toBe(0.7)
    expect(MOTION.stagger).toBe(0.16)
  })
})

describe('<Reveal />', () => {
  it('children을 렌더하고 reveal 클래스를 단다', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true })) // reduced → 즉시 표시 경로
    const { getByText, container } = render(<Reveal><p>내용</p></Reveal>)
    getByText('내용')
    expect(container.querySelector('.reveal')).toBeTruthy()
  })
})
