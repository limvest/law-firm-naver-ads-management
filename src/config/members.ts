export type Member = { name: string; title: string; bio: string }

// 실명·직함: sampletwo-law.example.com 공개 정보 (2026-07-04 확인)
export const members: Member[] = [
  { name: '김일번', title: '대표변호사', bio: '사기·재산범죄 사건의 초기 사실관계와 증거를 직접 검토합니다.' },
  { name: '이이번', title: '수석변호사', bio: '금융감독원 변호사 연수 및 검사직무대리 경력을 바탕으로 사건을 검토합니다.' },
  { name: '박삼번', title: '변호사', bio: '피해자 대리와 형사 절차의 적용 가능성을 구체적인 기록에 따라 검토합니다.' },
  { name: '최사번', title: '변호사', bio: '민사·손해배상 관점에서 회수 절차와 보전 필요성을 검토합니다.' },
]
