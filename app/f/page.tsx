import type { Metadata } from 'next'
import { SeoCaseIndex } from '@/components/scam/seo-case-index'
import { getSeoCasePage } from '@/lib/scam/seo-index'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lawfirm-ads.vercel.app'

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ q?: string }> }): Promise<Metadata> {
  const { q = '' } = await searchParams
  const firm = await currentRequestFirm()
  const origin = firm?.domain ? `https://${firm.domain}` : `https://${DEFAULT_FIRM.domain}`
  return {
    title: q ? `${q} 관련 사건 검색 | 금융사기 사건정보` : '금융사기 사건정보 | 업체명·앱·정보방 검색',
    description: '금융사기 업체명, 플랫폼명, 앱과 정보방명을 검색하고 사건별 접근 방식과 피해 대응 순서를 확인합니다.',
    alternates: { canonical: `${origin}/f` },
    robots: q || !firm ? { index: false, follow: true } : { index: true, follow: true },
  }
}

export default async function SeoCaseHubPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = '' } = await searchParams
  const data = getSeoCasePage({ query: q })
  const firm = await currentRequestFirm()
  const origin = firm?.domain ? `https://${firm.domain}` : `https://${DEFAULT_FIRM.domain}`
  return <SeoCaseIndex cases={data.items} page={data.page} totalPages={data.totalPages} total={data.total} query={q} origin={origin} sampleone={firm?.slug === 'sampleone'} />
}
