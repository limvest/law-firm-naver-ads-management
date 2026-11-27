import Link from 'next/link'
import type { Firm } from '@/lib/engine/firms'

export function SiteFooter({ firm = null }: { firm?: Firm | null }) {
  if (!firm) return null
  return (
    <footer className="firm-site-footer border-t t-border t-bg pb-24 pt-8 text-xs leading-relaxed t-sub">
      <div className="mx-auto max-w-3xl space-y-1 px-4">
        <p className="font-semibold t-ink">{firm.name}</p>
        <p>광고책임변호사: {firm.adLawyerName}</p>
        <p>{firm.addressRegion} {firm.addressLocality} {firm.address}</p>
        <p>전화 {firm.phone}</p>
        <p><Link href="/privacy" className="underline">개인정보처리방침</Link></p>
        <p>본 사이트는 {firm.name}의 광고입니다. 사건별 사실관계와 증거에 따라 가능한 절차와 결과는 달라질 수 있습니다.</p>
      </div>
    </footer>
  )
}
