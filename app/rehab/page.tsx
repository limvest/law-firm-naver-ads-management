import type { Metadata } from 'next'
import { DawnLanding } from '@/components/dawn-landing'

export const metadata: Metadata = {
  title: '개인회생 상담',
  description: '개인회생 제도의 요건과 절차를 안내합니다. 채무 규모별 상담 문의.',
}

export default function RehabPage() {
  return (
    <DawnLanding
      vertical="rehab"
      slug="rehab"
      eyebrow="REHABILITATION"
      titleLines={['가장 어두운 시간에도,', '아침은 준비되고 있습니다']}
      sub="일정한 소득이 있다면, 법원의 인가를 받아 3년 변제 후 남은 채무를 면책받는 절차가 있습니다. 지금 상황에서 신청 가능한지부터 확인합니다."
      steps={[
        { no: '01', name: '요건 확인·서류 준비', desc: '채무 총액, 소득, 재산을 기준으로 신청 가능성을 검토하고 신청 서류를 준비합니다.' },
        { no: '02', name: '신청·개시결정', desc: '법원에 신청서를 접수하고, 금지명령·중지명령 검토와 함께 개시결정을 받습니다.' },
        { no: '03', name: '변제계획 인가·면책', desc: '변제계획 인가 후 원칙적으로 3년간 변제를 수행하고 남은 채무의 면책을 받습니다.' },
      ]}
      closing="오늘 확인부터 시작하세요"
    />
  )
}
