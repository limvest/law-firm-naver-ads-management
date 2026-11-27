import { getDb } from '@/lib/db/client'
import { caseResultsForFirm } from '@/lib/dashboard/firm-profile'
import { DEFAULT_FIRM, normalizeHost } from '@/lib/engine/firms'
import { resolvePublicFirm } from '@/lib/engine/public-firm'
import { renderFirmProfilePage } from '@/lib/engine/firm-profile-render'

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lawfirm-ads.vercel.app'

export async function firmProfileResponse(request: Request, page: 'lawyers' | 'results'): Promise<Response> {
  const url = new URL(request.url)
  const preview = url.searchParams.get('preview') === '1'
  const previewSlug = preview ? url.searchParams.get('firm') ?? undefined : undefined
  const db = process.env.DATABASE_URL ? getDb() : null
  const firm = await resolvePublicFirm(db, request.headers.get('host'), previewSlug)

  if (!preview && firm.id !== DEFAULT_FIRM.id && !firm.landingReady) {
    return new Response('Not Found', { status: 404, headers: { Vary: 'Host' } })
  }

  let results: Awaited<ReturnType<typeof caseResultsForFirm>> = []
  if (page === 'results' && db) {
    try { results = await caseResultsForFirm(db, firm.id, true) } catch { /* 마이그레이션 순차 배포 중 폴백 */ }
  }
  const origin = firm.domain ? `https://${firm.domain}` : SITE
  const canonical = `${origin}/${page}`
  const previewQuery = previewSlug ? `?preview=1&firm=${encodeURIComponent(previewSlug)}` : ''
  const hostMatchesFirm = Boolean(firm.domain && normalizeHost(request.headers.get('host')) === firm.domain)
  const noindex = preview || !hostMatchesFirm

  return new Response(renderFirmProfilePage({
    firm,
    page,
    results,
    canonical,
    previewQuery,
    noindex,
  }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': preview ? 'no-store' : 's-maxage=3600, stale-while-revalidate=86400',
      Vary: 'Host',
      ...(noindex ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    },
  })
}
