import { describe, it, expect } from 'vitest'
import { siteConfig } from '@/config/site'

describe('siteConfig', () => {
  it('필수 사무소 필드가 전부 비어있지 않다', () => {
    expect(siteConfig.firmName.length).toBeGreaterThan(0)
    expect(siteConfig.adLawyerName.length).toBeGreaterThan(0)
    expect(siteConfig.phone.length).toBeGreaterThan(0)
    expect(siteConfig.kakaoUrl === '' || /^https:\/\/pf\.kakao\.com\//.test(siteConfig.kakaoUrl)).toBe(true)
    expect(siteConfig.address.length).toBeGreaterThan(0)
  })
})
