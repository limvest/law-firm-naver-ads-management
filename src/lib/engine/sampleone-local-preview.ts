import type { Firm } from '@/lib/engine/firms'
import type { FirmHomeSignals } from '@/lib/engine/firm-home-data'

/** 운영 DB가 없는 로컬 화면 검수 전용. 공개된 샘플원 프로필과 2026-08-27 Neon 집계 스냅샷만 사용한다. */
export const SAMPLEONE_LOCAL_PREVIEW_FIRM: Firm = {
  id: 289283342,
  slug: 'sampleone',
  name: '법무법인 샘플원',
  adLawyerName: '정오번',
  phone: '010-0000-0009',
  phoneIntl: '+82-10-0000-0009',
  address: '샘플로 2, 샘플빌딩 9층',
  addressRegion: '서울특별시',
  addressLocality: '서초구',
  kakaoUrl: 'https://open.kakao.com/o/mock',
  domain: 'sampleone.attorney',
  domainAliases: null,
  status: 'active',
  lawyers: [
    {
      id: 'sampleone-lawyere', name: '정오번 변호사', title: '대표변호사',
      education: ['○○고등학교', '○○대학교 법학과', '○○대학교 법학전문대학원'],
      badges: ['대한변호사협회 인증 형사 전문 변호사'],
      photo: null,
      bio: '육군 군검사 경력을 바탕으로 형사·재산범죄 사건의 초기 사실관계와 증거를 직접 검토합니다.',
      career: ['군검사', '법무법인 경쟁사V', '법무법인 경쟁사W'],
      practiceAreas: ['형사', '재산범죄', '금융사기'],
    },
    {
      id: 'sampleone-lawyerf', name: '강육번 변호사', title: '변호사',
      education: ['○○고등학교', '○○대학교 법학과', '○○대학교 법학전문대학원'],
      badges: ['법무법인 경쟁사X', '세무법인 근무'],
      photo: null,
      practiceAreas: ['형사', '조세', '재산범죄'],
    },
    {
      id: 'sampleone-lawyerg', name: '조칠번 변호사', title: '변호사',
      education: ['○○고등학교', '○○대학교 행정학과', '○○대학교 법학전문대학원'],
      badges: ['금융기관 법무실', '인터넷은행 컴플라이언스 법무팀'],
      photo: null,
      practiceAreas: ['금융', '컴플라이언스', '재산범죄'],
    },
    {
      id: 'sampleone-lawyerh', name: '윤팔번 변호사', title: '변호사',
      education: ['○○대학교 법학전문대학원', '○○대학교 법학과', '○○고등학교'],
      badges: ['대한변호사협회 인증 형사전문 변호사', '법무법인 경쟁사Y'],
      photo: null,
      practiceAreas: ['형사', '피해자 대리', '재산범죄'],
    },
    {
      id: 'sampleone-lawyeri', name: '장구번 변호사', title: '변호사',
      badges: [],
      photo: '/assets/sampleone-campaign-v3/people/lawyeri-card.jpg',
      career: ['경쟁사K법률사무소', '경쟁사Q법률사무소', '법무법인 경쟁사S', '법무법인 경쟁사T'],
      education: ['○○대학교 사회과학 전공', '○○대학교 법학전문대학원'],
    },
  ],
  wordmark: '법무법인 샘플원',
  landingReady: true,
  dashboardToken: null,
  siteTemplate: 'response-room',
  profileIntro: '군검사 출신 대표변호사와 금융기관·핀테크 법무 경험 변호사가 사기·재산범죄의 증거와 금융거래 흐름을 함께 검토합니다.',
  officeHistory: null,
  adConfig: null,
}

export const SAMPLEONE_LOCAL_PREVIEW_SIGNALS: FirmHomeSignals = {
  caseCount: 26091,
  trackedCaseCount: 26076,
  observationCount: 63001,
  livePageCount: 26091,
  recent: [
    { name: 'MOCKA', slug: 'mocka', scamType: 'leading', observationCount: 13 },
    { name: 'MOCKAPP', slug: 'mockapp', scamType: 'leading', observationCount: 8 },
    { name: 'MOCKCASE13', slug: 'mockcase13', scamType: 'leading', observationCount: 6 },
    { name: 'MOCKB', slug: 'mockb', scamType: 'leading', observationCount: 5 },
    { name: '가상업체E', slug: 'mock-case-11', scamType: 'leading', observationCount: 4 },
    { name: '가상업체G', slug: 'mock-case-12', scamType: 'leading', observationCount: 3 },
  ],
}
