import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { SampleoneFintechCase } from '@/components/firm/sampleone-fintech-case'
import { getDb } from '@/lib/db/client'
import { getSampleoneDbCase, getRelatedSampleoneDbCases } from '@/lib/scam/sampleone-fintech-db'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const firm = await currentRequestFirm() ?? SAMPLEONE_LOCAL_PREVIEW_FIRM
  const item = await getSampleoneDbCase(getDb(), { firmId: firm.id, slug })
  if (!item) return {}
  const title = `${item.name} 관련 피해 대응 | 법무법인 샘플원`
  const description = `${item.name} 관련 피해가 의심될 때 보전할 증거와 신고·고소, 지급정지 등 초기 대응 절차를 안내합니다.`
  const url = `https://fintech.sampleone.attorney/fraud/${item.databaseSlug}`
  return { title: { absolute: title }, description, alternates: { canonical: url }, openGraph: { title, description, url, type: 'article' } }
}

export default async function FraudCase({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const firm = await currentRequestFirm() ?? SAMPLEONE_LOCAL_PREVIEW_FIRM
  const item = await getSampleoneDbCase(getDb(), { firmId: firm.id, slug })
  if (!item) notFound()
  if (slug !== item.databaseSlug) permanentRedirect(`/fraud/${item.databaseSlug}`)
  const related = await getRelatedSampleoneDbCases(getDb(), {
    firmId: firm.id,
    currentId: item.id,
    scamType: item.scamType,
    limit: 4,
  })
  return <SampleoneFintechCase item={item} firm={firm} related={related} />
}
