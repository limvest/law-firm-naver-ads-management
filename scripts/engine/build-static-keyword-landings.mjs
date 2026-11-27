import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import http from 'node:http'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { cloneLandingHosts, storeLandingFile } from './static-landing-storage.mjs'

const require = createRequire(process.env.STATIC_LANDING_PACKAGE_JSON ?? '/app/package.json')
const { Pool } = require('pg')
const gzipAsync = promisify(gzip)

const root = process.env.STATIC_LANDING_OUTPUT_ROOT ?? '/app/data/static-landings'
const source = process.env.STATIC_LANDING_SOURCE_URL ?? 'http://web:3000/'
const concurrency = Math.max(1, Math.min(150, Number(process.env.STATIC_LANDING_CONCURRENCY ?? 75)))
const requestedLimit = Number(process.env.STATIC_LANDING_LIMIT ?? 0)
const requestedLabels = [...new Set((process.env.STATIC_LANDING_LABELS ?? '').split(',').map((value) => value.trim()).filter(Boolean))]
const publish = process.env.STATIC_LANDING_PUBLISH !== '0'
const retainVersions = Math.max(1, Math.min(10, Number(process.env.STATIC_LANDING_RETAIN_VERSIONS ?? 2)))
const version = process.env.STATIC_LANDING_VERSION
  ?? `landing-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`
const stage = `${root}/.build-${version}-${process.pid}`
const finalDir = `${root}/${version}`

const TRACKING_BOOTSTRAP = `<script id="static-attribution-v1">(()=>{try{const d=document.cookie,s=new URLSearchParams(location.search),u={};for(const[k,v]of s){if((k.startsWith('utm_')||k.startsWith('n_'))&&v)u[k]=v.slice(0,200)}const set=(k,v,a)=>{document.cookie=k+'='+encodeURIComponent(v)+'; Max-Age='+a+'; Path=/; SameSite=Lax; Secure'};if(!/(?:^|;\\s*)sid=/.test(d))set('sid',crypto.randomUUID(),31536000);if(Object.keys(u).length){const j=JSON.stringify(u);if(!/(?:^|;\\s*)ft=/.test(d))set('ft',j,2592000);set('lt',j,2592000)}}catch(_){}})();</script>`

function injectStaticBootstrap(html) {
  const marker = '<!-- static-landing:v1 -->'
  if (!html.includes('</head>')) throw new Error('HTML has no closing head')
  return html.replace('</head>', `${TRACKING_BOOTSTRAP}${marker}</head>`)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char])
}

function injectOperatorContext(html, content) {
  const sections = Array.isArray(content?.sections) ? content.sections : []
  const presentations = [
    {
      section: sections.find((item) => item?.heading === '다단계 사기 피해 대응 확인'),
      id: 'multilevel-fraud',
      label: 'MULTI-LEVEL FRAUD RESPONSE',
      heroLabel: '다단계사기',
    },
    {
      section: sections.find((item) => typeof item?.heading === 'string' && item.heading.includes('해외선물') && item.heading.includes('피해')),
      id: 'overseas-futures-fraud',
      label: 'OVERSEAS FUTURES FRAUD RESPONSE',
      heroLabel: '해외선물사기',
    },
  ]
  const presentation = presentations.find((item) => item.section)
  if (!presentation) return html
  const block = `<section class="section static-operator-context" id="${presentation.id}"><div class="wrap"><div style="padding:34px;border-left:5px solid #b3272d;background:#fff4f4"><p style="margin:0 0 9px;color:#b3272d;font-size:12px;font-weight:900;letter-spacing:.08em">${presentation.label}</p><h2 style="margin:0 0 18px;font-size:clamp(28px,4vw,48px)">${escapeHtml(presentation.section.heading)}</h2><p style="margin:0;white-space:pre-line;line-height:1.9;color:#4d596b">${escapeHtml(presentation.section.body)}</p></div></div></section>`
  const presented = html.replace('<em class="fraud-mark">사칭(사기)</em>', `<em class="fraud-mark">${presentation.heroLabel}</em>`)
  return presented.includes('</main>') ? presented.replace('</main>', `${block}</main>`) : presented
}

async function prunePublishedVersions() {
  const current = await readlink(`${root}/current`)
  const entries = await readdir(root, { withFileTypes: true })
  const versions = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^landing-[A-Za-z0-9._-]+$/.test(entry.name))
    .map(async (entry) => ({ name: entry.name, mtimeMs: (await stat(`${root}/${entry.name}`)).mtimeMs })))
  versions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const keep = new Set([current, ...versions.slice(0, retainVersions).map((entry) => entry.name)])
  const removed = []
  for (const entry of versions) {
    if (keep.has(entry.name)) continue
    await rm(`${root}/${entry.name}`, { recursive: true, force: true })
    removed.push(entry.name)
  }
  if (removed.length) console.log(JSON.stringify({ event: 'pruned', removed, retained: [...keep] }))
}

async function fetchHtml(label, content) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const target = new URL(source)
      const { status, html } = await new Promise((resolve, reject) => {
        const request = http.request({
          hostname: target.hostname,
          port: target.port || 80,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { Host: `${label}.sampleone.attorney`, 'X-Forwarded-Proto': 'https', 'User-Agent': 'LawfirmStaticLandingBuilder/1.0' },
        }, (response) => {
          const chunks = []
          let size = 0
          response.on('data', (chunk) => {
            size += chunk.length
            if (size > 5_000_000) request.destroy(new Error('HTML exceeds 5 MB'))
            else chunks.push(chunk)
          })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, html: Buffer.concat(chunks).toString('utf8') }))
        })
        request.setTimeout(60_000, () => request.destroy(new Error('source timeout')))
        request.on('error', reject)
        request.end()
      })
      if (status !== 200) throw new Error(`HTTP ${status}`)
      for (const marker of ['<title>', '<h1', '<form']) {
        if (!html.toLowerCase().includes(marker)) throw new Error(`missing ${marker}`)
      }
      if (!html.includes(`https://${label}.sampleone.attorney/`)) throw new Error('canonical host mismatch')
      return injectStaticBootstrap(injectOperatorContext(html, content))
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  let baseManifest = null
  let previousRoot = null
  try { previousRoot = `${root}/${await readlink(`${root}/current`)}` } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(`${stage}/hosts`, { recursive: true })
  if (requestedLabels.length) {
    for (const label of requestedLabels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) throw new Error(`unsafe requested label ${label}`)
    if (!previousRoot) throw new Error('partial publication requires a current version')
    baseManifest = JSON.parse(await readFile(`${previousRoot}/manifest.json`, 'utf8'))
    await cloneLandingHosts(`${previousRoot}/hosts`, `${stage}/hosts`)
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  let rows
  try {
    const result = await pool.query(`select fk.public_host_label as label,
        k.id::text as keyword_id, k.slug, k.name, sp.content,
        greatest(fk.updated_at, k.created_at, coalesce(sp.published_at, k.created_at)) as source_updated_at
      from firm_keywords fk
      join firms f on f.id=fk.firm_id
      join keywords k on k.id=fk.keyword_id
      left join scam_pages sp on sp.keyword_id=k.id and sp.lint_passed=true
      where fk.host_status='public'
        and fk.public_host_label is not null
        and f.status='active' and f.landing_ready=true
        and f.domain='sampleone.attorney'
        and k.status = any($1::text[])
        ${requestedLabels.length ? 'and fk.public_host_label = any($2::text[])' : ''}
      order by fk.public_host_label`, requestedLabels.length ? [[
        'verified', 'generated', 'published', 'ad_registered', 'live', 'discovered',
      ], requestedLabels] : [[
        'verified', 'generated', 'published', 'ad_registered', 'live', 'discovered',
      ]])
    rows = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? result.rows.slice(0, requestedLimit)
      : result.rows
  } finally {
    await pool.end()
  }
  if (!rows.length) throw new Error('no public keyword hosts found')

  let cursor = 0
  let completed = 0
  let plainBytes = 0
  let gzipBytes = 0
  let unchangedFiles = 0
  const manifestRows = new Array(rows.length)
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= rows.length) return
      const row = rows[index]
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(row.label)) throw new Error(`unsafe label ${row.label}`)
      const html = await fetchHtml(row.label, row.content)
      const body = Buffer.from(html)
      const compressed = await gzipAsync(body, { level: 6 })
      const unchanged = await Promise.all([
        storeLandingFile(previousRoot && `${previousRoot}/hosts/${row.label}.html`, `${stage}/hosts/${row.label}.html`, body),
        storeLandingFile(previousRoot && `${previousRoot}/hosts/${row.label}.html.gz`, `${stage}/hosts/${row.label}.html.gz`, compressed),
      ])
      unchangedFiles += unchanged.filter(Boolean).length
      plainBytes += body.length
      gzipBytes += compressed.length
      manifestRows[index] = {
        host: `${row.label}.sampleone.attorney`,
        keywordId: row.keyword_id,
        slug: row.slug,
        name: row.name,
        sourceUpdatedAt: row.source_updated_at,
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: body.length,
        gzipBytes: compressed.length,
      }
      completed += 1
      if (completed % 250 === 0 || completed === rows.length) {
        console.log(JSON.stringify({ event: 'progress', completed, total: rows.length }))
      }
    }
  })

  try {
    await Promise.all(workers)
    const mergedPages = baseManifest
      ? [...baseManifest.pages.filter((page) => !requestedLabels.includes(page.host.replace(/\.sampleone\.attorney$/, ''))), ...manifestRows].sort((a,b)=>a.host.localeCompare(b.host))
      : manifestRows
    if (baseManifest) {
      plainBytes = mergedPages.reduce((sum,page)=>sum+Number(page.bytes||0),0)
      gzipBytes = mergedPages.reduce((sum,page)=>sum+Number(page.gzipBytes||0),0)
    }
    const manifest = {
      schemaVersion: 1,
      version,
      generatedAt: new Date().toISOString(),
      source,
      count: mergedPages.length,
      plainBytes,
      gzipBytes,
      pages: mergedPages,
    }
    await writeFile(`${stage}/manifest.json`, `${JSON.stringify(manifest)}\n`, { mode: 0o644 })
    await rename(stage, finalDir)
    if (publish) {
      const nextLink = `${root}/.current-${process.pid}`
      await rm(nextLink, { force: true })
      await symlink(version, nextLink)
      await rename(nextLink, `${root}/current`)
      try {
        await prunePublishedVersions()
      } catch (error) {
        console.warn('static landing retention cleanup failed:', error)
      }
    }
    console.log(JSON.stringify({ event: publish ? 'published' : 'built', version, count: mergedPages.length, rebuilt: rows.length, unchangedFiles, plainBytes, gzipBytes }))
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
