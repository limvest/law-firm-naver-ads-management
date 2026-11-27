export const siteConfig = {
  firmId: 1,
  firmName: '법률사무소 샘플투',
  adLawyerName: '김일번',
  bar: '대한변호사협회 등록 변호사',
  phone: '031-000-0000',
  kakaoUrl: '',
  address: '경기도 샘플시 샘플구 샘플로 1, 5층 503·504호(샘플동, 샘플빌딩)',
  email: '',
} as const

export type SiteConfig = typeof siteConfig
