import Link from 'next/link'
import { LeadForm } from '@/components/lead-form/lead-form'
import type { Firm } from '@/lib/engine/firms'
import { leadRouteForFirm } from '@/lib/engine/public-firm'

export type PublicResult = {
  id: string
  category: string
  title: string
  summary: string
  outcome: string
  handledAt: string | null
}

export function FirmHome({ firm, results }: { firm: Firm; results: PublicResult[] }) {
  const signed = leadRouteForFirm(firm)
  return (
    <main className="firm-home bg-[#f5f3ed] text-[#172035]" data-vertical="scam">
      <section className="border-b border-[#172035]/15 px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto max-w-6xl">
          <p className="text-xs font-black tracking-[.15em] text-[#315b8c]">FINANCIAL FRAUD RESPONSE · {firm.name}</p>
          <h1 className="mt-7 max-w-5xl font-serif text-5xl font-black leading-[1.12] tracking-[-.055em] md:text-7xl">금융사기 피해 대응,<br />사실관계와 증거부터 검토합니다.</h1>
          <p className="mt-7 max-w-3xl text-lg leading-9 text-[#5f6877]">{firm.profileIntro ?? '상담자료를 토대로 사실관계와 증거를 정리하고 가능한 신고·민사·형사 절차를 검토합니다.'}</p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a href="#consult" className="rounded-xl bg-[#173f72] px-6 py-4 text-sm font-black text-white">상담 내용 남기기</a>
            <Link href="/f" className="rounded-xl border border-[#172035]/20 bg-white px-6 py-4 text-sm font-black">사건정보 검색</Link>
            <a href={`tel:${firm.phone}`} className="rounded-xl border border-[#172035]/20 px-6 py-4 text-sm font-black">{firm.phone}</a>
          </div>
        </div>
      </section>

      <section className="border-b border-[#172035]/15 bg-white px-5 py-16 md:px-10 md:py-20">
        <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-3">
          {[
            ['01', '사건정보 확인', '검색한 사건명과 관측된 접근 방식, 앱·대화방·출금 문제를 확인합니다.'],
            ['02', '증거와 송금 흐름 정리', '대화 원본, 이체내역, 계좌·앱·사이트 정보를 시간순으로 정리합니다.'],
            ['03', '적용 가능한 절차 검토', '신고, 고소, 보전처분과 민사상 청구의 적용 가능성과 한계를 설명합니다.'],
          ].map(([no, title, body]) => <article key={no} className="border-t-2 border-[#173f72] pt-5"><span className="font-mono text-xs font-black text-[#315b8c]">{no}</span><h2 className="mt-5 text-xl font-black">{title}</h2><p className="mt-3 text-sm leading-7 text-[#687180]">{body}</p></article>)}
        </div>
      </section>

      <section className="px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-black tracking-[.15em] text-[#315b8c]">LAWYERS</p><h2 className="mt-3 font-serif text-4xl font-black tracking-[-.045em] md:text-5xl">담당 변호사와 주요 이력</h2></div><Link href="/lawyers" className="text-sm font-black text-[#173f72]">전체 변호사 정보 →</Link></div>
          <div className="mt-10 grid gap-5 md:grid-cols-2">
            {(firm.lawyers ?? []).slice(0, 4).map((lawyer, index) => <article key={lawyer.id ?? `${lawyer.name}-${index}`} className="grid grid-cols-[92px_1fr] gap-5 rounded-2xl border border-[#172035]/12 bg-white p-5">{lawyer.photo ? <img src={lawyer.photo} alt={lawyer.name} className="h-28 w-[92px] rounded-xl object-cover object-top" /> : <div className="flex h-28 w-[92px] items-center justify-center rounded-xl bg-[#e8edf4] text-2xl font-black text-[#173f72]">{lawyer.name.slice(0, 1)}</div>}<div><p className="text-xs font-black text-[#315b8c]">{lawyer.title}</p><h3 className="mt-1 text-xl font-black">{lawyer.name}</h3>{lawyer.bio && <p className="mt-3 text-sm leading-6 text-[#687180]">{lawyer.bio}</p>}<p className="mt-3 text-xs font-semibold text-[#4f5b6d]">{lawyer.practiceAreas?.join(' · ')}</p></div></article>)}
          </div>
        </div>
      </section>

      <section className="border-y border-[#172035]/15 bg-[#e9edf2] px-5 py-20 md:px-10">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div><p className="text-xs font-black tracking-[.15em] text-[#315b8c]">CASE WORK</p><h2 className="mt-3 font-serif text-4xl font-black tracking-[-.045em]">사건 수행내역</h2></div>
            <Link href="/results" className="text-sm font-black text-[#173f72]">전체 수행내역 →</Link>
          </div>
          {results.length > 0 ? (
            <div className="mt-9 grid gap-4 md:grid-cols-3">{results.slice(0, 3).map((result) => <article key={result.id} className="rounded-2xl bg-white p-6"><p className="text-xs font-black text-[#315b8c]">{result.category} · {result.handledAt ?? '시기 비공개'}</p><h3 className="mt-4 text-lg font-black leading-7">{result.title}</h3><p className="mt-3 text-sm leading-7 text-[#687180]">{result.summary}</p></article>)}</div>
          ) : (
            <div className="mt-9 rounded-2xl border border-[#172035]/10 bg-white p-7 text-sm leading-7 text-[#687180]">현재 고객 검수와 공개 승인이 완료된 수행내역은 없습니다. 상담 시 유사 사건의 검토 범위와 가능한 절차를 담당 변호사에게 직접 확인해 주세요.</div>
          )}
          <p className="mt-5 text-xs leading-6 text-[#687180]">사건 수행내역은 익명화된 개별 기록이며 동일한 결과를 보장하지 않습니다.</p>
        </div>
      </section>

      <section id="consult" className="bg-[#10243d] px-5 py-20 text-white md:px-10 md:py-28">
        <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[.8fr_1.2fr]">
          <div><p className="text-xs font-black tracking-[.15em] text-[#9db9dc]">PRIVATE CONSULTATION</p><h2 className="mt-4 font-serif text-4xl font-black leading-tight tracking-[-.045em]">현재 단계와 남아 있는 기록을 알려주세요.</h2><p className="mt-5 text-sm leading-7 text-white/55">상담 전 담당 변호사, 업무 범위와 비용을 확인한 뒤 선임을 결정할 수 있습니다.</p></div>
          <div className="text-[#172035]"><LeadForm vertical="scam" slug="firm-home" firmId={signed?.firmId} routeToken={signed?.routeToken} /></div>
        </div>
      </section>
    </main>
  )
}
