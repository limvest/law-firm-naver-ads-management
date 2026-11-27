import { describe, it, expect } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, observations, firmKeywords } from '@/lib/db/schema'
import { overviewData } from '@/lib/dashboard/data'
import type { Firm } from '@/lib/engine/firms'

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

describe('overviewData', () => {
  it('전역 keywords/observations 집계 + firm의 등록 진행 중 집계 (스펙 §0·§C — 개요는 firm 무관 실데이터 + coverage.ts와 동일한 adPending 집합)', async () => {
    const db = await createTestDb()

    await db.insert(firms).values({
      id: 9, slug: 'demo', name: '법무법인 데모', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-demo1',
    })

    const inserted = await db.insert(keywords).values([
      { name: 'k1', slug: 'k1', scamType: 'coin', status: 'published', createdAt: daysAgo(10) },
      { name: 'k2', slug: 'k2', scamType: 'coin', status: 'published', createdAt: daysAgo(5) },
      { name: 'k3', slug: 'k3', scamType: 'coin', status: 'discovered', createdAt: daysAgo(0) },
      // adPending 집계용 — subscribed·paused·ad_pending 3-상태 합산과 published 조인을 검증하려면
      // 각 상태마다 별도 published 키워드가 필요하다(같은 (firm,keyword)에는 행이 하나뿐이므로).
      { name: 'k4', slug: 'k4', scamType: 'coin', status: 'published', createdAt: daysAgo(3) },
      { name: 'k5', slug: 'k5', scamType: 'coin', status: 'published', createdAt: daysAgo(2) },
      { name: 'k6', slug: 'k6', scamType: 'coin', status: 'published', createdAt: daysAgo(1) },
    ]).returning()
    const [k1, k2, k3, k4, k5, k6] = inserted

    await db.insert(observations).values([
      { keywordId: k1.id, observedAt: daysAgo(0), sourceType: 'community' },
      { keywordId: k1.id, observedAt: daysAgo(7), sourceType: 'community' },
      { keywordId: k2.id, observedAt: daysAgo(14), sourceType: 'news' },
      { keywordId: k3.id, observedAt: daysAgo(21), sourceType: 'news' },
    ])

    // 타 firm 등록 현황은 집계에서 제외됨을 함께 검증 (firm 스코프)
    await db.insert(firms).values({
      id: 10, slug: 'other', name: '타 firm', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-other1',
    })
    await db.insert(firmKeywords).values([
      { firmId: 9, keywordId: k1.id, status: 'subscribed', adDesired: true }, // adPending에 포함
      { firmId: 9, keywordId: k4.id, status: 'paused', adDesired: true },     // adPending에 포함
      { firmId: 9, keywordId: k5.id, status: 'ad_pending', adDesired: true }, // adPending에 포함
      { firmId: 9, keywordId: k6.id, status: 'live' },       // live는 확정 단계 — adPending 제외
      { firmId: 9, keywordId: k3.id, status: 'ad_pending' }, // k3는 discovered(미게시) — published 조인에서 제외
      { firmId: 10, keywordId: k2.id, status: 'subscribed' }, // 타 firm — firm 9 집계에 새면 안 됨
    ])

    const firm: Firm = {
      id: 9, slug: 'demo', name: '법무법인 데모', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
      kakaoUrl: null, domain: null, status: 'active',
      lawyers: null, wordmark: null, landingReady: false, dashboardToken: 'tok-demo1', adConfig: null,
    }

    const data = await overviewData(db, firm)

    expect(data.totalKeywords).toBe(6)
    expect(data.publishedKeywords).toBe(5) // k1·k2·k4·k5·k6 (k3는 discovered)
    expect(data.newToday).toBe(1)
    expect(data.obsTotal).toBe(4)
    // subscribed(k1) + paused(k4) + ad_pending(k5) = 3. live(k6)는 확정 단계라 제외,
    // k3의 ad_pending 행은 keywords.status='published' 조인 조건에 걸려 제외, firm 10 행도 격리.
    expect(data.adPending).toBe(3)

    expect(data.weeklyObs.length).toBeLessThanOrEqual(12)
    expect(data.weeklyObs.reduce((s, w) => s + w.n, 0)).toBe(data.obsTotal)
    for (const w of data.weeklyObs) expect(w.week).toMatch(/^\d{4}-\d{2}$/)

    expect(data.sourceMix.length).toBe(2)
    expect(data.sourceMix.reduce((s, x) => s + x.n, 0)).toBe(data.obsTotal)
    expect(data.sourceMix.map((x) => x.sourceType).sort()).toEqual(['community', 'news'])
  })

  it('subscribed∧ad_desired=false는 adPending에서 제외 (coverage.ts pipeline.excluded와 정합)', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 11, slug: 'demo2', name: '법무법인 데모2', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-demo2',
    })
    const inserted = await db.insert(keywords).values([
      { name: 'ke1', slug: 'ke1', scamType: 'coin', status: 'published' }, // 정상 subscribed
      { name: 'ke2', slug: 'ke2', scamType: 'coin', status: 'published' }, // subscribed∧desired=false
    ]).returning()
    const [ke1, ke2] = inserted
    await db.insert(firmKeywords).values([
      { firmId: 11, keywordId: ke1.id, status: 'subscribed', adDesired: true },
      { firmId: 11, keywordId: ke2.id, status: 'subscribed', adDesired: false },
    ])

    const firm: Firm = {
      id: 11, slug: 'demo2', name: '법무법인 데모2', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
      kakaoUrl: null, domain: null, status: 'active',
      lawyers: null, wordmark: null, landingReady: false, dashboardToken: 'tok-demo2', adConfig: null,
    }

    const data = await overviewData(db, firm)
    expect(data.adPending).toBe(1) // ke1만 — ke2는 coverage.ts pipeline.excluded로 잡혀야 할 몫
  })
})
