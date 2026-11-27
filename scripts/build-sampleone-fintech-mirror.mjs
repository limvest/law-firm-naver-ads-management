import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const sourceRoot = process.env.SAMPLEONE_FINTECH_SOURCE || './reference-mirror'
const outputRoot = join(process.cwd(), 'public', 'sampleone-fintech-mirror')
const sourceFraud = join(sourceRoot, 'fraud')
const sourceImages = join(sourceRoot, 'theme', 'competitorf_fintech', 'images')

if (!existsSync(join(sourceFraud, 'index.html'))) {
  throw new Error(`원본 사이트 미러를 찾을 수 없습니다: ${sourceRoot}`)
}

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(join(outputRoot, 'fraud'), { recursive: true })
mkdirSync(join(outputRoot, 'theme', 'images'), { recursive: true })
cpSync(sourceImages, join(outputRoot, 'theme', 'images'), { recursive: true })

// 원본 레이아웃 자산은 유지하되 법인 로고는 샘플원 정본으로 교체한다.
cpSync(join(process.cwd(), 'public', 'assets', 'sampleone-original', 'logo-header-inverse.png'), join(outputRoot, 'theme', 'images', 'logo_w.png'))
cpSync(join(process.cwd(), 'public', 'assets', 'sampleone-original', 'icon-sampleone.png'), join(outputRoot, 'theme', 'images', 'favicon.png'))

const literalReplacements = [
  ['https://competitor-f-fintech.example.com/theme/competitorf_fintech/images/', 'https://fintech.sampleone.attorney/sampleone-fintech-mirror/theme/images/'],
  ['/theme/competitorf_fintech/images/', '/sampleone-fintech-mirror/theme/images/'],
  ['https://competitor-f-fintech.example.com/theme/competitorf_fintech/page_html/privacy.html', 'https://sampleone-law.example.com/Privacy'],
  ['https://competitor-f-fintech.example.com/theme/competitorf_fintech/page_html/center_map.html', 'https://sampleone-law.example.com/About'],
  ['https://competitor-f-fintech.example.com', 'https://fintech.sampleone.attorney'],
  ['법무법인 경쟁사F 핀테크범죄센터', '법무법인 샘플원 핀테크범죄센터'],
  ['세담 핀테크범죄센터', '샘플원 핀테크범죄센터'],
  ['법무법인 경쟁사F', '법무법인 샘플원'],
  ['대표자 : 임십번 변호사', '광고책임변호사 : 정오번 변호사'],
  ['임십번 변호사', '정오번 변호사'],
  ['원본변호사 변호사', '정오번 변호사'],
  ['000-00-00002', '000-00-00003'],
  ['서울특별시 서초구 샘플로 3, 12층 (서초동, 샘플빌딩)', '서울특별시 서초구 샘플로 2, 샘플빌딩 9층'],
  ['샘플로 3, 12층 샘플빌딩', '샘플로 2, 샘플빌딩 9층'],
  ['02-000-0001', '02-000-0002'],
  ['>5503</span>', '>1661</span>'],
  ['https://pf.kakao.com/_mock1/chat', 'https://sampleone-law.example.com/'],
  ['/fraud_api/victim_relay.php', '/api/legacy-fraud-leads'],
  ["'competitorf_fintech'", "'sampleone_fintech'"],
  ['"competitorf_fintech"', '"sampleone_fintech"'],
]

function transform(html) {
  let result = html
  for (const [from, to] of literalReplacements) result = result.split(from).join(to)
  // Cloudflare에서 인코딩된 타 법인 이메일은 샘플원 페이지에 노출하지 않는다.
  result = result.replace(/e-mail\s*:\s*<a href="\/cdn-cgi\/l\/email-protection#[^"]+">[\s\S]*?<\/a>/gi, 'e-mail : 홈페이지 문의')
  result = result.replace(/<script[^>]+src="\/cdn-cgi\/scripts\/[^"]+email-decode\.min\.js"[^>]*><\/script>/gi, '')
  return result
}

let htmlCount = 0
for (const file of readdirSync(sourceFraud)) {
  if (!file.endsWith('.html')) continue
  let outputName = file
  const pageMatch = file.match(/^index\.html\?page=(\d+)\.html$/)
  if (pageMatch) outputName = `page-${pageMatch[1]}.html`
  writeFileSync(join(outputRoot, 'fraud', outputName), transform(readFileSync(join(sourceFraud, file), 'utf8')))
  htmlCount += 1
}

writeFileSync(join(outputRoot, 'build.json'), JSON.stringify({ htmlCount, source: basename(sourceRoot), builtAt: new Date().toISOString() }, null, 2))
console.log(`sampleone fintech mirror: ${htmlCount} HTML files`)
