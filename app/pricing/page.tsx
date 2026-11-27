import type { Metadata } from 'next'
import { ProductLeadForm } from '@/components/product-lead-form'
import { ProductPageViewTracker, ProductTrackedLink } from '@/components/product-tracking'

export const metadata: Metadata = {
  title: '도입 비용 0원 · 사건 수요 대응 OS',
  description: '법률사무소 전용 사건 수요 대응 OS를 현재 0원으로 제공합니다.',
}

const packages = [
  {
    name: 'Founding Pilot',
    price: '0원',
    detail: '구축비 0원 · 월 이용료 0원',
  },
  {
    name: 'Core',
    price: '0원',
    detail: '1 domain · 표준 운영 범위',
  },
  {
    name: 'Growth',
    price: '0원',
    detail: '확대 coverage · 고급 최적화',
  },
  {
    name: 'Managed Ops',
    price: '0원',
    detail: '운영 대행 지원 포함',
  },
]

export default function PricingPage() {
  return (
    <main className="product-landing min-h-screen bg-[#f4f4ed] text-[#10151f]">
      <ProductPageViewTracker page="pricing" />
      <header className="border-b border-[#10151f]/15 px-5 py-5 md:px-10">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <ProductTrackedLink href="/" page="pricing" cta="pricing_home" className="font-black tracking-[-.03em]">사건 수요 대응 OS</ProductTrackedLink>
          <ProductTrackedLink href="/#contact" page="pricing" cta="pricing_contact" className="text-sm font-bold text-[#245bff]">도입 상담</ProductTrackedLink>
        </div>
      </header>

      <section className="px-5 pb-16 pt-20 md:px-10 md:pb-24 md:pt-28">
        <div className="mx-auto max-w-7xl">
          <p className="product-section-label text-[#245bff]">FREE PILOT</p>
          <h1 className="product-display mt-5 max-w-4xl">현재 도입 비용은<br />0원입니다.</h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-[#626b79]">
            파트너사 우선 모집중입니다.
          </p>

          <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {packages.map((item) => (
              <article key={item.name} className="rounded-3xl border border-[#10151f]/15 bg-white/75 p-6">
                <p className="text-xs font-black tracking-[.12em] text-[#245bff]">{item.name}</p>
                <h2 className="mt-6 text-2xl font-black tracking-[-.04em]">{item.price}</h2>
                <p className="mt-4 text-sm leading-6 text-[#626b79]">{item.detail}</p>
              </article>
            ))}
          </div>

        </div>
      </section>

      <section className="bg-[#245bff] px-5 py-20 text-white md:px-10 md:py-28">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[.8fr_1.2fr]">
          <div>
            <p className="product-section-label text-white/65">NO GUARANTEES · QUALIFICATION FIRST</p>
            <h2 className="product-heading mt-4 text-white">현재 팀과 운영 조건에 맞는 가설부터 확인합니다.</h2>
            <p className="mt-6 max-w-xl text-lg leading-8 text-white/72">도메인, 네이버 광고계정, 리드 응답 담당자와 결과 기록 가능 여부를 알려주시면 founder-led 진단 범위를 안내합니다.</p>
          </div>
          <ProductLeadForm page="pricing" />
        </div>
      </section>
    </main>
  )
}
