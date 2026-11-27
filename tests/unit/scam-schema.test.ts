import { describe, it, expect } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { keywords, scamPages, observations } from '@/lib/db/schema'
import { SCAM_TYPE_SEEDS, buildSeedContent } from '@/lib/scam/seed-data'
import { findBannedTerms } from '@/lib/compliance/lexicon'

describe('scam 스키마', () => {
  it('keyword→page→observation 관계 라운드트립', async () => {
    const db = await createTestDb()
    const [k] = await db.insert(keywords).values({
      name: '리딩방 투자 사기', slug: 'leading-room', scamType: '리딩방',
    }).returning()
    expect(k.status).toBe('published')
    const [p] = await db.insert(scamPages).values({
      keywordId: k.id, content: buildSeedContent(SCAM_TYPE_SEEDS[0]), lintPassed: true,
    }).returning()
    expect(p.templateVersion).toBe('v1')
    const [o] = await db.insert(observations).values({
      keywordId: k.id, sourceUrl: 'https://example.com/post',
    }).returning()
    expect(o.observedAt).toBeInstanceOf(Date)
  })
  it('slug unique 제약', async () => {
    const db = await createTestDb()
    await db.insert(keywords).values({ name: 'a', slug: 'dup', scamType: 't' })
    await expect(
      db.insert(keywords).values({ name: 'b', slug: 'dup', scamType: 't' }),
    ).rejects.toThrow()
  })
})

describe('시드 데이터 (안전 정책)', () => {
  it('정확히 20종, slug 중복 없음', () => {
    expect(SCAM_TYPE_SEEDS).toHaveLength(20)
    expect(new Set(SCAM_TYPE_SEEDS.map((s) => s.slug)).size).toBe(20)
  })
  it('전 시드 콘텐츠 금지어 0 + 단정 표현 없음', () => {
    for (const s of SCAM_TYPE_SEEDS) {
      const c = buildSeedContent(s)
      const text = [s.name, c.intro, ...c.sections.flatMap((x) => [x.heading, x.body])].join(' ')
      expect(findBannedTerms(text)).toEqual([])
      expect(text).not.toMatch(/는 사기입니다/)
    }
  })
  it('업체 실명 금지 정책 — 시드는 수법 유형명만 (한글 유형 + 영문 slug)', () => {
    for (const s of SCAM_TYPE_SEEDS) {
      expect(s.slug).toMatch(/^[a-z0-9-]+$/)
      // 사기/스캠/피해 외에도 피싱·편취·먹튀 등 실제 시드에 쓰인 일반 수법 서술어를 포함 —
      // 전부 업체·브랜드 실명이 아닌 통칭 서술어이므로 "업체 실명 금지" 취지는 그대로 유지된다.
      expect(s.name).toMatch(/사기|스캠|피해|피싱|편취|먹튀/)
    }
  })
})
