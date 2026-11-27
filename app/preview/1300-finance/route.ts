import { renderSampleoneRefV3Case } from '@/lib/engine/sampleone-ref-v3-case-render'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'
import { renderStoredScamArticle } from '@/lib/scam/article'

const PREVIEW_SLUG = '1300-7535a80914-g64ng6o4aq'

async function approvedArticleHtml(): Promise<string | undefined> {
  if (!process.env.DATABASE_URL) return undefined
  try {
    const { getDb } = await import('@/lib/db/client')
    const { keywords, scamPages } = await import('@/lib/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const rows = await getDb().select({ name: keywords.name, content: scamPages.content })
      .from(keywords)
      .innerJoin(scamPages, eq(scamPages.keywordId, keywords.id))
      .where(and(eq(keywords.slug, PREVIEW_SLUG), eq(scamPages.lintPassed, true)))
      .limit(1)
    return rows[0] ? renderStoredScamArticle(rows[0].name, rows[0].content) : undefined
  } catch {
    return undefined
  }
}

export async function GET() {
  return new Response(renderSampleoneRefV3Case({
    firm: SAMPLEONE_LOCAL_PREVIEW_FIRM,
    caseName: '1300억 금융',
    slug: PREVIEW_SLUG,
    canonical: 'https://1300-7535a80914-g64ng6o4aq.sampleone.attorney/',
    description: '1300억금융 사칭 사기피해 대응 안내',
    observationCount: 3,
    articleHtml: await approvedArticleHtml(),
    indexable: false,
  }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}
