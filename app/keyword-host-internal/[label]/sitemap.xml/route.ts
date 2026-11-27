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
  if (!host) {
    return new Response(null, { status: 302, headers: { Location: 'https://sampleone.attorney/' } })
  }
  const mapped = await resolvePublicKeywordHost(getDb(), label).catch(() => null)
  if (!mapped) {
    return new Response(null, { status: 302, headers: { Location: 'https://sampleone.attorney/' } })
  }
  const url = `https://${label}.${mapped.firm.domain}/`
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url}</loc><changefreq>daily</changefreq><priority>0.8</priority></url></urlset>`
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Host',
    },
  })
}
