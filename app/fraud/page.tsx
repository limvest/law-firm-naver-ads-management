import type { Metadata } from 'next'
import { SampleoneFintechHub } from '@/components/firm/sampleone-fintech-hub'
import { getDb } from '@/lib/db/client'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'
import { listSampleoneDbCases } from '@/lib/scam/sampleone-fintech-db'

export const metadata: Metadata = {
  title: { absolute: '금융사기 진행 사건 | 법무법인 샘플원 핀테크범죄센터' },
  description: '금융사기 업체명, 플랫폼명, 앱과 정보방명을 검색하고 사건별 대응 절차를 확인합니다.',
  alternates: { canonical: 'https://fintech.sampleone.attorney/fraud' },
}

export default async function FraudHub({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const params = await searchParams
  const query = params.q?.trim() ?? ''
  const firm = await currentRequestFirm() ?? SAMPLEONE_LOCAL_PREVIEW_FIRM
  const data = await listSampleoneDbCases(getDb(), {
    firmId: firm.id,
    page: Number(params.page ?? 1),
    query,
  })
  return <SampleoneFintechHub cases={[...data.items]} total={data.total} page={data.page} totalPages={data.totalPages} query={query} />
}
