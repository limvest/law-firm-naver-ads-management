export const SESSION_COOKIE = 'sid'
export const FIRST_TOUCH_COOKIE = 'ft'
export const LAST_TOUCH_COOKIE = 'lt'

const TRACKED_PREFIXES = ['utm_', 'n_']

export function extractUtm(params: URLSearchParams): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [k, v] of params) {
    if (TRACKED_PREFIXES.some((p) => k.startsWith(p)) && v) out[k] = v.slice(0, 200)
  }
  return Object.keys(out).length ? out : null
}
