import type { Metadata } from 'next'
import Link from 'next/link'
import { getDb } from '@/lib/db/client'
import { EMPTY_PRODUCT_LIVE, productLiveData } from '@/lib/product-live'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: { absolute: '고객 포털 | 사건명 광고 엔진' },
  description: '법률사무소 고객이 사건명, 광고, 웹사이트, 상담 신청과 전환 퍼널을 관리하는 실제 운영 포털입니다.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function CustomerPortal(_props: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  let live = EMPTY_PRODUCT_LIVE
  if (process.env.DATABASE_URL) {
    try { live = await productLiveData(getDb()) } catch { /* 연결 상태를 그대로 표시 */ }
  }

  return (
    <main data-vertical="product" className="min-h-[calc(100vh-64px)] bg-[#eef0ec] px-5 py-20 text-[#101721] md:px-10">
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1.05fr_.95fr] lg:items-start">
        <section>
          <div className="flex items-center gap-3 text-xs font-black tracking-[.14em] text-[#315eff]">
            <span className={`h-2.5 w-2.5 rounded-full ${live.connected ? 'bg-[#25a75f] shadow-[0_0_12px_rgba(37,167,95,.45)]' : 'bg-amber-500'}`} />
            LIVE CUSTOMER PORTAL
          </div>
          <h1 className="mt-5 max-w-3xl text-4xl font-black tracking-[-.055em] md:text-6xl">고객별 운영 DB에 연결된 법률사무소 전용 포털</h1>
          <p className="mt-7 max-w-2xl text-base leading-8 text-[#68717f]">발급받은 로그인 ID와 비밀번호로 접속하면 해당 사무소의 사건명, 광고 설정, 웹사이트 콘텐츠, 상담 신청과 전환 퍼널만 분리해서 확인할 수 있습니다.</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[
              ['운영 DB', live.connected ? '연결됨' : '연결 확인 중'],
              ['수집 사건명', live.connected ? `${live.totalKeywords.toLocaleString('ko-KR')}개` : '—'],
              ['누적 관측', live.connected ? `${live.observations.toLocaleString('ko-KR')}건` : '—'],
            ].map(([label, value]) => <div key={label} className="rounded-2xl border border-black/10 bg-white p-5"><p className="text-xs font-bold text-[#7a828e]">{label}</p><p className="mt-3 text-xl font-black">{value}</p></div>)}
          </div>
          <div className="mt-8 grid gap-3 text-sm text-[#53606e] sm:grid-cols-2">
            {['사건명·롱테일 페이지 현황', '네이버 광고 설정·심사 단계', '암호화된 상담 리드 인박스', '변호사 정보·사건 수행내역 관리'].map((item) => <div key={item} className="flex items-center gap-3 border-t border-black/10 py-3"><span className="h-1.5 w-1.5 rounded-full bg-[#315eff]" />{item}</div>)}
          </div>
        </section>

        <section className="rounded-3xl bg-[#101721] p-7 text-white shadow-[0_28px_80px_rgba(16,23,33,.22)] md:p-10">
          <p className="text-[10px] font-bold tracking-[.16em] text-[#78a0ff]">SECURE WORKSPACE ACCESS</p>
          <h2 className="mt-4 text-2xl font-black">고객 대시보드 열기</h2>
          <p className="mt-3 text-sm leading-7 text-white/55">계약 후 발급된 법률사무소 로그인 ID와 비밀번호를 입력하세요.</p>
          {process.env.DATABASE_URL ? (
            <form action="/workspace" method="post" className="mt-7 space-y-3">
              <label htmlFor="firm-login-id" className="block text-xs font-bold text-white/55">로그인 ID</label>
              <input id="firm-login-id" name="username" type="text" required autoComplete="username" maxLength={60} className="w-full rounded-xl border border-white/15 bg-white/[.055] px-4 py-3.5 text-sm text-white outline-none placeholder:text-white/25 focus:border-[#78a0ff]" placeholder="법률사무소 로그인 ID" />
              <label htmlFor="firm-password" className="block text-xs font-bold text-white/55">비밀번호</label>
              <input id="firm-password" name="password" type="password" required autoComplete="current-password" maxLength={200} className="w-full rounded-xl border border-white/15 bg-white/[.055] px-4 py-3.5 text-sm text-white outline-none placeholder:text-white/25 focus:border-[#78a0ff]" placeholder="비밀번호" />
              <button className="mt-3 w-full rounded-xl bg-[#315eff] px-5 py-4 text-sm font-black text-white transition hover:bg-[#4771ff]">고객 대시보드 접속</button>
            </form>
          ) : <p className="mt-7 rounded-xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">운영 DB 연결을 확인하고 있습니다. 잠시 후 다시 시도해 주세요.</p>}
          <div className="mt-7 border-t border-white/10 pt-6 text-sm text-white/45">
            <p>로그인 정보를 분실했다면 도입 담당자에게 재설정을 요청하세요.</p>
            <Link href="/#contact" className="mt-4 inline-flex font-bold text-[#9cb7ff]">도입·접근 문의 →</Link>
          </div>
        </section>
      </div>
    </main>
  )
}
