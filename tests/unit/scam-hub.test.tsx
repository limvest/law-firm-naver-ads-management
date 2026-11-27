// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { createTestDb } from '../helpers/test-db'
import { keywords, scamPages } from '@/lib/db/schema'
import { listPublishedScamSlugs } from '@/lib/scam/list'
import { NodeCanvas } from '@/components/scenes/node-canvas'
import { buildSeedContent, SCAM_TYPE_SEEDS } from '@/lib/scam/seed-data'

describe('listPublishedScamSlugs', () => {
  it('published+lint 통과만, blocked 제외', async () => {
    const db = await createTestDb()
    const [a] = await db.insert(keywords).values({ name: '가 유형 사기', slug: 'a-type', scamType: 't' }).returning()
    const [b] = await db.insert(keywords).values({ name: '나 유형 사기', slug: 'b-type', scamType: 't', status: 'blocked' }).returning()
    await db.insert(scamPages).values([
      { keywordId: a.id, content: buildSeedContent(SCAM_TYPE_SEEDS[0]), lintPassed: true },
      { keywordId: b.id, content: buildSeedContent(SCAM_TYPE_SEEDS[0]), lintPassed: true },
    ])
    const list = await listPublishedScamSlugs(db as never)
    expect(list.map((x) => x.slug)).toEqual(['a-type'])
  })
})

describe('<NodeCanvas />', () => {
  it('캔버스를 렌더한다', () => {
    const { container } = render(<NodeCanvas />)
    expect(container.querySelector('canvas')).toBeTruthy()
  })
})
