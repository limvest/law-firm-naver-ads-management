import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { createTestDb } from '../helpers/test-db'
import { caseEntities, firms, leads, events } from '@/lib/db/schema'
import { encryptPII } from '@/lib/crypto'
import {
  funnelData,
  inferLeadPriority,
  leadQueueSummary,
  leadsData,
  LEAD_STATUS_OPTIONS,
  updateLeadIntakeForFirm,
  updateLeadStatusForFirm,
  type LeadStatus,
} from '@/lib/dashboard/leads'
import type { Firm } from '@/lib/engine/firms'

const mkFirm = (id: number, token: string): Firm => ({
  id, slug: `f${id}`, name: `firm${id}`, adLawyerName: 'x', phone: '1', phoneIntl: '1',
  address: 'x', addressRegion: 'r', addressLocality: 'l',
  kakaoUrl: null, domain: null, status: 'active',
  lawyers: null, wordmark: null, landingReady: false, dashboardToken: token, adConfig: null,
})

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number, token: string) {
  await db.insert(firms).values({
    id, slug: `f${id}`, name: `firm${id}`, adLawyerName: 'x', phone: '1', phoneIntl: '1',
    address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: token,
  })
}

describe('leadsData', () => {
  const originalKey = process.env.LEAD_ENC_KEY

  afterEach(() => {
    if (originalKey === undefined) delete process.env.LEAD_ENC_KEY
    else process.env.LEAD_ENC_KEY = originalKey
  })

  it('firm 스코프 격리 + 복호화 성공 + demo 배지 판별(utm.source===demo-seed)', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 2, 'tok-lead2')
    await seedFirm(db, 3, 'tok-lead3')

    await db.insert(leads).values([
      {
        firmId: 2, vertical: 'scam', slug: 'kw-lead-1',
        nameEnc: encryptPII('김철수'), phoneEnc: encryptPII('010-1111-2222'),
        utm: { source: 'demo-seed' }, status: 'new',
      },
      {
        firmId: 3, vertical: 'scam', slug: 'kw-lead-2',
        nameEnc: encryptPII('박영희'), phoneEnc: encryptPII('010-3333-4444'),
        utm: { source: 'naver' }, status: 'new',
      },
    ])

    const rows = await leadsData(db, mkFirm(2, 'tok-lead2'))

    expect(rows).toHaveLength(1) // firm 3 리드 부재 — 격리
    expect(rows[0].name).toBe('김철수')
    expect(rows[0].phone).toBe('010-1111-2222')
    expect(rows[0].slug).toBe('kw-lead-1')
    expect(rows[0].masked).toBe(false)
    expect(rows[0].isDemo).toBe(true)
  })

  it('LEAD_ENC_KEY 없으면 복호화 시도 없이 masked 처리(throw 금지)', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 4, 'tok-lead4')
    await db.insert(leads).values({
      firmId: 4, vertical: 'scam', slug: 'kw-lead-3',
      nameEnc: encryptPII('이몽룡'), phoneEnc: encryptPII('010-5555-6666'),
      utm: { source: 'naver' },
    })

    delete process.env.LEAD_ENC_KEY

    const rows = await leadsData(db, mkFirm(4, 'tok-lead4'))
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('암호화됨')
    expect(rows[0].phone).toBe('***')
    expect(rows[0].masked).toBe(true)
    expect(rows[0].isDemo).toBe(false)
  })
})

describe('updateLeadStatusForFirm', () => {
  it('intake 상태만 반영하고 outcome/타 firm 우회를 무시한다', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 5, 'tok-lead5')
    await seedFirm(db, 6, 'tok-lead6')
    const [lead5] = await db.insert(leads).values({
      firmId: 5, vertical: 'scam', nameEnc: encryptPII('a'), phoneEnc: encryptPII('b'),
    }).returning()

    expect(LEAD_STATUS_OPTIONS).toEqual(['new', '연락완료', '검토중'])

    // 타 firm(6)이 firm 5의 리드 id를 상태 변경 시도 — 무시되어야 함
    await updateLeadStatusForFirm(db, mkFirm(6, 'tok-lead6'), lead5.id, '연락완료')
    const afterOtherFirm = await db.select().from(leads).where(eq(leads.id, lead5.id))
    expect(afterOtherFirm[0].status).toBe('new')

    // 정당한 firm(5)의 기존 intake 전이 — 반영됨
    await updateLeadStatusForFirm(db, mkFirm(5, 'tok-lead5'), lead5.id, '연락완료')
    await updateLeadStatusForFirm(db, mkFirm(5, 'tok-lead5'), lead5.id, '검토중')
    const after = await db.select().from(leads).where(eq(leads.id, lead5.id))
    expect(after[0].status).toBe('검토중')

    // 과거 outcome 상태를 legacy 경로로 새로 만들 수 없어야 함
    for (const status of ['상담', '상담예약', '수임', '종결'] as LeadStatus[]) {
      await updateLeadStatusForFirm(db, mkFirm(5, 'tok-lead5'), lead5.id, status)
    }
    const afterOutcomeAttempts = await db.select().from(leads).where(eq(leads.id, lead5.id))
    expect(afterOutcomeAttempts[0].status).toBe('검토중')

    // 허용되지 않은 상태값 — 무시
    await updateLeadStatusForFirm(db, mkFirm(5, 'tok-lead5'), lead5.id, 'bogus' as LeadStatus)
    const afterBogus = await db.select().from(leads).where(eq(leads.id, lead5.id))
    expect(afterBogus[0].status).toBe('검토중') // 변경 없음
  })
})

describe('상담 실무 브리프', () => {
  it('긴급 문구는 투명한 규칙으로 우선순위를 올린다', () => {
    expect(inferLeadPriority({ detail: '지금 원격제어 앱에 접속 중이고 추가 입금을 요구합니다' })).toBe('urgent')
    expect(inferLeadPriority({ detail: '어제 계좌로 송금했습니다' })).toBe('high')
    expect(inferLeadPriority({ detail: '상담 절차가 궁금합니다' })).toBe('normal')
  })

  it('담당자·후속 연락·암호화 메모·증거 체크를 firm 범위 안에서 저장한다', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 11, 'tok-lead11')
    await seedFirm(db, 12, 'tok-lead12')
    const firm11 = { ...mkFirm(11, 'tok-lead11'), lawyers: [{ name: '김담당', title: '변호사', badges: [], photo: null }] }
    const [lead] = await db.insert(leads).values({ firmId: 11, vertical: 'scam', nameEnc: encryptPII('가나다'), phoneEnc: encryptPII('010-0000-0000') }).returning()
    const followUpAt = new Date('2026-08-11T00:30:00.000Z')

    expect(await updateLeadIntakeForFirm(db, mkFirm(12, 'tok-lead12'), lead.id, {
      status: '상담예약', priority: 'urgent', assignedLawyer: null, followUpAt, note: '침범', evidenceChecklist: {}, markContacted: false,
    })).toBe(false)
    expect(await updateLeadIntakeForFirm(db, firm11, lead.id, {
      status: '연락완료', priority: 'urgent', assignedLawyer: '김담당', followUpAt,
      note: '상대방은 추가 입금을 요구함', evidenceChecklist: { messages: true, transfers: true }, markContacted: true,
    })).toBe(true)

    const [saved] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(saved.status).toBe('연락완료')
    expect(saved.priority).toBe('urgent')
    expect(saved.assignedLawyer).toBe('김담당')
    expect(saved.intakeNoteEnc).not.toContain('추가 입금')
    expect(saved.evidenceChecklist).toMatchObject({ messages: true, transfers: true, app_site: false })
    expect(saved.lastContactAt).toBeInstanceOf(Date)

    const [row] = await leadsData(db, firm11, { id: lead.id })
    expect(row.intakeNote).toContain('추가 입금')

    // saveLeadIntake/updateLeadIntakeForFirm도 outcome 경로를 우회할 수 없다.
    for (const status of ['상담', '상담예약', '수임', '종결'] as LeadStatus[]) {
      expect(await updateLeadIntakeForFirm(db, firm11, lead.id, {
        status, priority: 'urgent', assignedLawyer: '김담당', followUpAt,
        note: '우회 시도', evidenceChecklist: {}, markContacted: false,
      })).toBe(false)
    }
    const [afterOutcomeAttempts] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(afterOutcomeAttempts.status).toBe('연락완료')

    // 이미 저장된 legacy outcome 행은 조회·표시할 수 있어야 한다.
    await db.update(leads).set({ status: '수임' }).where(eq(leads.id, lead.id))
    const [legacyRow] = await leadsData(db, firm11, { id: lead.id })
    expect(legacyRow.status).toBe('수임')
  })

  it('연락 지연·오늘 연락·충돌 검토·미배정을 집계한다', () => {
    const now = new Date('2026-08-10T03:00:00.000Z')
    const base = {
      id: '1', name: 'x', phone: 'x', vertical: 'scam', detail: null, damageType: null,
      amountBand: null, slug: null, status: 'new', priority: 'normal' as const, assignedLawyer: null,
      lastContactAt: null, intakeNote: null, conflictStatus: 'unchecked' as const,
      conflictCheckedAt: null, evidenceChecklist: {}, utm: null, firstTouch: null,
      createdAt: now, masked: false, isDemo: false,
    }
    const rows = [
      { ...base, id: '1', followUpAt: new Date('2026-08-10T02:00:00.000Z'), conflictStatus: 'review' as const },
      { ...base, id: '2', followUpAt: new Date('2026-08-10T08:00:00.000Z'), assignedLawyer: '김담당' },
      { ...base, id: '3', status: '종결', followUpAt: new Date('2026-08-09T00:00:00.000Z') },
    ]
    expect(leadQueueSummary(rows, now)).toEqual({ newCount: 2, overdue: 1, dueToday: 2, conflictReview: 1, unassigned: 1 })
  })
})

describe('funnelData', () => {
  it('firm 스코프 pv/call/kakao/form 집계 + slug별 표', async () => {
    const db = await createTestDb()
    await seedFirm(db, 7, 'tok-lead7')
    await seedFirm(db, 8, 'tok-lead8')

    const mk = (firmId: number, type: string, slug: string | null, n: number) =>
      Array.from({ length: n }, () => ({ firmId, type, slug }))

    await db.insert(events).values([
      ...mk(7, 'page_view', 'kw-lead-1', 5),
      ...mk(7, 'call_click', 'kw-lead-1', 2),
      ...mk(7, 'form_submit', 'kw-lead-1', 1),
      ...mk(8, 'page_view', 'kw-lead-2', 9),
    ])

    const data = await funnelData(db, mkFirm(7, 'tok-lead7'))
    expect(data.pv).toBe(5)
    expect(data.call).toBe(2)
    expect(data.kakao).toBe(0)
    expect(data.form).toBe(1)
    expect(data.bySlug).toEqual([{ slug: 'kw-lead-1', pv: 5, form: 1 }])
    expect(data.byCase).toEqual([{ caseEntityId: null, label: 'kw-lead-1', slug: 'kw-lead-1', pv: 5, form: 1 }])
    // 최종 리뷰 F5 — demo-seed 이벤트가 전혀 없으면 0 (배지 미노출 조건)
    expect(data.demoSeedCount).toBe(0)

    const dataOther = await funnelData(db, mkFirm(8, 'tok-lead8'))
    expect(dataOther.pv).toBe(9)
    expect(dataOther.call).toBe(0)
    expect(dataOther.form).toBe(0)
    expect(dataOther.demoSeedCount).toBe(0)
  })

  it('정본 case_entity_id로 묶고 slug가 달라도 같은 사건으로 귀속한다', async () => {
    const db = await createTestDb()
    await seedFirm(db, 13, 'tok-lead13')
    await seedFirm(db, 14, 'tok-lead14')
    const [entity] = await db.insert(caseEntities).values({
      canonicalName: '정본 사건 알파', slug: 'canonical-alpha', category: 'coin', status: 'approved',
    }).returning()
    await db.insert(events).values([
      { firmId: 13, type: 'page_view', slug: 'case/canonical-alpha', caseEntityId: entity.id },
      { firmId: 13, type: 'page_view', slug: 'response/canonical-alpha', caseEntityId: entity.id },
      { firmId: 13, type: 'form_submit', slug: 'response/canonical-alpha', caseEntityId: entity.id },
      { firmId: 14, type: 'page_view', slug: 'case/canonical-alpha', caseEntityId: entity.id },
    ])

    const data = await funnelData(db, mkFirm(13, 'tok-lead13'))
    expect(data.byCase).toEqual([{
      caseEntityId: entity.id,
      label: '정본 사건 알파',
      slug: 'case/canonical-alpha',
      pv: 2,
      form: 1,
    }])
  })

  // 최종 리뷰 F5 — 퍼널 뷰가 데모 시드 위에서도 "실측·추정 없음"을 단정하던 표기 계약 불일치를
  // 고치기 위해 funnelData가 demo-seed(utm.source='demo-seed') 이벤트 건수를 firm 스코프로
  // 별도 반환하는지 검증(leadsData.isDemo와 동일한 utm 파생 판별 계약).
  it('demo-seed 이벤트가 섞여 있으면 firm 스코프로 건수를 반환한다', async () => {
    const db = await createTestDb()
    await seedFirm(db, 9, 'tok-lead9')
    await seedFirm(db, 10, 'tok-lead10')

    await db.insert(events).values([
      { firmId: 9, type: 'page_view', slug: 'kw-lead-1', utm: { source: 'demo-seed' } },
      { firmId: 9, type: 'form_submit', slug: 'kw-lead-1', utm: { source: 'demo-seed' } },
      { firmId: 9, type: 'page_view', slug: 'kw-lead-1', utm: { source: 'naver' } },
      { firmId: 10, type: 'page_view', slug: 'kw-lead-2', utm: { source: 'demo-seed' } },
    ])

    const data = await funnelData(db, mkFirm(9, 'tok-lead9'))
    expect(data.pv).toBe(2) // demo-seed 1건 + naver 1건 — 4단 집계 자체는 출처 무관 합산 유지
    expect(data.demoSeedCount).toBe(2) // firm 9의 demo-seed 이벤트만(firm 10 격리)
  })
})
