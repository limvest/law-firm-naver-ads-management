import { headers } from 'next/headers'
import { getDb } from '@/lib/db/client'
import { resolveFirmByExactHost, type Firm } from '@/lib/engine/firms'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'
import { isSampleoneFintechHost, isSampleoneHost, SAMPLEONE_CANONICAL_HOST } from '@/lib/engine/theme-host'

export async function currentRequestFirm(): Promise<Firm | null> {
  if (!process.env.DATABASE_URL) return null
  const requestHeaders = await headers()
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host')
  const lookupHost = isSampleoneFintechHost(host) ? SAMPLEONE_CANONICAL_HOST : host
  const sampleoneRequest = isSampleoneHost(lookupHost)
  try {
    const firm = await resolveFirmByExactHost(getDb(), lookupHost)
    // 샘플원 도메인은 DB 장애나 초기 이관 누락 때문에 공용 제품 홈으로 떨어지면 안 된다.
    return firm ?? (sampleoneRequest ? SAMPLEONE_LOCAL_PREVIEW_FIRM : null)
  } catch {
    return sampleoneRequest ? SAMPLEONE_LOCAL_PREVIEW_FIRM : null
  }
}

export async function currentRequestIsSampleoneFintech(): Promise<boolean> {
  const requestHeaders = await headers()
  return isSampleoneFintechHost(requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host'))
}

export async function currentRequestOrigin(): Promise<string> {
  const requestHeaders = await headers()
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host')
  const protocol = requestHeaders.get('x-forwarded-proto') ?? (host?.includes('localhost') ? 'http' : 'https')
  const productBase = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, '') || 'https://lawfirm-ads.vercel.app'
  return host ? `${protocol}://${host}` : productBase
}
