import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const operatorPageSource = readFileSync(new URL('../../app/operator/page.tsx', import.meta.url), 'utf8')

describe('operator console navigation', () => {
  it('keeps all six menu links as full-page section navigations', () => {
    expect(operatorPageSource).toMatch(/href=\{`\/operator\?section=\$\{key\}#operator-content`\}/)
    expect(operatorPageSource).toMatch(/\['overview',[\s\S]*\['agents',[\s\S]*\['cases',[\s\S]*\['firms',[\s\S]*\['sources',[\s\S]*\['runs',/)
  })

  it('shows the three real agents and their working controls', () => {
    expect(operatorPageSource).toContain('수집 에이전트')
    expect(operatorPageSource).toContain('파서 생성 에이전트')
    expect(operatorPageSource).toContain('DB 검토 에이전트')
    expect(operatorPageSource).toContain('action={runParserBuilderFromConsole}')
    expect(operatorPageSource).toContain('action={runDatabaseReviewFromConsole}')
    expect(operatorPageSource).toContain('15분 반복 수집 없음')
    expect(operatorPageSource).toContain('에이전트 실행 이력·피드백')
    expect(operatorPageSource).toContain('상세 결과와 권장 조치 보기')
  })
})
