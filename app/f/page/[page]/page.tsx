import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SeoCaseIndex } from '@/components/scam/seo-case-index'
import { getSeoCasePage } from '@/lib/scam/seo-index'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lawfirm-ads.vercel.app'

export function generateStaticParams() {
  const { totalPages } = getSeoCasePage({})
  return Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => ({ page: String(index + 2) }))
}

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }): Promise<Metadata> {
  const page = Number((await params).page)
  const firm = await currentRequestFirm()
  const origin = firm?.domain ? `https://${firm.domain}` : `https://${DEFAULT_FIRM.domain}`
  return { title: `금융사기 사건정보 ${page}페이지`, description: '최근 확인된 금융사기 사건 목록과 사건별 피해 대응 정보를 확인합니다.', alternates: { canonical: `${origin}/f/page/${page}` }, robots: firm ? undefined : { index: false, follow: true } }
}

export default async function SeoCaseListPage({ params }: { params: Promise<{ page: string }> }) {
  const page = Number((await params).page)
  if (!Number.isInteger(page) || page < 2) notFound()
  const data = getSeoCasePage({ page })
  if (data.page !== page) notFound()
  const firm = await currentRequestFirm()
  const origin = firm?.domain ? `https://${firm.domain}` : `https://${DEFAULT_FIRM.domain}`
  return <SeoCaseIndex cases={data.items} page={data.page} totalPages={data.totalPages} total={data.total} origin={origin} sampleone={firm?.slug === 'sampleone'} />
}
