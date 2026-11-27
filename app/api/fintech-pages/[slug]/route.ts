import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDb } from '@/lib/db/client'
import { firms } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  extractMirrorCaseName,
  getSampleoneFintechCaseProjection,
  renderSampleoneFintechMirrorHtml,
} from '@/lib/scam/sampleone-fintech-mirror'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SAMPLEONE_DOMAIN = 'sampleone.attorney'
const SAFE_SLUG = /^[\p{L}\p{N}._-]+$/u

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  if (!SAFE_SLUG.test(slug)) return new Response('Not found', { status: 404 })

  let template: string
  try {
    template = await readFile(
      join(process.cwd(), 'public', 'sampleone-fintech-mirror', 'fraud', `${slug}.html`),
      'utf8',
    )
  } catch {
    return new Response('Not found', { status: 404 })
  }

  let projection = null
  try {
    const db = getDb()
    const [firm] = await db.select({ id: firms.id }).from(firms)
      .where(eq(firms.domain, SAMPLEONE_DOMAIN)).limit(1)
    if (firm) {
      projection = await getSampleoneFintechCaseProjection(db, {
        publicSlug: slug,
        caseName: extractMirrorCaseName(template, slug),
        firmId: firm.id,
      })
    }
  } catch (error) {
    console.error('[fintech-pages] DB projection failed; serving mirror fallback', error)
  }

  return new Response(renderSampleoneFintechMirrorHtml(template, projection, slug), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      Vary: 'Host',
    },
  })
}
