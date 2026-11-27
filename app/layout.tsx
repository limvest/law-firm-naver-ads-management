import './globals.css'
import type { Metadata } from 'next'
import { Analytics } from '@/components/analytics'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'
import { siteConfig } from '@/config/site'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { currentRequestIsSampleoneFintech } from '@/lib/engine/request-firm'

export const productRootMetadata: Metadata = {
  title: { default: '사건명 광고 엔진', template: '%s | 사건명 광고 엔진' },
  description: '법률사무소 전용 사건명 수집·롱테일 랜딩·검색광고·상담 분석 서비스',
  robots: { index: true, follow: true },
}

export async function generateMetadata(): Promise<Metadata> {
  const firm = await currentRequestFirm()
  if (firm) {
    const origin = firm.domain ? `https://${firm.domain}` : undefined
    const description = firm.profileIntro ?? `${firm.name} 금융사기 피해 사건 상담 및 대응 절차 안내`
    const socialImage = firm.slug === 'sampleone' ? '/assets/sampleone-original/og-sampleone-logo.png' : '/assets/styleframes/hf_act0_v1.png'
    return {
      ...(origin && { metadataBase: new URL(origin), alternates: { canonical: '/' } }),
      title: { default: `${firm.name} | 금융사기 피해 대응`, template: `%s | ${firm.name}` },
      description,
      robots: {
        index: true, follow: true,
        googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 },
      },
      openGraph: {
        type: 'website', locale: 'ko_KR', url: '/', siteName: firm.name,
        title: `${firm.name} | 금융사기 피해 대응`, description,
        images: [{ url: socialImage, width: 1200, height: 630, alt: firm.name }],
      },
      twitter: {
        card: 'summary_large_image', title: `${firm.name} | 금융사기 피해 대응`, description,
        images: [socialImage],
      },
      ...(firm.slug === 'sampleone' && { icons: {
        icon: [{ url: '/assets/sampleone-original/icon-sampleone.png', type: 'image/png', sizes: '512x512' }],
        apple: [{ url: '/assets/sampleone-original/apple-icon-sampleone.png', sizes: '180x180' }],
      } }),
    }
  }
  return productRootMetadata
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [firm, sampleoneFintech] = await Promise.all([currentRequestFirm(), currentRequestIsSampleoneFintech()])
  const origin = firm?.domain ? `https://${firm.domain}` : null
  const firmSocialImage = firm?.slug === 'sampleone' ? 'assets/sampleone-original/og-sampleone-logo.png' : 'assets/styleframes/hf_act0_v1.png'
  const firmLogoImage = firm?.slug === 'sampleone' ? 'assets/sampleone-original/logo-header-inverse.png' : firmSocialImage
  const organizationJsonLd = firm && origin ? JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite', '@id': `${origin}/#website`, url: origin, name: firm.name,
        inLanguage: 'ko-KR', publisher: { '@id': `${origin}/#legal-service` },
      },
      {
        '@type': 'LegalService', '@id': `${origin}/#legal-service`, url: origin, name: firm.name,
        telephone: firm.phoneIntl, image: `${origin}/${firmSocialImage}`, logo: `${origin}/${firmLogoImage}`,
        areaServed: { '@type': 'Country', name: '대한민국' },
        address: {
          '@type': 'PostalAddress', addressCountry: 'KR', addressRegion: firm.addressRegion,
          addressLocality: firm.addressLocality, streetAddress: firm.address,
        },
      },
    ],
  }).replace(/</g, '\\u003c') : null
  return (
    <html lang="ko">
      <head>
        <Analytics />
        {organizationJsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: organizationJsonLd }} />}
      </head>
      <body className="t-bg t-ink antialiased">
        {!sampleoneFintech && firm?.slug !== 'sampleone' && <SiteHeader firm={firm} />}
        {children}
        {!sampleoneFintech && <SiteFooter firm={firm} />}
      </body>
    </html>
  )
}
