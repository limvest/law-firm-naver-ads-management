import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { getDb } from '@/lib/db/client'
import {
  caseEntities,
  contentAssets,
  publications,
} from '@/lib/db/schema'
import {
  normalizeHost,
  resolveFirmByExactHost,
  type Firm,
} from '@/lib/engine/firms'
import { leadRouteForFirm } from '@/lib/engine/public-firm'

export type TargetPublicationAssetType = 'seo_page' | 'ad_landing'

type JsonObject = Record<string, unknown>
type PublicationRow = typeof publications.$inferSelect
type ContentAssetRow = typeof contentAssets.$inferSelect
type CaseEntityRow = typeof caseEntities.$inferSelect

type TargetPublicationRow = {
  publication: PublicationRow
  asset: ContentAssetRow
  caseEntity: CaseEntityRow
}

type ContentQualityReport = {
  evidenceReady: boolean
  placeholderFree: boolean
  linksReady: boolean
  brandReady: boolean
  complianceReady: boolean
  issues: string[]
}

type RenderedContent = {
  title: string
  description: string
  body: string
  ctaLabel: string | null
}

const VARY_HEADERS = { Vary: 'Host' } as const
const ROBOTS = 'noindex, nofollow'
const SEO_PUBLIC_STATUSES = new Set(['published', 'indexed'])
const SEO_PREVIEW_STATUSES = new Set(['approved', 'published', 'indexed', 'stale', 'refreshed'])
const AD_PUBLIC_STATUSES = new Set(['published', 'experiment_live', 'winner'])
const AD_PREVIEW_STATUSES = new Set(['approved', 'published', 'experiment_live', 'winner'])

/** Values from the content generator that indicate unfinished or template copy. */
const PLACEHOLDER_TOKEN = /(?:\{\{|\}\}|<%|%>|\[\[|\]\]|\b(?:TODO|TBD|PLACEHOLDER)\b)/i

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const valueTrimmed = value.trim()
  if (!valueTrimmed || PLACEHOLDER_TOKEN.test(valueTrimmed)) return null
  return valueTrimmed
}

function textField(object: JsonObject, key: string): string | null {
  return textValue(object[key])
}

function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => textValue(item))
    .filter((item): item is string => item !== null)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeExternalHref(value: unknown): string | null {
  const text = textValue(value)
  if (!text) return null
  try {
    const url = new URL(text)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hash) return null
    return url.toString()
  } catch {
    return null
  }
}

function phoneHref(phone: string): string | null {
  const normalized = phone.replace(/[^+\d]/g, '')
  return normalized.length >= 7 ? `tel:${normalized}` : null
}

type ConsultationConfig = {
  slug: string
  firmId: number
  assetType: TargetPublicationAssetType
  routeToken?: string
}

/** Escape JSON before placing it in a script element, including </script> breakers. */
function safeScriptJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function consultationScript(config: ConsultationConfig): string {
  const serialized = safeScriptJson(config)
  return `<script>(function(){'use strict';const config=${serialized};const eventTypes=['page_view','call_click','kakao_click','form_submit'];const jsonRequest=(path,payload)=>window.fetch(path,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',keepalive:true,body:JSON.stringify(payload)});const emit=(type)=>{if(!eventTypes.includes(type))return Promise.resolve();const payload={type,slug:config.slug,firmId:config.firmId,variant:config.assetType};if(config.routeToken)payload.routeToken=config.routeToken;try{return jsonRequest('/api/events',payload).catch(function(){if(navigator.sendBeacon)navigator.sendBeacon('/api/events',JSON.stringify(payload));})}catch(_error){if(navigator.sendBeacon)navigator.sendBeacon('/api/events',JSON.stringify(payload));return Promise.resolve();}};const form=document.querySelector('[data-consultation-form]');const status=form&&form.querySelector('[data-form-status]');const success=form&&form.querySelector('[data-form-success]');const button=form&&form.querySelector('button[type="submit"]');const setStatus=function(message,isError){if(!status)return;status.textContent=message;status.setAttribute('data-state',isError?'error':'info');};document.querySelectorAll('[data-track]').forEach(function(link){link.addEventListener('click',function(){const type=link.getAttribute('data-track');if(type)void emit(type);});});if(form){form.addEventListener('submit',function(event){event.preventDefault();if(!form.checkValidity()){form.reportValidity();setStatus('연락처와 개인정보 수집·이용 동의를 확인해 주세요.',true);return;}if(button)button.disabled=true;setStatus('접수 중입니다.',false);const values=new FormData(form);const payload={vertical:'scam',phone:String(values.get('phone')||'').trim(),detail:String(values.get('detail')||'').trim()||undefined,website:String(values.get('website')||'').trim()||undefined,slug:config.slug,firmId:config.firmId,consent:true};const name=String(values.get('name')||'').trim();if(name)payload.name=name;if(config.routeToken)payload.routeToken=config.routeToken;jsonRequest('/api/leads',payload).then(function(response){return response.json().catch(function(){return null;}).then(function(body){if(!response.ok||!body||body.ok!==true)throw new Error('lead_failed');});}).then(function(){form.hidden=true;if(success)success.hidden=false;setStatus('상담 신청이 접수되었습니다.',false);void emit('form_submit');}).catch(function(){if(button)button.disabled=false;setStatus('접수하지 못했습니다. 아래 전화번호로 문의해 주세요.',true);});});}void emit('page_view');})();</script>`
}

function qualityPassed(value: unknown): value is ContentQualityReport {
  if (!isObject(value)) return false
  return value.evidenceReady === true
    && value.placeholderFree === true
    && value.linksReady === true
    && value.brandReady === true
    && value.complianceReady === true
    && Array.isArray(value.issues)
    && value.issues.length === 0
}

function expectedCanonical(firm: Firm, assetType: TargetPublicationAssetType, slug: string): string | null {
  const domain = normalizeHost(firm.domain)
  if (!domain) return null
  const path = assetType === 'seo_page' ? 'case' : 'response'
  return `https://${domain}/${path}/${encodeURIComponent(slug)}`
}

function sameCanonical(actual: string, expected: string): boolean {
  try {
    const actualUrl = new URL(actual)
    const expectedUrl = new URL(expected)
    return actualUrl.protocol === 'https:'
      && actualUrl.username === ''
      && actualUrl.password === ''
      && actualUrl.hostname === expectedUrl.hostname
      && actualUrl.port === expectedUrl.port
      && actualUrl.pathname === expectedUrl.pathname
      && actualUrl.search === ''
      && actualUrl.hash === ''
  } catch {
    return false
  }
}

function latestTargetRowIsUsable(
  row: TargetPublicationRow,
  firm: Firm,
  assetType: TargetPublicationAssetType,
  slug: string,
  preview: boolean,
): boolean {
  const { publication, asset, caseEntity } = row
  const canonical = expectedCanonical(firm, assetType, slug)
  if (!canonical) return false

  if (caseEntity.status !== 'approved') return false
  if (asset.assetType !== assetType || asset.firmId !== firm.id) return false
  if (publication.firmId !== firm.id || publication.contentAssetId !== asset.id) return false
  if (!qualityPassed(asset.qualityReport)) return false

  const validAssetStatuses = assetType === 'seo_page'
    ? (preview ? SEO_PREVIEW_STATUSES : SEO_PUBLIC_STATUSES)
    : (preview ? AD_PREVIEW_STATUSES : AD_PUBLIC_STATUSES)
  if (!validAssetStatuses.has(asset.status)) return false

  if (publication.status === 'blocked' || publication.status === 'failed') return false
  if (preview) {
    if (!new Set(['pending', 'live', 'stale']).has(publication.status)) return false
  } else if (publication.status !== 'live') {
    return false
  }

  if (assetType === 'ad_landing' && publication.indexPolicy !== 'noindex') return false
  if (assetType === 'seo_page' && !['index', 'noindex'].includes(publication.indexPolicy)) return false

  const deployedVersion = publication.deployedVersion?.trim()
  if (!preview && (!deployedVersion || deployedVersion !== String(asset.contentVersion))) return false
  if (preview && deployedVersion && deployedVersion !== String(asset.contentVersion)) return false

  const publicationDomain = normalizeHost(publication.domain)
  const firmDomain = normalizeHost(firm.domain)
  if (!publicationDomain || !firmDomain || publicationDomain !== firmDomain) return false
  if (!sameCanonical(publication.url, canonical)) return false
  if (!sameCanonical(publication.canonicalUrl, canonical)) return false

  return true
}

function renderList(items: string[]): string {
  if (!items.length) return ''
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
}

function renderEvidence(value: unknown): string {
  if (!isObject(value)) return ''
  const methods = stringItems(value.methods)
  const amounts = stringItems(value.amounts)
  const infrastructure = Array.isArray(value.infrastructure)
    ? value.infrastructure
      .map((item) => {
        if (!isObject(item)) return null
        const type = textField(item, 'type')
        const itemValue = textField(item, 'value')
        return type && itemValue ? `${type}: ${itemValue}` : null
      })
      .filter((item): item is string => item !== null)
    : []
  const blocks = [
    methods.length ? `<div><h3>확인된 접근 방식</h3>${renderList(methods)}</div>` : '',
    infrastructure.length ? `<div><h3>관측된 수단</h3>${renderList(infrastructure)}</div>` : '',
    amounts.length ? `<div><h3>기록에 나타난 금액</h3>${renderList(amounts)}</div>` : '',
  ].filter(Boolean)
  return blocks.length ? `<section class="facts"><h2>저장된 공개 관측</h2><div class="fact-grid">${blocks.join('')}</div></section>` : ''
}

function renderSections(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const sections = value
    .map((item) => {
      if (!isObject(item)) return ''
      const heading = textField(item, 'heading')
      if (!heading) return ''
      const body = textField(item, 'body')
      return `<section class="section"><h2>${escapeHtml(heading)}</h2>${body ? `<p>${escapeHtml(body)}</p>` : ''}</section>`
    })
    .filter(Boolean)
  return sections.join('')
}

function contentFor(
  asset: ContentAssetRow,
  caseEntity: CaseEntityRow,
  firm: Firm,
  assetType: TargetPublicationAssetType,
): RenderedContent | null {
  if (!isObject(asset.content)) return null
  const content = asset.content
  const declaredType = textField(content, 'assetType')
  if (declaredType && declaredType !== assetType) return null

  const contentCaseName = textField(content, 'caseName')
  if (contentCaseName && contentCaseName !== caseEntity.canonicalName) return null
  const structuredFirm = isObject(content.firm) ? textField(content.firm, 'name') : null
  if (structuredFirm && structuredFirm !== firm.name) return null

  if (assetType === 'seo_page') {
    const title = textField(content, 'title')
    const description = textField(content, 'description')
    if (!title || !description) return null
    const disclaimer = textField(content, 'disclaimer')
    const cta = isObject(content.cta) ? content.cta : null
    return {
      title,
      description,
      body: `${renderSections(content.sections)}${renderEvidence(content.evidence)}${disclaimer ? `<p class="disclaimer">${escapeHtml(disclaimer)}</p>` : ''}`,
      ctaLabel: cta ? (textField(cta, 'label') ?? textField(cta, 'primary')) : null,
    }
  }

  const headline = textField(content, 'headline')
  const subheadline = textField(content, 'subheadline')
  if (!headline || !subheadline) return null
  const eyebrow = textField(content, 'eyebrow')
  const cta = isObject(content.cta) ? content.cta : null
  const ctaLabel = cta ? (textField(cta, 'primary') ?? textField(cta, 'label')) : null
  return {
    title: textField(content, 'title') ?? headline,
    description: subheadline,
    body: `${eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : ''}<h1>${escapeHtml(headline)}</h1><p class="lead">${escapeHtml(subheadline)}</p><div class="actions">${renderCta(firm, ctaLabel)}</div>`,
    ctaLabel,
  }
}

function renderCta(firm: Firm, label: string | null): string {
  const phone = phoneHref(firm.phone)
  if (!phone) return ''
  const links = [`<a class="button" data-track="call_click" href="${escapeHtml(phone)}">${escapeHtml(label ?? '상담 요청')}</a>`]
  const kakao = safeExternalHref(firm.kakaoUrl)
  if (kakao) links.push(`<a class="button secondary" data-track="kakao_click" href="${escapeHtml(kakao)}" rel="noopener noreferrer">카카오 상담</a>`)
  return links.join('')
}

function renderConsultationForm(firm: Firm, slug: string, assetType: TargetPublicationAssetType): string {
  const phone = phoneHref(firm.phone)
  if (!phone) return ''
  const route = leadRouteForFirm(firm)
  const config: ConsultationConfig = {
    slug,
    firmId: firm.id,
    assetType,
    ...(route?.routeToken ? { routeToken: route.routeToken } : {}),
  }
  const routeToken = route?.routeToken
    ? `<input type="hidden" name="routeToken" value="${escapeHtml(route.routeToken)}">`
    : ''
  const kakao = safeExternalHref(firm.kakaoUrl)
  return `<section class="contact" id="consultation"><h2>현재 상황을 상담으로 확인</h2><p>${escapeHtml(firm.name)} · 광고책임변호사 ${escapeHtml(firm.adLawyerName)}</p><p>${escapeHtml(firm.address)}</p><div class="actions"><a class="button" data-track="call_click" href="${escapeHtml(phone)}">전화 상담 ${escapeHtml(firm.phone)}</a>${kakao ? `<a class="button secondary" data-track="kakao_click" href="${escapeHtml(kakao)}" rel="noopener noreferrer">카카오 상담</a>` : ''}</div><form action="/api/leads" method="post" data-consultation-form><input type="hidden" name="vertical" value="scam"><input type="hidden" name="slug" value="${escapeHtml(slug)}"><input type="hidden" name="firmId" value="${String(firm.id)}">${routeToken}<label>이름 <input name="name" type="text" maxlength="50" autocomplete="name"></label><label>연락처 <input name="phone" type="tel" inputmode="tel" maxlength="20" pattern="0[0-9]{1,2}-?[0-9]{3,4}-?[0-9]{4}" autocomplete="tel" required></label><label>상담 내용 <textarea name="detail" maxlength="2000" rows="4"></textarea></label><label class="consent"><input name="consent" type="checkbox" value="true" required> 개인정보 수집·이용에 동의합니다. <a href="/privacy">개인정보처리방침</a></label><label class="honeypot" aria-hidden="true">웹사이트 <input name="website" type="text" tabindex="-1" autocomplete="off"></label><p data-form-status role="status" aria-live="polite"></p><p data-form-success hidden role="status" aria-live="polite">상담 신청이 접수되었습니다. 확인 후 연락드리겠습니다.</p><button type="submit">상담 신청</button></form><noscript><p>자바스크립트를 사용할 수 없어 전화 상담으로 연결합니다. <a href="${escapeHtml(phone)}">${escapeHtml(firm.phone)}로 전화</a></p></noscript></section>${consultationScript(config)}`
}

function pageStyles(): string {
  return 'body{margin:0;background:#f7f8fa;color:#172235;font-family:system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;line-height:1.7}main,header,footer{width:min(920px,calc(100% - 32px));margin:auto}.top{padding:28px 0;border-bottom:1px solid #d9dee7}.brand{font-weight:800}.hero{padding:72px 0 48px}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.1em;color:#315f93}.lead{font-size:19px;color:#536176}.section,.facts,.contact{padding:28px 0;border-top:1px solid #d9dee7}.fact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:18px}.facts ul{padding-left:20px}.disclaimer{color:#667085;font-size:13px}.contact{margin:36px 0 72px}.actions{display:flex;flex-wrap:wrap;gap:10px}.button{display:inline-flex;padding:11px 16px;border-radius:8px;background:#153f73;color:#fff;text-decoration:none;font-weight:700}.button.secondary{background:#edf1f5;color:#172235}.contact form{display:grid;gap:12px;margin-top:24px}.contact label{display:grid;gap:4px;font-weight:700}.contact input,.contact textarea{box-sizing:border-box;width:100%;border:1px solid #c7ced9;border-radius:6px;padding:10px;font:inherit;font-weight:400}.contact .consent{display:flex;align-items:flex-start;gap:8px;font-size:13px;font-weight:400}.contact .consent input{width:auto;margin-top:5px}.contact .honeypot{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.contact button{width:max-content;border:0;border-radius:8px;padding:11px 16px;background:#153f73;color:#fff;font:inherit;font-weight:700}.contact button:disabled{opacity:.6}.contact [data-form-status][data-state="error"]{color:#b42318}.contact [data-form-status][data-state="info"]{color:#315f93}footer{padding:0 0 48px;color:#667085;font-size:13px}'
}

function renderDocument(
  content: RenderedContent,
  firm: Firm,
  slug: string,
  canonical: string,
  noindex: boolean,
  assetType: TargetPublicationAssetType,
): string {
  const phone = phoneHref(firm.phone)
  if (!phone) return ''
  const robots = noindex ? '<meta name="robots" content="noindex,nofollow">' : ''
  const brand = textValue(firm.wordmark) ?? firm.name
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.title)} | ${escapeHtml(firm.name)}</title><meta name="description" content="${escapeHtml(content.description)}"><link rel="canonical" href="${escapeHtml(canonical)}">${robots}<style>${pageStyles()}</style></head><body><header class="top"><span class="brand">${escapeHtml(brand)}</span></header><main><section class="hero">${assetType === 'seo_page' ? `<p class="eyebrow">CASE INFORMATION</p><h1>${escapeHtml(content.title)}</h1><p class="lead">${escapeHtml(content.description)}</p>` : content.body}</section>${assetType === 'seo_page' ? content.body : ''}${renderConsultationForm(firm, slug, assetType)}</main><footer>${escapeHtml(firm.name)} · ${escapeHtml(firm.phone)} · ${escapeHtml(firm.address)}</footer></body></html>`
}

function blockedResponse(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      ...VARY_HEADERS,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': ROBOTS,
    },
  })
}

function successResponse(
  html: string,
  noindex: boolean,
  _preview: boolean,
): Response {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    // Target publications are database-backed and can move live→pending or
    // change versions between requests. Until a deployed remote purge hook is
    // configured, shared caching would serve stale legal/brand content. A
    // no-store correctness boundary makes publication changes immediately
    // visible; the publishing invalidation adapter remains available for a
    // future measured cache layer.
    'Cache-Control': 'private, no-store, max-age=0',
    ...VARY_HEADERS,
  })
  if (noindex) headers.set('X-Robots-Tag', ROBOTS)
  return new Response(html, { headers })
}

async function findTargetPublication(
  db: Db,
  firm: Firm,
  slug: string,
  assetType: TargetPublicationAssetType,
): Promise<TargetPublicationRow | null> {
  const rows = await db.select({
    publication: publications,
    asset: contentAssets,
    caseEntity: caseEntities,
  }).from(publications)
    .innerJoin(contentAssets, eq(publications.contentAssetId, contentAssets.id))
    .innerJoin(caseEntities, eq(contentAssets.caseEntityId, caseEntities.id))
    .where(and(
      eq(publications.firmId, firm.id),
      eq(contentAssets.firmId, firm.id),
      eq(contentAssets.assetType, assetType),
      eq(caseEntities.slug, slug),
    ))
    .orderBy(desc(contentAssets.contentVersion), desc(contentAssets.createdAt), desc(publications.updatedAt))
    .limit(1)
  return rows[0] ?? null
}

/** Shared runtime for the target evidence and ad publication routes. */
export async function renderTargetPublication(
  request: Request,
  params: Promise<{ slug: string }>,
  assetType: TargetPublicationAssetType,
): Promise<Response> {
  const url = new URL(request.url)
  const slug = (await params).slug?.trim()
  if (!slug || slug.includes('/') || slug.includes('?') || slug.includes('#')) return blockedResponse()

  const preview = url.searchParams.get('preview') === '1'
  const requestHost = request.headers.get('host') ?? url.host

  try {
    const db = getDb()
    const firm = await resolveFirmByExactHost(db, requestHost)
    if (!firm || firm.status === 'paused') return blockedResponse()

    const row = await findTargetPublication(db, firm, slug, assetType)
    if (!row || !latestTargetRowIsUsable(row, firm, assetType, slug, preview)) return blockedResponse()

    const canonical = expectedCanonical(firm, assetType, slug)
    const content = canonical ? contentFor(row.asset, row.caseEntity, firm, assetType) : null
    if (!canonical || !content) return blockedResponse()

    const requestHostNormalized = normalizeHost(requestHost)
    const firmDomainNormalized = normalizeHost(firm.domain)
    const canonicalHost = Boolean(
      requestHostNormalized && firmDomainNormalized && requestHostNormalized === firmDomainNormalized,
    )
    const canIndex = assetType === 'seo_page'
      && !preview
      && row.publication.status === 'live'
      && row.publication.indexPolicy === 'index'
      && firm.landingReady
      && canonicalHost
    const noindex = assetType === 'ad_landing' || !canIndex
    const html = renderDocument(content, firm, slug, canonical, noindex, assetType)
    return html ? successResponse(html, noindex, preview) : blockedResponse()
  } catch {
    // A publication route must never fall back to legacy slug data or a product page.
    return blockedResponse()
  }
}

export const targetPublicationResponse = renderTargetPublication
