import { describe, it, expect, beforeEach } from 'vitest'
import type { Db } from '@/lib/db/client'
import { createTestDb } from '../helpers/test-db'
import { firms } from '@/lib/db/schema'
import { clearFirmCache, DEFAULT_FIRM, normalizeHost, resolveFirmByHost } from '@/lib/engine/firms'

// db.select 호출 횟수만 세는 얇은 래퍼 — resolveFirmByHost는 select만 쓴다.
// (Proxy 대신 최소 대리 객체: drizzle 인스턴스의 내부 상태를 건드리지 않는다.)
function countingDb(db: Db) {
  let selects = 0
  const counting = {
    select: (...args: Parameters<Db['select']>) => { selects++; return db.select(...args) },
  } as unknown as Db
  return { counting, count: () => selects }
}

describe('firm 해석', () => {
  beforeEach(() => clearFirmCache()) // 모듈 스코프 캐시가 테스트 간 새지 않도록


  it('normalizeHost: 포트·www 제거, 소문자', () => {
    expect(normalizeHost('WWW.Sampletwo-law.example.com:443')).toBe('sampletwo-law.example.com')
    expect(normalizeHost(null)).toBe(null)
  })

  it('DEFAULT_FIRM은 샘플투 실값', () => {
    expect(DEFAULT_FIRM.id).toBe(1)
    expect(DEFAULT_FIRM.name).toBe('법률사무소 샘플투')
    expect(DEFAULT_FIRM.phone).toBe('031-000-0000')
    expect(DEFAULT_FIRM.adLawyerName).toBe('김일번')
  })

  it('db 없음·미매핑 호스트 → DEFAULT_FIRM 폴백', async () => {
    expect(await resolveFirmByHost(null, 'unknown.example')).toBe(DEFAULT_FIRM)
  })

  it('매핑 호스트 → 해당 firm, paused firm → 폴백', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      { id: 2, slug: 'a', name: 'A법률', adLawyerName: '갑', phone: '1', phoneIntl: '1',
        address: 'x', addressRegion: 'r', addressLocality: 'l', domain: 'a.example', status: 'active' },
      { id: 3, slug: 'b', name: 'B법률', adLawyerName: '을', phone: '2', phoneIntl: '2',
        address: 'y', addressRegion: 'r', addressLocality: 'l', domain: 'b.example', status: 'paused' },
    ])
    expect((await resolveFirmByHost(db, 'www.a.example')).id).toBe(2)
    expect((await resolveFirmByHost(db, 'b.example')).id).toBe(1) // paused → 폴백
  })

  it('추가 도메인 별칭도 같은 firm으로 해석한다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({ id: 4, slug: 'alias', name: '별칭법률', adLawyerName: '갑',
      phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'r', addressLocality: 'l',
      domain: 'primary.example', domainAliases: ['preview.example'], status: 'active' })
    expect((await resolveFirmByHost(db, 'preview.example')).id).toBe(4)
  })

  // F9 — /f/[slug]는 요청마다 이 조회를 태운다. 같은 host는 TTL 안에서 DB를 다시 치지 않는다.
  it('같은 host 재조회는 캐시 히트 — db.select 1회', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({ id: 2, slug: 'a', name: 'A법률', adLawyerName: '갑',
      phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'r', addressLocality: 'l',
      domain: 'a.example', status: 'active' })
    const { counting, count } = countingDb(db)

    expect((await resolveFirmByHost(counting, 'a.example')).id).toBe(2)
    expect((await resolveFirmByHost(counting, 'www.a.example:443')).id).toBe(2) // 정규화 후 같은 키
    expect(count()).toBe(1)

    clearFirmCache()
    expect((await resolveFirmByHost(counting, 'a.example')).id).toBe(2)
    expect(count()).toBe(2) // 무효화 후에는 다시 조회
  })

  it('폴백(미매핑 host) 결과도 캐시 — 반복 실패 쿼리 방지', async () => {
    const db = await createTestDb()
    const { counting, count } = countingDb(db)

    expect(await resolveFirmByHost(counting, 'nope.example')).toBe(DEFAULT_FIRM)
    expect(await resolveFirmByHost(counting, 'nope.example')).toBe(DEFAULT_FIRM)
    expect(count()).toBe(1)
  })

  it('기본 도메인은 DB를 아예 치지 않는다', async () => {
    const db = await createTestDb()
    const { counting, count } = countingDb(db)
    expect(await resolveFirmByHost(counting, DEFAULT_FIRM.domain)).toBe(DEFAULT_FIRM)
    expect(count()).toBe(0)
  })
})
