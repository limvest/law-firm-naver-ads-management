// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { createTestDb } from '../helpers/test-db'
import { keywords, scamPages, observations } from '@/lib/db/schema'
import { getScamPage } from '@/lib/scam/data'
import { scamMetadata } from '@/lib/scam/metadata'
import { TrustModules } from '@/components/scam/trust-modules'
import { ScamLanding } from '@/components/scam/scam-landing'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { SCAM_TYPE_SEEDS, buildSeedContent } from '@/lib/scam/seed-data'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

beforeEach(() => {
  window.dataLayer = []
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(), configurable: true })
})

describe('getScamPage', () => {
  it('slug로 페이지+관측 집계를 읽는다', async () => {
    const db = await createTestDb()
    const [k] = await db.insert(keywords).values({ name: '리딩방 투자 사기', slug: 'leading-room', scamType: '리딩방', firstSeenAt: new Date('2026-06-01') }).returning()
    await db.insert(scamPages).values({ keywordId: k.id, content: buildSeedContent(SCAM_TYPE_SEEDS[0]), lintPassed: true })
    await db.insert(observations).values([{ keywordId: k.id }, { keywordId: k.id }])
    const data = await getScamPage(db as never, 'leading-room')
    expect(data!.name).toBe('리딩방 투자 사기')
    expect(data!.observationCount).toBe(2)
    expect(data!.content.sections).toHaveLength(3)
  })
  it('없는 slug는 null', async () => {
    const db = await createTestDb()
    expect(await getScamPage(db as never, 'nope')).toBeNull()
  })
  it('blocked 키워드는 null (게시 중단)', async () => {
    const db = await createTestDb()
    const [k] = await db.insert(keywords).values({ name: 'x', slug: 'blocked-one', scamType: 't', status: 'blocked' }).returning()
    await db.insert(scamPages).values({ keywordId: k.id, content: buildSeedContent(SCAM_TYPE_SEEDS[0]), lintPassed: true })
    expect(await getScamPage(db as never, 'blocked-one')).toBeNull()
  })
})

describe('scamMetadata', () => {
  it('키워드 삽입 + 금지어 0', () => {
    const m = scamMetadata('리딩방 투자 사기')
    expect(m.title).toContain('리딩방 투자 사기')
    expect(findBannedTerms(m.title + ' ' + m.description)).toEqual([])
  })
})

describe('<TrustModules />', () => {
  it('관측 0건이면 아무것도 렌더하지 않는다 (graceful degradation)', () => {
    const { container } = render(<TrustModules firstSeenAt={null} observationCount={0} />)
    expect(container.innerHTML).toBe('')
  })
  it('관측 있으면 모니터링 라벨+경과일+단계 표시', () => {
    const first = new Date(Date.now() - 45 * 86400_000) // 45일 전 → ③ 대응 본격화
    const { getByText, container } = render(<TrustModules firstSeenAt={first} observationCount={7} />)
    getByText(/본 사무소 모니터링 시스템 기준/)
    getByText(/45일/)
    getByText(/대응 본격화/)
    expect(container.textContent).toContain('7건')
    expect(findBannedTerms(container.textContent ?? '')).toEqual([]) // 트러스트 모듈 카피 렉시콘 회귀 방지
  })
})

describe('<ScamLanding />', () => {
  it('scam 테마 + 키워드 헤드라인 + CTA + 금지어 0', () => {
    const data = {
      name: '리딩방 투자 사기', slug: 'leading-room', scamType: '리딩방',
      content: buildSeedContent(SCAM_TYPE_SEEDS[0]), firstSeenAt: null, observationCount: 0,
    }
    const { container, getByText } = render(<ScamLanding data={data} firm={DEFAULT_FIRM} />)
    expect(container.querySelector('[data-vertical="scam"]')).toBeTruthy()
    getByText(/리딩방 투자 사기/)
    expect(container.textContent).toContain('상담')
    expect(findBannedTerms(container.textContent ?? '')).toEqual([])
  })
})
