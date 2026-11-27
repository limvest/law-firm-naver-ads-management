import { sql } from 'drizzle-orm'
import { pgTable, uuid, integer, text, jsonb, timestamp, boolean, unique, uniqueIndex, index } from 'drizzle-orm/pg-core'

export type FirmLawyer = {
  id?: string
  name: string
  title: string
  badges: string[]
  photo: string | null
  bio?: string
  career?: string[]
  education?: string[]
  practiceAreas?: string[]
}

// 스펙 §4 데이터 모델 중 Phase 0 필요분 (keywords/pages/ad_stats는 Phase 1+)
export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().default(1),
  vertical: text('vertical').notNull(), // 'scam' | 'rehab' | 'bankruptcy' | 'product'
  slug: text('slug'),
  nameEnc: text('name_enc').notNull(),
  phoneEnc: text('phone_enc').notNull(),
  detailEnc: text('detail_enc'),
  damageType: text('damage_type'),
  amountBand: text('amount_band'),
  utm: jsonb('utm').$type<Record<string, string>>(),
  firstTouch: jsonb('first_touch').$type<Record<string, string>>(),
  lastTouch: jsonb('last_touch').$type<Record<string, string>>(),
  sessionId: text('session_id'),
  caseEntityId: uuid('case_entity_id'),
  contentAssetId: uuid('content_asset_id'),
  publicationId: uuid('publication_id'),
  adExecutionId: uuid('ad_execution_id'),
  status: text('status').notNull().default('new'), // 신규→연락완료→상담예약→검토중→수임|종결
  priority: text('priority').notNull().default('normal'), // urgent | high | normal | low
  assignedLawyer: text('assigned_lawyer'),
  followUpAt: timestamp('follow_up_at', { withTimezone: true }),
  lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
  intakeNoteEnc: text('intake_note_enc'),
  conflictStatus: text('conflict_status').notNull().default('unchecked'), // unchecked | clear | review
  conflictCheckedAt: timestamp('conflict_checked_at', { withTimezone: true }),
  evidenceChecklist: jsonb('evidence_checklist').$type<Record<string, boolean>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('leads_firm_queue_idx').on(t.firmId, t.status, t.followUpAt)])

// 공개 상담 API의 짧은 시간창 요청 제한. 원 IP는 저장하지 않고
// firm·시간창과 함께 SHA-256으로 단방향 해시한 키만 보관한다.
export const leadRateLimits = pgTable('lead_rate_limits', {
  id: text('id').primaryKey(),
  count: integer('count').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().default(1),
  type: text('type').notNull(), // page_view | call_click | kakao_click | form_step | form_submit
  slug: text('slug'),
  sessionId: text('session_id'),
  caseEntityId: uuid('case_entity_id'),
  contentAssetId: uuid('content_asset_id'),
  publicationId: uuid('publication_id'),
  adExecutionId: uuid('ad_execution_id'),
  variant: text('variant'),
  utm: jsonb('utm').$type<Record<string, string>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// BLUEPRINT §2 — 키워드 파이프라인 (P0.5: 스키마+유형 시드, 실명 키워드·크롤 적재는 P1/P2)
export const keywords = pgTable('keywords', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().default(1),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull().default(''),
  slug: text('slug').notNull().unique(),
  aliases: jsonb('aliases').$type<string[]>(),
  scamType: text('scam_type').notNull(),
  sourceUrl: text('source_url'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  status: text('status').notNull().default('published'), // discovered→verified→generated→published→ad_registered→live→paused|blocked
  managedBy: text('managed_by').notNull().default('curated'), // curated | competitor-sitemap | llm-extraction
  autoPublished: boolean('auto_published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('keywords_normalized_name_idx').on(t.normalizedName)])

export type ScamPageContent = {
  intro: string
  sections: { heading: string; body: string }[]
  contentDegree?: 1 | 2 | 3
  observationCount?: number
  independentSourceCount?: number
  generatedAt?: string
}

export const scamPages = pgTable('scam_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  keywordId: uuid('keyword_id').notNull().references(() => keywords.id),
  content: jsonb('content').$type<ScamPageContent>().notNull(),
  templateVersion: text('template_version').notNull().default('v1'),
  lintPassed: boolean('lint_passed').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('scam_pages_keyword_unique').on(t.keywordId)])

export const observations = pgTable('observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  keywordId: uuid('keyword_id').notNull().references(() => keywords.id),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(), // 수집된 날짜
  sourceUrl: text('source_url'),                                                       // 수집된 곳
  sourceType: text('source_type'),                                                     // 수집된 형태: community|news|report|sns|etc
  title: text('title'),                                                                // 게시글 제목 원문 (공개 웹 그대로)
  origin: text('origin'),                                                              // 수집 소스 표시명 (예: 커뮤니티카페)
  sourceFamily: text('source_family'),                                                  // 동일 운영 주체/미러 그룹 (독립 근거 중복 집계 방지)
  facts: jsonb('facts').$type<ObsFacts>(),                                             // 본문 파생 구조화 사실 (원문 무저장 — dossier용). 계좌·전화 미포함
}, (t) => [
  unique('observations_keyword_source_url').on(t.keywordId, t.sourceUrl),
  index('observations_source_family_url_idx').on(t.sourceFamily, t.sourceUrl),
])

// 관측 단위 구조화 사실 — factlib.extract_facts 산출.
export type ObsFacts = {
  method: string[]                              // 수법 태그 (출금거절·선입금요구·리딩방 …)
  infra: { type: string; value: string }[]      // 사기 인프라 (company|app|site|telegram|kakao|bank|wallet) — 계좌·전화 없음
  amounts: string[]                             // 원문 명시 금액 문자열 원문 그대로 (집계·단정 금지)
}

// 세 에이전트의 공통 실행·피드백 원장. 기존 데일리 수집 리포트와 운영자/CLI 실행을
// 같은 행 구조로 보관해 진행 상태, 결과, 권장 조치와 과거 이력을 한 화면에서 조회한다.
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  runKey: text('run_key'),
  day: text('day').notNull(),                                                          // 런 기준일 YYYY-MM-DD (하루 여러 런 허용)
  status: text('status').notNull(),                                                    // running | ok | warn | error
  agentType: text('agent_type').$type<AgentExecutionType>().notNull().default('collection'),
  trigger: text('trigger').notNull().default('daily'),
  pipelineVersion: text('pipeline_version').notNull().default('agent-orchestrator-v1'),
  currentStage: text('current_stage'),
  stageEvents: jsonb('stage_events').$type<AgentStageEvent[]>().notNull().default([]),
  error: text('error'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  metrics: jsonb('metrics').$type<AgentRunMetrics>(),
  report: jsonb('report').$type<AgentExecutionReport>(),
  recommendations: jsonb('recommendations').$type<string[]>(),
  logExcerpt: text('log_excerpt'),                                                     // 해당 런 로그 발췌 (자체 산출 로그만, 상한 있음)
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('agent_runs_run_key').on(t.runKey)])

// 런 지표 — report-run.ts 가 agent.log 의 자체 산출 라인에서 파싱 (null = 해당 라인 미출현)
export type AgentRunMetrics = {
  collected: number | null      // RSS 수집 건수
  harvested: number | null      // 카페·법무법인 페이지 수확 건수
  candidates: number | null     // 신규 업체 후보 (discovered 증가)
  obsAdded: number | null       // 관측 증가 (유형+업체명 매칭 합)
  dbKw: number | null           // sync-db keywords 삽입
  dbObs: number | null          // sync-db observations 삽입
  documentsChecked?: number | null
  documentsInserted?: number | null
  documentsUpdated?: number | null
  documentsUnchanged?: number | null
  casesChanged?: number | null
  sourceDiscoveryQueries?: number | null
  sourceDiscoveryCandidates?: number | null
  sourcesDiscovered?: number | null
  keywordCoverageTotal?: number | null
  keywordCoverageProcessed?: number | null
  keywordCoverageSucceeded?: number | null
  keywordCoverageFailed?: number | null
  keywordCoverageRemaining?: number | null
  keywordCoverageRetries?: number | null
  committed: boolean            // 오늘 데이터 커밋 여부
  deployed: boolean | null      // true 완료 | false 실패 | null 단계 미실행(커밋 없음)
  llmProvider?: string | null   // openai
  llmModel?: string | null      // 실제 실행 모델 ID
  llmStatus?: string | null     // ok | failed | skipped-empty | missing-cli
  warns: string[]               // WARN:/ERROR: 라인 원문
}

export type AgentStageEvent = {
  stage: string
  state: 'started' | 'succeeded' | 'skipped' | 'warning' | 'failed'
  at: string
  exitCode?: number
  message?: string
}

export type AgentExecutionType = 'collection' | 'parser_builder' | 'database_review'

export type AgentExecutionReport = {
  summary: string
  counts: Record<string, number>
  details: string[]
  findings: Array<{
    code: string
    severity: 'info' | 'warning' | 'critical'
    count: number
    message: string
  }>
}

// ── B2B 엔진 ──
// firm 1 = 샘플투. id는 운영자 부여 정수 (leads/events.firmId 기본값 1과 정합 — 시퀀스 아님)
export const firms = pgTable('firms', {
  id: integer('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  adLawyerName: text('ad_lawyer_name').notNull(),   // 광고책임변호사 (규정 §3②)
  phone: text('phone').notNull(),                    // 표기용 "031-000-0000"
  phoneIntl: text('phone_intl').notNull(),           // JSON-LD "+82-31-000-0000"
  address: text('address').notNull(),
  addressRegion: text('address_region').notNull(),
  addressLocality: text('address_locality').notNull(),
  kakaoUrl: text('kakao_url'),
  domain: text('domain').unique(),                   // Host 매핑 (소문자, www·포트 제거)
  domainAliases: jsonb('domain_aliases').$type<string[]>(), // DNS 전환·검수용 추가 Host(정본 canonical은 domain)
  status: text('status').notNull().default('pilot'), // pilot | active | paused
  planNote: text('plan_note'),
  // SaaS 데모 확장
  lawyers: jsonb('lawyers').$type<FirmLawyer[]>(),        // 변호사단 (0~4인 가변, photo null=이니셜 카드)
  wordmark: text('wordmark'),                              // 랜딩 워드마크 텍스트 (샘플투 "SAMPLE:2")
  landingReady: boolean('landing_ready').notNull().default(false), // 실자산 분리 후 공개 승인 플래그
  dashboardToken: text('dashboard_token').unique(),        // /d/[token] 접근 토큰
  siteTemplate: text('site_template').notNull().default('response-room'), // 피해자용 웹사이트 3종 중 선택
  profileIntro: text('profile_intro'),                     // 공개 변호사 소개 페이지의 사무소 안내문
  officeHistory: jsonb('office_history').$type<string[]>(), // 공개 사무소 연혁(검증된 고객 입력만)
  // 네이버 광고 통합 — 입찰가·일예산 설정 + 비즈채널 확인 캐시. 미설정 시 null(안전 기본값은 소비처가 적용)
  adConfig: jsonb('ad_config').$type<FirmAdConfig>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// 고객 운영실 로그인 정본. URL 토큰으로 사무소를 식별하지 않고, 로그인 ID와
// 비밀번호 검증 뒤 firm_id가 들어간 HttpOnly 세션만 사용한다.
export const firmAccounts = pgTable('firm_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  loginId: text('login_id').notNull(),
  passwordHash: text('password_hash').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('firm_accounts_firm').on(t.firmId),
  unique('firm_accounts_login_id').on(t.loginId),
  index('firm_accounts_firm_enabled_idx').on(t.firmId, t.enabled),
])

// 브라우저 세션×사건명 단위 관심도 원장. 운영자용 유입 분석을 위해 접속 IP·User-Agent·유입 URL을
// 함께 보관한다. 클라이언트는 누적 활성시간·최대 스크롤을 보내며 서버가 단조 증가 값으로 병합한다.
export const engagementSessions = pgTable('engagement_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  slug: text('slug').notNull().default('직접 유입'),
  activeSeconds: integer('active_seconds').notNull().default(0),
  maxScroll: integer('max_scroll').notNull().default(0),
  pageViews: integer('page_views').notNull().default(1),
  lawyerViewed: boolean('lawyer_viewed').notNull().default(false),
  processViewed: boolean('process_viewed').notNull().default(false),
  contactViewed: boolean('contact_viewed').notNull().default(false),
  formStarted: boolean('form_started').notNull().default(false),
  interestScore: integer('interest_score').notNull().default(0),
  highIntent: boolean('high_intent').notNull().default(false),
  utm: jsonb('utm').$type<Record<string, string>>(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  referrer: text('referrer'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('engagement_sessions_firm_session_slug').on(t.firmId, t.sessionId, t.slug),
  index('engagement_sessions_firm_last_seen_idx').on(t.firmId, t.lastSeenAt),
  index('engagement_sessions_firm_slug_intent_idx').on(t.firmId, t.slug, t.highIntent),
])

// 상담 단계에서 기록한 당사자·상대방·관련인. 이름 원문은 암호화하고, 사무소 내부
// 이해충돌 검색에는 LEAD_ENC_KEY 기반 결정적 HMAC만 사용한다(타 사무소와 절대 교차 검색하지 않음).
export const leadParties = pgTable('lead_parties', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // prospective | adverse | related
  nameEnc: text('name_enc').notNull(),
  nameHash: text('name_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('lead_parties_lead_role_hash').on(t.leadId, t.role, t.nameHash),
  index('lead_parties_firm_hash_idx').on(t.firmId, t.nameHash),
])

// 이해충돌 점검 이력. 자동 판정이 아니라 같은 사무소의 과거 상담 당사자와 일치하는지 표시하는
// 보조 기록이며, 최종 수임 가능 여부는 변호사가 판단한다.
export const leadConflictChecks = pgTable('lead_conflict_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  termsEnc: text('terms_enc').notNull(),
  result: text('result').notNull(), // clear | review
  matchCount: integer('match_count').notNull().default(0),
  matchedLeadIds: jsonb('matched_lead_ids').$type<string[]>(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('lead_conflict_checks_firm_lead_idx').on(t.firmId, t.leadId, t.checkedAt)])

// 고객이 직접 등록하고 공개 여부를 정하는 익명화 사건 수행내역.
// 결과 보장·승소율 같은 집계값은 저장하지 않고, 사건별 조치와 결과를 사실 단위로 기록한다.
export const firmCaseResults = pgTable('firm_case_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  category: text('category').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  outcome: text('outcome').notNull(),
  handledAt: text('handled_at'),
  published: boolean('published').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type FirmAdConfig = {
  bidAmt: number
  dailyBudget: number
  useDailyBudget: boolean
  channelOk?: boolean
  channelCheckedAt?: string
  pcChannelId?: string
  mobileChannelId?: string
}

export const firmCredentials = pgTable('firm_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  provider: text('provider').notNull().default('naver_searchad'),
  customerId: text('customer_id').notNull(),
  apiKeyEnc: text('api_key_enc').notNull(),          // cred-crypto(CRED_ENC_KEY) 암호화, 평문 금지
  secretEnc: text('secret_enc').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('firm_credentials_firm_provider').on(t.firmId, t.provider)])

// firm × keyword 구독 — firm 상태는 광고 파이프라인 소유 (중앙 keywords.status와 독립)
export const firmKeywords = pgTable('firm_keywords', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  keywordId: uuid('keyword_id').notNull().references(() => keywords.id),
  status: text('status').notNull().default('subscribed'), // src/lib/engine/state.ts 전이표가 정본
  naverAdgroupId: text('naver_adgroup_id'),
  lastError: text('last_error'),
  // 네이버 광고 통합 §B — 고객 소유 유일 컬럼(올리기/내리기 의사표시). status(엔진 소유 파이프라인)와 독립
  adDesired: boolean('ad_desired').notNull().default(false),
  // 고객 화면의 '키워드 삭제'는 중앙 키워드와 다른 법무법인 데이터를 지우지 않고
  // 이 법무법인의 목록에서만 숨기는 소프트 삭제다.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  publicHostLabel: text('public_host_label'),
  hostStatus: text('host_status').notNull().default('pending'), // pending | preview | public | paused | retired
  hostKeyVersion: integer('host_key_version').notNull().default(1),
  hostPublishedAt: timestamp('host_published_at', { withTimezone: true }),
  hostRedirectedAt: timestamp('host_redirected_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('firm_keywords_firm_keyword').on(t.firmId, t.keywordId),
  unique('firm_keywords_firm_public_host').on(t.firmId, t.publicHostLabel),
  index('firm_keywords_firm_archived_idx').on(t.firmId, t.archivedAt),
])

export const keywordHostAliases = pgTable('keyword_host_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  keywordId: uuid('keyword_id').notNull().references(() => keywords.id, { onDelete: 'cascade' }),
  hostLabel: text('host_label').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  status: text('status').notNull().default('active'), // active | redirected | retired
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (t) => [
  unique('keyword_host_aliases_firm_label').on(t.firmId, t.hostLabel),
  index('keyword_host_aliases_keyword_idx').on(t.keywordId),
])

// 키워드 변형 — 텍스트는 firm 무관 중앙 공유
export const keywordVariants = pgTable('keyword_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  keywordId: uuid('keyword_id').notNull().references(() => keywords.id),
  text: text('text').notNull(),
  rule: text('rule').notNull(),                      // base | alias | suffix:사기 …
  ruleVersion: text('rule_version').notNull().default('v1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('keyword_variants_keyword_text').on(t.keywordId, t.text)])

// 네이버 측 객체의 유일한 미러 — 캠페인/광고그룹/키워드/소재
export const firmAdEntities = pgTable('firm_ad_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  entityType: text('entity_type').notNull(),         // campaign | adgroup | keyword | ad
  keywordId: uuid('keyword_id').references(() => keywords.id),
  variantId: uuid('variant_id').references(() => keywordVariants.id),
  naverId: text('naver_id').notNull(),
  reviewStatus: text('review_status').notNull().default('pending'), // pending | approved | rejected
  rejectReason: text('reject_reason'),
  raw: jsonb('raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('firm_ad_entities_firm_type_naver').on(t.firmId, t.entityType, t.naverId)])

export const adStats = pgTable('ad_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  entityId: uuid('entity_id').notNull().references(() => firmAdEntities.id),
  day: text('day').notNull(),                        // YYYY-MM-DD
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  cost: integer('cost').notNull().default(0),        // KRW
}, (t) => [unique('ad_stats_entity_day').on(t.entityId, t.day)])

// ── 사건 수요 대응 OS — additive target model ──
// 기존 keywords/observations/firm_keywords는 호환 계층으로 유지하고, 아래 테이블을 새 정본으로
// 점진 도입한다. slug는 URL 별칭일 뿐 조인의 정본이 아니며 case_entities.id를 사용한다.

export type EvidenceSnapshotFacts = {
  methods: string[]
  infrastructure: { type: string; value: string }[]
  amounts: string[]
  citations: { observationId?: string; sourceUrl?: string; sourceFamily?: string }[]
}

export type ContentQualityReport = {
  evidenceReady: boolean
  placeholderFree: boolean
  linksReady: boolean
  brandReady: boolean
  complianceReady: boolean
  uniqueFacts: number
  issues: string[]
}

export const intelligenceSources = pgTable('intelligence_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceKey: text('source_key').notNull(),
  name: text('name').notNull(),
  sourceType: text('source_type').notNull(),
  sourceFamily: text('source_family'),
  baseUrl: text('base_url'),
  enabled: boolean('enabled').notNull().default(true),
  cadenceMinutes: integer('cadence_minutes'),
  config: jsonb('config').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('intelligence_sources_source_key').on(t.sourceKey)])

// 법률사무소가 제안한 추가 수집 링크의 검토 큐. 고객 입력만으로 외부 URL에 접속하거나
// intelligence_sources/harvest-sources.json을 바꾸지 않는다. 운영자가 소스 유형·범위·안전성을
// 확인해 실제 수집 정본에 수동 반영한 뒤 registered/rejected로 처리한다.
export const sourceCollectionRequests = pgTable('source_collection_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  sourceId: uuid('source_id').references(() => intelligenceSources.id, { onDelete: 'set null' }),
  sourceUrl: text('source_url').notNull(),
  status: text('status').notNull().default('pending'), // pending | registered | rejected
  operatorNote: text('operator_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('source_collection_requests_firm_url').on(t.firmId, t.sourceUrl),
  index('source_collection_requests_status_created_idx').on(t.status, t.createdAt),
  index('source_collection_requests_firm_created_idx').on(t.firmId, t.createdAt),
])

// 총운영자가 법무법인별로 승인한 수집 소스 정본. 전역 source enabled 상태와 별개로
// 이 관계가 active여야 해당 법무법인의 수동 수집 요청에 포함된다.
export const firmSourceGrants = pgTable('firm_source_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => intelligenceSources.id),
  approvedFromRequestId: uuid('approved_from_request_id').references(() => sourceCollectionRequests.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('active'), // active | paused | revoked
  approvedBy: text('approved_by').notNull().default('operator-console'),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  operatorNote: text('operator_note'),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('firm_source_grants_firm_source').on(t.firmId, t.sourceId),
  index('firm_source_grants_firm_status_idx').on(t.firmId, t.status),
  index('firm_source_grants_source_status_idx').on(t.sourceId, t.status),
])

export const sourceRuns = pgTable('source_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull().references(() => intelligenceSources.id),
  runKey: text('run_key').notNull().default(''),
  trigger: text('trigger').notNull().default('unknown'),
  attempted: boolean('attempted').notNull().default(true),
  sourceKey: text('source_key').notNull().default(''),
  sourceName: text('source_name').notNull().default(''),
  sourceType: text('source_type').notNull().default(''),
  sourceFamily: text('source_family'),
  sourceUrl: text('source_url'),
  collectorMethod: text('collector_method').notNull().default('unknown'),
  collectorConfig: jsonb('collector_config').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('running'), // running | succeeded | warning | failed | skipped
  checkpointBefore: jsonb('checkpoint_before').$type<Record<string, unknown>>(),
  checkpointAfter: jsonb('checkpoint_after').$type<Record<string, unknown>>(),
  itemsSeen: integer('items_seen').notNull().default(0),
  itemsAccepted: integer('items_accepted').notNull().default(0),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  index('source_runs_source_started_idx').on(t.sourceId, t.startedAt),
  // A source may have at most one active run.  This partial unique index is
  // the database-level backstop for workers that race between their
  // "running" check and the insert (the discovery worker uses it to avoid
  // duplicate scans on the same database).
  uniqueIndex('source_runs_source_running_unique').on(t.sourceId).where(sql`${t.status} = 'running'`),
])

export type AgentActionType = 'retry_collection' | 'reanalyze_source'
export type AgentActionProposalStatus = 'pending' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed'

// 3호는 조치를 직접 실행하지 않고 이 승인 원장에 제안만 기록한다. 총운영자의
// 명시적 승인 뒤 prepare/finalize worker가 1호 또는 2호에 전달한다.
export const agentActionProposals = pgTable('agent_action_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewRunId: uuid('review_run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => intelligenceSources.id, { onDelete: 'cascade' }),
  actionType: text('action_type').$type<AgentActionType>().notNull(),
  status: text('status').$type<AgentActionProposalStatus>().notNull().default('pending'),
  findingCode: text('finding_code').notNull(),
  rationale: text('rationale').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  decidedBy: text('decided_by'),
  decisionNote: text('decision_note'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  executionRunId: uuid('execution_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  executionError: text('execution_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('agent_action_proposals_review_source_action').on(t.reviewRunId, t.sourceId, t.actionType),
  index('agent_action_proposals_status_created_idx').on(t.status, t.createdAt),
  index('agent_action_proposals_source_status_idx').on(t.sourceId, t.status),
])

export const caseEntities = pgTable('case_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  legacyKeywordId: uuid('legacy_keyword_id').references(() => keywords.id),
  canonicalName: text('canonical_name').notNull(),
  slug: text('slug').notNull(),
  category: text('category').notNull(),
  status: text('status').notNull().default('observed'), // observed | corroborated | approved | blocked | merged
  confidence: integer('confidence').notNull().default(0), // 0..10000 basis points
  mergedIntoId: uuid('merged_into_id'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('case_entities_legacy_keyword').on(t.legacyKeywordId),
  unique('case_entities_slug').on(t.slug),
  index('case_entities_status_last_seen_idx').on(t.status, t.lastSeenAt),
])

export const caseAliases = pgTable('case_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseEntityId: uuid('case_entity_id').notNull().references(() => caseEntities.id, { onDelete: 'cascade' }),
  alias: text('alias').notNull(),
  normalizedAlias: text('normalized_alias').notNull(),
  kind: text('kind').notNull().default('observed'), // canonical | observed | typo | merged
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('case_aliases_case_normalized').on(t.caseEntityId, t.normalizedAlias),
  index('case_aliases_normalized_idx').on(t.normalizedAlias),
])

export const caseEntityLinks = pgTable('case_entity_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseEntityId: uuid('case_entity_id').notNull().references(() => caseEntities.id, { onDelete: 'cascade' }),
  relationType: text('relation_type').notNull(), // app | domain | site | telegram | kakao | institution | wallet
  value: text('value').notNull(),
  normalizedValue: text('normalized_value').notNull(),
  sourceObservationId: uuid('source_observation_id').references(() => observations.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('case_entity_links_case_type_value').on(t.caseEntityId, t.relationType, t.normalizedValue),
  index('case_entity_links_type_value_idx').on(t.relationType, t.normalizedValue),
])

export const sourceItems = pgTable('source_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull().references(() => intelligenceSources.id),
  // 호환 컬럼이지만 이제 "이 행을 마지막으로 확인한 실행"을 가리킨다.
  sourceRunId: uuid('source_run_id').notNull().references(() => sourceRuns.id, { onDelete: 'cascade' }),
  firstSeenRunId: uuid('first_seen_run_id').notNull().references(() => sourceRuns.id),
  lastSeenRunId: uuid('last_seen_run_id').notNull().references(() => sourceRuns.id),
  sourceItemKey: text('source_item_key').notNull(),
  sourceUrl: text('source_url'),
  fingerprint: text('fingerprint').notNull(),
  title: text('title'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('observed'), // observed | candidate | linked | ambiguous | unmatched | rejected
  caseEntityId: uuid('case_entity_id').references(() => caseEntities.id),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  isCurrent: boolean('is_current').notNull().default(true),
  parserVersion: text('parser_version').notNull().default('collector-v1'),
}, (t) => [
  unique('source_items_source_item').on(t.sourceId, t.sourceItemKey),
  index('source_items_source_last_seen_idx').on(t.sourceId, t.lastSeenAt),
  index('source_items_fingerprint_idx').on(t.fingerprint),
  index('source_items_case_idx').on(t.caseEntityId),
])

// source_items 변경과 후속 사건 정비를 분리하는 트랜잭셔널 outbox. 수집 행과 같은
// 트랜잭션에서 생성되므로 페이지 생성 중 장애가 나도 다음 실행이 미처리 변경을 재개한다.
export const sourceItemChanges = pgTable('source_item_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceRunId: uuid('source_run_id').notNull().references(() => sourceRuns.id, { onDelete: 'cascade' }),
  sourceItemId: uuid('source_item_id').notNull().references(() => sourceItems.id, { onDelete: 'cascade' }),
  changeType: text('change_type').notNull(), // inserted | updated
  previousFingerprint: text('previous_fingerprint'),
  nextFingerprint: text('next_fingerprint').notNull(),
  keywordIds: jsonb('keyword_ids').$type<string[]>().notNull().default([]),
  caseEntityIds: jsonb('case_entity_ids').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('pending'), // pending | materialized | processed | failed
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  materializedAt: timestamp('materialized_at', { withTimezone: true }),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (t) => [
  unique('source_item_changes_run_item_fingerprint').on(t.sourceRunId, t.sourceItemId, t.nextFingerprint),
  index('source_item_changes_status_created_idx').on(t.status, t.createdAt),
  index('source_item_changes_item_created_idx').on(t.sourceItemId, t.createdAt),
])

export const caseEvidenceSnapshots = pgTable('case_evidence_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseEntityId: uuid('case_entity_id').notNull().references(() => caseEntities.id, { onDelete: 'cascade' }),
  observationCount: integer('observation_count').notNull().default(0),
  independentSourceCount: integer('independent_source_count').notNull().default(0),
  confidence: integer('confidence').notNull().default(0),
  fingerprint: text('fingerprint').notNull(),
  facts: jsonb('facts').$type<EvidenceSnapshotFacts>().notNull(),
  policyVersion: text('policy_version').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('case_evidence_case_fingerprint').on(t.caseEntityId, t.fingerprint),
  index('case_evidence_case_captured_idx').on(t.caseEntityId, t.capturedAt),
])

export const caseApprovals = pgTable('case_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseEntityId: uuid('case_entity_id').notNull().references(() => caseEntities.id, { onDelete: 'cascade' }),
  firmId: integer('firm_id').references(() => firms.id),
  decision: text('decision').notNull(), // approved | rejected | hold | blocked
  actorType: text('actor_type').notNull(), // operator | lawyer | policy
  actorId: text('actor_id'),
  policyVersion: text('policy_version').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('case_approvals_case_firm_created_idx').on(t.caseEntityId, t.firmId, t.createdAt)])

export const caseOpportunities = pgTable('case_opportunities', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseEntityId: uuid('case_entity_id').notNull().references(() => caseEntities.id, { onDelete: 'cascade' }),
  firmId: integer('firm_id').references(() => firms.id),
  scopeKey: text('scope_key').notNull(), // global | firm:<id>
  score: integer('score').notNull(), // 0..10000 basis points
  recommendation: text('recommendation').notNull(), // publish | watch | hold | block
  reasons: jsonb('reasons').$type<string[]>().notNull(),
  inputSnapshot: jsonb('input_snapshot').$type<Record<string, unknown>>().notNull(),
  modelVersion: text('model_version').notNull(),
  calculatedAt: timestamp('calculated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('case_opportunities_case_scope').on(t.caseEntityId, t.scopeKey),
  index('case_opportunities_firm_score_idx').on(t.firmId, t.score),
])

export const contentAssets = pgTable('content_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  caseEntityId: uuid('case_entity_id').notNull().references(() => caseEntities.id),
  assetType: text('asset_type').notNull(), // seo_page | ad_landing
  status: text('status').notNull().default('draft'),
  templateVersion: text('template_version').notNull(),
  contentVersion: integer('content_version').notNull().default(1),
  evidenceSnapshotId: uuid('evidence_snapshot_id').references(() => caseEvidenceSnapshots.id),
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  qualityReport: jsonb('quality_report').$type<ContentQualityReport>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('content_assets_firm_case_type_version').on(t.firmId, t.caseEntityId, t.assetType, t.contentVersion),
  index('content_assets_firm_status_idx').on(t.firmId, t.status),
])

export const publications = pgTable('publications', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  contentAssetId: uuid('content_asset_id').notNull().references(() => contentAssets.id),
  domain: text('domain').notNull(),
  url: text('url').notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  indexPolicy: text('index_policy').notNull().default('noindex'), // index | noindex
  status: text('status').notNull().default('pending'), // pending | live | stale | failed | blocked
  deployedVersion: text('deployed_version'),
  lastError: text('last_error'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('publications_firm_url').on(t.firmId, t.url),
  index('publications_firm_status_idx').on(t.firmId, t.status),
])

export const publicationChecks = pgTable('publication_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicationId: uuid('publication_id').notNull().references(() => publications.id, { onDelete: 'cascade' }),
  statusCode: integer('status_code'),
  canonicalOk: boolean('canonical_ok').notNull().default(false),
  ctaOk: boolean('cta_ok').notNull().default(false),
  brandOk: boolean('brand_ok').notNull().default(false),
  placeholderFree: boolean('placeholder_free').notNull().default(false),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
}, (t) => [index('publication_checks_publication_checked_idx').on(t.publicationId, t.checkedAt)])

export const operationJobs = pgTable('operation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobType: text('job_type').notNull(),
  state: text('state').notNull().default('queued'), // queued | running | retryable | failed | succeeded | dead
  firmId: integer('firm_id').references(() => firms.id),
  caseEntityId: uuid('case_entity_id').references(() => caseEntities.id),
  idempotencyKey: text('idempotency_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  priority: integer('priority').notNull().default(100),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  unique('operation_jobs_idempotency').on(t.idempotencyKey),
  index('operation_jobs_claim_idx').on(t.state, t.availableAt, t.priority),
  index('operation_jobs_firm_state_idx').on(t.firmId, t.state),
])

export const operationJobAttempts = pgTable('operation_job_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => operationJobs.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  workerId: text('worker_id').notNull(),
  state: text('state').notNull(),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  unique('operation_job_attempts_job_attempt').on(t.jobId, t.attempt),
  index('operation_job_attempts_job_started_idx').on(t.jobId, t.startedAt),
])

// 법무법인 운영자가 누른 '수집하기'의 사용량 원장. 실제 외부 수집은 operation_jobs의
// 내구성 큐와 로컬 에이전트가 처리하고, 이 테이블은 중복 클릭을 합치면서 향후 월별
// 과금 단위와 수집 결과를 법무법인별로 남긴다.
export const firmCollectionRuns = pgTable('firm_collection_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  requestKey: text('request_key').notNull(),
  activeKey: text('active_key'), // running 동안 firm:<id>, 완료/에러 시 null
  requestedBy: text('requested_by').notNull().default('firm-client'),
  trigger: text('trigger').notNull().default('manual'),
  periodKey: text('period_key').notNull(), // Asia/Seoul YYYY-MM
  status: text('status').notNull().default('running'), // running | completed | error
  // 버튼을 누른 시점에 이 법무법인에 승인돼 있던 소스 ID 스냅샷.
  // 별도 run-source 테이블을 만들지 않고 한 실행의 범위를 이 원장에 함께 보존한다.
  requestedSourceIds: jsonb('requested_source_ids').$type<string[]>().notNull().default([]),
  requestedSourceCount: integer('requested_source_count').notNull().default(0),
  sourceRunIds: jsonb('source_run_ids').$type<string[]>(),
  sourceRunCount: integer('source_run_count').notNull().default(0),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('firm_collection_runs_request_key').on(t.requestKey),
  unique('firm_collection_runs_one_active').on(t.activeKey),
  index('firm_collection_runs_firm_period_idx').on(t.firmId, t.periodKey, t.requestedAt),
  index('firm_collection_runs_status_requested_idx').on(t.status, t.requestedAt),
])

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: text('event_type').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  firmId: integer('firm_id').references(() => firms.id),
  actor: text('actor').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  correlationId: text('correlation_id'),
  causationId: text('causation_id'),
  schemaVersion: text('schema_version').notNull(),
  policyVersion: text('policy_version'),
  idempotencyKey: text('idempotency_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishAttempts: integer('publish_attempts').notNull().default(0),
}, (t) => [
  unique('outbox_events_idempotency').on(t.idempotencyKey),
  index('outbox_events_unpublished_idx').on(t.publishedAt, t.recordedAt),
])

// ── Closed-loop acquisition, search, advertising and operations ──
// These tables keep result data tenant-owned while preserving canonical IDs
// from case → asset → publication → traffic → lead → retained outcome.

export type AttributionTouch = {
  source?: string
  medium?: string
  campaign?: string
  term?: string
  content?: string
  referrer?: string
  occurredAt: string
}

export const firmDomains = pgTable('firm_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  hostname: text('hostname').notNull(),
  isCanonical: boolean('is_canonical').notNull().default(false),
  status: text('status').notNull().default('pending'), // pending | verified | active | failed
  tlsStatus: text('tls_status').notNull().default('pending'), // pending | valid | invalid
  verificationError: text('verification_error'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('firm_domains_hostname').on(t.hostname),
  index('firm_domains_firm_status_idx').on(t.firmId, t.status),
])

export const firmPolicies = pgTable('firm_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  policyVersion: text('policy_version').notNull(),
  contentAutoApprove: boolean('content_auto_approve').notNull().default(false),
  adAutoSubmit: boolean('ad_auto_submit').notNull().default(false),
  allowedActions: jsonb('allowed_actions').$type<string[]>().notNull(),
  allowedCaseEntityIds: jsonb('allowed_case_entity_ids').$type<string[]>(),
  monthlyBudget: integer('monthly_budget'),
  dailyBudget: integer('daily_budget'),
  bidCeiling: integer('bid_ceiling'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('firm_policies_firm').on(t.firmId)])

export const adAccounts = pgTable('ad_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  provider: text('provider').notNull().default('naver_searchad'),
  externalCustomerId: text('external_customer_id').notNull(),
  status: text('status').notNull().default('pending'), // pending | verified | active | failed
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('ad_accounts_firm_provider').on(t.firmId, t.provider)])

export const adExecutions = pgTable('ad_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  adAccountId: uuid('ad_account_id').references(() => adAccounts.id),
  caseEntityId: uuid('case_entity_id').notNull().references(() => caseEntities.id),
  contentAssetId: uuid('content_asset_id').notNull().references(() => contentAssets.id),
  publicationId: uuid('publication_id').references(() => publications.id),
  status: text('status').notNull().default('draft'), // draft | submitted | pending_review | live | paused | rejected | retired
  desiredActive: boolean('desired_active').notNull().default(false),
  campaignExternalId: text('campaign_external_id'),
  adGroupExternalId: text('ad_group_external_id'),
  creativeExternalId: text('creative_external_id'),
  reviewStatus: text('review_status').notNull().default('not_submitted'),
  reviewReason: text('review_reason'),
  bidAmount: integer('bid_amount'),
  dailyBudget: integer('daily_budget'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('ad_executions_firm_asset').on(t.firmId, t.contentAssetId),
  index('ad_executions_firm_status_idx').on(t.firmId, t.status),
])

export const adReviewEvents = pgTable('ad_review_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  adExecutionId: uuid('ad_execution_id').notNull().references(() => adExecutions.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  reason: text('reason'),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ad_review_events_execution_observed_idx').on(t.adExecutionId, t.observedAt)])

export const adDailyStatsV2 = pgTable('ad_daily_stats_v2', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  adExecutionId: uuid('ad_execution_id').notNull().references(() => adExecutions.id, { onDelete: 'cascade' }),
  day: text('day').notNull(),
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  cost: integer('cost').notNull().default(0),
  conversions: integer('conversions').notNull().default(0),
  qualifiedLeads: integer('qualified_leads').notNull().default(0),
  retainedMatters: integer('retained_matters').notNull().default(0),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('ad_daily_stats_v2_execution_day').on(t.adExecutionId, t.day),
  index('ad_daily_stats_v2_firm_day_idx').on(t.firmId, t.day),
])

export const searchIntegrations = pgTable('search_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  provider: text('provider').notNull(), // naver_search_advisor | google_search_console
  status: text('status').notNull().default('pending'),
  siteUrl: text('site_url').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('search_integrations_firm_provider_site').on(t.firmId, t.provider, t.siteUrl)])

export const searchUrlStatuses = pgTable('search_url_statuses', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => searchIntegrations.id, { onDelete: 'cascade' }),
  publicationId: uuid('publication_id').notNull().references(() => publications.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // unknown | discovered | crawled | indexed | excluded | error
  reason: text('reason'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }),
  indexedAt: timestamp('indexed_at', { withTimezone: true }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
}, (t) => [
  unique('search_url_statuses_integration_publication').on(t.integrationId, t.publicationId),
  index('search_url_statuses_status_checked_idx').on(t.status, t.checkedAt),
])

export const searchQueryStats = pgTable('search_query_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => searchIntegrations.id, { onDelete: 'cascade' }),
  publicationId: uuid('publication_id').references(() => publications.id, { onDelete: 'cascade' }),
  day: text('day').notNull(),
  query: text('query').notNull(),
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  positionBasisPoints: integer('position_basis_points'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('search_query_stats_integration_publication_day_query').on(t.integrationId, t.publicationId, t.day, t.query),
  index('search_query_stats_publication_day_idx').on(t.publicationId, t.day),
])

export const visitorSessions = pgTable('visitor_sessions', {
  id: text('id').primaryKey(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  firstCaseEntityId: uuid('first_case_entity_id').references(() => caseEntities.id),
  firstContentAssetId: uuid('first_content_asset_id').references(() => contentAssets.id),
  firstPublicationId: uuid('first_publication_id').references(() => publications.id),
  firstAdExecutionId: uuid('first_ad_execution_id').references(() => adExecutions.id),
  firstTouch: jsonb('first_touch').$type<Record<string, unknown>>().notNull(),
  lastTouch: jsonb('last_touch').$type<Record<string, unknown>>().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('visitor_sessions_firm_last_seen_idx').on(t.firmId, t.lastSeenAt)])

export const touchpoints = pgTable('touchpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  dedupeKey: text('dedupe_key').notNull(),
  sessionId: text('session_id').notNull().references(() => visitorSessions.id, { onDelete: 'cascade' }),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  caseEntityId: uuid('case_entity_id').references(() => caseEntities.id),
  contentAssetId: uuid('content_asset_id').references(() => contentAssets.id),
  publicationId: uuid('publication_id').references(() => publications.id),
  adExecutionId: uuid('ad_execution_id').references(() => adExecutions.id),
  touchType: text('touch_type').notNull(), // landing | page_view | call_click | kakao_click | form_submit
  attribution: jsonb('attribution').$type<AttributionTouch>().notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('touchpoints_dedupe_key').on(t.dedupeKey),
  index('touchpoints_firm_occurred_idx').on(t.firmId, t.occurredAt),
  index('touchpoints_session_occurred_idx').on(t.sessionId, t.occurredAt),
])

export const leadStatusHistory = pgTable('lead_status_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  idempotencyKey: text('idempotency_key').notNull(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reason: text('reason'),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('lead_status_history_idempotency_key').on(t.idempotencyKey),
  index('lead_status_history_lead_created_idx').on(t.leadId, t.createdAt),
])

export const leadQualifications = pgTable('lead_qualifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // pending | qualified | unqualified
  reason: text('reason'),
  actor: text('actor').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('lead_qualifications_lead').on(t.leadId),
  index('lead_qualifications_firm_status_idx').on(t.firmId, t.status),
])

export const consultations = pgTable('consultations', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('booked'), // booked | completed | cancelled | no_show
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('consultations_firm_status_idx').on(t.firmId, t.status)])

export const matterOutcomes = pgTable('matter_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  consultationId: uuid('consultation_id').references(() => consultations.id),
  status: text('status').notNull(), // retained | not_retained | closed
  reason: text('reason'),
  feeBand: text('fee_band'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('matter_outcomes_lead').on(t.leadId),
  index('matter_outcomes_firm_status_idx').on(t.firmId, t.status),
])

export const approvalTasks = pgTable('approval_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').references(() => firms.id),
  caseEntityId: uuid('case_entity_id').references(() => caseEntities.id),
  contentAssetId: uuid('content_asset_id').references(() => contentAssets.id),
  taskType: text('task_type').notNull(),
  status: text('status').notNull().default('pending'), // pending | approved | rejected | expired
  reason: text('reason'),
  requiredActorType: text('required_actor_type').notNull(),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('approval_tasks_firm_status_idx').on(t.firmId, t.status)])

export const operationAlerts = pgTable('operation_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').references(() => firms.id),
  jobId: uuid('job_id').references(() => operationJobs.id),
  alertType: text('alert_type').notNull(),
  severity: text('severity').notNull(), // info | warning | critical
  status: text('status').notNull().default('open'), // open | acknowledged | resolved
  message: text('message').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [index('operation_alerts_status_severity_idx').on(t.status, t.severity)])

export const dailyReports = pgTable('daily_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').references(() => firms.id),
  day: text('day').notNull(),
  status: text('status').notNull(), // ready | warning | failed
  metrics: jsonb('metrics').$type<Record<string, number | null>>().notNull(),
  exceptions: jsonb('exceptions').$type<string[]>().notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('daily_reports_firm_day').on(t.firmId, t.day)])

// Founder-led sales intake. Product leads belong to the platform firm while
// retaining a firm_id so every operator query has an explicit tenant boundary.
// Contact PII remains on leads.detail_enc/name_enc/phone_enc; this table only
// stores structured qualification and pipeline state.
export type ProductLeadPackageInterest = 'founding_pilot' | 'core' | 'growth' | 'managed_ops'
export type ProductLeadStage = 'targeted' | 'contacted' | 'interview' | 'demo' | 'pilot' | 'active' | 'lost'

export const productLeadProfiles = pgTable('product_lead_profiles', {
  leadId: uuid('lead_id').primaryKey().references(() => leads.id, { onDelete: 'cascade' }),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  packageInterest: text('package_interest').notNull().default('founding_pilot'),
  managedOps: boolean('managed_ops').notNull().default(false),
  budgetBand: text('budget_band'),
  teamSize: text('team_size'),
  repeatFraudMatters: text('repeat_fraud_matters'),
  ownDomain: text('own_domain'),
  naverAccount: text('naver_account'),
  responseOwner: text('response_owner'),
  outcomeTracking: text('outcome_tracking'),
  stage: text('stage').notNull().default('targeted'),
  followUpAt: timestamp('follow_up_at', { withTimezone: true }),
  lostReason: text('lost_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('product_lead_profiles_firm_stage_updated_idx').on(t.firmId, t.stage, t.updatedAt),
  index('product_lead_profiles_firm_followup_idx').on(t.firmId, t.followUpAt),
])

// Immutable GTM milestone ledger. The profile keeps the current working
// state; this table is the audit trail used for gate progress. Evidence is
// optional only for non-substantive contact updates (for example, contacted).
export const productLeadStageHistory = pgTable('product_lead_stage_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull().references(() => productLeadProfiles.leadId, { onDelete: 'cascade' }),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  fromStage: text('from_stage'),
  toStage: text('to_stage').notNull(),
  evidenceNote: text('evidence_note'),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('product_lead_stage_history_firm_created_idx').on(t.firmId, t.createdAt),
  index('product_lead_stage_history_lead_created_idx').on(t.leadId, t.createdAt),
])

// 네이버 공개 검색 순환의 진행률 정본. source_runs.checkpoint_after는 다음
// 커서 힌트일 뿐이며, 순환(wrap)·실패 재시도·동시 실행이 섞이면 커서만으로
// 전체 eligible keyword의 실제 커버리지를 계산할 수 없다. 이 원장은 검색
// 자체를 실행하지 않고, 불변 eligible 스냅샷과 배치 결과만 보관한다.
export type KeywordSearchCoverageRunStatus = 'running' | 'completed' | 'warning' | 'failed'
export type KeywordSearchCoverageBatchStatus = 'pending' | 'running' | 'succeeded' | 'warning' | 'failed'

export const keywordSearchCoverageRuns = pgTable('keyword_search_coverage_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  coverageKey: text('coverage_key').notNull(), // 예: naver-public-search
  runKey: text('run_key').notNull(),           // 한 순환(cycle)의 멱등 키
  status: text('status').$type<KeywordSearchCoverageRunStatus>().notNull().default('running'),
  eligibilityVersion: text('eligibility_version').notNull().default('observed-nonblocked-v1'),
  // 실행 시작 시점의 eligible ID 스냅샷. keywords 자체는 이 원장에서 변경하지 않는다.
  eligibleSeedIds: jsonb('eligible_seed_ids').$type<string[]>().notNull().default([]),
  totalEligible: integer('total_eligible').notNull().default(0),
  processedCount: integer('processed_count').notNull().default(0),
  succeededCount: integer('succeeded_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  pendingRetryCount: integer('pending_retry_count').notNull().default(0),
  retryCount: integer('retry_count').notNull().default(0),
  remainingCount: integer('remaining_count').notNull().default(0),
  cursorHint: jsonb('cursor_hint').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('keyword_search_coverage_runs_key').on(t.coverageKey, t.runKey),
  index('keyword_search_coverage_runs_key_created_idx').on(t.coverageKey, t.createdAt),
  index('keyword_search_coverage_runs_status_updated_idx').on(t.status, t.updatedAt),
])

// 배치 원장. seed ID 배열은 immutable assignment이고, 나머지 배열은 해당
// 배치의 최신 seed 상태를 나타낸다. retry 이력은 attempts 테이블에서 보존한다.
export const keywordSearchCoverageBatches = pgTable('keyword_search_coverage_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => keywordSearchCoverageRuns.id, { onDelete: 'cascade' }),
  batchKey: text('batch_key').notNull(),
  batchNumber: integer('batch_number').notNull(),
  status: text('status').$type<KeywordSearchCoverageBatchStatus>().notNull().default('pending'),
  seedIds: jsonb('seed_ids').$type<string[]>().notNull().default([]),
  attemptedSeedIds: jsonb('attempted_seed_ids').$type<string[]>().notNull().default([]),
  succeededSeedIds: jsonb('succeeded_seed_ids').$type<string[]>().notNull().default([]),
  failedSeedIds: jsonb('failed_seed_ids').$type<string[]>().notNull().default([]),
  retriedSeedIds: jsonb('retried_seed_ids').$type<string[]>().notNull().default([]),
  retryableSeedIds: jsonb('retryable_seed_ids').$type<string[]>().notNull().default([]),
  pendingSeedIds: jsonb('pending_seed_ids').$type<string[]>().notNull().default([]),
  attemptCount: integer('attempt_count').notNull().default(0),
  processedCount: integer('processed_count').notNull().default(0),
  remainingCount: integer('remaining_count').notNull().default(0),
  lastError: text('last_error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('keyword_search_coverage_batches_run_key').on(t.runId, t.batchKey),
  unique('keyword_search_coverage_batches_run_number').on(t.runId, t.batchNumber),
  index('keyword_search_coverage_batches_run_status_idx').on(t.runId, t.status),
  index('keyword_search_coverage_batches_updated_idx').on(t.updatedAt),
])

// 시드별 검색 시도 이벤트. attempt_key가 같은 결과의 재전송을 한 번만
// 반영하게 하므로 worker 재시작/재실행에도 retry·processed 수가 부풀지 않는다.
export const keywordSearchCoverageAttempts = pgTable('keyword_search_coverage_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => keywordSearchCoverageBatches.id, { onDelete: 'cascade' }),
  attemptKey: text('attempt_key').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  seedIds: jsonb('seed_ids').$type<string[]>().notNull().default([]),
  succeededSeedIds: jsonb('succeeded_seed_ids').$type<string[]>().notNull().default([]),
  failedSeedIds: jsonb('failed_seed_ids').$type<string[]>().notNull().default([]),
  retryableSeedIds: jsonb('retryable_seed_ids').$type<string[]>().notNull().default([]),
  processedCount: integer('processed_count').notNull().default(0),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('keyword_search_coverage_attempts_batch_key').on(t.batchId, t.attemptKey),
  index('keyword_search_coverage_attempts_batch_created_idx').on(t.batchId, t.createdAt),
])
