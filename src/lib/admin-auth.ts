import { createHmac, timingSafeEqual } from 'node:crypto'

export const ADMIN_SESSION_COOKIE = 'lawfirm_admin_session'

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function validAdminCredential(supplied: string | null | undefined, secret: string | null | undefined): boolean {
  return Boolean(supplied && secret && safeEqual(supplied, secret))
}

export function adminSessionValue(secret: string): string {
  return createHmac('sha256', secret).update('lawfirm-admin-session:v1').digest('base64url')
}

export function validAdminSession(session: string | null | undefined, secret: string | null | undefined): boolean {
  return Boolean(session && secret && safeEqual(session, adminSessionValue(secret)))
}

export function adminSessionCookie(secret: string, secure = true): string {
  return `${ADMIN_SESSION_COOKIE}=${adminSessionValue(secret)}; Path=/; Max-Age=2592000; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict`
}
