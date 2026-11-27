// GTM(GA4·메타·카카오·당근 픽셀 컨테이너) + 네이버 프리미엄 로그분석(직접 설치)
// 스펙 §7. PII는 dataLayer로 절대 흘리지 않는다(track.ts 인터페이스가 차단).
export function Analytics() {
  const gtmId = process.env.NEXT_PUBLIC_GTM_ID
  const wcsId = process.env.NEXT_PUBLIC_NAVER_WCS_ID
  if (!gtmId && !wcsId) return null

  return (
    <>
      {gtmId && (
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtmId}');`,
          }}
        />
      )}
      {wcsId && (
        <script
          dangerouslySetInnerHTML={{
            __html: `if(!wcs_add)var wcs_add={};wcs_add['wa']='${wcsId}';(function(){var s=document.createElement('script');s.async=true;s.src='//wcs.naver.net/wcslog.js';s.onload=function(){if(window.wcs){wcs_do();}};document.head.appendChild(s);})();`,
          }}
        />
      )}
    </>
  )
}
