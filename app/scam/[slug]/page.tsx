import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { getScamPage } from '@/lib/scam/data'
import { scamMetadata } from '@/lib/scam/metadata'
import { ScamLanding } from '@/components/scam/scam-landing'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

export const revalidate = 86400 // 경과일 M 일 1회 갱신 (스펙 §6.1)

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params
  const data = await getScamPage(getDb(), slug)
  if (!data) return { title: '페이지를 찾을 수 없습니다' }
  return scamMetadata(data.name, slug)
}

export default async function ScamSlugPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const data = await getScamPage(getDb(), slug)
  if (!data) notFound()
  const firm = await currentRequestFirm() ?? DEFAULT_FIRM
  return <ScamLanding data={data} firm={firm} />
}
