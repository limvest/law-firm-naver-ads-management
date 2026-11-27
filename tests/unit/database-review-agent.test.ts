import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { intelligenceSources, keywords, observations, sourceRuns } from '@/lib/db/schema'
import { detectDatabaseReviewNeed, runDatabaseReviewAgent } from '@/domains/intelligence/database-review-agent'

const NOW = new Date('2026-08-25T03:00:00.000Z')

describe('조건부 운영 DB 검토 에이전트', () => {
  it('이상 징후가 없으면 검토 에이전트를 호출하지 않는다', async () => {
    const db = await createTestDb()
    const result = await runDatabaseReviewAgent(db, { now: NOW })
    expect(result.invoked).toBe(false)
    expect(result.report).toBeNull()
    expect(result.decision.findings).toEqual([])
  })

  it('파서 실패나 수집 실패가 있을 때만 읽기 전용 검토를 호출한다', async () => {
    const db = await createTestDb()
    const [source] = await db.insert(intelligenceSources).values({
      sourceKey: 'operator:review-me', name: '검토 소스', sourceType: 'pending', enabled: false,
      config: { onboardingStatus: 'needs_review', analysisError: '구조 판별 실패' },
    }).returning()
    await db.insert(sourceRuns).values({
      sourceId: source.id, status: 'failed', itemsSeen: 0, itemsAccepted: 0,
      checkpointBefore: { cursor: 10 }, checkpointAfter: { cursor: 10 },
      startedAt: new Date('2026-08-25T02:00:00.000Z'), finishedAt: new Date('2026-08-25T02:01:00.000Z'),
    })

    const result = await runDatabaseReviewAgent(db, { now: NOW })
    expect(result.invoked).toBe(true)
    expect(result.report?.mode).toBe('read-only')
    expect(result.decision.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'parser_needs_review', 'source_run_failed',
    ]))
  })

  it('운영 관측의 필수값 누락을 이상으로 판별한다', async () => {
    const db = await createTestDb()
    const [keyword] = await db.insert(keywords).values({ name: '검토 사건', slug: 'review-case', scamType: 'coin' }).returning()
    await db.insert(observations).values({ keywordId: keyword.id, sourceUrl: null, sourceType: null, observedAt: NOW })

    const decision = await detectDatabaseReviewNeed(db, { now: NOW })
    expect(decision.needed).toBe(true)
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'malformed_observation', count: 1 }),
    ]))
  })

  it('ready 상태의 누락·저표본 parserSpec을 다시 검토 대상으로 잡는다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values([
      {
        sourceKey: 'operator:missing-spec', name: '누락 파서', sourceType: 'report', enabled: true,
        config: { onboardingStatus: 'ready' },
      },
      {
        sourceKey: 'operator:weak-spec', name: '저표본 파서', sourceType: 'report', enabled: true,
        config: { onboardingStatus: 'ready', parserSpec: { adapter: 'webpage-list', sampleItemCount: 2 } },
      },
      {
        sourceKey: 'operator:weak-extraction', name: '상세 검증 부족', sourceType: 'report', enabled: true,
        config: { onboardingStatus: 'ready', parserSpec: {
          adapter: 'sitemap-xml', sampleItemCount: 100,
          extractionRule: { samplesAttempted: 8, caseNamesExtracted: 4, observationsExtracted: 8 },
        } },
      },
    ])

    const decision = await detectDatabaseReviewNeed(db, { now: NOW })
    expect(decision.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'parser_spec_missing', count: 1 }),
      expect.objectContaining({ code: 'weak_parser_sample', count: 1 }),
      expect.objectContaining({ code: 'unverified_case_extraction', count: 2 }),
    ]))
  })
})
