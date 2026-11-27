import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const HIGGSFIELD_CLIENT_COOKIE = 'lawfirm_higgsfield_client_session'

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function higgsfieldClientSessionValue(secret: string, firmId: number): string {
  const signature = createHmac('sha256', secret)
    .update(`lawfirm-higgsfield-client-session:v1:firm:${firmId}`)
    .digest('base64url')
  return `${firmId}.${signature}`
}

export function firmIdFromHiggsfieldClientSession(
  session: string | null | undefined,
  secret: string | null | undefined,
): number | null {
  if (!session || !secret) return null
  const separator = session.indexOf('.')
  if (separator < 1) return null
  const firmId = Number(session.slice(0, separator))
  if (!Number.isSafeInteger(firmId) || firmId < 1) return null
  return safeEqual(session, higgsfieldClientSessionValue(secret, firmId)) ? firmId : null
}

export function validHiggsfieldClientSession(
  session: string | null | undefined,
  secret: string | null | undefined,
  firmId: number,
): boolean {
  return firmIdFromHiggsfieldClientSession(session, secret) === firmId
}

export function higgsfieldClientSessionCookie(secret: string, firmId: number): string {
  return `${HIGGSFIELD_CLIENT_COOKIE}=${higgsfieldClientSessionValue(secret, firmId)}; Path=/workspace; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`
}

export function hashFirmPassword(password: string, salt = randomBytes(16).toString('base64url')): string {
  if (password.length < 4 || password.length > 200) throw new TypeError('invalid password length')
  const digest = scryptSync(password, salt, 32).toString('base64url')
  return `scrypt-v1$${salt}$${digest}`
}

export function verifyFirmPassword(password: string, encoded: string): boolean {
  const [version, salt, digest] = encoded.split('$')
  if (version !== 'scrypt-v1' || !salt || !digest || password.length > 200) return false
  try {
    return safeEqual(scryptSync(password, salt, 32).toString('base64url'), digest)
  } catch {
    return false
  }
}
