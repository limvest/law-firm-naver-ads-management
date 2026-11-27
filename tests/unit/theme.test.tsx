// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { themeFor } from '@/lib/theme'
import { ThemeScope } from '@/components/theme-scope'

describe('themeFor', () => {
  it('라우트→테마 매핑 (스펙 §3)', () => {
    expect(themeFor('/')).toBe('firm')
    expect(themeFor('/about')).toBe('firm')
    expect(themeFor('/rehab')).toBe('rehab')
    expect(themeFor('/bankruptcy')).toBe('rehab')
    expect(themeFor('/scam')).toBe('scam')
    expect(themeFor('/scam/leading-room')).toBe('scam')
  })
})

describe('<ThemeScope />', () => {
  it('data-vertical 속성을 렌더한다', () => {
    const { container } = render(<ThemeScope vertical="rehab"><p>x</p></ThemeScope>)
    const el = container.querySelector('[data-vertical="rehab"]')
    expect(el).toBeTruthy()
    expect(el!.className).toContain('theme-scope')
    expect(el!.textContent).toBe('x')
  })
})
