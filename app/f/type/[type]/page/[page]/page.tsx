import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SeoCaseIndex } from '@/components/scam/seo-case-index'
import { SEO_CATEGORIES, getSeoCasePage, getSeoCategory } from '@/lib/scam/seo-index'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lawfirm-ads.vercel.app'

export function generateStaticParams() {
  return SEO_CATEGORIES.flatMap((category) => {
    const { totalPages } = getSeoCasePage({ category: category.key })
    return Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => ({ type: category.key, page: String(index + 2) }))
  })
}

export async function generateMetadata({ params }: { params: Promise<{ type: string; page: string }> }): Promise<Metadata> {
  const { type, page: rawPage } = await params
  const category = getSeoCategory(type)
  const page = Number(rawPage)
  if (!category) return { title: '사건 유형을 찾을 수 없습니다' }
  const firm = await currentRequestFirm()
  const origin = firm?.domain ? `https://${firm.domain}` : `https://${DEFAULT_FIRM.domain}`
  return { title: `${category.label} 사건 목록 ${page}페이지`, description: category.description, alternates: { canonical: `${origin}/f/type/${category.key}/page/${page}` }, robots: firm ? undefined : { index: false, follow: true } }
}

export default async function SeoCategoryListPage({ params }: { params: Promise<{ type: string; page: string }> }) {
  const { type, page: rawPage } = await params
  const category = getSeoCategory(type)
  const page = Number(rawPage)
  if (!category || !Number.isInteger(page) || page < 2) notFound()
  const data = getSeoCasePage({ page, category: category.key })
  if (data.page !== page) notFound()
  const firm = await currentRequestFirm()
  const origin = firm?.domain ? `https://${firm.domain}` : `https://${DEFAULT_FIRM.domain}`
  return <SeoCaseIndex cases={data.items} page={data.page} totalPages={data.totalPages} total={data.total} category={category} origin={origin} sampleone={firm?.slug === 'sampleone'} />
}
