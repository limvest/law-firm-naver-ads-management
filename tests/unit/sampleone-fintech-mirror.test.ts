import { afterEach, describe, expect, it } from 'vitest'
import { setDbForTesting } from '@/lib/db/client'
import { events, firms, keywords, observations, scamPages } from '@/lib/db/schema'
import { createTestDb } from '../helpers/test-db'
import {
  extractMirrorCaseName,
  getSampleoneFintechCaseProjection,
  renderSampleoneFintechMirrorHtml,
} from '@/lib/scam/sampleone-fintech-mirror'

const HTML = `<!doctype html><body>
<div>피해 접수 <strong id="victimCount">0</strong>건+ <span>(8월 27일 22:34 기준)</span></div>
<h2 id="fc-analysis-title">사건 분석</h2>
<p class="fc-analysis-p fc-reveal-up">기존 사건 설명</p>
<h3 class="fc-analysis-h3 fc-reveal-up">mocksite-cp.com 사칭 사기, 어떻게 접근하나</h3>
<p class="fc-analysis-p fc-reveal-up">공통 정황</p>
<p class="fc-analysis-p fc-reveal-up">기존 접근 설명</p>
<p class="fc-analysis-p fc-analysis-stat fc-reveal-up">약 15건의 상담</p>
<form><input type="hidden" name="case_name" value="mocksite-cp.com"></form>
<script>var targetCount = 15;</script></body>`

describe('샘플원 핀테크 미러 DB projection', () => {
  afterEach(() => setDbForTesting(null))

  it('안정 해시 slug 사건의 관측·페이지뷰·수집 콘텐츠를 조회한다', async () => {
    const db = await createTestDb()
    setDbForTesting(db)
    await db.insert(firms).values({
      id: 289283342, slug: 'sampleone', name: '법무법인 샘플원', adLawyerName: '정오번',
      phone: '010-0000-0009', phoneIntl: '+82-10-0000-0009', address: '서울',
      addressRegion: '서울', addressLocality: '서초구', domain: 'sampleone.attorney',
    })
    const [keyword] = await db.insert(keywords).values({
      firmId: 1,
      name: 'mocksite cpcom',
      normalizedName: '',
      slug: 'mocksite-cpcom-76a3573a0d',
      scamType: 'invest',
      status: 'discovered',
    }).returning()
    await db.insert(observations).values([
      { keywordId: keyword.id, title: '고수익 투자 유도 후 출금 거절', sourceType: 'report', sourceFamily: 'a', facts: { method: ['고수익유도'], infra: [], amounts: [] } },
      { keywordId: keyword.id, title: '원금 보장 문구 확인', sourceType: 'community', sourceFamily: 'b', facts: { method: ['원금보장'], infra: [], amounts: [] } },
    ])
    await db.insert(scamPages).values({
      keywordId: keyword.id,
      lintPassed: true,
      content: { intro: '수집된 사건 피해정보입니다.', sections: [{ heading: '접근 수법', body: '수집 내용에 기반한 접근 설명입니다.' }] },
    })
    await db.insert(events).values(Array.from({ length: 7 }, () => ({
      firmId: 289283342, type: 'page_view', slug: `f/${keyword.slug}`,
    })))

    const projection = await getSampleoneFintechCaseProjection(db, {
      publicSlug: 'mocksite-cpcom',
      caseName: 'mocksite-cp.com',
      firmId: 289283342,
    })
    expect(projection).toMatchObject({
      keywordSlug: 'mocksite-cpcom-76a3573a0d',
      observationCount: 2,
      pageViewCount: 7,
      incidentSummary: '수집된 사건 피해정보입니다.',
      approachSummary: '수집 내용에 기반한 접근 설명입니다.',
    })
  })

  it('원본 구조를 유지하면서 세 표시 영역과 추적 slug를 치환한다', () => {
    expect(extractMirrorCaseName(HTML, 'fallback')).toBe('mocksite-cp.com')
    const output = renderSampleoneFintechMirrorHtml(HTML, {
      keywordSlug: 'mocksite-cpcom-76a3573a0d',
      caseName: 'mocksite-cp.com',
      observationCount: 3,
      pageViewCount: 21,
      observedAt: new Date('2026-08-27T01:00:00Z'),
      incidentSummary: 'DB 사건 설명',
      approachSummary: 'DB 접근 설명',
    }, 'mocksite-cpcom')
    expect(output).toContain('<strong id="victimCount">3</strong>건+')
    expect(output).toContain('var targetCount = 3;')
    expect(output).toContain('DB 사건 설명')
    expect(output).toContain('DB 접근 설명')
    expect(output).toContain('약 21건의 상담이 접수')
    expect(output).toContain('f/mocksite-cpcom-76a3573a0d')
    expect(output).toContain("send('page_view')")
  })
})
