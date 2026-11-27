import type { MetadataRoute } from 'next'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { caseEntities, contentAssets, keywords, publications } from '@/lib/db/schema'
import { SEO_CATEGORIES, caseIndexPath, getPublicSeoCases, getSeoCasePage } from '@/lib/scam/seo-index'
import { currentRequestFirm, currentRequestIsSampleoneFintech, currentRequestOrigin } from '@/lib/engine/request-firm'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'
import type { Firm } from '@/lib/engine/firms'

const STATIC_PATHS = ['', '/about', '/members', '/lawyers', '/results', '/criminal', '/scam', '/f', '/rehab', '/bankruptcy']
const SAMPLEONE_STATIC_PATHS = ['', '/privacy']

// /f/[slug] 공개 상태 — app/f/[slug]/route.ts 의 PUBLIC_STATUSES 와 동기
const F_PUBLIC_STATUSES = ['verified', 'generated', 'published', 'ad_registered', 'live']

export async function sitemapForFirm(firm: Firm | null, sampleoneFintech = false): Promise<MetadataRoute.Sitemap> {
  const productBase = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, '') || 'https://lawfirm-ads.vercel.app'
  if (!firm?.domain) return [{ url: productBase, changeFrequency: 'weekly' }]
  const base = sampleoneFintech ? 'https://fintech.sampleone.attorney' : `https://${firm.domain}`
  const isSampleone = firm.slug === 'sampleone'
  const staticPaths = sampleoneFintech ? ['', '/fraud'] : isSampleone ? SAMPLEONE_STATIC_PATHS : STATIC_PATHS
  const entries: MetadataRoute.Sitemap = staticPaths.map((p) => ({
    url: `${base}${p}`,
    changeFrequency: 'weekly' as const,
    priority: p === '' ? 1 : p === '/f' ? 0.9 : 0.6,
  }))
  const seen = new Set(entries.map((entry) => entry.url))
  const targetSlugs = new Set<string>()

  const push = (entry: MetadataRoute.Sitemap[number]) => {
    if (seen.has(entry.url)) return
    seen.add(entry.url)
    entries.push(entry)
  }

  if (sampleoneFintech) {
    // 핀테크 사건 상세는 대량 열거를 유발하므로 허브만 사이트맵에 둔다.
    return entries
  }

  // 사건 정본은 개별 서브도메인 sitemap 한 건씩만 제공한다. 루트에서는 목록을 노출하지 않는다.
  if (isSampleone) return entries

  // Target-model SEO publications are the canonical discoverable URLs.
  // Advertising landings are intentionally noindex and never enter sitemap.
  try {
    const db = getDb()
    const targetRows = await db.select({
      slug: caseEntities.slug,
      canonicalUrl: publications.canonicalUrl,
      updatedAt: publications.updatedAt,
    }).from(publications)
      .innerJoin(contentAssets, eq(contentAssets.id, publications.contentAssetId))
      .innerJoin(caseEntities, eq(caseEntities.id, contentAssets.caseEntityId))
      .where(and(
        eq(publications.firmId, firm.id),
        eq(publications.domain, firm.domain),
        eq(publications.status, 'live'),
        eq(publications.indexPolicy, 'index'),
        eq(contentAssets.assetType, 'seo_page'),
        eq(caseEntities.status, 'approved'),
      ))
    for (const row of targetRows) {
      if (isSampleone) continue
      let canonical: URL
      try { canonical = new URL(row.canonicalUrl) } catch { continue }
      if (canonical.origin !== base || canonical.pathname !== `/case/${encodeURIComponent(row.slug)}`) continue
      targetSlugs.add(row.slug)
      push({
        url: canonical.toString(),
        lastModified: row.updatedAt,
        changeFrequency: 'daily',
        priority: 0.8,
      })
    }
  } catch {
    // Migration 전 DB에서는 기존 /f 사이트맵을 유지한다.
  }

  // DB가 없어도 에이전트 스테이징의 공개 사건은 허브·상세·사이트맵에 동일하게 반영한다.
  const publicCases = getPublicSeoCases()
  const allPages = getSeoCasePage({}).totalPages
  for (let page = 2; page <= allPages; page++) {
    push({ url: `${base}${caseIndexPath(page)}`, changeFrequency: 'daily' })
  }
  for (const category of SEO_CATEGORIES) {
    const categoryPage = getSeoCasePage({ category: category.key })
    if (!categoryPage.total) continue
    push({ url: `${base}${caseIndexPath(1, category.key)}`, changeFrequency: 'daily' })
    for (let page = 2; page <= categoryPage.totalPages; page++) {
      push({ url: `${base}${caseIndexPath(page, category.key)}`, changeFrequency: 'daily' })
    }
  }
  for (const item of publicCases) {
    if (!isSampleone && targetSlugs.has(item.slug)) continue
    push({
      url: `${base}/f/${encodeURIComponent(item.slug)}`,
      lastModified: item.lastSeenAt ?? item.firstSeenAt ?? undefined,
      changeFrequency: 'daily',
      priority: 0.8,
    })
  }

  try {
    const db = getDb()
    // DB에만 존재하는 공개 사건도 /f 정본으로 합친다. /scam/[slug]는 canonical 중복이라 제외한다.
    const fRows = await db
      .select({ slug: keywords.slug })
      .from(keywords)
      .where(inArray(keywords.status, F_PUBLIC_STATUSES))
    for (const r of fRows) {
      if (!isSampleone && targetSlugs.has(r.slug)) continue
      push({ url: `${base}/f/${encodeURIComponent(r.slug)}`, changeFrequency: 'daily', priority: 0.8 })
    }
  } catch {
    // DB 미설정 빌드에서도 sitemap은 생성된다
  }
  return entries
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const [firm, sampleoneFintech] = await Promise.all([currentRequestFirm(), currentRequestIsSampleoneFintech()])
    if (!firm) {
      const hostname = new URL(await currentRequestOrigin()).hostname
      if (hostname === 'sampleone.attorney' || hostname === 'www.sampleone.attorney') {
        return sitemapForFirm(SAMPLEONE_LOCAL_PREVIEW_FIRM, false)
      }
    }
    return sitemapForFirm(firm, sampleoneFintech)
  } catch {
    return sitemapForFirm(null)
  }
}
