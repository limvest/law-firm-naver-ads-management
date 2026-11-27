import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createTestDb } from '../helpers/test-db'
import { firms, leadParties, leads } from '@/lib/db/schema'
import { encryptPII } from '@/lib/crypto'
import {
  conflictHistoryForLead,
  normalizePartyTerm,
  parsePartyTerms,
  recordLeadParty,
  runConflictCheckForFirm,
} from '@/lib/leads/conflict'
import type { Firm } from '@/lib/engine/firms'

const originalKey = process.env.LEAD_ENC_KEY
afterEach(() => { if (originalKey === undefined) delete process.env.LEAD_ENC_KEY; else process.env.LEAD_ENC_KEY = originalKey })

function firm(id: number): Firm {
  return { id, slug: `f${id}`, name: `firm${id}`, adLawyerName: 'x', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'r', addressLocality: 'l', kakaoUrl: null, domain: null, status: 'active', lawyers: null, wordmark: null, landingReady: false, dashboardToken: `t${id}`, adConfig: null }
}

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number) {
  await db.insert(firms).values({ id, slug: `f${id}`, name: `firm${id}`, adLawyerName: 'x', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'r', addressLocality: 'l' })
}

describe('사무소 내부 이해충돌 보조 검색', () => {
  it('표기 정규화와 다중 입력 중복 제거', () => {
    expect(normalizePartyTerm(' (주) 가나다 ')).toBe('주가나다')
    expect(parsePartyTerms('홍 길동, 홍 길동\n김회사 / 김회사')).toEqual(['홍 길동', '김회사'])
  })

  it('같은 firm의 과거 상담만 매칭하고 검색어·이력을 암호화 저장한다', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 21)
    await seedFirm(db, 22)
    const [past, current, otherFirm] = await db.insert(leads).values([
      { firmId: 21, vertical: 'scam', nameEnc: encryptPII('과거'), phoneEnc: encryptPII('1') },
      { firmId: 21, vertical: 'scam', nameEnc: encryptPII('현재'), phoneEnc: encryptPII('2') },
      { firmId: 22, vertical: 'scam', nameEnc: encryptPII('타사'), phoneEnc: encryptPII('3') },
    ]).returning()
    await recordLeadParty(db, 21, past.id, 'adverse', '주식회사 가나다')
    await recordLeadParty(db, 22, otherFirm.id, 'prospective', '타사 전용 이름')

    const match = await runConflictCheckForFirm(db, firm(21), current.id, {
      prospective: '신규 의뢰인', adverse: '주식회사 가나다', related: '타사 전용 이름',
    })
    expect(match).toEqual({ status: 'review', matchCount: 1, matchedLeadIds: [past.id] })

    const history = await conflictHistoryForLead(db, firm(21), current.id)
    expect(history).toHaveLength(1)
    expect(history[0].terms?.adverse).toEqual(['주식회사 가나다'])
    expect(history[0].matchedLeadIds).toEqual([past.id])
    const parties = await db.select().from(leadParties)
    expect(parties.some((party) => party.nameEnc.includes('주식회사 가나다'))).toBe(false)
  })

  it('존재하지 않거나 다른 firm 소유 리드는 점검하지 않는다', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 31)
    await seedFirm(db, 32)
    const [lead] = await db.insert(leads).values({ firmId: 31, vertical: 'scam', nameEnc: encryptPII('x'), phoneEnc: encryptPII('y') }).returning()
    expect(await runConflictCheckForFirm(db, firm(32), lead.id, { prospective: '가나다', adverse: '', related: '' })).toBeNull()
  })
})
