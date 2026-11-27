const BOT_PATTERN =
  /bot|crawler|spider|crawling|yeti|naverbot|daum|kakaotalk-scrap|googlebot|bingbot|slurp|facebookexternalhit|headless/i

export function isBotUA(ua: string | null): boolean {
  if (!ua) return true
  return BOT_PATTERN.test(ua)
}
