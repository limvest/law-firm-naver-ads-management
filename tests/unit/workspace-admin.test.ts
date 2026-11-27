import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  ADMIN_SESSION_COOKIE,
} from '@/lib/admin-auth'
import {
  HIGGSFIELD_CLIENT_COOKIE,
  hashFirmPassword,
  higgsfieldClientSessionValue,
} from '@/lib/higgsfield-client-auth'
import { setDbForTesting } from '@/lib/db/client'
import { firmAccounts, firmCollectionRuns, firmKeywords, firmSourceGrants, firms, intelligenceSources, keywords, scamPages } from '@/lib/db/schema'
import { createTestDb } from '../helpers/test-db'
import { GET, POST, parseKeywordListQuery, renderCasesShowcase, renderClientDashboard, renderObservationDetail } from '../../app/workspace/route'

describe('firm-scoped Higgsfield client dashboard', () => {
  const previousToken = process.env.ADMIN_TOKEN
  const previousDatabaseUrl = process.env.DATABASE_URL

  beforeEach(() => {
    process.env.ADMIN_TOKEN = 'test-admin-token'
    delete process.env.DATABASE_URL
    setDbForTesting(null)
  })

  afterEach(() => {
    setDbForTesting(null)
    vi.restoreAllMocks()
    if (previousToken === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = previousToken
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
  })

  it('shows a law-firm client login and no platform operator vocabulary', async () => {
    const response = await GET(new Request('https://example.test/workspace'))
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('법무법인 고객 운영실')
    expect(html).toContain('자사 방문·상담·사건 페이지·광고 성과')
    expect(html).toContain('name="username"')
    expect(html).toContain('name="password"')
    expect(html).not.toContain('사기업체 harvester')
    expect(html).not.toContain('에이전트 리포트')
    expect(html).not.toContain('소스 건강')
  })

  it('rejects invalid credentials and issues a path-scoped client cookie for test / 0000', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({ id: 2, slug: 'demo', name: '데모', adLawyerName: '데모', phone: '1', phoneIntl: '1', address: 'a', addressRegion: 'a', addressLocality: 'a' })
    await db.insert(firmAccounts).values({ firmId: 2, loginId: 'test', passwordHash: hashFirmPassword('0000', 'test-salt') })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const invalid = await POST(new Request('https://example.test/workspace', {
      method: 'POST', body: new URLSearchParams({ username: 'test', password: 'wrong' }),
    }))
    expect(await invalid.text()).toContain('아이디 또는 비밀번호를 확인해 주세요.')

    const valid = await POST(new Request('https://example.test/workspace', {
      method: 'POST', body: new URLSearchParams({ username: 'test', password: '0000' }),
    }))
    expect(valid.status).toBe(303)
    expect(valid.headers.get('location')).toBe('/workspace')
    const cookie = valid.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${HIGGSFIELD_CLIENT_COOKIE}=`)
    expect(cookie).toContain('Path=/workspace')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toContain('lawfirm_admin_session=')
  })

  it('does not accept the total-operator admin cookie', async () => {
    const response = await GET(new Request('https://example.test/workspace', {
      headers: { cookie: 'lawfirm_admin_session=anything' },
    }))
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('법무법인 고객 운영실')
    expect(html).toContain('name="password"')
  })

  it('never clears the total-operator cookie while serving the client route', async () => {
    const response = await GET(new Request('https://example.test/workspace', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=operator-session` },
    }))

    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('does not expose observation detail without the firm-bound client session', async () => {
    const response = await GET(new Request(
      'https://example.test/workspace?view=observations&slug=secret-case',
    ))
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('로그인이 필요합니다')
  })

  it('loads every observation for an assigned firm keyword on demand', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          name: '실제 사건', observationId: 'obs-2', observedAt: '2026-08-12T03:15:00.000Z',
          sourceUrl: 'https://example.com/two', sourceType: 'news', title: '두 번째 관측', facts: null,
        },
        {
          name: '실제 사건', observationId: 'obs-1', observedAt: '2026-08-11T02:00:00.000Z',
          sourceUrl: 'https://example.com/one', sourceType: 'community', title: '첫 번째 관측',
          facts: { method: ['추가입금 요구'], infra: [], amounts: ['500만원'] },
        },
      ],
    })
    setDbForTesting({ execute } as never)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const response = await GET(new Request(
      'https://example.test/workspace?view=observations&slug=real-case',
      { headers: { cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` } },
    ))
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(html).toContain('원본 관측 2건')
    expect(html).toContain('고유 내용 2건으로 묶어 표시')
    expect(html).toContain('두 번째 관측')
    expect(html).toContain('첫 번째 관측')
    expect(html).toContain('500만원')
  })

  it('returns 404 instead of exposing an unassigned keyword observation', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] })
    setDbForTesting({ execute } as never)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const response = await GET(new Request(
      'https://example.test/workspace?view=observations&slug=other-firm-case',
      { headers: { cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` } },
    ))
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('배정된 사건을 찾을 수 없습니다')
  })

  it('accepts only a firm-bound client session before touching the database', async () => {
    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const response = await GET(new Request('https://example.test/workspace', {
      headers: { cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
    }))
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('고객 데이터베이스에 연결할 수 없습니다')

    const otherFirmSession = higgsfieldClientSessionValue('test-admin-token', 3)
    const denied = await GET(new Request('https://example.test/workspace', {
      headers: { cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${otherFirmSession}` },
    }))
    expect(denied.status).toBe(503)
    expect(await denied.text()).toContain('고객 데이터베이스에 연결할 수 없습니다')
  })

  it('parses the full keyword URL list controls', () => {
    expect(parseKeywordListQuery(new URL(
      'https://example.test/workspace?tab=cases&q=%20%EC%BD%94%EC%9D%B8%20&sort=inquiries&dir=asc&page=23&size=500',
    ))).toEqual({
      tab: 'cases', q: '코인', sort: 'inquiries', dir: 'asc', page: 23, pageSize: 500,
    })
  })

  it('parses the separate source-request tab', () => {
    expect(parseKeywordListQuery(new URL(
      'https://example.test/workspace?tab=requests',
    )).tab).toBe('requests')
  })

  it('maps the retired advertising-creation tab into the page and advertising flow', () => {
    expect(parseKeywordListQuery(new URL(
      'https://example.test/workspace?tab=ad-create&q=%EC%BD%94%EC%9D%B8&page=2',
    ))).toMatchObject({ tab: 'cases', q: '코인', page: 2 })
  })

  it('requires same-origin firm authentication before submitting a source request', async () => {
    const execute = vi.fn()
    setDbForTesting({ execute } as never)
    process.env.DATABASE_URL = 'postgresql://test'
    const form = new URLSearchParams({ action: 'source-request', sourceUrl: 'https://example.com/board' })

    const unauthenticated = await POST(new Request('https://example.test/workspace', {
      method: 'POST', headers: { origin: 'https://example.test' }, body: form,
    }))
    expect(unauthenticated.status).toBe(401)
    expect(execute).not.toHaveBeenCalled()

    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const crossOrigin = await POST(new Request('https://example.test/workspace', {
      method: 'POST', headers: {
        origin: 'https://attacker.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}`,
      }, body: form,
    }))
    expect(crossOrigin.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('requires same-origin firm authentication before changing a page advertising toggle', async () => {
    const update = vi.fn()
    setDbForTesting({ update } as never)
    process.env.DATABASE_URL = 'postgresql://test'
    const form = new URLSearchParams({
      action: 'set-ad-desired',
      keywordId: '11111111-1111-4111-8111-111111111111',
      desired: 'true',
    })

    const unauthenticated = await POST(new Request('https://example.test/workspace', {
      method: 'POST', headers: { origin: 'https://example.test' }, body: form,
    }))
    expect(unauthenticated.status).toBe(401)
    expect(update).not.toHaveBeenCalled()

    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const crossOrigin = await POST(new Request('https://example.test/workspace', {
      method: 'POST', headers: {
        origin: 'https://attacker.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}`,
      }, body: form,
    }))
    expect(crossOrigin.status).toBe(403)
    expect(update).not.toHaveBeenCalled()
  })

  it('requires same-origin firm authentication before queuing a collection run', async () => {
    const transaction = vi.fn()
    setDbForTesting({ transaction } as never)
    process.env.DATABASE_URL = 'postgresql://test'
    const form = new URLSearchParams({ action: 'run-collection', returnTab: 'cases' })

    const unauthenticated = await POST(new Request('https://example.test/workspace', {
      method: 'POST', headers: { origin: 'https://example.test' }, body: form,
    }))
    expect(unauthenticated.status).toBe(401)
    expect(transaction).not.toHaveBeenCalled()

    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const crossOrigin = await POST(new Request('https://example.test/workspace', {
      method: 'POST', headers: {
        origin: 'https://attacker.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}`,
      }, body: form,
    }))
    expect(crossOrigin.status).toBe(403)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('accepts a Vercel public origin when the internal request URL uses the deployment host', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ result: 'no-sources' }] })
    setDbForTesting({ execute } as never)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)

    const response = await POST(new Request('https://internal-deployment.vercel.app/workspace', {
      method: 'POST',
      headers: {
        origin: 'https://lawfirm-ads.vercel.app',
        'x-forwarded-host': 'lawfirm-ads.vercel.app',
        'x-forwarded-proto': 'https',
        cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}`,
      },
      body: new URLSearchParams({ action: 'run-collection', returnTab: 'cases' }),
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/workspace?tab=cases&action=collection-no-sources')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('stores an authenticated source request for firm 2 and redirects back to its queue', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'request-2' }])
    const onConflictDoNothing = vi.fn(() => ({ returning }))
    const values = vi.fn(() => ({ onConflictDoNothing }))
    const insert = vi.fn(() => ({ values }))
    setDbForTesting({ insert } as never)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)

    const response = await POST(new Request('https://example.test/workspace', {
      method: 'POST',
      headers: { origin: 'https://example.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
      body: new URLSearchParams({ action: 'source-request', sourceUrl: 'https://Example.com/board#latest' }),
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/workspace?tab=requests&request=created')
    expect(values).toHaveBeenCalledWith({ firmId: 2, sourceUrl: 'https://example.com/board' })
  })

  it('queues one firm-scoped collection run and coalesces duplicate clicks', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 2,
      slug: 'demo-firm',
      name: '데모 법무법인',
      adLawyerName: '담당 변호사',
      phone: '02-0000-0000',
      phoneIntl: '+82-2-0000-0000',
      address: '서울',
      addressRegion: '서울',
      addressLocality: '강남',
    })
    const sourceId = '22222222-2222-4222-8222-222222222222'
    await db.insert(intelligenceSources).values({
      id: sourceId,
      sourceKey: 'legacy:test-source',
      name: '승인 수집소스',
      sourceType: 'news',
      enabled: true,
    })
    await db.insert(firmSourceGrants).values({ firmId: 2, sourceId, status: 'active' })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const submit = () => POST(new Request('https://example.test/workspace?tab=cases', {
      method: 'POST',
      headers: { origin: 'https://example.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
      body: new URLSearchParams({
        action: 'run-collection',
        returnTab: 'cases',
        firmId: '999',
        sourceUrl: 'http://127.0.0.1/private',
      }),
    }))

    const first = await submit()
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe('/workspace?tab=cases&action=collection-running')
    const second = await submit()
    expect(second.status).toBe(303)
    expect(second.headers.get('location')).toBe('/workspace?tab=cases&action=collection-duplicate')

    const runs = await db.select().from(firmCollectionRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      firmId: 2,
      status: 'running',
      requestedSourceIds: [sourceId],
      requestedSourceCount: 1,
    })
    expect(JSON.stringify(runs[0].requestedSourceIds)).not.toContain('127.0.0.1')
    expect(runs[0].firmId).not.toBe(999)
  })

  it('turns on Naver advertising only for the selected firm keyword', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 2,
      slug: 'demo-firm',
      name: '데모 법무법인',
      adLawyerName: '담당 변호사',
      phone: '02-0000-0000',
      phoneIntl: '+82-2-0000-0000',
      address: '서울',
      addressRegion: '서울',
      addressLocality: '강남',
    })
    const [keyword] = await db.insert(keywords).values({
      firmId: 2, name: '광고 테스트 사건', slug: 'ad-test-case', scamType: 'coin', status: 'published',
    }).returning()
    await db.insert(scamPages).values({
      keywordId: keyword.id,
      content: { intro: '피해 대응 안내', sections: [] },
      templateVersion: 'response-pipeline-v1',
      lintPassed: true,
    })
    await db.insert(firmKeywords).values({ firmId: 2, keywordId: keyword.id, adDesired: false })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const form = new URLSearchParams({
      action: 'set-ad-desired',
      keywordId: keyword.id,
      desired: 'true',
    })

    const response = await POST(new Request('https://example.test/workspace', {
      method: 'POST',
      headers: { origin: 'https://example.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
      body: form,
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('/workspace?tab=cases')
    const [updatedKeyword] = await db.select().from(firmKeywords).where(eq(firmKeywords.keywordId, keyword.id))
    expect(updatedKeyword.adDesired).toBe(true)
  })

  it('bulk-updates checked advertising rows without touching another firm', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      {
        id: 2, slug: 'demo-firm', name: '데모 법무법인', adLawyerName: '담당 변호사',
        phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: '서울', addressRegion: '서울', addressLocality: '강남',
      },
      {
        id: 3, slug: 'other-firm', name: '다른 법무법인', adLawyerName: '다른 변호사',
        phone: '02-1111-1111', phoneIntl: '+82-2-1111-1111', address: '서울', addressRegion: '서울', addressLocality: '서초',
      },
    ])
    const [owned, other] = await db.insert(keywords).values([
      { firmId: 2, name: '자사 사건', slug: 'owned-bulk-case', scamType: 'coin', status: 'published' },
      { firmId: 3, name: '타사 사건', slug: 'other-bulk-case', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(firmKeywords).values([
      { firmId: 2, keywordId: owned.id, adDesired: false },
      { firmId: 3, keywordId: other.id, adDesired: false },
    ])
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)

    const response = await POST(new Request('https://example.test/workspace?tab=cases', {
      method: 'POST',
      headers: { origin: 'https://example.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
      body: new URLSearchParams({
        action: 'set-ad-desired-bulk',
        keywordIds: `${owned.id},${other.id}`,
        desired: 'true',
      }),
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('action=ad-bulk-on')
    const [ownedSetting] = await db.select().from(firmKeywords).where(eq(firmKeywords.keywordId, owned.id))
    const [otherSetting] = await db.select().from(firmKeywords).where(eq(firmKeywords.keywordId, other.id))
    expect(ownedSetting.adDesired).toBe(true)
    expect(otherSetting.adDesired).toBe(false)
  })

  it('bulk-updates an N-to-M range in the current server sort order', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 2, slug: 'range-firm', name: '범위 법무법인', adLawyerName: '담당 변호사',
      phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: '서울', addressRegion: '서울', addressLocality: '강남',
    })
    const created = await db.insert(keywords).values([
      { firmId: 2, name: '가 사건', slug: 'range-a', scamType: 'coin', status: 'published' },
      { firmId: 2, name: '나 사건', slug: 'range-b', scamType: 'coin', status: 'published' },
      { firmId: 2, name: '다 사건', slug: 'range-c', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(firmKeywords).values(created.map((keyword) => ({ firmId: 2, keywordId: keyword.id, adDesired: false })))
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)

    const response = await POST(new Request('https://example.test/workspace?tab=cases', {
      method: 'POST',
      headers: { origin: 'https://example.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
      body: new URLSearchParams({
        action: 'set-ad-desired-bulk', desired: 'true', keywordIds: '',
        sort: 'name', dir: 'asc', q: '', rangeStart: '2', rangeEnd: '3',
      }),
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('action=ad-bulk-on')
    const settings = await db.select().from(firmKeywords)
    const byKeyword = new Map(settings.map((setting) => [setting.keywordId, setting.adDesired]))
    expect(byKeyword.get(created[0].id)).toBe(false)
    expect(byKeyword.get(created[1].id)).toBe(true)
    expect(byKeyword.get(created[2].id)).toBe(true)
  })

  it('adds a normalized manual keyword to the firm and generates its public response page', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 2,
      slug: 'demo-firm',
      name: '데모 법무법인',
      adLawyerName: '담당 변호사',
      phone: '02-0000-0000',
      phoneIntl: '+82-2-0000-0000',
      address: '서울',
      addressRegion: '서울',
      addressLocality: '강남',
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)

    const response = await POST(new Request('https://example.test/workspace?tab=requests', {
      method: 'POST',
      headers: { origin: 'https://example.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
      body: new URLSearchParams({
        action: 'add-keyword',
        keywordName: '  직접 추가 사건  ',
        scamType: 'coin',
      }),
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('/workspace?tab=requests')
    const [keyword] = await db.select().from(keywords).where(eq(keywords.name, '직접 추가 사건'))
    expect(keyword).toMatchObject({ scamType: 'coin', status: 'published' })
    const [assignment] = await db.select().from(firmKeywords).where(eq(firmKeywords.keywordId, keyword.id))
    expect(assignment).toMatchObject({ firmId: 2, adDesired: false, archivedAt: null })
    const [page] = await db.select().from(scamPages).where(eq(scamPages.keywordId, keyword.id))
    expect(page).toMatchObject({ lintPassed: true })
  })

  it('keeps an existing scam-page content payload intact when the keyword is added again', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 2,
      slug: 'demo-firm',
      name: '데모 법무법인',
      adLawyerName: '담당 변호사',
      phone: '02-0000-0000',
      phoneIntl: '+82-2-0000-0000',
      address: '서울',
      addressRegion: '서울',
      addressLocality: '강남',
    })
    const [keyword] = await db.insert(keywords).values({
      firmId: 2,
      name: '기존 콘텐츠 사건',
      slug: 'existing-content-case',
      scamType: 'coin',
      status: 'discovered',
    }).returning()
    const originalContent = {
      intro: '운영자가 검수한 기존 안내문',
      sections: [{ title: '기존 섹션', body: '이 문구는 다시 추가해도 유지되어야 합니다.' }],
      marker: 'do-not-overwrite',
    }
    await db.insert(scamPages).values({
      keywordId: keyword.id,
      content: originalContent,
      templateVersion: 'reviewed-v7',
      lintPassed: true,
    })
    await db.insert(firmKeywords).values({
      firmId: 2,
      keywordId: keyword.id,
      adDesired: false,
      archivedAt: new Date('2026-08-01T00:00:00.000Z'),
    })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)

    const response = await POST(new Request('https://example.test/workspace?tab=requests', {
      method: 'POST',
      headers: { origin: 'https://example.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
      body: new URLSearchParams({
        action: 'add-keyword',
        keywordName: '기존 콘텐츠 사건',
        scamType: 'other',
      }),
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('action=keyword-existing')
    const pages = await db.select().from(scamPages).where(eq(scamPages.keywordId, keyword.id))
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      content: originalContent,
      templateVersion: 'reviewed-v7',
      lintPassed: true,
    })
    const [assignment] = await db.select().from(firmKeywords)
      .where(eq(firmKeywords.keywordId, keyword.id))
    expect(assignment.archivedAt).toBeNull()
  })

  it('shows a discovered firm keyword in collection management but not in the public-page list', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 2,
      slug: 'demo-firm',
      name: '데모 법무법인',
      adLawyerName: '담당 변호사',
      phone: '02-0000-0000',
      phoneIntl: '+82-2-0000-0000',
      address: '서울',
      addressRegion: '서울',
      addressLocality: '강남',
    })
    const [keyword] = await db.insert(keywords).values({
      firmId: 2,
      name: '아직 수집 중인 사건',
      slug: 'discovered-only-case',
      scamType: 'other',
      status: 'discovered',
    }).returning()
    await db.insert(firmKeywords).values({ firmId: 2, keywordId: keyword.id, adDesired: false })
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)
    const headers = { cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` }

    const collectionResponse = await GET(new Request(
      'https://example.test/workspace?tab=requests&q=%EC%95%84%EC%A7%81%20%EC%88%98%EC%A7%91',
      { headers },
    ))
    const collectionHtml = await collectionResponse.text()
    expect(collectionResponse.status).toBe(200)
    expect(collectionHtml).toContain('아직 수집 중인 사건')
    expect(collectionHtml).toContain('생성 대기 · 미리보기')

    const pagesResponse = await GET(new Request(
      'https://example.test/workspace?tab=cases&q=%EC%95%84%EC%A7%81%20%EC%88%98%EC%A7%91',
      { headers },
    ))
    const pagesHtml = await pagesResponse.text()
    expect(pagesResponse.status).toBe(200)
    expect(pagesHtml).not.toContain('아직 수집 중인 사건')
    expect(pagesHtml).toContain('검색 조건에 맞는 배포 URL이 없습니다')
  })

  it('archives a keyword only for the signed-in firm and keeps the shared keyword intact', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      {
        id: 2, slug: 'demo-firm', name: '데모 법무법인', adLawyerName: '담당 변호사',
        phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: '서울', addressRegion: '서울', addressLocality: '강남',
      },
      {
        id: 3, slug: 'other-firm', name: '다른 법무법인', adLawyerName: '다른 변호사',
        phone: '02-1111-1111', phoneIntl: '+82-2-1111-1111', address: '서울', addressRegion: '서울', addressLocality: '서초',
      },
    ])
    const [keyword] = await db.insert(keywords).values({
      firmId: 2, name: '공유 사건', slug: 'shared-case', scamType: 'other', status: 'published',
    }).returning()
    await db.insert(firmKeywords).values([
      { firmId: 2, keywordId: keyword.id, adDesired: true },
      { firmId: 3, keywordId: keyword.id, adDesired: true },
    ])
    setDbForTesting(db)
    process.env.DATABASE_URL = 'postgresql://test'
    const session = higgsfieldClientSessionValue('test-admin-token', 2)

    const response = await POST(new Request('https://example.test/workspace?tab=requests', {
      method: 'POST',
      headers: { origin: 'https://example.test', cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${session}` },
      body: new URLSearchParams({ action: 'archive-keyword', keywordId: keyword.id }),
    }))

    expect(response.status).toBe(303)
    const assignments = await db.select().from(firmKeywords).where(eq(firmKeywords.keywordId, keyword.id))
    expect(assignments.find((row) => row.firmId === 2)).toMatchObject({ adDesired: false })
    expect(assignments.find((row) => row.firmId === 2)?.archivedAt).toBeInstanceOf(Date)
    expect(assignments.find((row) => row.firmId === 3)).toMatchObject({ adDesired: true, archivedAt: null })
    expect(await db.select().from(keywords).where(eq(keywords.id, keyword.id))).toHaveLength(1)
  })

  it('uses safe defaults for invalid keyword URL list controls', () => {
    expect(parseKeywordListQuery(new URL(
      'https://example.test/workspace?tab=operator&sort=secret&dir=sideways&page=-1&size=20000',
    ))).toEqual({
      tab: 'cases', q: '', sort: 'visitors', dir: 'desc', page: 1, pageSize: 100,
    })
  })

  it('restores the original observation dossier and full source detail safely', () => {
    const html = renderObservationDetail({
      name: '<사건명>',
      rows: [
        {
          observedAt: '2026-08-12T03:15:00.000Z',
          sourceUrl: 'https://example.com/source?a=1&b=2',
          sourceType: 'community',
          title: '<script>alert(1)</script>',
          facts: {
            method: ['추가입금 요구'],
            infra: [{ type: 'telegram', value: 'bad<channel' }],
            amounts: ['1,000만원'],
          },
        },
        {
          observedAt: '2026-08-11T02:00:00.000Z',
          sourceUrl: 'javascript:alert(1)',
          sourceType: 'report',
          title: '두 번째 관측',
          facts: null,
        },
      ],
    })
    expect(html).toContain('관측 2건')
    expect(html).toContain('구조화 사실 1건')
    expect(html).toContain('수법')
    expect(html).toContain('확인된 인프라')
    expect(html).toContain('원문 언급 금액')
    expect(html).toContain('관측 기간(원문 작성)')
    expect(html).toContain('커뮤니티')
    expect(html).toContain('제보/리포트')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('https://example.com/source?a=1&amp;b=2')
    expect(html).not.toContain('javascript:alert(1)')
  })

  it('groups repeated observation posts into one detail row without changing the raw count', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      observedAt: new Date(Date.UTC(2024, 9, index + 1, 15)).toISOString(),
      sourceUrl: `https://blog.example/posts/${index + 1}`,
      sourceType: 'report',
      title: '가상코인B 가상코인C 가상코인B [코인투자사기]',
      facts: null,
    }))
    const html = renderObservationDetail({ name: '가상코인B', rows })
    expect(html).toContain('원본 관측 20건')
    expect(html).toContain('고유 내용 1건으로 묶어 표시')
    expect(html).toContain('반복 ×20')
    expect(html).toContain('2024-10-01 ~ 2024-10-20')
    expect(html).toContain('https://blog.example/posts/20')
    expect(html).not.toContain('https://blog.example/posts/1"')
    expect(html.match(/가상코인B 가상코인C 가상코인B/g)).toHaveLength(1)
  })

  it('renders observation detail in a full-width row without widening the clicked cell', async () => {
    const response = renderClientDashboard({
      firm: { id: 2, name: '데모', status: 'pilot', domain: null, landingReady: true, siteTemplate: 'response-room' },
      visits: 0, leads: 0, qualified: 0, retained: 0, assignedKeywords: 1,
      adDesiredKeywords: 0, deployedUrls: 1, livePages: 0, pendingPages: 0,
      ad: { spend: 0, impressions: 0, clicks: 0, qualifiedLeads: 0, retainedMatters: 0 },
      leadQueue: [], campaigns: [],
      sourceRequests: [],
      collectionUsage: { periodKey: '2026-08', approvedSourceCount: 1, requested: 0, completed: 0, active: null, recent: [] },
      keywordList: {
        tab: 'cases', q: '', sort: 'visitors', dir: 'desc', page: 1, pageSize: 100,
        total: 1, pageCount: 1, from: 1, to: 1,
        rows: [{
          keywordId: '11111111-1111-4111-8111-111111111111',
          name: '사건 A', slug: 'case-a', scamType: 'other', keywordStatus: 'published',
          sourceUrl: null,
          pipelineStatus: 'subscribed', adDesired: false, pageStatus: 'not_published',
          observationCount: 7, visitors: 0, inquiries: 0, lastVisitedAt: null,
        }],
      },
    }, 'https://example.test')
    const html = await response.text()
    expect(html).toContain('class="obs-toggle"')
    expect(html).toContain('관측 7건 · 자세히 보기')
    expect(html).toContain('class="obs-row" id="observation-panel-0" hidden')
    expect(html).toContain('<td colspan="11"><div class="obs-panel">')
    expect(html).toContain('scrollLeft=scroller?.scrollLeft??0')
    expect(html).not.toContain('obs-detail[open]')
  })

  it('renders a read-only cases and landing showcase with at most 200 keywords', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      keywordId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
      name: `사건 ${index + 1}`, slug: `case-${index + 1}`, scamType: 'other', keywordStatus: 'published',
      sourceUrl: null, pipelineStatus: 'subscribed', adDesired: false, pageStatus: 'live',
      observationCount: 1, visitors: index, inquiries: 0, lastVisitedAt: null,
    }))
    const response = renderCasesShowcase({
      firm: { id: 2, name: '데모', status: 'pilot', domain: null, landingReady: true, siteTemplate: 'response-room' },
      visits: 300, leads: 2, qualified: 0, retained: 0, assignedKeywords: 25000,
      adDesiredKeywords: 0, deployedUrls: 25000, livePages: 25000, pendingPages: 0,
      ad: { spend: 0, impressions: 0, clicks: 0, qualifiedLeads: 0, retainedMatters: 0 },
      leadQueue: [], campaigns: [], sourceRequests: [],
      collectionUsage: { periodKey: '2026-08', approvedSourceCount: 1, requested: 0, completed: 0, active: null, recent: [] },
      keywordList: { tab: 'cases', q: '', sort: 'visitors', dir: 'desc', page: 1, pageSize: 200, total: 25000, pageCount: 125, from: 1, to: 200, rows },
    }, 'https://example.test')
    const html = await response.text()
    expect(html).toContain('사건명 수집 예시')
    expect(html).toContain('문의 시 실제 작동하는 전체 기능')
    expect(html).toContain('사건·랜딩 페이지 예시')
    expect(html).toContain('200개의 검색어')
    expect(html).toContain('페이지 열기')
    expect(html).not.toContain('관측 수·상세')
    expect(html).not.toContain('방문자수')
    expect(html).not.toContain('문의수')
    expect(html).not.toContain('키워드·수집')
    expect(html).not.toContain('상담·성과')
    expect(html).not.toContain('name="action"')
  })

  it('renders one page flow from collected keyword to live page and Naver advertising O/X', async () => {
    const response = renderClientDashboard({
      firm: { id: 2, name: '데모', status: 'pilot', domain: 'example.test', landingReady: true, siteTemplate: 'response-room' },
      visits: 4, leads: 1, qualified: 0, retained: 0, assignedKeywords: 1,
      adDesiredKeywords: 0, deployedUrls: 1, livePages: 1, pendingPages: 0,
      ad: { spend: 0, impressions: 0, clicks: 0, qualifiedLeads: 0, retainedMatters: 0 },
      leadQueue: [], campaigns: [], sourceRequests: [],
      collectionUsage: { periodKey: '2026-08', approvedSourceCount: 1, requested: 2, completed: 1, active: null, recent: [] },
      keywordList: {
        tab: 'cases', q: '', sort: 'visitors', dir: 'desc', page: 1, pageSize: 100,
        total: 1, pageCount: 1, from: 1, to: 1,
        rows: [{
          keywordId: '11111111-1111-4111-8111-111111111111',
          name: '가상코인B', slug: 'mockcoinb', scamType: 'coin', keywordStatus: 'published',
          sourceUrl: 'https://collector.example/mockcoinb',
          pipelineStatus: 'subscribed', adDesired: false, pageStatus: 'live',
          observationCount: 20, visitors: 4, inquiries: 1, lastVisitedAt: null,
        }],
      },
    }, 'https://example.test')
    const html = await response.text()
    expect(html).toContain('data-tab="cases"')
    expect(html).toContain('페이지·광고')
    expect(html).toContain('키워드 수집')
    expect(html).toContain('페이지 생성')
    expect(html).toContain('네이버 광고 O/X')
    expect(html).toContain('새 키워드 수집')
    expect(html).toContain('name="action" value="run-collection"')
    expect(html).toContain('>수집하기</button>')
    expect(html).toContain('2026-08 실행')
    expect(html).toContain('수집소스 1개')
    expect(html).not.toContain('대기열')
    expect(html).not.toContain('다음 15분')
    expect(html).not.toContain('귀속된 데이터만 조회합니다')
    expect(html).not.toContain('버튼 1회가 실행 1회로 기록됩니다')
    expect(html).toContain('class="kw-select"')
    expect(html).toContain('set-ad-desired-bulk')
    expect(html).toContain('범위 시작 번호')
    expect(html).toContain('data-tip=')
    expect(html).toContain('name="action" value="set-ad-desired"')
    expect(html).toContain('name="keywordId" value="11111111-1111-4111-8111-111111111111"')
    expect(html).toContain('name="desired" value="true"')
    expect(html).toContain('class="ox off"')
    expect(html).not.toContain('data-tab="ad-create"')
    expect(html).not.toContain('페이지 공개 후 가능')
    expect(html).not.toContain('name="monthlyBudget"')
    expect(html).not.toContain('name="scopeConfirmed"')
  })

  it('renders collected keyword add/archive controls and a safely scoped parser-source request', async () => {
    const response = renderClientDashboard({
      firm: { id: 2, name: '데모', status: 'pilot', domain: null, landingReady: true, siteTemplate: 'response-room' },
      visits: 0, leads: 0, qualified: 0, retained: 0, assignedKeywords: 1,
      adDesiredKeywords: 0, deployedUrls: 1, livePages: 1, pendingPages: 0,
      ad: { spend: 0, impressions: 0, clicks: 0, qualifiedLeads: 0, retainedMatters: 0 },
      leadQueue: [], campaigns: [],
      collectionUsage: { periodKey: '2026-08', approvedSourceCount: 1, requested: 0, completed: 0, active: null, recent: [] },
      sourceRequests: [{
        id: 'request-1', sourceUrl: 'https://example.com/board?a=1&b=2', status: 'pending',
        operatorNote: null, createdAt: new Date('2026-08-13T12:00:00.000Z'), reviewedAt: null,
      }],
      keywordList: {
        tab: 'requests', q: '', sort: 'visitors', dir: 'desc', page: 1, pageSize: 100,
        total: 1, pageCount: 1, from: 1, to: 1,
        rows: [{
          keywordId: '22222222-2222-4222-8222-222222222222',
          name: '수집된 사건', slug: 'collected-case', scamType: 'other', sourceUrl: null,
          keywordStatus: 'published', pipelineStatus: 'subscribed', adDesired: false, pageStatus: 'live',
          observationCount: 3, visitors: 0, inquiries: 0, lastVisitedAt: null,
        }],
      },
    }, 'https://example.test', 'created')
    const html = await response.text()
    expect(html).toContain('키워드 직접 추가')
    expect(html).toContain('name="action" value="add-keyword"')
    expect(html).toContain('name="keywordName"')
    expect(html).toContain('name="scamType"')
    expect(html).toContain('수집된 사건')
    expect(html).toContain('name="action" value="archive-keyword"')
    expect(html).toContain('name="keywordId" value="22222222-2222-4222-8222-222222222222"')
    expect(html).toContain('name="sourceUrl"')
    expect(html).toContain('총운영자가 확인한 뒤 에이전트·파서 수집 대상에 추가합니다')
    expect(html).toContain('수집 요청을 접수했습니다')
    expect(html).toContain('https://example.com/board?a=1&amp;b=2')
    expect(html).toContain('검토 대기')
  })
})
