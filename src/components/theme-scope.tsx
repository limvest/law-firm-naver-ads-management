import type { Vertical } from '@/lib/theme'

export function ThemeScope({ vertical, children }: { vertical: Vertical; children: React.ReactNode }) {
  return (
    <div data-vertical={vertical} className="theme-scope t-bg t-ink">
      {children}
    </div>
  )
}
