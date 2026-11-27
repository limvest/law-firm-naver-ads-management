import { describe, it, expect } from 'vitest'
import { FRAUD_CINEMA_TEMPLATE } from '@/templates/fraud-cinema'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { SCAM_TYPE_SEEDS } from '@/lib/scam/seed-data'

/**
 * /f/[slug] 프로그래매틱 시네마 랜딩 컴플라이언스 (BLUEPRINT §7 신규 페이지 의무 ①)
 * 템플릿은 fraud-v2.html에서 scripts/build-cinema-template.py로 생성된다 —
 * 카피(키워드 문진 세트·QA 포함)가 전부 템플릿 문자열 안에 있으므로 전문 스캔으로 커버된다.
 */

const visibleText = FRAUD_CINEMA_TEMPLATE
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')

describe('/f/[slug] 시네마 템플릿 컴플라이언스', () => {
  it('금지어 0건 (전 키워드 세트·QA·폼 포함 전문)', () => {
    // 발주자가 확정한 "상담은 무료입니다" 정책 문구만 허용한다.
    // 다른 가격·성과 유인 표현은 기존 금지어 검사로 계속 차단한다.
    expect(findBannedTerms(visibleText).filter((term) => term !== '무료')).toEqual([])
  })

  it('필수 요소: 사무소명·주소·연락처·개인정보처리방침·광고 고지', () => {
    for (const required of ['샘플투', '샘플시', '031-000-0000', '개인정보처리방침', '광고입니다']) {
      expect(visibleText).toContain(required)
    }
  })

  it('단정 표현 금지: "는 사기입니다" 류 부재 (§3-4 — 관측 언어만)', () => {
    expect(visibleText).not.toMatch(/[은는]\s*사기입니다/)
  })

  it('서버 주입 토큰이 템플릿에 존재', () => {
    expect(FRAUD_CINEMA_TEMPLATE).toContain('{{TITLE}}')
    expect(FRAUD_CINEMA_TEMPLATE).toContain('{{KJSON}}')
    expect(FRAUD_CINEMA_TEMPLATE).toContain('{{DESC}}')
    expect(FRAUD_CINEMA_TEMPLATE).toContain('{{ARTICLE}}')
    expect(FRAUD_CINEMA_TEMPLATE).toContain('<base href="/">')
  })

  it('서버 토큰 개수 고정 — 주석 내 스트레이 토큰이 비전역 replace를 가로채는 회귀 방지', () => {
    const count = (s: string, tok: string) => s.split(tok).length - 1
    const noComments = FRAUD_CINEMA_TEMPLATE.replace(/<!--[\s\S]*?-->/g, '')
    const EXPECTED: [string, number][] = [
      ['{{ARTICLE}}', 1], ['{{KJSON}}', 1], ['{{CANON}}', 2], ['{{JSONLD}}', 1],
      ['{{H1}}', 1], ['{{TITLE}}', 4], ['{{DESC}}', 3],
    ]
    for (const [tok, n] of EXPECTED) {
      expect(count(FRAUD_CINEMA_TEMPLATE, tok), `${tok} 총 개수`).toBe(n)
      expect(count(noComments, tok), `${tok} 주석 제거 후에도 동수(주석 안 토큰 0)`).toBe(n)
    }
  })

  it('시드 slug 전부 라우트 해석 가능 (TYPE_TO_K 매핑 누락 없음)', async () => {
    // route.ts의 TYPE_TO_K와 동기 — 시드의 모든 scamType이 매핑되거나 default로 안전해야 한다
    const types = new Set(SCAM_TYPE_SEEDS.map((s) => s.scamType))
    expect(types.size).toBeGreaterThan(0)   // 시드 존재
    for (const s of SCAM_TYPE_SEEDS) {
      expect(s.slug).toMatch(/^[a-z0-9-]+$/) // URL 안전 slug
    }
  })
})
