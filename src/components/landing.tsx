import { CtaGroup } from '@/components/cta-group'
import { StickyBar } from '@/components/sticky-bar'
import { LeadForm } from '@/components/lead-form/lead-form'
import { PageViewTracker } from '@/components/page-view-tracker'
import { ThemeScope } from '@/components/theme-scope'
import { themeFor } from '@/lib/theme'
import type { Vertical } from '@/components/lead-form/reducer'

type Section = { heading: string; body: string }

export function Landing(props: {
  vertical: Vertical
  slug: string
  title: string
  subtitle: string
  sections: Section[]
}) {
  return (
    <ThemeScope vertical={themeFor('/' + props.slug)}>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <PageViewTracker slug={props.slug} />
        <h1 className="text-3xl font-bold leading-snug">{props.title}</h1>
        <p className="mt-3 text-lg t-sub">{props.subtitle}</p>
        <div className="mt-6">
          <CtaGroup slug={props.slug} />
        </div>
        <div className="mt-10 space-y-8">
          {props.sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-xl font-semibold">{s.heading}</h2>
              <p className="mt-2 leading-relaxed t-ink">{s.body}</p>
            </section>
          ))}
        </div>
        <div className="mt-10">
          <LeadForm vertical={props.vertical} slug={props.slug} />
        </div>
        <StickyBar slug={props.slug} />
      </main>
    </ThemeScope>
  )
}
