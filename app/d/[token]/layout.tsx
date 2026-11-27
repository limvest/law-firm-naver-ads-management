import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'

/**
 * Firm 대시보드 셸 (/d/[token]) — 고객(법무법인)에게 파는 제품의 얼굴.
 * 내부 운영자 콘솔(/operator)과 완전히 분리된 별개 표면: 토큰 인증·색인 금지·
 * 매 요청 실데이터(force-dynamic). 쓰기 액션은 하위 페이지(리드 상태 갱신) 1종뿐 — 사건명
 * 탭은 어드민 미러형 read-only 뷰다(스펙 2026-08-03 §C). 이 셸 자체는 읽기 전용 뼈대다.
 *
 * 루트 레이아웃(app/layout.tsx)이 이미 <html>/<body> + 마케팅 SiteHeader/SiteFooter(샘플투 광고
 * 셸)를 정의하고 있어, 이 서브트리는 그걸 다시 정의할 수 없다("충돌 없는 서브트리" 제약 — Next.js는
 * 단일 트리에서 <html>을 두 번 둘 수 없고, 기존 정적 라우트 전체를 라우트 그룹으로 옮겨 멀티 루트
 * 레이아웃으로 바꾸는 건 이 태스크 범위를 넘는 광범위한 리팩터다). 대신 fixed 풀뷰포트 레이어로
 * 대시보드를 마케팅 크롬 위에 완전히 덮어 씌운다 — 다른 법무법인 고객이 자기 대시보드에서
 * 샘플투 마케팅 내비(사기피해·개인회생·전화번호)를 보는 걸 막는 유일한 로우코스트 방법.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: { default: '개요', template: '%s · 대시보드' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

const TABS: { href: string; label: string; icon: string }[] = [
  { href: '', label: '운영 홈', icon: '⌂' },
  { href: '/leads', label: '상담 관리', icon: '◎' },
  { href: '/ads', label: '광고 운영', icon: '↗' },
  { href: '/campaigns', label: '검색광고 현황', icon: '▶' },
  { href: '/site', label: '랜딩 페이지', icon: '▤' },
  { href: '/keywords', label: '사건 기회', icon: '◇' },
  { href: '/funnel', label: '성과 퍼널', icon: '⌁' },
  { href: '/search', label: '검색 성과', icon: '◉' },
  { href: '/profile', label: '법무법인 정보', icon: '□' },
  { href: '/activation', label: '연동 상태', icon: '●' },
  { href: '/reports', label: '리포트', icon: '↓' },
]

const STATUS_LABEL: Record<string, string> = { pilot: '파일럿', active: '계약 중', paused: '일시중지' }

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ token: string }>
}) {
  // DB 미연결 — 가짜 데이터로 채우지 않고 정직하게 안내한다(스펙 §B).
  if (!process.env.DATABASE_URL) return <ServiceUnavailable />

  const { token } = await params
  const firm = await resolveFirmByToken(getDb(), token)
  if (!firm) notFound()

  return (
    <div data-vertical="firm" className="theme-scope t-bg t-ink font-dash fixed inset-0 z-50 flex overflow-hidden bg-[#f3f5f7]">
      <aside className="hidden w-[244px] shrink-0 flex-col bg-[#11151c] text-white lg:flex">
        <div className="border-b border-white/10 px-6 py-6">
          <Link href={`/d/${token}`} className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#5dff9b] text-sm font-black text-[#11151c]">LF</span>
            <span><strong className="block text-sm">LAW FIRM ADS</strong><span className="mt-0.5 block text-[10px] tracking-[.14em] text-white/45">CLIENT CONSOLE</span></span>
          </Link>
        </div>
        <div className="px-4 py-5">
          <p className="px-3 text-[10px] font-bold tracking-[.14em] text-white/35">업무 메뉴</p>
          <nav className="mt-3 space-y-1" aria-label="고객 운영 메뉴">
            {TABS.map((tab, index) => (
              <Link key={tab.label} href={`/d/${token}${tab.href}`} className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition hover:bg-white/[.06] hover:text-white ${index === 0 ? 'bg-white/10 font-bold text-white' : 'text-white/60'}`}>
                <span aria-hidden="true" className="w-5 text-center text-sm text-[#5dff9b]">{tab.icon}</span>{tab.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="mt-auto border-t border-white/10 p-5">
          <p className="text-[10px] font-bold tracking-[.12em] text-white/35">계약 상태</p>
          <p className="mt-2 flex items-center gap-2 text-xs font-bold"><span className="h-2 w-2 rounded-full bg-[#5dff9b]" />{STATUS_LABEL[firm.status] ?? firm.status}</p>
          <p className="mt-4 truncate text-xs text-white/45">{firm.name}</p>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-20 border-b border-[#dfe3e8] bg-white">
          <div className="flex h-16 items-center justify-between gap-3 px-5 md:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="dash-pulse-ring absolute h-2.5 w-2.5 rounded-full bg-[#25a55f]" aria-hidden="true"/><span className="relative h-2.5 w-2.5 rounded-full bg-[#25a55f]"/></span>
              <div className="min-w-0"><h1 className="truncate text-sm font-bold text-[#202732]">{firm.name}</h1><p className="text-[10px] text-[#748091]">광고 운영 콘솔 · 실데이터 연결</p></div>
            </div>
            <p className="rounded-md bg-[#eef1f4] px-2.5 py-1.5 text-[10px] font-bold text-[#647083]">{STATUS_LABEL[firm.status] ?? firm.status}</p>
          </div>
          <nav className="flex gap-1 overflow-x-auto border-t border-[#edf0f3] px-4 py-2 lg:hidden" aria-label="모바일 고객 운영 메뉴">
            {TABS.map((tab) => <Link key={tab.label} href={`/d/${token}${tab.href}`} className="whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold text-[#596577]">{tab.label}</Link>)}
          </nav>
        </header>
        <main className="mx-auto max-w-[1440px] px-5 py-7 md:px-8 md:py-9">{children}</main>
      </div>
    </div>
  )
}

function ServiceUnavailable() {
  return (
    <div data-vertical="firm" className="theme-scope t-bg t-ink font-dash fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-6">
      <div className="max-w-md text-center">
        <p className="font-mono-label t-sub">503 · 서비스 일시 중단</p>
        <h1 className="mt-3 text-2xl font-bold">대시보드에 연결할 수 없습니다</h1>
        <p className="mt-3 text-sm leading-relaxed t-sub">
          데이터베이스 연결(DATABASE_URL)이 설정되어 있지 않아 실데이터를 보여드릴 수 없습니다.
          가짜 데이터로 대신 채우지 않습니다 — 연결 설정 후 다시 시도해 주세요.
        </p>
      </div>
    </div>
  )
}
