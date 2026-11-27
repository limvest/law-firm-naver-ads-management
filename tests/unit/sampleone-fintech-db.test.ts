import { afterEach, describe, expect, it } from 'vitest'
import { setDbForTesting } from '@/lib/db/client'
import { events, firmKeywords, firms, keywords, observations, scamPages } from '@/lib/db/schema'
import { createTestDb } from '../helpers/test-db'
import { getSampleoneDbCase, listSampleoneDbCases } from '@/lib/scam/sampleone-fintech-db'

describe('샘플원 핀테크 DB 페이지', () => {
  afterEach(() => setDbForTesting(null))

  it('신규 관측 사건을 목록과 상세에 같은 DB 값으로 제공한다', async () => {
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
      { keywordId: keyword.id, title: 'mocksite cp.com', origin: 'source-a', sourceUrl: 'https://a.test/1' },
      { keywordId: keyword.id, title: 'mocksite cpcom', origin: 'source-b', sourceUrl: 'https://b.test/2' },
    ])
    await db.insert(events).values(Array.from({ length: 4 }, () => ({
      firmId: 289283342, type: 'page_view', slug: `f/${keyword.slug}`,
    })))

    const list = await listSampleoneDbCases(db, { firmId: 289283342, query: 'mocksite' })
    expect(list.total).toBe(1)
    expect(list.items[0]).toMatchObject({
      name: 'mocksite-cp.com',
      slug: 'mocksite-cpcom-76a3573a0d',
      observationCount: 2,
      independentSourceCount: 2,
    })

    const detail = await getSampleoneDbCase(db, { firmId: 289283342, slug: 'mocksite-cpcom' })
    expect(detail).toMatchObject({
      name: 'mocksite-cp.com',
      slug: 'mocksite-cpcom-76a3573a0d',
      databaseSlug: 'mocksite-cpcom-76a3573a0d',
      observationCount: 2,
      independentSourceCount: 2,
      pageViewCount: 4,
      contentSource: 'observation-count',
    })
    expect(detail?.incidentSummary).toContain('2건 관측')
  })

  it('검수 통과 사건 원고를 수집 건수형 문구보다 우선한다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 1, slug: 'test-firm', name: '테스트 법무법인', adLawyerName: '테스트',
      phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: '서울',
      addressRegion: '서울', addressLocality: '서초구', domain: 'test.example',
    })
    const [keyword] = await db.insert(keywords).values({
      firmId: 1, name: '검수 사건', normalizedName: '검수사건', slug: 'reviewed-case',
      scamType: 'leading', status: 'published',
    }).returning()
    await db.insert(firmKeywords).values({ firmId: 1, keywordId: keyword.id })
    await db.insert(scamPages).values({
      keywordId: keyword.id,
      lintPassed: true,
      content: { intro: '검수된 사건 설명', sections: [{ heading: '접근 수법', body: '검수된 접근 설명' }] },
    })
    const detail = await getSampleoneDbCase(db, { firmId: 1, slug: 'reviewed-case' })
    expect(detail).toMatchObject({
      contentSource: 'reviewed',
      incidentSummary: '검수된 사건 설명',
      approachSummary: '검수된 접근 설명',
    })
  })

  it('같은 짧은 slug의 서로 다른 사건은 전체 DB slug로 분리하고 모호한 주소는 선택하지 않는다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 1, slug: 'collision-firm', name: '충돌 테스트', adLawyerName: '테스트',
      phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: '서울',
      addressRegion: '서울', addressLocality: '서초구', domain: 'collision.example',
    })
    const inserted = await db.insert(keywords).values([
      { firmId: 1, name: '첫 번째 사건', normalizedName: '첫번째사건', slug: 'case-000b457fe6', scamType: 'other', status: 'published' },
      { firmId: 1, name: '두 번째 사건', normalizedName: '두번째사건', slug: 'case-000cb07dab', scamType: 'other', status: 'published' },
    ]).returning()
    await db.insert(firmKeywords).values(inserted.map((keyword) => ({ firmId: 1, keywordId: keyword.id })))

    const list = await listSampleoneDbCases(db, { firmId: 1 })
    expect(list.items.map((item) => item.slug).sort()).toEqual(['case-000b457fe6', 'case-000cb07dab'])
    expect(await getSampleoneDbCase(db, { firmId: 1, slug: 'case' })).toBeNull()
    expect(await getSampleoneDbCase(db, { firmId: 1, slug: 'case-000b457fe6' })).toMatchObject({ name: '첫 번째 사건' })
  })
})
