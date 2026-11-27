import type { Metadata } from 'next'
import { DawnLanding } from '@/components/dawn-landing'

export const metadata: Metadata = {
  title: '개인파산 상담',
  description: '개인파산·면책 제도의 요건과 절차를 안내합니다.',
}

export default function BankruptcyPage() {
  return (
    <DawnLanding
      vertical="bankruptcy"
      slug="bankruptcy"
      eyebrow="BANKRUPTCY"
      titleLines={['멈추는 것이,', '다시 시작하는 방법일 때']}
      sub="변제 능력이 없는 상태라면, 파산 선고와 면책 결정을 통해 채무에서 벗어나는 절차를 검토할 수 있습니다. 면책 불허가 사유 검토가 먼저입니다."
      steps={[
        { no: '01', name: '지급불능·면책요건 검토', desc: '변제 능력과 면책 불허가 사유 유무를 먼저 검토합니다. 회생과 파산 중 적합한 절차를 판단합니다.' },
        { no: '02', name: '파산 신청·선고', desc: '신청서와 소명 자료를 준비해 법원에 접수하고 파산 선고를 받습니다.' },
        { no: '03', name: '면책 결정', desc: '면책 심문·조사를 거쳐 면책 결정을 받으면 채무의 책임에서 벗어납니다.' },
      ]}
      closing="검토부터 정확하게"
    />
  )
}
