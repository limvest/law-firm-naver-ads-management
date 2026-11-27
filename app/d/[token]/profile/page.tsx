import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import { caseResultsForFirm } from '@/lib/dashboard/firm-profile'
import {
  addFirmCaseResult,
  addFirmLawyer,
  removeFirmCaseResult,
  removeFirmLawyer,
  saveFirmProfile,
  setFirmCaseResultPublished,
} from '@/lib/dashboard/actions'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '변호사·수행사례',
  robots: { index: false, follow: false },
}

export default async function FirmProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  if (!process.env.DATABASE_URL) return null
  const { token } = await params
  const query = await searchParams
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()
  const results = await caseResultsForFirm(db, firm.id)
  const previewQuery = `?preview=1&firm=${encodeURIComponent(firm.slug)}`

  return (
    <div className="space-y-10">
      <section>
        <p className="font-mono-label t-sub">PUBLIC TRUST CONTENT</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">변호사 정보와 수행내역을 실제 공개 사이트에 연결합니다</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 t-sub">
          여기서 저장한 내용은 이 사무소 도메인의 변호사 소개와 사건 수행내역 페이지에 표시됩니다.
          확인할 수 있는 사실만 입력하고 의뢰인 식별정보는 반드시 제거해 주세요.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/lawyers${previewQuery}`} target="_blank" className="rounded-lg border t-border px-4 py-2 text-xs font-semibold">변호사 페이지 보기 ↗</Link>
          <Link href={`/results${previewQuery}`} target="_blank" className="rounded-lg border t-border px-4 py-2 text-xs font-semibold">수행내역 페이지 보기 ↗</Link>
        </div>
      </section>

      {(query.saved || query.error) && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${query.error ? 'border-red-300 bg-red-50 text-red-700' : 't-border t-surface t-accent'}`}>
          {query.error ? '입력값을 확인해 주세요. 기존 정보는 변경되지 않았습니다.' : '저장되었습니다. 공개 페이지에 반영되었습니다.'}
        </div>
      )}

      <section className="rounded-2xl border t-border t-surface p-6 md:p-8">
        <p className="font-mono-label t-sub">OFFICE PROFILE</p>
        <h3 className="mt-2 text-xl font-bold">사무소 소개와 연혁</h3>
        <form action={saveFirmProfile.bind(null, token)} className="mt-6 grid gap-5">
          <Field label="사무소 소개" name="intro" textarea defaultValue={firm.profileIntro ?? ''} placeholder="사건을 어떤 원칙과 방식으로 검토하는지 설명해 주세요." />
          <Field label="사무소 연혁" name="history" textarea defaultValue={(firm.officeHistory ?? []).join('\n')} placeholder={'한 줄에 하나씩 입력\n예: 2024 금융사기 피해 대응팀 운영'} />
          <button className="w-fit rounded-xl t-cta-accent px-6 py-3 text-sm font-semibold">사무소 정보 저장</button>
        </form>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><p className="font-mono-label t-sub">LAWYERS</p><h3 className="mt-2 text-xl font-bold">등록된 변호사 {firm.lawyers?.length ?? 0}명</h3></div>
          <span className="text-xs t-sub">공개 페이지에 입력 순서대로 표시</span>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {(firm.lawyers ?? []).map((lawyer, index) => {
            const key = lawyer.id ?? String(index)
            return (
              <article key={key} className="rounded-2xl border t-border t-surface p-6">
                <div className="flex items-start justify-between gap-4">
                  <div><p className="text-xs font-semibold t-accent">{lawyer.title}</p><h4 className="mt-1 text-lg font-bold">{lawyer.name}</h4></div>
                  <form action={removeFirmLawyer.bind(null, token, key)}><button className="text-xs text-red-600">삭제</button></form>
                </div>
                {lawyer.bio && <p className="mt-4 text-sm leading-6 t-sub">{lawyer.bio}</p>}
                <InfoList label="주요 이력" items={lawyer.career} />
                <InfoList label="학력" items={lawyer.education} />
                <InfoList label="주요 업무" items={lawyer.practiceAreas} />
              </article>
            )
          })}
        </div>

        <form action={addFirmLawyer.bind(null, token)} className="mt-6 rounded-2xl border t-border p-6 md:p-8">
          <h4 className="text-lg font-bold">변호사 추가</h4>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label="이름" name="name" placeholder="김변호 변호사" />
            <Field label="직책" name="title" placeholder="대표변호사" />
            <Field label="사진 URL" name="photo" required={false} placeholder="/assets/lawyer-name.jpg 또는 https://…" />
            <Field label="배지·전문분야" name="badges" required={false} placeholder="쉼표 또는 줄바꿈으로 구분" />
            <div className="md:col-span-2"><Field label="소개" name="bio" textarea required={false} placeholder="담당 영역과 상담 원칙을 설명해 주세요." /></div>
            <Field label="주요 이력" name="career" textarea required={false} placeholder="한 줄에 하나씩 입력" />
            <Field label="학력" name="education" textarea required={false} placeholder="한 줄에 하나씩 입력" />
            <div className="md:col-span-2"><Field label="주요 업무" name="practiceAreas" required={false} placeholder="금융사기, 손해배상, 형사 고소" /></div>
          </div>
          <button className="mt-5 rounded-xl t-cta-accent px-6 py-3 text-sm font-semibold">변호사 추가</button>
        </form>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><p className="font-mono-label t-sub">CASE WORK</p><h3 className="mt-2 text-xl font-bold">사건 수행내역 {results.length}건</h3></div>
          <span className="text-xs t-sub">공개 상태인 항목만 피해자 사이트에 표시</span>
        </div>
        <div className="mt-5 space-y-3">
          {results.map((result) => (
            <article key={result.id} className="rounded-2xl border t-border t-surface p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><p className="text-xs font-semibold t-accent">{result.category} · {result.handledAt ?? '처리 시기 비공개'}</p><h4 className="mt-1 text-lg font-bold">{result.title}</h4></div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${result.published ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{result.published ? '공개 중' : '비공개'}</span>
              </div>
              <p className="mt-4 text-sm leading-6 t-sub">{result.summary}</p>
              <p className="mt-3 text-sm font-semibold">조치·결과 · {result.outcome}</p>
              <div className="mt-5 flex gap-3">
                <form action={setFirmCaseResultPublished.bind(null, token, result.id)}><input type="hidden" name="published" value={result.published ? 'false' : 'true'} /><button className="rounded-lg border t-border px-3 py-2 text-xs font-semibold">{result.published ? '공개 내리기' : '공개하기'}</button></form>
                <form action={removeFirmCaseResult.bind(null, token, result.id)}><button className="px-3 py-2 text-xs text-red-600">삭제</button></form>
              </div>
            </article>
          ))}
        </div>

        <form action={addFirmCaseResult.bind(null, token)} className="mt-6 rounded-2xl border t-border p-6 md:p-8">
          <h4 className="text-lg font-bold">수행내역 추가</h4>
          <p className="mt-2 text-xs leading-5 t-sub">개인정보·사건번호를 제거하고, 확인 가능한 조치와 결과만 작성해 주세요. 동일한 결과를 보장한다는 표현은 사용할 수 없습니다.</p>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label="사건 유형" name="category" placeholder="투자리딩방 사기" />
            <Field label="처리 시기" name="handledAt" required={false} placeholder="2026.08" />
            <div className="md:col-span-2"><Field label="제목" name="title" placeholder="추가입금 요구 단계에서 증거보전 및 대응 절차 검토" /></div>
            <Field label="사건 개요" name="summary" textarea placeholder="익명화한 사실관계와 의뢰 당시 상황" />
            <Field label="조치·결과" name="outcome" textarea placeholder="실제로 진행한 조치와 확인된 결과" />
          </div>
          <label className="mt-4 flex items-start gap-2 text-xs t-sub"><input type="checkbox" name="published" className="mt-0.5" /><span>저장과 동시에 공개합니다. 내용 검수가 필요하면 체크하지 마세요.</span></label>
          <button className="mt-5 rounded-xl t-cta-accent px-6 py-3 text-sm font-semibold">수행내역 저장</button>
        </form>
      </section>
    </div>
  )
}

function Field({ label, name, placeholder, defaultValue, textarea = false, required = true }: { label: string; name: string; placeholder: string; defaultValue?: string; textarea?: boolean; required?: boolean }) {
  const cls = 'w-full rounded-xl border t-border bg-transparent px-4 py-3 text-sm outline-none focus:[border-color:var(--t-accent)]'
  return <label><span className="mb-2 block text-xs font-semibold t-sub">{label}</span>{textarea ? <textarea name={name} required={required} defaultValue={defaultValue} placeholder={placeholder} rows={4} className={cls} /> : <input name={name} required={required} defaultValue={defaultValue} placeholder={placeholder} className={cls} />}</label>
}

function InfoList({ label, items }: { label: string; items?: string[] }) {
  if (!items?.length) return null
  return <div className="mt-4"><p className="text-[10px] font-bold tracking-[.08em] t-sub">{label}</p><ul className="mt-2 space-y-1 text-xs leading-5 t-sub">{items.map((item) => <li key={item}>· {item}</li>)}</ul></div>
}
