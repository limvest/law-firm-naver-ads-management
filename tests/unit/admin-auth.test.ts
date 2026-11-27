import { describe, expect, it } from 'vitest'
import {
  ADMIN_SESSION_COOKIE,
  adminSessionCookie,
  adminSessionValue,
  validAdminCredential,
  validAdminSession,
} from '@/lib/admin-auth'

describe('운영자 세션 인증', () => {
  const secret = 'a-strong-admin-secret'

  it('초기 자격증명과 HMAC 세션을 일정시간 비교한다', () => {
    expect(validAdminCredential(secret, secret)).toBe(true)
    expect(validAdminCredential('wrong', secret)).toBe(false)
    const session = adminSessionValue(secret)
    expect(session).not.toContain(secret)
    expect(validAdminSession(session, secret)).toBe(true)
    expect(validAdminSession(session, 'rotated')).toBe(false)
  })

  it('원문 토큰 없이 보안 쿠키를 만든다', () => {
    const cookie = adminSessionCookie(secret)
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=`)
    expect(cookie).not.toContain(secret)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
  })
})
