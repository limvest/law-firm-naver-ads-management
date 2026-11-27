import Link from 'next/link'
import {
  SEO_CATEGORIES,
  caseIndexPath,
  getCategoryCounts,
  type SeoCase,
  type SeoCategory,
} from '@/lib/scam/seo-index'

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lawfirm-ads.vercel.app'

type Props = {
  cases: SeoCase[]
  page: number
  totalPages: number
  total: number
  category?: SeoCategory
  query?: string
  origin?: string
  sampleone?: boolean
}

function pageNumbers(page: number, totalPages: number) {
  return [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, totalPages])]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((a, b) => a - b)
}

export function SeoCaseIndex({ cases, page, totalPages, total, category, query = '', origin = SITE, sampleone = false }: Props) {
  const counts = getCategoryCounts()
  const canonicalPath = query ? '/f' : caseIndexPath(page, category?.key)
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: category ? `${category.label} 사건 안내` : '금융사기 사건정보',
        url: `${origin}${canonicalPath}`,
        inLanguage: 'ko-KR',
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: cases.length,
          itemListElement: cases.map((item, index) => ({
            '@type': 'ListItem', position: (page - 1) * 36 + index + 1,
            name: `${item.name} 피해 대응 안내`, url: `${origin}/f/${encodeURIComponent(item.slug)}`,
          })),
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '홈', item: origin },
          { '@type': 'ListItem', position: 2, name: '사건정보', item: `${origin}/f` },
          ...(category ? [{ '@type': 'ListItem', position: 3, name: category.label, item: `${origin}/f/type/${category.key}` }] : []),
        ],
      },
    ],
  }

  return (
    <main className="min-h-screen bg-[#f4f6f9] text-[#162033]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="border-b border-[#162033]/10 bg-white">
        <nav aria-label="경로" className="mx-auto flex max-w-7xl items-center gap-2 px-5 py-3 text-xs text-[#788397] md:px-8">
          <Link href="/">홈</Link><span>›</span><Link href="/f">사건정보</Link>
          {category ? <><span>›</span><strong className="text-[#324057]">{category.label}</strong></> : null}
        </nav>
      </div>

      <section className="bg-[#eaf1f8] px-5 py-14 md:px-8 md:py-20">
        <div className="mx-auto max-w-7xl">
          <p className="text-xs font-black tracking-[.14em] text-[#3f6286]">CASE INFORMATION HUB</p>
          <h1 className="mt-5 max-w-4xl font-serif text-4xl font-black leading-[1.15] tracking-[-.05em] md:text-6xl">
            {category ? category.label : '사건명으로 확인하는 금융사기 피해 대응 정보'}
          </h1>
          <p className="mt-6 max-w-3xl text-base leading-8 text-[#536177]">
            {category?.description ?? '피해 업체명, 플랫폼명, 앱 이름 또는 정보방명을 검색하면 관련 사건의 접근 방식과 현재 단계에서 준비할 자료를 확인할 수 있습니다.'}
          </p>
          <form action="/f" method="get" role="search" className="mt-9 flex max-w-2xl gap-2 rounded-2xl bg-white p-2 shadow-[0_12px_35px_rgba(31,54,86,.1)]">
            <label htmlFor="case-search" className="sr-only">사건명 검색</label>
            <input id="case-search" name="q" defaultValue={query} placeholder="업체명·플랫폼·앱·정보방명 검색" className="min-w-0 flex-1 rounded-xl px-4 py-3 text-sm outline-none" />
            <button className="rounded-xl bg-[#123f78] px-5 py-3 text-sm font-bold text-white">검색</button>
          </form>
        </div>
      </section>

      <section className="border-b border-[#162033]/10 bg-white px-5 py-7 md:px-8">
        <div className="mx-auto max-w-7xl">
          <h2 className="sr-only">사기 유형별 사건정보</h2>
          <div className="flex gap-2 overflow-x-auto pb-1">
            <Link href="/f" className={`shrink-0 rounded-full border px-4 py-2 text-xs font-bold ${!category ? 'border-[#123f78] bg-[#123f78] text-white' : 'border-[#162033]/15'}`}>전체 {counts.reduce((sum, item) => sum + item.count, 0).toLocaleString('ko-KR')}</Link>
            {counts.filter((item) => item.count > 0).map((item) => (
              <Link key={item.key} href={`/f/type/${item.key}`} className={`shrink-0 rounded-full border px-4 py-2 text-xs font-bold ${category?.key === item.key ? 'border-[#123f78] bg-[#123f78] text-white' : 'border-[#162033]/15'}`}>{item.shortLabel} {item.count.toLocaleString('ko-KR')}</Link>
            ))}
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-14 md:px-8 md:py-20 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section>
          <div className="flex items-end justify-between gap-4 border-b border-[#162033]/15 pb-5">
            <div><p className="text-[11px] font-black tracking-[.12em] text-[#3f6286]">CASE INDEX</p><h2 className="mt-2 text-2xl font-black">{query ? `'${query}' 검색 결과` : category ? `${category.shortLabel} 사건 목록` : '최근 확인된 사건 목록'}</h2></div>
            <p className="text-sm text-[#68758a]">총 {total.toLocaleString('ko-KR')}건</p>
          </div>

          {cases.length ? <div className="grid gap-3 pt-6 md:grid-cols-2">
            {cases.map((item) => {
              const type = SEO_CATEGORIES.find((candidate) => candidate.key === item.category)!
              return <article key={item.slug} className="rounded-2xl border border-[#162033]/10 bg-white p-5 transition-transform hover:-translate-y-0.5">
                <Link href={`/f/type/${item.category}`} className="text-[11px] font-black tracking-[.08em] text-[#1e765d]">{type.shortLabel}</Link>
                <h3 className="mt-3 text-lg font-black leading-7"><Link href={`/f/${item.slug}`} className="hover:text-[#123f78]">{item.name} 피해 대응 안내</Link></h3>
                <p className="mt-3 text-xs leading-6 text-[#68758a]">접근 방식, 앱·대화방, 입출금 문제와 현재 단계별 대응 내용을 확인합니다.</p>
                <Link href={`/f/${item.slug}`} className="mt-5 inline-block text-xs font-bold text-[#123f78]">사건 상세 확인 →</Link>
              </article>
            })}
          </div> : <div className="rounded-2xl border border-[#162033]/10 bg-white p-10 text-center text-[#68758a]">일치하는 사건을 찾지 못했습니다. 다른 명칭이나 앱 이름으로 다시 검색해 보세요.</div>}

          {!query && totalPages > 1 ? <nav aria-label="사건 목록 페이지" className="mt-10 flex flex-wrap items-center gap-2">
            {page > 1 ? <Link rel="prev" href={caseIndexPath(page - 1, category?.key)} className="rounded-lg border border-[#162033]/15 bg-white px-4 py-2 text-sm font-bold">이전</Link> : null}
            {pageNumbers(page, totalPages).map((value, index, values) => <span key={value} className="contents">
              {index > 0 && value - values[index - 1] > 1 ? <span className="px-1 text-[#8791a1]">…</span> : null}
              <Link href={caseIndexPath(value, category?.key)} aria-current={value === page ? 'page' : undefined} className={`rounded-lg px-3.5 py-2 text-sm font-bold ${value === page ? 'bg-[#123f78] text-white' : 'border border-[#162033]/15 bg-white'}`}>{value}</Link>
            </span>)}
            {page < totalPages ? <Link rel="next" href={caseIndexPath(page + 1, category?.key)} className="rounded-lg border border-[#162033]/15 bg-white px-4 py-2 text-sm font-bold">다음</Link> : null}
          </nav> : null}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl bg-[#101827] p-6 text-white"><p className="text-[10px] font-black tracking-[.12em] text-[#77e1bf]">HOW TO USE</p><h2 className="mt-3 text-xl font-black">내 사건을 찾는 순서</h2><ol className="mt-5 space-y-4 text-sm leading-6 text-white/65"><li>1. 업체·앱·정보방명 검색</li><li>2. 상세 페이지 진행 방식 대조</li><li>3. 대화·송금·앱 기록 보전</li><li>4. 현재 단계에 맞는 절차 확인</li></ol></div>
          <div className="rounded-2xl border border-[#162033]/10 bg-white p-6"><h2 className="font-black">함께 확인할 안내</h2><div className="mt-4 space-y-3 text-sm font-bold">{sampleone ? <><Link href="/#response" className="block text-[#123f78]">샘플원의 피해 대응 안내 →</Link><Link href="/#counsel" className="block text-[#123f78]">샘플원 담당 변호사 →</Link></> : <><Link href="/scam" className="block text-[#123f78]">금융사기 대응 절차 →</Link><Link href="/about" className="block text-[#123f78]">법률사무소 안내 →</Link></>}<Link href="/privacy" className="block text-[#123f78]">개인정보처리방침 →</Link></div></div>
        </aside>
      </div>

      <section className="border-t border-white/10 bg-[#101827] px-5 py-10 text-xs leading-6 text-white/45 md:px-8"><div className="mx-auto max-w-7xl"><strong className="text-white/75">금융사기 사건정보 안내</strong><p className="mt-2">사건명과 유형별 대응 정보를 제공하며, 특정 업체·인물의 위법성을 단정하지 않습니다. 개별 절차는 구체적인 사실관계에 따라 달라질 수 있습니다.</p></div></section>
    </main>
  )
}
