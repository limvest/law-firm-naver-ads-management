export type Vertical = 'firm' | 'rehab' | 'scam'

export function themeFor(path: string): Vertical {
  if (path === '/rehab' || path === '/bankruptcy' || path.startsWith('/rehab/') || path.startsWith('/bankruptcy/')) return 'rehab'
  if (path === '/scam' || path.startsWith('/scam/')) return 'scam'
  return 'firm'
}
