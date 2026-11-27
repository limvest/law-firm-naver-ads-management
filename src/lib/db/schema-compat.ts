/**
 * Additive-rollout compatibility guard. Only missing relation/column errors are
 * eligible for a legacy write retry; validation, permission and provider
 * errors must still fail.
 */
export function isAdditiveSchemaUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current)
    const value = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (value.code === '42P01' || value.code === '42703') return true
    if (typeof value.message === 'string' && /(relation|column) .* does not exist/i.test(value.message)) return true
    current = value.cause
  }
  return false
}
