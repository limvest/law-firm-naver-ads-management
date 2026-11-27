import { getDb } from '@/lib/db/client'
import { resolvePublicKeywordHost } from '@/lib/engine/keyword-host-db'
import { matchingKeywordHost } from '@/lib/engine/keyword-host'

export async function GET(request: Request, { params }: { params: Promise<{ label: string }> }) {
  const { label } = await params
  const host = matchingKeywordHost(label, [
    request.headers.get('x-forwarded-host'),
    request.headers.get('host'),
    new URL(request.url).host,
  ])
  const mapped = host
    ? await resolvePublicKeywordHost(getDb(), label).catch(() => null)
    : null
  if (!mapped) {
    return new Response('User-agent: *\nDisallow: /\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain', 'X-Robots-Tag': 'noindex, nofollow' },
    })
  }
  const origin = `https://${label}.${mapped.firm.domain}`
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Host',
    },
  })
}
