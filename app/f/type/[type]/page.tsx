import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SeoCaseIndex } from '@/components/scam/seo-case-index'
import { SEO_CATEGORIES, getSeoCasePage, getSeoCategory } from '@/lib/scam/seo-index'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lawfirm-ads.vercel.app'

export function generateStaticParams() {
  return SEO_CATEGORIES.map((category) => ({ type: category.key }))
}

export async function generateMetadata({ params }: { params: Promise<{ type: string }> }): Promise<Metadata> {
  const category = getSeoCategory((await params).type)
  if (!category) return { title: '사건 유형을 찾을 수 없습니다' }
  const firm = await currentRequestFirm()
  const origin = firm?.domain ? `https://${firm.domain}` : `https://${DEFAULT_FIRM.domain}`
  return { title: `${category.label} 사건 목록과 피해 대응`, description: category.description, alternates: { canonical: `${origin}/f/type/${category.key}` }, robots: firm ? undefined : { index: false, follow: true } }
}

export default async function SeoCategoryPage({ params }: { params: Promise<{ type: string }> }) {
  const category = getSeoCategory((await params).type)
  if (!category) notFound()
  const data = getSeoCasePage({ category: category.key })
  const firm = await currentRequestFirm()
  const origin = firm?.domain ? `https://${firm.domain}` : `https://${DEFAULT_FIRM.domain}`
  return <SeoCaseIndex cases={data.items} page={data.page} totalPages={data.totalPages} total={data.total} category={category} origin={origin} sampleone={firm?.slug === 'sampleone'} />
}
