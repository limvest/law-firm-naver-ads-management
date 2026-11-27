import { describe, expect, it } from 'vitest'
import {
  createNaverHtmlSearchClient,
  NaverWebSearchBlockedError,
  NaverWebSearchError,
  naverHtmlSearchOptedIn,
  parseNaverIntegratedSearchHtml,
} from '@/domains/intelligence/naver-web-search'

const HTML = `
<div class="total_wrap">
  <a class="total_tit _cross_trigger" href="https://law.example/case?a=1#top"><em>Alpha</em> 거래소 사기</a>
  <div class="api_txt_lines dsc_txt">입금 후 출금이 거절된 피해 사례입니다.</div>
</div>
<div class="total_wrap">
  <a class="link_tit" href="https://law.example/second">Beta 피해</a>
  <div class="total_dsc">두 번째 설명</div>
</div>`

describe('Naver public integrated-search HTML client', () => {
  it('result title/link/description를 추출하고 nested markup과 fragment를 정리한다', () => {
    expect(parseNaverIntegratedSearchHtml(HTML)).toEqual([
      { title: 'Alpha 거래소 사기', link: 'https://law.example/case?a=1', description: '입금 후 출금이 거절된 피해 사례입니다.' },
      { title: 'Beta 피해', link: 'https://law.example/second', description: '두 번째 설명' },
    ])
  })

  it('2026 Fender bootstrap·해시 클래스 anchor에서도 결과를 추출한다', () => {
    const modern = `<script>bootstrap(root, {"body":{"props":{"title":"<mark>MOCKQIB 사기</mark> 피해 대응","titleHref":"https://law.example/fraud/mockqib","content":"출금 거절 피해 사례","contentHref":"https://law.example/fraud/mockqib"}}})</script>
      <a href="https://blog.naver.com/law_blog/224392745035" class="fender-ui_deadbeef"><span>MOCKF 사기 피해</span><span>새 창 열림</span></a>`
    expect(parseNaverIntegratedSearchHtml(modern)).toEqual([
      { title: 'MOCKQIB 사기 피해 대응', link: 'https://law.example/fraud/mockqib', description: '' },
      { title: 'MOCKF 사기 피해', link: 'https://blog.naver.com/law_blog/224392745035', description: '' },
    ])
  })

  it('빈 제목·위험한 링크·중복 링크를 제외한다', () => {
    expect(parseNaverIntegratedSearchHtml(`
      <a class="total_tit" href="javascript:alert(1)">bad</a>
      <a class="total_tit" href="https://law.example/a">첫 <strong>결과</strong></a>
      <a class="total_tit" href="https://law.example/a">중복</a>
      <a class="total_tit" href="//law.example/b">둘째</a>
    `)).toEqual([
      { title: '첫 결과', link: 'https://law.example/a', description: '' },
      { title: '둘째', link: 'https://law.example/b', description: '' },
    ])
  })

  it('opt-in 없이는 생성할 수 없고 opt-in helper는 명시적 1만 허용한다', () => {
    expect(naverHtmlSearchOptedIn(undefined)).toBe(false)
    expect(naverHtmlSearchOptedIn('0')).toBe(false)
    expect(naverHtmlSearchOptedIn('1')).toBe(true)
    expect(() => createNaverHtmlSearchClient()).toThrowError(NaverWebSearchError)
    expect(() => createNaverHtmlSearchClient({ optIn: false })).toThrow('명시적 opt-in')
  })

  it('public Naver HTML endpoint와 query를 사용한다', async () => {
    let requested = ''
    const client = createNaverHtmlSearchClient({
      optIn: true,
      minIntervalMs: 0,
      fetcher: (async (url) => {
        requested = String(url)
        return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }) as typeof fetch,
    })
    await expect(client.search('Alpha 거래소')).resolves.toHaveLength(2)
    expect(requested).toBe('https://search.naver.com/search.naver?where=nexearch&query=Alpha+%EA%B1%B0%EB%9E%98%EC%86%8C')
  })

  it('403/429 and CAPTCHA open a circuit and reject subsequent work', async () => {
    let calls = 0
    const client = createNaverHtmlSearchClient({
      optIn: true,
      minIntervalMs: 0,
      fetcher: (async () => {
        calls += 1
        return new Response('<html>자동입력방지 CAPTCHA</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      }) as typeof fetch,
    })
    await expect(client.search('blocked')).rejects.toMatchObject({ reason: 'captcha', code: 'blocked' })
    expect(client.halted).toBe(true)
    await expect(client.search('again')).rejects.toBeInstanceOf(NaverWebSearchBlockedError)
    expect(calls).toBe(1)

    const limited = createNaverHtmlSearchClient({
      optIn: true,
      minIntervalMs: 0,
      fetcher: (async () => new Response('', { status: 429 })) as typeof fetch,
    })
    await expect(limited.search('limited')).rejects.toMatchObject({ reason: 'http-429' })
    expect(limited.halted).toBe(true)
  })

  it('정상 페이지의 공통 script 내 captcha 단어는 차단으로 오판하지 않는다', async () => {
    const client = createNaverHtmlSearchClient({
      optIn: true,
      minIntervalMs: 0,
      fetcher: (async () => new Response(
        `<html><script>const captchaHandler = true</script>${HTML}</html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      )) as typeof fetch,
    })
    await expect(client.search('normal')).resolves.toHaveLength(2)
    expect(client.halted).toBe(false)
  })

  it('rejects external redirects and does not follow them', async () => {
    let calls = 0
    const client = createNaverHtmlSearchClient({
      optIn: true,
      minIntervalMs: 0,
      fetcher: (async () => {
        calls += 1
        return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } })
      }) as typeof fetch,
    })
    await expect(client.search('ssrf')).rejects.toMatchObject({ code: 'invalid-redirect' })
    expect(calls).toBe(1)
  })

  it('limits concurrency to two even when callers fan out', async () => {
    let active = 0
    let peak = 0
    const client = createNaverHtmlSearchClient({
      optIn: true,
      maxConcurrent: 2,
      minIntervalMs: 0,
      fetcher: (async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }) as typeof fetch,
    })
    await Promise.all(Array.from({ length: 6 }, (_, index) => client.search(`q${index}`)))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('reserves the minimum interval across concurrent callers', async () => {
    const starts: number[] = []
    const client = createNaverHtmlSearchClient({
      optIn: true,
      maxConcurrent: 2,
      minIntervalMs: 20,
      fetcher: (async () => {
        starts.push(Date.now())
        await new Promise((resolve) => setTimeout(resolve, 1))
        return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }) as typeof fetch,
    })

    await Promise.all(Array.from({ length: 4 }, (_, index) => client.search(`paced-${index}`)))
    expect(starts).toHaveLength(4)
    expect(starts.slice(1).every((startedAt, index) => startedAt - starts[index] >= 15)).toBe(true)
  })
})
