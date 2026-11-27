import { and, asc, eq, exists, ne, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { firmKeywords, firms, keywords, observations } from '@/lib/db/schema'
import { keywordHostLabel } from '@/lib/engine/keyword-host'

async function main() {
  const firmSlug = process.argv[process.argv.indexOf('--firm') + 1] || 'sampleone'
  const db = getDb()
  const [firm] = await db.select().from(firms).where(eq(firms.slug, firmSlug)).limit(1)
  if (!firm?.domain) throw new Error(`firm not found or domain missing: ${firmSlug}`)

  const tracked = await db.select({ id: keywords.id, slug: keywords.slug })
    .from(keywords)
    .where(and(
      ne(keywords.status, 'blocked'),
      exists(db.select({ one: sql`1` }).from(observations).where(eq(observations.keywordId, keywords.id))),
    )).orderBy(asc(keywords.id))

  let published = 0
  for (let offset = 0; offset < tracked.length; offset += 500) {
    const batch = tracked.slice(offset, offset + 500)
    await db.insert(firmKeywords).values(batch.map((keyword) => ({
      firmId: firm.id,
      keywordId: keyword.id,
      adDesired: false,
      publicHostLabel: keywordHostLabel({ firmId: firm.id, keywordId: keyword.id, slug: keyword.slug }),
      hostStatus: 'public',
      hostKeyVersion: 1,
      hostPublishedAt: new Date(),
    }))).onConflictDoUpdate({
      target: [firmKeywords.firmId, firmKeywords.keywordId],
      set: {
        publicHostLabel: sql`coalesce(${firmKeywords.publicHostLabel}, excluded.public_host_label)`,
        hostStatus: 'public',
        hostPublishedAt: sql`coalesce(${firmKeywords.hostPublishedAt}, now())`,
        updatedAt: new Date(),
      },
    })
    published += batch.length
    console.log(`keyword-hosts: ${published}/${tracked.length}`)
  }
  console.log(JSON.stringify({ firm: firm.slug, domain: firm.domain, published }))
}

main().catch((error) => { console.error('publish-keyword-hosts failed:', error); process.exitCode = 1 })
