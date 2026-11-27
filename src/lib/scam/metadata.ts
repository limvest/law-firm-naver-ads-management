// 규정 §4-12 결과 예측 금지 — 절차 안내형 문구만. 금지어 렉시콘 준수는 테스트로 강제.
import type { Metadata } from 'next'

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lawfirm-ads.vercel.app'

export function scamMetadata(name: string, slug: string): Metadata {
  return {
    title: `${name} 피해 대응 안내`,
    description: `${name} 유형의 피해 대응 절차를 단계별로 안내합니다. 증거 보전부터 고소·보전처분 검토까지.`,
    // SEO 정본은 /f/[slug] (2026-07-06 발주자 확정) — /scam/[slug]는 dossier 보조 지면
    alternates: { canonical: `${SITE}/f/${slug}` },
  }
}
