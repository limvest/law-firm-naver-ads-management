import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

function key(): Buffer {
  const b64 = process.env.LEAD_ENC_KEY
  if (!b64) throw new Error('LEAD_ENC_KEY is not set')
  const k = Buffer.from(b64, 'base64')
  if (k.length !== 32) throw new Error('LEAD_ENC_KEY must be 32 bytes (base64)')
  return k
}

export function encryptPII(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decryptPII(payload: string): string {
  const [v, ivB64, tagB64, ctB64] = payload.split(':')
  if (v !== 'v1') throw new Error('unknown payload version')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}

/** 암호화 원문을 복호화하지 않고 같은 값인지 비교하기 위한 용도별 결정적 지문. */
export function fingerprintPII(namespace: string, normalizedValue: string): string {
  return createHmac('sha256', key())
    .update(`lawfirm-ads:${namespace}:v1:${normalizedValue}`)
    .digest('hex')
}
