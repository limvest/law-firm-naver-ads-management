/**
 * 수집 데이터 → 고객용 사건 설명 페이지 모델.
 *
 * Degree는 고객에게 노출하는 등급이 아니라, 확보된 사실 차원에 따라 어떤 섹션까지
 * 생성할지 정하는 내부 게이트다. 데이터가 부족한 사건에 구체적인 피해 서사를 만들지 않는다.
 */
export type ContentDegree = 1 | 2 | 3

export type ProgrammaticObservation = {
  title?: string
  sourceFamily?: string
  facts?: {
    method?: string[]
    infra?: { type: string; value: string }[]
    amounts?: string[]
  }
}

export type ProgrammaticCaseInput = {
  name: string
  scamType: string
  aliases?: string[]
  observations: ProgrammaticObservation[]
}

export type ProgrammaticCasePage = {
  degree: ContentDegree
  caseType: string
  summary: string
  overview: string[]
  keyFacts: { label: string; value: string; description: string }[]
  flow: { title: string; description: string }[]
  victimPatterns: { title: string; description: string }[]
  detailedNarratives: { title: string; description: string }[]
  riskMechanisms: { title: string; description: string }[]
  responseFocus: { title: string; description: string }[]
  entities: { label: string; values: string[] }[]
  sectionFlags: {
    flow: boolean
    victimPatterns: boolean
    detailedNarrative: boolean
  }
}

const TYPE_LABEL: Record<string, string> = {
  coin: '가상자산 투자 사칭',
  invest: '투자 프로젝트 사칭',
  leading: '리딩방 투자 사칭',
  stock: '주식·기관계좌 사칭',
  romance: '관계형 금융 사칭',
  used: '거래·결제 사칭',
}

function unique(values: string[]) {
  return values.filter((value, index) => value && values.indexOf(value) === index)
}

function extractUppercaseApps(text: string) {
  const blocked = new Set(['SNS', 'HTS', 'MTS', 'AI', 'PRO'])
  return unique((text.match(/\b[A-Z][A-Z0-9]{2,15}\b/g) ?? []).filter((value) => !blocked.has(value)))
}

function extractImpersonatedEntities(text: string) {
  const matches = text.matchAll(/([가-힣A-Za-z0-9·&]{2,30}(?:증권|투자증권|은행|거래소|자산운용))\s*(?:사칭|가짜)/g)
  return unique([...matches].map((match) => match[1]))
}

export function decideContentDegree(input: ProgrammaticCaseInput): ContentDegree {
  const text = input.observations.map((item) => item.title ?? '').join(' ')
  const bodyFactCount = input.observations.filter((item) => {
    const facts = item.facts
    return Boolean(facts && ((facts.method?.length ?? 0) || (facts.infra?.length ?? 0) || (facts.amounts?.length ?? 0)))
  }).length
  const independentFamilies = new Set(input.observations.map((item) => item.sourceFamily).filter(Boolean)).size
  const dimensions = [
    /사칭|가짜/.test(text),
    /정보방|단체방|리딩방|텔레그램|카카오톡/.test(text),
    /어플|앱\s*설치|앱설치|HTS|MTS/.test(text),
    /입금|송금|투자금/.test(text),
    /출금|환급|수수료|세금|보증금/.test(text),
    extractUppercaseApps(text).length > 0 || extractImpersonatedEntities(text).length > 0,
    input.observations.some((item) => (item.facts?.method?.length ?? 0) > 0),
    input.observations.some((item) => (item.facts?.infra?.length ?? 0) > 0 || (item.facts?.amounts?.length ?? 0) > 0),
  ].filter(Boolean).length

  // Degree 3는 제목 나열만으로 허용하지 않는다. 본문 파생 사실 또는 서로 독립된 소스군이
  // 있어야 구체적인 피해 서사·금액·역할 관계를 페이지에 넣을 수 있다.
  if (dimensions >= 5 && (bodyFactCount >= 2 || independentFamilies >= 2)) return 3
  if (dimensions >= 3) return 2
  return 1
}

export function buildProgrammaticCasePage(input: ProgrammaticCaseInput): ProgrammaticCasePage {
  const text = input.observations.map((item) => item.title ?? '').join(' ')
  const degree = decideContentDegree(input)
  const caseType = TYPE_LABEL[input.scamType] ?? '금융 사칭 의심 사건'
  const apps = extractUppercaseApps(text)
  const institutions = extractImpersonatedEntities(text)
  const channels = unique([
    /정보방/.test(text) ? '정보방' : '',
    /단체방/.test(text) ? '단체 대화방' : '',
    /리딩방/.test(text) ? '리딩방' : '',
    /텔레그램/.test(text) ? '텔레그램' : '',
    /카카오톡/.test(text) ? '카카오톡' : '',
  ])
  const hasAppInstall = /어플|앱\s*설치|앱설치/.test(text)
  const hasDeposit = /입금|송금|투자금/.test(text)
  const hasWithdrawal = /출금|환급/.test(text)
  const hasBlock = /출금\s*(?:차단|거절|제한)|먹튀/.test(text)
  const methods = unique(input.observations.flatMap((item) => item.facts?.method ?? []))
  const infrastructures = unique(input.observations.flatMap((item) => item.facts?.infra?.map((infra) => infra.value) ?? []))
  const amounts = unique(input.observations.flatMap((item) => item.facts?.amounts ?? []))

  const appText = apps.length ? apps.join('·') : '별도 투자 앱'
  const institutionText = institutions.length ? institutions.join('·') : '금융회사 또는 투자 전문가'
  const channelText = channels.length ? channels.join('·') : '온라인 광고와 메신저 대화방'

  const summary = `${input.name} 명칭을 이용해 ${institutionText} 관련 정상 투자 기회처럼 접근한 뒤, ${appText} 등 별도 환경으로 이동시키는 유형을 확인해야 합니다.`
  const overview = [
    `${input.name} 관련 정황에서는 ${institutionText}의 명칭을 앞세워 신뢰를 만든 뒤 ${channelText}으로 연결하는 흐름이 나타납니다.`,
    `${hasAppInstall ? `${appText} 앱 설치 또는 가입을 안내하고 화면 안의 투자 정보로 참여를 이어가게 하는 방식` : '별도 투자 화면이나 회원 전용 채널로 참여를 이어가게 하는 방식'}을 주의해야 합니다.`,
    `${hasDeposit && hasWithdrawal ? '입금 이후 출금 단계에서 문제가 생기거나 추가 조건을 제시받는다면 더 보내기 전에 송금·대화·앱 기록을 한 번에 보전해야 합니다.' : '금전 요구가 시작되면 송금 전에 상대 신원과 공식 채널 일치 여부를 별도로 확인해야 합니다.'}`,
  ]

  const keyFacts = [
    institutions.length ? { label: '사칭 대상으로 언급', value: institutionText, description: '상대방이 안내한 연락처가 아니라 해당 기관의 공식 대표번호로 별도 확인해야 합니다.' } : null,
    apps.length ? { label: '연계된 앱 명칭', value: appText, description: '앱 이름뿐 아니라 게시자·설치 링크·요청 권한과 실제 접속 주소를 함께 확인해야 합니다.' } : null,
    channels.length ? { label: '주요 접촉 채널', value: channelText, description: '초대 링크, 방 이름, 운영자 프로필과 최초 연락 시점을 보전해야 합니다.' } : null,
    hasWithdrawal ? { label: '피해 인지 지점', value: hasBlock ? '출금 차단·연락 단절' : '출금 지연·추가 조건', description: '출금 처리 명목의 추가 비용 요구가 이어져도 먼저 사실관계를 확인해야 합니다.' } : null,
  ].filter((item): item is { label: string; value: string; description: string } => item !== null)

  const flow = [
    { title: '광고·메신저로 접근', description: `${institutionText} 관련 투자 기회 또는 프로젝트처럼 소개하며 대화를 시작합니다.` },
    { title: `${channelText}으로 이동`, description: '개별 연락에서 단체 대화로 옮긴 뒤 운영자·참여자 메시지로 신뢰를 강화하는지 확인합니다.' },
    ...(hasAppInstall ? [{ title: `${appText} 설치·가입 안내`, description: '상대가 전달한 링크로 앱을 설치하게 하거나 별도 투자 화면에 개인정보를 입력하게 하는 단계입니다.' }] : []),
    ...(hasDeposit ? [{ title: '투자금 입금 유도', description: '참여 조건, 배정 물량, 추가 매수 등의 설명으로 송금 규모를 늘리도록 요구하는지 확인합니다.' }] : []),
    ...(hasWithdrawal ? [{ title: hasBlock ? '출금 차단 또는 연락 단절' : '출금 지연과 추가 조건', description: '출금 신청 뒤 수수료·세금·인증 등 새로운 조건이 붙는다면 추가 송금을 중단해야 합니다.' }] : []),
  ]

  const victimPatterns = [
    { title: '송금 전 단계', description: `${channelText}에 참여했고 ${appText} 설치를 안내받았지만 아직 송금하지 않은 경우입니다. 링크와 상대 계정부터 보전해야 합니다.` },
    ...(hasAppInstall ? [{ title: '앱 설치·가입 단계', description: `${appText} 앱을 설치하고 개인정보를 입력했거나 거래 화면을 확인한 경우입니다. 삭제 전에 게시자·권한·화면을 기록해야 합니다.` }] : []),
    ...(hasDeposit ? [{ title: '입금 이후 단계', description: '안내받은 계좌로 입금했거나 추가 매수를 요구받는 경우입니다. 이체확인증과 전체 대화를 시간순으로 정리해야 합니다.' }] : []),
    ...(hasWithdrawal ? [{ title: '출금 문제 발생 단계', description: '출금이 지연·차단되고 비용이나 추가 입금을 요구받는 경우입니다. 더 보내지 말고 금융회사와 신고 절차를 확인해야 합니다.' }] : []),
  ]

  const detailedNarratives = [
    methods.length ? { title: '구체적으로 확인된 유도 방식', description: `${methods.join(' · ')} 방식이 함께 언급됩니다. 실제 대화에서 어떤 표현과 순서로 안내받았는지 대조해야 합니다.` } : null,
    infrastructures.length ? { title: '함께 확인할 앱·사이트·채널', description: `${infrastructures.join(' · ')} 명칭이 확인됩니다. 같은 이름이라도 설치 링크, 도메인, 게시자와 운영 계정이 일치하는지 확인해야 합니다.` } : null,
    amounts.length ? { title: '사건정보에 언급된 금액', description: `${amounts.join(' · ')} 관련 내용이 확인됩니다. 이 금액은 일반적인 피해액을 뜻하지 않으므로 개별 송금내역과 구분해 봐야 합니다.` } : null,
  ].filter((item): item is { title: string; description: string } => item !== null)

  const responseFocus = [
    { title: '유입 경로 확인', description: `어떤 광고·연락을 통해 ${channelText}에 들어갔는지 초대한 계정과 링크를 확인합니다.` },
    ...(hasAppInstall ? [{ title: '앱·사이트 식별', description: `${appText}의 게시자, 설치파일, 권한 요청, 로그인 주소와 화면을 보전합니다.` }] : []),
    { title: '송금 흐름 정리', description: '입금 계좌, 예금주, 송금 시각과 출금 신청 이후 받은 답변을 하나의 시간표로 정리합니다.' },
  ]

  const riskMechanisms = [
    { title: '실존 기관의 신뢰를 빌리는 방식', description: `${institutionText}의 명칭·로고·직원 직함을 사용하더라도 상대가 준 연락처가 아닌 공식 채널로 확인하기 전에는 실제 관계를 알 수 없습니다.` },
    { title: '대화방과 전용 화면으로 확신을 만드는 방식', description: `${channelText}의 다른 참여자 반응과 ${appText} 화면이 실제 거래를 증명하지는 않습니다. 앱 게시자와 실제 자금 흐름을 따로 확인해야 합니다.` },
    ...(hasWithdrawal ? [{ title: '출금 단계에서 비용을 더 요구하는 방식', description: '출금이 지연된 뒤 수수료·세금·인증비·보증금 같은 새로운 조건이 붙으면 추가 입금으로 문제가 해결되는지 먼저 의심해야 합니다.' }] : []),
  ]

  return {
    degree,
    caseType,
    summary,
    overview,
    keyFacts,
    flow,
    victimPatterns,
    detailedNarratives,
    riskMechanisms,
    responseFocus,
    entities: [
      ...(institutions.length ? [{ label: '사칭 대상으로 언급된 기관', values: institutions }] : []),
      ...(apps.length ? [{ label: '함께 확인할 앱·플랫폼', values: apps }] : []),
      ...(channels.length ? [{ label: '접촉 채널', values: channels }] : []),
    ],
    sectionFlags: {
      flow: degree >= 2,
      victimPatterns: degree >= 2,
      detailedNarrative: degree >= 3,
    },
  }
}
