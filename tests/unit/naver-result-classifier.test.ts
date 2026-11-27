import { describe, expect, it } from 'vitest'
import {
  classifyNaverResult,
  extractCaseNameCandidate,
} from '@/domains/intelligence/naver-result-classifier'

describe('Naver result/landing deterministic classifier', () => {
  it('accepts a legal victim-support case page and extracts only structured signals', () => {
    const verdict = classifyNaverResult(
      {
        title: 'Mock Trade 사기 피해, 출금거절 사건 대응 | 법무법인 예시',
        description: '피해사례와 고소·회수 절차를 안내합니다.',
        link: 'https://law.example/cases/mock-trade',
      },
      {
        url: 'https://law.example/cases/mock-trade',
        html: `<html><head><title>Mock Trade 사기 피해</title></head><body><article>
          <h1>Mock Trade 피해사례</h1>
          <p>리딩방에서 안내받고 입금했으나 출금이 거절되었습니다.</p>
          <p>세금 명목으로 3,000만원 선입금을 요구했습니다.</p>
          <p>텔레그램 @alpha_help와 mock-trade.com 사이트가 확인됩니다.</p>
        </article><a>무료 상담 신청</a></body></html>`,
      },
    )

    expect(verdict).toMatchObject({
      decision: 'accept',
      pageType: 'ad-and-case',
      isLegalPractice: true,
      isVictimSupport: true,
      isAd: true,
      isCaseDetail: true,
      confidence: 'high',
      caseNameCandidate: { value: 'Mock Trade' },
    })
    expect(verdict.observations.method).toEqual(expect.arrayContaining(['리딩방', '출금거절', '선입금요구']))
    expect(verdict.observations.amounts).toContain('3,000만원')
    expect(verdict.observations.infra).toEqual(expect.arrayContaining([
      { type: 'site', value: 'mock-trade.com' },
      { type: 'telegram', value: '@alpha_help' },
    ]))
    expect(JSON.stringify(verdict)).not.toContain('010-')
  })

  it('does not mistake a law-firm name or generic scam noun for a case name', () => {
    const lawFirm = extractCaseNameCandidate({
      title: '법무법인 피해자센터 투자사기 무료상담',
      description: '변호사가 피해 대응을 안내합니다.',
      link: 'https://law.example/',
    })
    expect(lawFirm).toBeNull()

    const generic = classifyNaverResult({
      title: '코인 거래소 사기 피해 대응 방법',
      description: '일반적인 투자사기 예방법입니다.',
      link: 'https://law.example/guide',
    })
    expect(generic.caseNameCandidate).toBeNull()
    expect(generic.decision).not.toBe('accept')
  })

  it('marks a consultation landing page for review, not as a case detail', () => {
    const verdict = classifyNaverResult({
      title: '법률사무소 예시 | 투자사기 피해 무료 상담',
      description: '24시간 변호사 상담 신청',
      link: 'https://law.example/contact',
    })
    expect(verdict).toMatchObject({
      decision: 'review', pageType: 'ad', isLegalPractice: true,
      isVictimSupport: true, isAd: true, isCaseDetail: false,
      caseNameCandidate: null,
    })
  })

  it('rejects a normal result and never returns raw landing text', () => {
    const verdict = classifyNaverResult({
      title: '오늘의 코인 시세와 시장 전망',
      description: '시장 동향을 정리했습니다.',
      link: 'https://news.example/article/1',
    }, { html: '<article>사건이 아닌 일반 시장 뉴스 본문</article>' })
    expect(verdict).toMatchObject({ decision: 'reject', pageType: 'other' })
    expect(verdict).not.toHaveProperty('body')
    expect(JSON.stringify(verdict)).not.toContain('일반 시장 뉴스 본문')
  })

  it('관련 사건·footer의 다른 인프라를 현재 article 관측정보에 섞지 않는다', () => {
    const verdict = classifyNaverResult({
      title: 'MOCK QIB 사기 피해 | 경쟁사B법률사무소',
      description: '피해 대응 상담',
      link: 'https://law.example/fraud/mock-qib',
    }, {
      url: 'https://law.example/fraud/mock-qib',
      html: `<main><article><h1>MOCK QIB 피해</h1><p>2026-08-29 업데이트. 리딩방 접근 후 출금이 거절되었습니다.</p></article>
        <section class="related">로맨스 접근 other-case.example 사이트 폐쇄</section></main>
        <footer>무료 상담 신청</footer>`,
    })
    expect(verdict.observations.method).toEqual(['출금거절', '리딩방'])
    expect(verdict.observations.infra).toEqual([])
  })

  it('일반 예방 설명문은 사건명으로 받지 않고 영문 고유명의 일반 접미어는 정리한다', () => {
    expect(extractCaseNameCandidate({
      title: '해외선물 FX마진 사설 거래 프로그램 위장 확인, 투자 사기 유형',
      link: 'https://law.example/fraud/fx-guide-578525',
    })).toBeNull()
    expect(extractCaseNameCandidate({
      title: '주식 HTS MTS 사칭 앱 사기, 공모주 청약 피해 예방',
      link: 'https://law.example/fraud/ipo-stock-eb51d5',
    })).toBeNull()
    expect(extractCaseNameCandidate({
      title: 'MOCKH 프로그램 사기 피해',
      link: 'https://law.example/fraud/mockh-program-f5f1bf',
    })).toMatchObject({ value: 'MOCKH', normalized: 'mockh' })
  })
})
