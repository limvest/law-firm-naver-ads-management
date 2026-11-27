import { createHash, createHmac } from 'node:crypto'

export type KeywordSubdomainMode = 'off' | 'shadow' | 'redirect' | 'canonical'

export const KEYWORD_HOST_RESERVED = new Set([
  'www', 'api', 'admin', 'operator', 'workspace', 'assets', 'static', 'mail',
  'fintech', 'sitemap', 'robots',
])

export function keywordSubdomainMode(): KeywordSubdomainMode {
  const value = process.env.KEYWORD_SUBDOMAIN_MODE
  return value === 'shadow' || value === 'redirect' || value === 'canonical' ? value : 'off'
}

function base32(buffer: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return output
}

export function keywordHostLabel(input: { firmId: number; keywordId: string; slug: string; secret?: string }): string {
  const secret = input.secret ?? process.env.KEYWORD_HOST_SIGNING_KEY
  let readable = input.slug.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/g, '')
  if (!readable || KEYWORD_HOST_RESERVED.has(readable)) readable = `case-${readable || 'item'}`.slice(0, 48)
  // A signing key keeps labels non-enumerable when configured.  Collection must
  // still be able to publish deterministic hosts in installations that predate
  // that optional key, so the fallback is a stable public identifier hash.
  const digest = secret && secret.length >= 32
    ? createHmac('sha256', secret).update(`${input.firmId}:${input.keywordId}`).digest()
    : createHash('sha256').update(`lawfirm-ads:keyword-host:v1:${input.firmId}:${input.keywordId}`).digest()
  const token = base32(digest).slice(0, 10)
  return `${readable}-${token}`
}

export function keywordChildLabel(host: string | null, parent = 'sampleone.attorney'): string | null {
  if (!host) return null
  const normalized = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  const suffix = `.${parent}`
  if (!normalized.endsWith(suffix)) return null
  const label = normalized.slice(0, -suffix.length)
  if (!label || label.includes('.') || KEYWORD_HOST_RESERVED.has(label)) return null
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null
}

export function matchingKeywordHost(label: string, hosts: Array<string | null | undefined>): string | null {
  return hosts.find((host): host is string => keywordChildLabel(host ?? null) === label) ?? null
}
