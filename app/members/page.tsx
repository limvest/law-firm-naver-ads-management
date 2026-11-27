import type { Metadata } from 'next'
import { ThemeScope } from '@/components/theme-scope'
import { PageViewTracker } from '@/components/page-view-tracker'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '구성원 소개',
  description: '담당 변호사의 주요 업무와 검증된 이력을 소개합니다.',
}

export function MembersContent({ firm = DEFAULT_FIRM }: { firm?: typeof DEFAULT_FIRM }) {
  return (
    <ThemeScope vertical="firm">
      <PageViewTracker slug="members" />
      <main className="mx-auto max-w-5xl px-5 py-16 md:px-10">
        <p className="font-mono-label t-accent">LAWYERS · {firm.name}</p>
        <h1 className="mt-3 text-4xl font-extrabold">담당 변호사</h1>
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {(firm.lawyers ?? []).map((lawyer, index) => (
            <article key={lawyer.id ?? `${lawyer.name}-${index}`} className="rounded-2xl border t-border t-surface p-6">
              <div className="flex items-start gap-5">
                {lawyer.photo ? <img src={lawyer.photo} alt={lawyer.name} className="h-28 w-24 rounded-xl object-cover object-top" /> : <div className="flex h-28 w-24 items-center justify-center rounded-xl border t-border text-2xl font-black t-accent">{lawyer.name.slice(0, 1)}</div>}
                <div><p className="text-sm font-semibold t-accent">{lawyer.title}</p><h2 className="mt-1 text-xl font-bold">{lawyer.name}</h2>{lawyer.bio && <p className="mt-3 text-sm leading-6 t-sub">{lawyer.bio}</p>}</div>
              </div>
              {lawyer.career?.length ? <ul className="mt-5 space-y-2 border-t pt-5 text-sm t-sub" style={{ borderColor: 'var(--t-line)' }}>{lawyer.career.map((item) => <li key={item}>· {item}</li>)}</ul> : null}
            </article>
          ))}
        </div>
      </main>
    </ThemeScope>
  )
}


export default async function MembersPage() {
  const firm = await currentRequestFirm() ?? DEFAULT_FIRM
  return <MembersContent firm={firm} />
}
