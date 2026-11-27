import { describe, expect, it } from 'vitest'
import { buildProgrammaticCasePage, decideContentDegree } from '@/lib/scam/programmatic-page'

const base = { name: '테스트프로젝트', scamType: 'invest' }

describe('programmable 사건 페이지 degree', () => {
  it('Degree 1 — 이름·유형 위주면 개요만 생성한다', () => {
    const input = { ...base, observations: [{ title: '테스트프로젝트 투자 관련 문의' }] }
    const page = buildProgrammaticCasePage(input)
    expect(page.degree).toBe(1)
    expect(page.sectionFlags.flow).toBe(false)
    expect(page.sectionFlags.victimPatterns).toBe(false)
    expect(page.detailedNarratives).toHaveLength(0)
  })

  it('Degree 2 — 제목에서 접근·앱·입출금 흐름이 확인되면 패턴 섹션을 연다', () => {
    const input = { ...base, observations: [{ title: 'MOCKR, 가상증권 사칭 앱설치 정보방 연계 입금 후 출금 차단' }] }
    const page = buildProgrammaticCasePage(input)
    expect(page.degree).toBe(2)
    expect(page.sectionFlags.flow).toBe(true)
    expect(page.sectionFlags.victimPatterns).toBe(true)
    expect(page.sectionFlags.detailedNarrative).toBe(false)
    expect(page.entities.find((item) => item.label.includes('기관'))?.values).toContain('가상증권')
    expect(page.entities.find((item) => item.label.includes('앱'))?.values).toContain('MOCKR')
  })

  it('Degree 3 — 구체 본문 파생 사실이 2건 이상이면 상세 피해 서사를 허용한다', () => {
    const observation = {
      title: 'MOCKR, 가상증권 사칭 앱설치 정보방 연계 입금 후 출금 차단',
      facts: { method: ['리딩방', '출금거절'], infra: [{ type: 'app', value: 'MOCKR' }], amounts: [] },
    }
    const input = { ...base, observations: [observation, { ...observation, title: `${observation.title} 추가 제보` }] }
    expect(decideContentDegree(input)).toBe(3)
    const page = buildProgrammaticCasePage(input)
    expect(page.sectionFlags.detailedNarrative).toBe(true)
    expect(page.detailedNarratives.map((item) => item.title)).toContain('구체적으로 확인된 유도 방식')
  })
})
