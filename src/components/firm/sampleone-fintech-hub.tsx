import Link from 'next/link'
import { SampleoneFintechFooter, SampleoneFintechHeader } from './sampleone-fintech-header'
import type { SampleoneDbCase } from '@/lib/scam/sampleone-fintech-db'

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(new Date(value)) : '관측 중'
}

export function SampleoneFintechHub({ cases, total, page, totalPages, query }: {
  cases: SampleoneDbCase[]; total: number; page: number; totalPages: number; query: string
}) {
  return (
    <main className="jf-site jf-hub">
      <SampleoneFintechHeader />
      <section className="jf-list-hero">
        <div className="jf-shell">
          <p className="jf-kicker">SAMPLEONE FINTECH CRIME CENTER</p>
          <h1>금융사기<br /><em>진행 사건</em></h1>
          <p>법무법인 샘플원이 수집·검토하는 사건명을 검색하고, 유형별 대응 절차를 확인하세요.</p>
          <div className="jf-list-count"><strong>{total.toLocaleString('ko-KR')}</strong><span>건의 게시 가능 사건</span></div>
        </div>
      </section>
      <section className="jf-list-body">
        <div className="jf-shell">
          <form className="jf-search" action="/fraud">
            <label htmlFor="jf-q">업체명·앱·프로젝트명 검색</label>
            <div><input id="jf-q" name="q" defaultValue={query} placeholder="예: 거래소명, 리딩방명, 쇼핑몰명" /><button>검색</button></div>
          </form>
          <div className="jf-list-head"><p>{query ? `‘${query}’ 검색 결과` : '최근 관측 사건'}</p><span>{total.toLocaleString('ko-KR')} CASES</span></div>
          <div className="jf-case-grid">
            {cases.map((item, index) => (
              <Link href={`/fraud/${item.slug}`} className="jf-case-card" key={item.slug}>
                <span>{String((page - 1) * 36 + index + 1).padStart(3, '0')}</span>
                <small>{item.scamType || '금융 피해'} · 관측 {item.observationCount.toLocaleString('ko-KR')}건 · {date(item.lastSeenAt)}</small>
                <h2>{item.name}</h2>
                <p>{item.name} 관련 피해 정보와 초기 대응 절차를 확인하세요.</p>
                <b>사건 안내 보기 →</b>
              </Link>
            ))}
          </div>
          {!cases.length && <div className="jf-empty">일치하는 사건명이 없습니다. 표기를 달리해 검색해 보세요.</div>}
          {totalPages > 1 && <nav className="jf-pages" aria-label="페이지 이동">
            {page > 1 && <Link href={`/fraud?page=${page - 1}${query ? `&q=${encodeURIComponent(query)}` : ''}`}>이전</Link>}
            <span>{page} / {totalPages}</span>
            {page < totalPages && <Link href={`/fraud?page=${page + 1}${query ? `&q=${encodeURIComponent(query)}` : ''}`}>다음</Link>}
          </nav>}
        </div>
      </section>
      <section className="jf-list-cta" id="consult"><p>지금 검색한 이름으로 입금하셨나요?</p><h2>지체하지 말고 입금 내역과 대화 기록부터 보전하세요.</h2><a href="tel:010-0000-0009">010-0000-0009 전화 상담</a></section>
      <SampleoneFintechFooter />
    </main>
  )
}
