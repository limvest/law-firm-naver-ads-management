// src/lib/engine/seed-demo.ts — 데모 firm(2) 시드 코어. scripts/engine/seed-demo.ts CLI가 사용.
//
// seedDemo: data/engine/firms/demo.json을 onboardFirm으로 upsert한다 — onboardFirm은 이제
// lawyers/wordmark/landingReady를 입력에 present일 때 그대로 반영하므로(src/lib/engine/onboard.ts),
// 이 셋은 아래 onboardFirm 호출 한 번으로 이미 채워진다. 그 직후의 별도 update는 두 가지만 실질
// 의미가 있다: ① landingReady는 브리프 불변식이라 JSON 값과 무관하게 항상 false여야 하는데,
// onboardFirm 호출에도 이미 false를 넘기므로 사실 재확정용 안전망(lawyers/wordmark는 완전히
// 중복 — onboardFirm이 같은 값을 이미 SET했음). ② dashboardToken은 onboardFirm이 입력값을 아예
// 읽지 않고 자체적으로 결정(기존 값 보존 또는 NULL 백필)하므로, "데모는 매 실행마다 새 토큰"이라는
// 이 함수만의 계약을 지키려면 onboardFirm이 정한 값을 여기서 다시 덮어써야 한다 — opts.token이
// 없으면 매 실행마다 randomBytes(12).toString('base64url')로 새로 만든다(재실행 시 값이 바뀌는 게
// 정상 — 멱등성 계약은 개수(enrolled/leads/events)에만 적용되고 토큰 자체에는 적용되지 않는다).
//
// 사건명별 구독 없음(스펙 2026-08-03 §A) — published 키워드 전량을 등록한다(코어
// subscribeKeywords/src/lib/engine/onboard.ts를 limit 미지정으로 재사용, onConflictDoNothing —
// 재실행해도 중복 삽입 없음). 그 등록 slug들에 데모 리드 8건·이벤트(pv40/call9/kakao6/form8)를 분산
// 삽입한다. 리드/이벤트 둘 다 utm.source='demo-seed'로 이미 존재하면(재실행) 삽입을 생략한다 — 이
// 값이 대시보드의 데모 배지 판별과 동일한 계약이다(src/lib/dashboard/leads.ts).
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { events, firmKeywords, firms, keywords, leads, type FirmLawyer } from '@/lib/db/schema'
import { encryptPII } from '@/lib/crypto'
import type { EventType } from '@/lib/tracking/track'
import { onboardFirm, subscribeKeywords } from './onboard'
import demoFirmFile from '../../../data/engine/firms/demo.json'

const DEMO_SOURCE = 'demo-seed'
const LEAD_COUNT = 8
// events.type(src/lib/tracking/track.ts EventType) 중 데모에 채울 4종 — 개수는 브리프 고정값.
const EVENT_PLAN: { type: EventType; count: number }[] = [
  { type: 'page_view', count: 40 },
  { type: 'call_click', count: 9 },
  { type: 'kakao_click', count: 6 },
  { type: 'form_submit', count: 8 },
]

type DemoFirmJson = {
  firm: {
    id: number; slug: string; name: string; adLawyerName: string
    phone: string; phoneIntl: string; address: string
    addressRegion: string; addressLocality: string
    kakaoUrl: string | null; domain: string | null
    lawyers: FirmLawyer[]; wordmark: string
  }
}

const DEMO_FIRM = (demoFirmFile as DemoFirmJson).firm

export async function seedDemo(
  db: Db,
  opts: { token?: string } = {},
): Promise<{ firmId: number; enrolled: number; leads: number; events: number }> {
  const firmId = DEMO_FIRM.id
  const token = opts.token ?? randomBytes(12).toString('base64url')

  // 1) firm upsert — base 필드는 onboardFirm(멱등)에 위임. lawyers/wordmark/landingReady/
  //    dashboardToken은 onboardFirm의 SET 절이 다루지 않는 컬럼이라 아래 update로 별도 반영한다.
  await onboardFirm(db, {
    firm: {
      id: DEMO_FIRM.id, slug: DEMO_FIRM.slug, name: DEMO_FIRM.name, adLawyerName: DEMO_FIRM.adLawyerName,
      phone: DEMO_FIRM.phone, phoneIntl: DEMO_FIRM.phoneIntl, address: DEMO_FIRM.address,
      addressRegion: DEMO_FIRM.addressRegion, addressLocality: DEMO_FIRM.addressLocality,
      kakaoUrl: DEMO_FIRM.kakaoUrl, domain: DEMO_FIRM.domain,
      lawyers: DEMO_FIRM.lawyers, wordmark: DEMO_FIRM.wordmark, landingReady: false, dashboardToken: token,
      adConfig: null,
    },
  })
  await db.update(firms)
    .set({ lawyers: DEMO_FIRM.lawyers, wordmark: DEMO_FIRM.wordmark, landingReady: false, dashboardToken: token })
    .where(eq(firms.id, firmId))

  // 2) published 키워드 전량 등록 — 사건명별 구독 없음(스펙 2026-08-03 §A): 코어
  //    subscribeKeywords(src/lib/engine/onboard.ts)를 limit 미지정(전량)으로 재사용한다.
  await subscribeKeywords(db, firmId, {})

  const enrolledRows = await db.select({ id: keywords.id, slug: keywords.slug })
    .from(firmKeywords)
    .innerJoin(keywords, eq(keywords.id, firmKeywords.keywordId))
    .where(eq(firmKeywords.firmId, firmId))
  const enrolledCount = enrolledRows.length

  const slugs = enrolledRows.map((k) => k.slug)
  const cycleSlug = (i: number): string | null => (slugs.length > 0 ? slugs[i % slugs.length] : null)

  // 3) 데모 리드 8건 — utm.source='demo-seed' 리드가 이미 있으면(재실행) 삽입 생략(멱등).
  const existingLeadRows = await db.select({ utm: leads.utm }).from(leads).where(eq(leads.firmId, firmId))
  const hasDemoLeads = existingLeadRows.some((r) => r.utm?.source === DEMO_SOURCE)

  if (!hasDemoLeads && slugs.length > 0) {
    await db.insert(leads).values(
      Array.from({ length: LEAD_COUNT }, (_, i) => ({
        firmId, vertical: 'scam', slug: cycleSlug(i),
        nameEnc: encryptPII(`데모리드${i + 1}`),
        phoneEnc: encryptPII(`010-0000-${String(i + 1).padStart(4, '0')}`),
        utm: { source: DEMO_SOURCE },
      })),
    )
  }

  const leadRows = await db.select({ utm: leads.utm }).from(leads).where(eq(leads.firmId, firmId))
  const leadCount = leadRows.filter((r) => r.utm?.source === DEMO_SOURCE).length

  // 4) 데모 이벤트 — 동일 멱등 규칙(utm.source='demo-seed' 존재 시 삽입 생략).
  const existingEventRows = await db.select({ utm: events.utm }).from(events).where(eq(events.firmId, firmId))
  const hasDemoEvents = existingEventRows.some((r) => r.utm?.source === DEMO_SOURCE)

  if (!hasDemoEvents && slugs.length > 0) {
    const rows: { firmId: number; type: string; slug: string | null; utm: Record<string, string> }[] = []
    let cursor = 0
    for (const { type, count } of EVENT_PLAN) {
      for (let i = 0; i < count; i++) {
        rows.push({ firmId, type, slug: cycleSlug(cursor++), utm: { source: DEMO_SOURCE } })
      }
    }
    await db.insert(events).values(rows)
  }

  const eventRows = await db.select({ utm: events.utm }).from(events).where(eq(events.firmId, firmId))
  const eventCount = eventRows.filter((r) => r.utm?.source === DEMO_SOURCE).length

  return { firmId, enrolled: enrolledCount, leads: leadCount, events: eventCount }
}
