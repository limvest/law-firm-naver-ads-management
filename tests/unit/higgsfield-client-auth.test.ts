import { describe, expect, it } from 'vitest'
import {
  HIGGSFIELD_CLIENT_COOKIE,
  higgsfieldClientSessionCookie,
  higgsfieldClientSessionValue,
  validHiggsfieldClientSession,
} from '@/lib/higgsfield-client-auth'

describe('Higgsfield client session isolation', () => {
  const secret = 'client-session-secret'

  it('binds the session signature to one firm id', () => {
    const firmTwo = higgsfieldClientSessionValue(secret, 2)
    expect(validHiggsfieldClientSession(firmTwo, secret, 2)).toBe(true)
    expect(validHiggsfieldClientSession(firmTwo, secret, 3)).toBe(false)
    expect(validHiggsfieldClientSession(firmTwo, 'rotated', 2)).toBe(false)
  })

  it('uses a dedicated cookie restricted to the client route', () => {
    const cookie = higgsfieldClientSessionCookie(secret, 2)
    expect(cookie).toContain(`${HIGGSFIELD_CLIENT_COOKIE}=`)
    expect(cookie).toContain('Path=/workspace')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).not.toContain('lawfirm_admin_session')
  })
})
