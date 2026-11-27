import { getDb } from '../src/lib/db/client'
import * as schema from '../src/lib/db/schema'
import { SCAM_TYPE_SEEDS, buildSeedContent } from '../src/lib/scam/seed-data'
import { findBannedTerms } from '../src/lib/compliance/lexicon'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL required')
  const db = getDb()

  for (const seed of SCAM_TYPE_SEEDS) {
    const content = buildSeedContent(seed)
    const text = [seed.name, content.intro, ...content.sections.flatMap((s) => [s.heading, s.body])].join(' ')
    const banned = findBannedTerms(text)
    if (banned.length) {
      console.error(`SKIP ${seed.slug}: 금지어 검출 ${banned.join(',')}`)
      continue
    }
    const inserted = await db
      .insert(schema.keywords)
      .values({ name: seed.name, slug: seed.slug, scamType: seed.scamType })
      .onConflictDoNothing({ target: schema.keywords.slug })
      .returning()
    if (!inserted.length) {
      console.log(`skip (exists): ${seed.slug}`)
      continue
    }
    await db.insert(schema.scamPages).values({ keywordId: inserted[0].id, content, lintPassed: true })
    console.log(`seeded: ${seed.slug}`)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
