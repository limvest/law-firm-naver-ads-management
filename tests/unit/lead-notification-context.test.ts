import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import type { Db } from '@/lib/db/client'
import { keywords, observations } from '@/lib/db/schema'
import { leadCaseNotificationContext } from '@/lib/leads/notification-context'

let db: Db

beforeEach(async () => { db = await createTestDb() })

describe('leadCaseNotificationContext', () => {
  it('사건 slug로 DB 사건명·기록수·수법을 조립한다', async () => {
    const [keyword] = await db.insert(keywords).values({
      firmId: 1, name: 'MOCKSHOPA', normalizedName: 'mockshopa', slug: 'mockshopa', scamType: '투자사기', status: 'published',
    }).returning()
    await db.insert(observations).values([
      { keywordId: keyword.id, sourceUrl: 'https://a.example/1', title: 'MOCKSHOPA 출금 거절 관련 기록', facts: { method: ['출금 거절'], infra: [], amounts: [] } },
      { keywordId: keyword.id, sourceUrl: 'https://b.example/2', title: 'MOCKSHOPA 추가입금 요구 관련 기록', facts: { method: ['출금 거절', '추가입금 요구'], infra: [], amounts: [] } },
    ])
    await expect(leadCaseNotificationContext(db, 'f/mockshopa')).resolves.toMatchObject({
      caseName: 'MOCKSHOPA', caseType: '투자사기', recordCount: 2, methods: ['출금 거절', '추가입금 요구'],
      titles: ['MOCKSHOPA 출금 거절 관련 기록', 'MOCKSHOPA 추가입금 요구 관련 기록'],
    })
  })
})
