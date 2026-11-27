import type { MetadataRoute } from 'next'
import { currentRequestOrigin } from '@/lib/engine/request-firm'

export default async function robots(): Promise<MetadataRoute.Robots> {
  const productBase = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, '') || 'https://lawfirm-ads.vercel.app'
  let base = productBase
  try { base = await currentRequestOrigin() } catch { /* 빌드·DB 장애 시 제품 호스트 정책 */ }
  return {
    rules: [{
      userAgent: '*',
      allow: '/',
      disallow: ['/api/'],
    }],
    sitemap: `${base}/sitemap.xml`,
  }
}
