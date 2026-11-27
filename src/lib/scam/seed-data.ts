export type ScamTypeSeed = { name: string; slug: string; scamType: string; intro: string }

// 시드 정책: 업체 실명 금지 — 수법 유형만. 변호사 승인 대기 초안 카피.
export const SCAM_TYPE_SEEDS: ScamTypeSeed[] = [
  { name: '리딩방 투자 사기', slug: 'leading-room', scamType: '리딩방', intro: '단체 대화방에서 종목 추천과 수익 인증으로 투자를 유도한 뒤 출금을 막는 유형입니다.' },
  { name: '코인 거래소 출금 사기', slug: 'coin-exchange', scamType: '코인', intro: '가짜 거래소나 지갑으로 입금을 유도한 뒤 출금 시 수수료·세금 명목을 요구하는 유형입니다.' },
  { name: '주식 리딩 손실 피해', slug: 'stock-leading', scamType: '리딩방', intro: '고수익을 내세운 유료 리딩 서비스 가입 후 손실과 연락 두절이 이어지는 유형입니다.' },
  { name: '로맨스 스캠', slug: 'romance-scam', scamType: '로맨스', intro: '온라인에서 친분과 연애 감정을 쌓은 뒤 송금을 요구하는 유형입니다.' },
  { name: '중고거래 사기', slug: 'secondhand', scamType: '중고거래', intro: '입금 후 물품을 보내지 않거나 다른 물건을 보내는 유형입니다.' },
  { name: '전세 보증금 사기', slug: 'jeonse', scamType: '부동산', intro: '깡통전세·이중계약 등으로 보증금 반환이 어려워지는 유형입니다.' },
  { name: '부업·재택 알바 사기', slug: 'side-job', scamType: '부업', intro: '간단한 작업으로 수익을 낼 수 있다며 보증금이나 물품 구매를 요구하는 유형입니다.' },
  { name: '쇼핑몰 미배송 사기', slug: 'shopping-mall', scamType: '쇼핑몰', intro: '결제 후 상품을 보내지 않고 연락이 끊기는 유형입니다.' },
  { name: '몸캠 피싱 협박', slug: 'body-cam', scamType: '피싱', intro: '영상 통화를 유도해 녹화한 뒤 지인 유포를 빌미로 금전을 요구하는 유형입니다.' },
  { name: '대출 수수료 사기', slug: 'loan-fee', scamType: '대출', intro: '대출을 미끼로 선입금 수수료나 앱 설치를 요구하는 유형입니다.' },
  { name: '게임 아이템 거래 사기', slug: 'game-item', scamType: '게임', intro: '아이템·계정 거래 대금을 받고 이행하지 않는 유형입니다.' },
  { name: '티켓 대리구매 사기', slug: 'ticket', scamType: '티켓', intro: '공연·스포츠 티켓 대리구매 명목으로 입금만 받는 유형입니다.' },
  { name: '해외직구 대행 사기', slug: 'overseas-order', scamType: '직구', intro: '구매 대행 대금을 받고 물품을 전달하지 않는 유형입니다.' },
  { name: 'SNS 마켓 사기', slug: 'sns-market', scamType: 'SNS', intro: 'SNS 판매 계정에서 입금을 받은 뒤 차단하는 유형입니다.' },
  { name: '노쇼 대금 편취', slug: 'no-show', scamType: '자영업', intro: '단체 예약·선결제를 유도한 뒤 잠적해 자영업자에게 손해를 입히는 유형입니다.' },
  { name: '프랜차이즈 창업 사기', slug: 'franchise', scamType: '창업', intro: '수익 전망을 부풀려 가맹비를 받은 뒤 지원을 이행하지 않는 유형입니다.' },
  { name: '헬스장·이용권 먹튀', slug: 'gym-closure', scamType: '이용권', intro: '장기 이용권 판매 직후 폐업하는 유형입니다.' },
  { name: '숙박·여행 예약 사기', slug: 'travel-booking', scamType: '여행', intro: '가짜 숙소·항공 예약 페이지로 결제를 유도하는 유형입니다.' },
  { name: '보이스피싱 자금 피해', slug: 'voice-phishing', scamType: '피싱', intro: '기관 사칭 전화로 이체·현금 전달을 유도하는 유형입니다.' },
  { name: '스미싱 결제 피해', slug: 'smishing', scamType: '피싱', intro: '문자 링크로 악성 앱을 설치시켜 소액결제·이체 피해를 일으키는 유형입니다.' },
]

// 공용 섹션(승인 대기 초안 — P0 /scam 카피 재사용) + 유형별 intro
export function buildSeedContent(seed: ScamTypeSeed) {
  return {
    intro: seed.intro,
    sections: [
      { heading: '왜 초기 대응이 중요한가요', body: '피해 직후에는 송금 내역·대화 기록 등 증거를 보전하고, 계좌 지급정지 등 취할 수 있는 조치를 빠르게 검토하는 것이 이후 절차에 큰 영향을 줍니다.' },
      { heading: '단계별 대응 절차', body: '피해 확인과 증거 정리, 수사기관 고소·진정, 가압류 등 재산 보전 처분, 민사상 손해배상 청구 순으로 진행 여부를 검토합니다. 사안에 따라 필요한 절차가 다르므로 상담을 통해 확인하시기 바랍니다.' },
      { heading: '상담 시 준비하면 좋은 것', body: '송금 내역, 상대방과의 대화 기록, 상대 계좌·연락처 정보를 정리해 두시면 상담이 빠르게 진행됩니다.' },
    ],
  }
}
