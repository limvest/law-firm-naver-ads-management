import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'

beforeAll(() => {
  process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
})

describe('PII crypto', () => {
  it('암복호화 라운드트립', async () => {
    const { encryptPII, decryptPII } = await import('@/lib/crypto')
    const enc = encryptPII('010-1234-5678')
    expect(enc).toMatch(/^v1:/)
    expect(enc).not.toContain('010-1234-5678')
    expect(decryptPII(enc)).toBe('010-1234-5678')
  })
  it('같은 평문도 매번 다른 암호문 (IV 무작위)', async () => {
    const { encryptPII } = await import('@/lib/crypto')
    expect(encryptPII('홍길동')).not.toBe(encryptPII('홍길동'))
  })
  it('변조된 payload는 예외', async () => {
    const { encryptPII, decryptPII } = await import('@/lib/crypto')
    const enc = encryptPII('secret')
    const parts = enc.split(':')
    parts[3] = Buffer.from('tampered!!').toString('base64')
    expect(() => decryptPII(parts.join(':'))).toThrow()
  })
})
