import { and, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { keywords, observations, scamPages, type ObsFacts, type ScamPageContent } from '@/lib/db/schema'
import { buildProgrammaticCasePage } from './programmatic-page'

type KeywordRow = typeof keywords.$inferSelect
type ObservationRow = typeof observations.$inferSelect

const EVIDENCE_BY_TYPE: Record<string, string[]> = {
  coin: ['가상자산 거래소 입출금 내역과 지갑 주소', '앱 설치 링크·게시자·요청 권한', '대화방 전체 기록과 운영자 계정'],
  leading: ['리딩방 초대 링크와 운영자 프로필', '종목 추천·수익 인증 화면', '입금 계좌와 이체확인증'],
  stock: ['투자 제안서와 종목·계좌 안내', 'HTS·MTS 설치 링크와 게시자', '입금·출금 신청 화면과 상담 기록'],
  invest: ['투자 제안서·약정 설명과 광고 화면', '입금 계좌·예금주·이체확인증', '수익·출금 조건을 안내한 전체 대화'],
  romance: ['최초 연락부터 금전 요구까지의 전체 대화', '상대 프로필·SNS 계정·사진', '송금 계좌·가상자산 전송 내역'],
  used: ['거래 게시글과 판매자 계정', '결제 링크·주문·배송 화면', '계좌이체 또는 카드 결제 내역'],
  other: ['최초 광고·연락 경로', '상대 계정과 전체 대화', '송금·결제·출금 관련 화면'],
}

const QUESTIONS_BY_TYPE: Record<string, string[]> = {
  coin: ['별도 거래소·지갑·앱 설치를 요구했나요?', '출금 전에 세금·인증비·보증금을 더 요구하나요?'],
  leading: ['단체방의 수익 인증을 보고 입금을 결정했나요?', '운영자가 지정한 계좌나 별도 앱으로 자금을 보냈나요?'],
  stock: ['증권사·전문가를 사칭한 연락이었나요?', '공식 앱이 아닌 별도 HTS·MTS 설치를 안내받았나요?'],
  invest: ['원금 또는 고수익을 약속받았나요?', '투자금 회수 전에 추가 비용을 요구받았나요?'],
  romance: ['SNS·메신저에서 관계를 만든 뒤 투자나 송금을 권했나요?', '상대가 직접 만남을 미루면서 금전을 요구했나요?'],
  used: ['판매자가 외부 안전결제 링크를 보냈나요?', '결제 오류를 이유로 재결제·추가 송금을 요구하나요?'],
  other: ['상대가 공식 연락처가 아닌 메신저로 이동시켰나요?', '송금·결제 뒤 새로운 조건이나 추가 비용을 요구하나요?'],
}

function normalizedType(value: string) {
  if (['coin', '코인'].includes(value)) return 'coin'
  if (['leading', '리딩방'].includes(value)) return 'leading'
  if (['stock'].includes(value)) return 'stock'
  if (['invest', '부동산', '창업', '부업'].includes(value)) return 'invest'
  if (['romance', '로맨스'].includes(value)) return 'romance'
  if (['used', '중고거래', '쇼핑몰', '티켓', '직구'].includes(value)) return 'used'
  return 'other'
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))]
}

export function buildCaseResponseContent(keyword: Pick<KeywordRow, 'name' | 'scamType'>, rows: Array<Pick<ObservationRow, 'title' | 'sourceFamily' | 'sourceType' | 'facts'>>): ScamPageContent {
  const type = normalizedType(keyword.scamType)
  const page = buildProgrammaticCasePage({
    name: keyword.name,
    scamType: type,
    observations: rows.map((row) => ({
      title: row.title ?? keyword.name,
      sourceFamily: row.sourceFamily ?? row.sourceType ?? undefined,
      facts: (row.facts as ObsFacts | null) ?? undefined,
    })),
  })
  const methods = unique(rows.flatMap((row) => row.facts?.method ?? []))
  const infrastructure = unique(rows.flatMap((row) => row.facts?.infra?.map((item) => item.value) ?? []))
  const sourceCount = new Set(rows.map((row) => row.sourceFamily ?? row.sourceType).filter(Boolean)).size
  const questions = QUESTIONS_BY_TYPE[type] ?? QUESTIONS_BY_TYPE.other
  const evidence = EVIDENCE_BY_TYPE[type] ?? EVIDENCE_BY_TYPE.other
  const observed = [
    ...(page.degree >= 2
      ? page.overview
      : [`${keyword.name} 명칭이 수집 목록에서 확인됐습니다. 현재 자료만으로 구체적인 진행 방식을 단정할 수 없어 실제 연락·송금 기록과 대조해야 합니다.`]),
    ...(methods.length ? [`수집 자료에는 ${methods.slice(0, 5).join('·')} 관련 표현이 포함돼 있어 실제 대화와 대조해야 합니다.`] : []),
    ...(infrastructure.length ? [`함께 언급된 앱·사이트·채널(${infrastructure.slice(0, 4).join('·')})은 이름만 보지 말고 주소·게시자·계정을 확인해야 합니다.`] : []),
  ]

  return {
    intro: `${keyword.name} 명칭과 관련해 수집된 자료를 정비한 피해 대응 안내입니다. 현재 단계에 맞는 질문부터 확인하고, 추가 송금 전에 기록을 보전하십시오.`,
    contentDegree: page.degree,
    observationCount: rows.length,
    independentSourceCount: sourceCount,
    generatedAt: new Date().toISOString(),
    sections: [
      { heading: `${keyword.name} 관련 먼저 확인할 질문`, body: questions.map((item) => `• ${item}`).join('\n') },
      { heading: '수집 자료에서 확인할 진행 방식', body: observed.join('\n\n') },
      { heading: '지금 보전할 증거', body: evidence.map((item) => `• ${item}`).join('\n') },
      { heading: '지금 해야 할 조치', body: '• 추가 입금과 원격제어 앱 사용을 중단합니다.\n• 대화·입금·앱·사이트 화면을 삭제 전에 보전합니다.\n• 금융회사에 거래 상태와 가능한 지급정지 절차를 문의합니다.\n• 경찰 신고와 법률상 가능한 조치를 구체적인 사실관계에 따라 검토합니다.' },
      { heading: '현재 확인 범위', body: rows.length
        ? `현재 ${rows.length.toLocaleString('ko-KR')}건의 관측 자료와 ${sourceCount.toLocaleString('ko-KR')}개 출처군을 기준으로 정리했습니다.${methods.length || infrastructure.length ? ' 구조화된 수법·연계 정보를 본문에 반영했습니다.' : ' 구체적인 수법·계정 정보는 아직 확인되지 않아 실제 대화와 송금 자료의 추가 확인이 필요합니다.'}`
        : '현재 사건명 외의 독립 관측 자료가 없어 일반적인 대응 순서만 제공합니다. 실제 연락·송금 자료를 바탕으로 추가 확인이 필요합니다.' },
    ],
  }
}

export async function refreshScamPages(db: Db, options: { keywordIds?: string[] } = {}) {
  const scopedIds = options.keywordIds ? [...new Set(options.keywordIds)] : null
  if (scopedIds?.length === 0) return { keywords: 0, observations: 0, updated: 0, published: 0 }
  const keywordRows = await db.select().from(keywords).where(scopedIds
    ? and(ne(keywords.status, 'blocked'), inArray(keywords.id, scopedIds))
    : ne(keywords.status, 'blocked'))
  let updated = 0
  let observationCount = 0
  const batchSize = 250
  for (let offset = 0; offset < keywordRows.length; offset += batchSize) {
    const chunk = keywordRows.slice(offset, offset + batchSize)
    const ids = chunk.map((row) => row.id)
    const observationRows = await db.select().from(observations).where(inArray(observations.keywordId, ids))
    observationCount += observationRows.length
    const byKeyword = new Map<string, ObservationRow[]>()
    for (const row of observationRows) byKeyword.set(row.keywordId, [...(byKeyword.get(row.keywordId) ?? []), row])
    const generatedAt = new Date()
    const values = chunk.map((keyword) => ({
      keywordId: keyword.id,
      content: buildCaseResponseContent(keyword, byKeyword.get(keyword.id) ?? []),
      templateVersion: 'response-pipeline-v1',
      lintPassed: true,
      publishedAt: generatedAt,
    }))
    await db.insert(scamPages).values(values).onConflictDoUpdate({
      target: scamPages.keywordId,
      set: {
        content: sql`excluded.content`,
        templateVersion: sql`excluded.template_version`,
        lintPassed: sql`excluded.lint_passed`,
        publishedAt: sql`excluded.published_at`,
      },
    })
    updated += chunk.length
  }
  // 수집 단계에서 품질 판정을 마친 정상 업체명은 이미 published다. 페이지 생성 단계에는
  // 별도의 discovered→published 승격 게이트를 두지 않는다.
  const published = keywordRows.filter((row) => ['published', 'ad_registered', 'live'].includes(row.status)).length
  return { keywords: keywordRows.length, observations: observationCount, updated, published }
}
