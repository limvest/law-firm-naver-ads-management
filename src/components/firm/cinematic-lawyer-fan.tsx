'use client'

import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { FirmLawyer } from '@/lib/engine/firms'

const counselHighlights: Record<string, string> = {
  정오번: '대한변협 인증 형사전문 · 군검사 출신',
  강육번: '기업법무 · 조세 · 복잡한 거래구조 분석',
  조칠번: '금융결제원 · 카카오뱅크 법무 출신 · 금융거래 분석',
  윤팔번: '형사전문 · 피해 자료 정리 · 수사 절차 대응',
}

export function CinematicLawyerFan({ lawyers }: { lawyers: FirmLawyer[] }) {
  const visible = lawyers.slice(0, 4)
  const [active, setActive] = useState(0)
  if (!visible.length) return null

  return (
    <div className="cinematic-lawyer-stage">
      <div className="cinematic-lawyer-fan" role="list" aria-label="전담변호사">
        {visible.map((item, index) => (
          <button
            key={item.id ?? `${item.name}-${index}`}
            type="button"
            role="listitem"
            className={index === active ? 'is-active' : ''}
            style={{
              '--fan-index': index,
              '--fan-slot': visible.length - 1 - index,
              '--fan-z': visible.length - index,
            } as CSSProperties}
            aria-label={`${item.name} 상세정보 보기`}
            aria-pressed={index === active}
            onClick={() => setActive(index)}
          >
            {item.photo ? <img src={item.photo} alt="" /> : <span className="cinematic-lawyer-initial">{item.name.slice(0, 1)}</span>}
            <i>{String(index + 1).padStart(2, '0')} · {item.name.replace(/\s*변호사$/, '')}</i>
          </button>
        ))}
      </div>
      <div className="cinematic-lawyer-details" aria-live="polite">
        {visible.map((item, index) => (
          <article className={`cinematic-lawyer-detail${index === active ? ' is-active' : ''}`} key={item.id ?? `${item.name}-detail`}>
            <p>COUNSEL {String(index + 1).padStart(2, '0')}</p>
            <h3>{item.name}</h3>
            <strong>{item.title}</strong>
            <p className="cinematic-lawyer-highlight">{counselHighlights[item.name.replace(/\s*변호사$/, '')] ?? item.badges[0]}</p>
            {(item.practiceAreas?.length ?? 0) > 0 && <div className="cinematic-lawyer-detail-practices">{item.practiceAreas?.map((area) => <span key={area}>{area}</span>)}</div>}
            <div className="cinematic-lawyer-detail-body">
              {(item.career?.length ?? item.badges.length) > 0 && <section><h4>주요 경력</h4><ul>{(item.career?.length ? item.career : item.badges).map((career) => <li key={career}>{career}</li>)}</ul></section>}
              {(item.education?.length ?? 0) > 0 && <section><h4>학력</h4><ul>{item.education?.map((education) => <li key={education}>{education}</li>)}</ul></section>}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
