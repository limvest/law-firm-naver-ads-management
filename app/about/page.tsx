import type { Metadata } from 'next'
import { ThemeScope } from '@/components/theme-scope'
import { Reveal } from '@/components/reveal'
import { PageViewTracker } from '@/components/page-view-tracker'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

export const metadata: Metadata = {
  title: '사무소 소개',
  description: '사무소의 금융사기 피해 사건 검토 원칙과 연락처를 안내합니다.',
}

export const dynamic = 'force-dynamic'

export function AboutContent({ firm = DEFAULT_FIRM }: { firm?: typeof DEFAULT_FIRM }) {
  return (
    <ThemeScope vertical="firm">
      <PageViewTracker slug="about" />
      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-3xl font-extrabold">사무소 소개</h1>
        <Reveal>
          <p className="mt-5 leading-relaxed t-sub">
            {firm.profileIntro ?? `${firm.name}은 금융사기 피해 사건에서 사실관계와 증거를 먼저 확인하고 적용 가능한 절차와 한계를 설명하는 것을 원칙으로 합니다.`}
          </p>
        </Reveal>
        <Reveal>
          <div className="mt-8 rounded-2xl border t-border t-surface p-6">
            <p className="text-sm t-sub">오시는 길</p>
            <p className="mt-2 font-semibold">{firm.addressRegion} {firm.addressLocality} {firm.address}</p>
            <p className="mt-1 text-sm t-sub">전화 {firm.phone}</p>
          </div>
        </Reveal>
      </main>
    </ThemeScope>
  )
}

export default async function AboutPage() {
  const firm = await currentRequestFirm() ?? DEFAULT_FIRM
  return <AboutContent firm={firm} />
}
