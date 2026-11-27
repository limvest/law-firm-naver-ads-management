import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

describe('cred-crypto', () => {
  beforeEach(() => { process.env.CRED_ENC_KEY = randomBytes(32).toString('base64') })

  it('암복호화 왕복', async () => {
    const { encryptCred, decryptCred } = await import('@/lib/engine/cred-crypto')
    const secret = 'naver-api-secret-0123456789'
    const enc = encryptCred(secret)
    expect(enc).not.toContain(secret)
    expect(enc.startsWith('v1:')).toBe(true)
    expect(decryptCred(enc)).toBe(secret)
  })

  it('키 미설정이면 명시적 에러', async () => {
    delete process.env.CRED_ENC_KEY
    const { encryptCred } = await import('@/lib/engine/cred-crypto')
    expect(() => encryptCred('x')).toThrow(/CRED_ENC_KEY/)
  })
})
