import Link from 'next/link'
import type { Firm } from '@/lib/engine/firms'

export function SiteHeader({ firm = null }: { firm?: Firm | null }) {
  if (firm) {
    return (
      <header className="firm-site-header sticky top-0 z-40 border-b t-border t-chrome backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6 md:px-10">
          <Link href="/" className="font-display text-lg font-bold tracking-tight t-ink">{firm.name}</Link>
          <nav className="flex items-center gap-6" aria-label="법률사무소 메뉴">
            <Link href="/f" className="link-draw hidden text-sm font-semibold sm:block">사건정보</Link>
            <Link href="/lawyers" className="link-draw hidden text-sm font-semibold md:block">변호사</Link>
            <Link href="/results" className="link-draw hidden text-sm font-semibold lg:block">수행내역</Link>
            <a href={`tel:${firm.phone}`} className="font-mono-label t-ink normal-case tracking-normal" style={{ fontSize: '13px' }}>{firm.phone}</a>
          </nav>
        </div>
      </header>
    )
  }

  return (
    <header className="product-site-header sticky top-0 z-40 border-b border-[#10151f]/15 bg-[#f4f4ed]/90 text-[#10151f] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5 md:px-10">
        <Link href="/" className="flex items-center gap-3 font-bold tracking-[-.03em]"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#245bff] text-xs font-black text-white">CE</span><span>사건명 광고 엔진</span></Link>
        <nav className="flex items-center gap-5 text-sm font-semibold" aria-label="제품 메뉴">
          <Link href="/f/mock-project-d" className="hidden hover:text-[#245bff] lg:block">Cinematic 페이지</Link>
          <Link href="/portal" className="hidden hover:text-[#245bff] xl:block">고객 포털</Link>
          <Link href="/f" className="hidden hover:text-[#245bff] lg:block">SEO 운영 페이지</Link>
          <a href="/#flow" className="hidden hover:text-[#245bff] sm:block">작동 방식</a>
          <a href="/#dashboard" className="hidden hover:text-[#245bff] md:block">대시보드</a>
          <a href="/#contact" className="rounded-lg bg-[#10151f] px-4 py-2.5 text-white transition hover:bg-[#245bff]">도입 문의</a>
        </nav>
      </div>
    </header>
  )
}
