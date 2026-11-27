import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'
import { CONTENT_SECURITY_POLICY_REPORT_ONLY, securityHeaders } from '@/lib/security/headers'

function headerValue(key: string): string | undefined {
  return securityHeaders.find((header) => header.key === key)?.value
}

describe('보안 응답 헤더', () => {
  it('전역 헤더 설정이 Next 설정에 연결된다', async () => {
    expect(nextConfig.poweredByHeader).toBe(false)

    const configured = await nextConfig.headers?.()
    expect(configured).toEqual([
      { source: '/(.*)', headers: securityHeaders },
    ])
  })

  it('Report-Only CSP가 현재 랜딩 의존성과 프레이밍 방어를 명시한다', () => {
    expect(headerValue('Content-Security-Policy-Report-Only')).toBe(CONTENT_SECURITY_POLICY_REPORT_ONLY)
    expect(CONTENT_SECURITY_POLICY_REPORT_ONLY).toContain("frame-ancestors 'none'")
    expect(CONTENT_SECURITY_POLICY_REPORT_ONLY).toContain("script-src 'self' 'unsafe-inline'")
    expect(CONTENT_SECURITY_POLICY_REPORT_ONLY).toContain('https://fonts.googleapis.com')
    expect(CONTENT_SECURITY_POLICY_REPORT_ONLY).toContain('https://cdn.jsdelivr.net')
    expect(CONTENT_SECURITY_POLICY_REPORT_ONLY).toContain('https://cdnjs.cloudflare.com')
    expect(CONTENT_SECURITY_POLICY_REPORT_ONLY).toContain('https://www.googletagmanager.com')
    expect(CONTENT_SECURITY_POLICY_REPORT_ONLY).toContain('https://wcs.naver.net')
  })

  it('기본 방어 헤더를 고정한다', () => {
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff')
    expect(headerValue('X-Frame-Options')).toBe('DENY')
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headerValue('Permissions-Policy')).toContain('camera=()')
    expect(headerValue('Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(headerValue('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
  })
})
