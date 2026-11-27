import { describe, it, expect } from 'vitest'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { scamMetadata } from '@/lib/scam/metadata'
import { productRootMetadata as home } from '../../app/layout'
import { metadata as about } from '../../app/about/page'
import { metadata as membersMeta } from '../../app/members/page'
import { metadata as criminal } from '../../app/criminal/page'
import { metadata as rehab } from '../../app/rehab/page'
import { metadata as bankruptcy } from '../../app/bankruptcy/page'
import { metadata as scamHub } from '../../app/scam/page'
import { metadata as privacy } from '../../app/privacy/page'
import { SCAM_TYPE_SEEDS } from '@/lib/scam/seed-data'

function textOf(m: { title?: unknown; description?: unknown }): string {
  const t = typeof m.title === 'string' ? m.title : JSON.stringify(m.title ?? '')
  return `${t} ${m.description ?? ''}`
}

describe('metadata 금지어 (규정 §14 — SERP 노출면)', () => {
  const metas = { home, about, membersMeta, criminal, rehab, bankruptcy, scamHub, privacy }
  for (const [name, m] of Object.entries(metas)) {
    it(`${name}: 금지어 0`, () => {
      expect(findBannedTerms(textOf(m as never))).toEqual([])
    })
  }
  it('프로그래매틱 metadata: 시드 20종 전부 금지어 0', () => {
    for (const s of SCAM_TYPE_SEEDS) {
      const m = scamMetadata(s.name)
      expect(findBannedTerms(m.title + ' ' + m.description)).toEqual([])
    }
  })
})
