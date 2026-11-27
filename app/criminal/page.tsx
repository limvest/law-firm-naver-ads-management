import type { Metadata } from 'next'
import { Landing } from '@/components/landing'
import { ThemeScope } from '@/components/theme-scope'

export const metadata: Metadata = {
  title: '형사 사건 대응',
  description: '수사 단계부터 공판까지, 형사 절차 단계별 대응을 안내합니다.',
}

export default function CriminalPage() {
  return (
    <ThemeScope vertical="firm">
      <Landing
        vertical="scam"
        slug="criminal"
        title="형사 절차, 단계마다 해야 할 일이 다릅니다"
        subtitle="출석 요구를 받은 순간부터 공판까지 — 지금 단계에 맞는 대응을 안내합니다."
        sections={[
          { heading: '수사 단계', body: '조사 출석 전 사실관계 정리와 진술 방향 검토가 이후 절차 전체에 영향을 줍니다. 출석 통보를 받았다면 조사 전에 상담을 권합니다.' },
          { heading: '기소 이후', body: '공소사실 검토, 증거 의견, 양형 자료 준비 순으로 진행합니다. 사안에 따라 필요한 대응이 다르므로 기록을 기준으로 판단합니다.' },
        ]}
      />
    </ThemeScope>
  )
}
