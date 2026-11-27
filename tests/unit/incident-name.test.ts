import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import type { Db } from '@/lib/db/client'
import { firmKeywords, firms, keywords } from '@/lib/db/schema'
import { incidentNameForTracking } from '@/lib/tracking/incident-name'

let db: Db

beforeEach(async () => {
  db = await createTestDb()
  await db.insert(firms).values({ id: 42, slug: 'sampleone', name: '샘플원', adLawyerName: '김', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'x', addressLocality: 'x', status: 'active' })
  const [keyword] = await db.insert(keywords).values({ firmId: 42, name: '가상프로젝트A', normalizedName: '가상프로젝트A', slug: '12-4a605cb62d', scamType: 'other', status: 'published' }).returning()
  await db.insert(firmKeywords).values({ firmId: 42, keywordId: keyword.id, publicHostLabel: '12-4a605cb62d', hostStatus: 'public' })
})

describe('incidentNameForTracking', () => {
  it('내부 slug와 서브도메인을 DB 사건명으로 변환한다', async () => {
    await expect(incidentNameForTracking(db, 42, 'f/12-4a605cb62d')).resolves.toBe('가상프로젝트A')
    await expect(incidentNameForTracking(db, 42, 'f/fraud-v2', new Request('https://12-4a605cb62d.sampleone.attorney/api/events', { headers: { host: '12-4a605cb62d.sampleone.attorney' } }))).resolves.toBe('가상프로젝트A')
  })

  it('복원할 수 없는 내부 기본경로는 노출하지 않는다', async () => {
    await expect(incidentNameForTracking(db, 42, 'f/fraud-v2')).resolves.toBeNull()
  })
})
