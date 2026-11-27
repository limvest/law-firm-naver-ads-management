import { normalizeHost } from '@/lib/engine/firms'

export const SAMPLEONE_FINTECH_HOST = 'fintech.sampleone.attorney'
export const SAMPLEONE_CANONICAL_HOST = 'sampleone.attorney'

export function isSampleoneFintechHost(host: string | null): boolean {
  return normalizeHost(host) === SAMPLEONE_FINTECH_HOST
}

export function isSampleoneHost(host: string | null): boolean {
  return normalizeHost(host) === SAMPLEONE_CANONICAL_HOST
}
