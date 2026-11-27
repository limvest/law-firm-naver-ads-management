import Link from 'next/link'

export function SampleoneFintechHeader() {
  return (
    <header className="jf-header">
      <Link href="/fraud" className="jf-brand" aria-label="법무법인 샘플원 핀테크범죄센터 홈">
        <img src="/assets/sampleone-original/logo-header-inverse.png" alt="법무법인 샘플원" />
        <span>핀테크범죄센터</span>
      </Link>
      <nav aria-label="주요 메뉴">
        <Link href="/fraud">진행 사건</Link>
        <Link href="/fraud#process">대응 절차</Link>
        <Link href="/fraud#consult">상담 신청</Link>
      </nav>
      <a className="jf-header-call" href="tel:010-0000-0009">010-0000-0009</a>
    </header>
  )
}
export function SampleoneFintechFooter() {
  return (
    <footer className="jf-footer">
      <div className="jf-shell">
        <img src="/assets/sampleone-original/logo-header-inverse.png" alt="법무법인 샘플원" />
        <div>
          <p>법무법인 샘플원 · 서울특별시 서초구 샘플로 2, 샘플빌딩 9층</p>
          <p>대표변호사 정오번 · Tel <a href="tel:010-0000-0009">010-0000-0009</a></p>
          <p className="jf-footer-note">본 사이트의 정보는 일반적인 안내이며, 개별 사건의 결과를 보장하지 않습니다.</p>
        </div>
      </div>
    </footer>
  )
}
