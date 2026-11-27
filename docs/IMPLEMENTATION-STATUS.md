# 구현 현황과 증거 경계

기준일: 2026-08-11
전략 정본: `docs/PRODUCT-GOAL-ARCHITECTURE-GTM.md`
실행·운영 정본: `docs/PRODUCT.md`

이 문서는 “코드가 있다”, “로컬에서 검증됐다”, “실제 시장에서 증명됐다”를 분리한다. 테스트·타입체크·빌드가 통과해도 실제 도메인, 네이버 계정, 검색 노출, 광고비, 상담과 수임 결과가 확인되지 않았다면 외부 완료로 표시하지 않는다.

## 1. 현재 결론

| 판정 | 상태 |
|---|---|
| 내부 제품 폐쇄루프 | 구현됨 |
| tokenless 5분 데모 | 공유 workspace 기준 구현됨; localhost desktop 1440px·mobile 390px에서 상담 제출→dashboard 반영→operator 승인→고객 상태 전파 검증 |
| 운영 DB target migration | 파일 `0009`~`0022` 생성됨, 실제 DB 적용 전 |
| production deployment | 이 작업에서 미실행 |
| 실제 고객 도메인·TLS·검색 integration | 미검증 |
| 실제 네이버 등록·심사·비용 동기화 | adapter와 opt-in 실행 경로 구현, 실계정 미실행 |
| 30일 파일럿·귀속률·유료 고객·갱신 | 외부 증거 없음 |

따라서 현재 상태는 **내부 폐쇄루프 구현 완료, 운영 DB migration·배포·실고객 파일럿 활성화 전**이다.

## 2. 구현된 정본 폐쇄루프

```text
source run/item
→ case_entity + alias/link + evidence snapshot
→ global/firm opportunity snapshot
→ SEO content_asset | ad_landing content_asset
→ approval task
→ publication + HTTP quality check
→ ad_execution + review + daily stats
→ visitor_session + touchpoint + lead
→ qualification + consultation + matter_outcome
→ daily/weekly report + next opportunity context
```

관계 조인은 `slug`가 아니라 가능한 모든 target 경로에서 `case_entity_id`, `content_asset_id`, `publication_id`, `ad_execution_id`, `session_id`, `lead_id`를 사용한다. `/f/{slug}`는 legacy compatibility route로 유지한다.

## 3. 도메인별 구현 증거

| 도메인 | 주요 구현 | 로컬 증거 | 외부 경계 |
|---|---|---|---|
| Intelligence | source registry/run/item, legacy 정본화, exact source linkage, 별칭·관계·근거 snapshot | `src/domains/intelligence/*`, `scripts/agent/sync-source-runs.ts`, case/source tests | 실제 소스 최신성·장애율은 일일 런에서 측정 |
| Opportunity | 설명 가능한 global/firm 점수와 입력 snapshot; 속도·검색 노출·CPC·실제 심사·적격·수임·정책 반영 | `src/domains/opportunities/*`, opportunity tests | calibration은 실상담·수임 표본 필요 |
| Content | SEO/ad 별도 자산, evidence/version/quality state | `src/domains/content/*`, content tests | 실제 고객 문구 승인 필요 |
| Publishing | `/case` index SEO, `/response` noindex 광고 랜딩, firm/domain chain, CTA/event/form, HTTP 후검증 | `src/domains/publishing/*`, target publication tests, `app/sitemap.ts` | custom domain·TLS·실 URL 2xx는 배포 후 검증 |
| Advertising | 고객 정책·예산 guard, dry-run 기본, opt-in 실등록, 심사 GET, 일별 stats GET | `src/domains/advertising/*`, `src/platform/integrations/naver-*`, sync/CLI tests | 실제 계정 호출·과금은 미실행 |
| Search | provider-neutral snapshot import, URL 색인·사유·검색어·CTR·순위·버전·refresh 권고 | `src/domains/search/*`, `scripts/agent/sync-search-performance.ts`, search tests | Search Advisor/GSC 실제 export 연결 전 |
| Acquisition | session/touchpoint/event/lead의 canonical attribution, firm isolation | `src/domains/acquisition/*`, `/api/events`, `/api/leads`, attribution tests | 실제 사람 세션과 전화 성공은 미검증 |
| Outcomes | append-only lead 상태, 적격 여부, 상담, 수임·미수임·종결 | `src/domains/outcomes/*`, lead detail UI, outcome tests | 고객이 실제 결과를 갱신해야 함 |
| Tenancy | Host 기반 firm, profile/site/ad policy, 8개 activation gate | `src/domains/tenancy/*`, `/d/{token}/activation`, activation tests | 실제 DNS/TLS/Naver 증거 행 필요 |
| Operations | Postgres claim/lease/retry/backoff/dead-letter, outbox, 승인·경보·SLA control plane | `src/platform/jobs/*`, `src/domains/operations/*`, worker/control-plane tests | scheduler와 운영 DB에서 연속 실행 증거 필요 |
| Reporting | 검색·광고·귀속·비용·색인·SLA·추천·수임 일/주간 snapshot, CSV/JSON | reporting/export code and tests, `/d/{token}/reports` | 실데이터가 없으면 `null`/`계산 대기` 유지 |
| GTM | 구조화 문의, 가격 가설, append-only 단계 이력, target→active pipeline, 30/10/5/1 gate | `src/domains/gtm/*`, `/pricing`, `/api/product-leads`, operator GTM panel/tests | 인터뷰·데모·파일럿을 실제 영업 기록으로 채워야 함 |

## 4. 제품 표면

| 사용자 | 경로 | 상태 |
|---|---|---|
| 구매자 | `/`, `/pricing`, `/#contact` | 실제 DB 수치는 연결될 때만 표시; ICP·가격 가설·무보장 문구 포함 |
| 법무법인 운영실 | `/workspace` | ID 로그인 기반 실제 사건·광고·수집 운영 |
| 피해자 | `/case/{slug}`, `/response/{slug}` | firm/domain/publication chain 검증 후 렌더; CTA·상담·이벤트 연결 |
| 고객 | `/d/{token}` | 비용→검색→적격상담→수임 개요 |
| 고객 | `/d/{token}/activation` | DB 증거 8개 gate, ready/pending/blocked |
| 고객 | `/d/{token}/search` | 색인·검색어·노출·클릭·CTR·순위·refresh |
| 고객 | `/d/{token}/ads` | 고객 정책·자산 승인·광고 상태·성과 |
| 고객 | `/d/{token}/leads/{leadId}` | 이해충돌 보조, 적격 판단, 상담, 수임 결과 |
| 고객 | `/d/{token}/reports` | 일/주간 report와 CSV/JSON export |
| 운영자 | `/operator` | source·case·approval·publication·job·alert·SLA·activation·GTM |

## 5. 일일 무인 루프

`scripts/agent/daily.sh`는 다음 순서를 fail-closed로 실행한다.

1. target schema 29개 relation preflight
2. 수집·harvest·경쟁사 누적 합집합·후보화
3. 제한된 LLM 추출과 deterministic ingest
4. legacy DB + source ledger + case entity sync
5. opportunity·content·approval·durable jobs
6. publication worker와 HTTP verification
7. 광고 dry-run 또는 이중 전역 opt-in + 고객 정책 내 실등록
8. 광고 심사, 검색 snapshot, 광고 stats 동기화
9. 일/주간 고객 report
10. legacy compatibility 편입, publication·광고 완료 불변식, 성공 marker와 agent run

DB·schema·정본 동기화·worker·성과 sync·report 중 핵심 단계가 실패하면 성공 marker를 기록하지 않는다. 광고 외부 변경은 기본적으로 꺼져 있다.

## 6. Migration과 배포 전제

- `drizzle/0009_*`~`drizzle/0022_*`가 additive target migration이다.
- `0021`은 `product_lead_profiles`를 추가한다.
- `0022`는 증거 메모와 행위자를 포함한 `product_lead_stage_history`를 추가한다.
- 저장소에서 migration 파일은 생성했지만 운영 DB에는 적용하지 않았다.
- 현재 로컬 `.env.local` DB가 target schema보다 뒤처진 경우 legacy `/api/events`와 `/api/leads`는 canonical 값을 꾸며내지 않고 호환 insert를 시도한다.
- 일일 production pipeline은 호환 skip을 성공으로 오인하지 않도록 schema preflight에서 중단한다.

## 7. 완료로 주장할 수 없는 항목

다음은 코드를 더 작성한다고 완료되는 항목이 아니다.

- 실제 고객 자산으로 30일 운영
- 일일 핵심 파이프라인 성공률 95% 이상과 최소 14회 연속 정상
- 적격 상담 귀속률 95% 이상
- 사람 세션 100건 또는 적격 리드 10건
- 유료 고객 3~5곳의 8주 유지와 동일 가격대 갱신
- 고객당 주 30분·월 2시간 이하 운영
- 유료 고객 10곳, 3개월 유지율 80%, gross margin 70%
- discovery 속도·적격 상담 경제성·outcome benchmark 우위

이 수치는 운영 DB, 고객 행동, 광고비와 계약 증거가 생긴 뒤에만 갱신한다.

## 8. Release verification

최종 handoff 기준 검증 결과:

| 검증 | 결과 |
|---|---|
| TypeScript/Vitest | 127 files, 737 tests 통과 |
| 수집기 Python 회귀 | 56 tests 통과 |
| Next production build | TypeScript·83개 static page generation 포함 통과 |
| shell 문법·diff whitespace | 통과 |
| desktop browser | 제품 홈·가격·공유 데모·데모 프로필, 수평 overflow·console error 0 |
| mobile browser | 390×844 제품 홈·가격·사건 페이지·고객/운영자 데모, 수평 overflow·console error 0 |
| demo 폐쇄루프 | 합성 상담 제출→고객 dashboard 표시→operator 승인→SEO published·광고 ready 전파 후 workspace 초기화 |

재검증 명령:

```bash
npm test
npx tsc --noEmit
npm run build
zsh -n scripts/agent/collect.sh scripts/agent/daily.sh scripts/agent/daily-supervisor.sh scripts/agent/click-collection-daemon.sh scripts/agent/click-collection-pipeline.sh scripts/agent/pipeline-lock.sh
git diff --check
```

별도로 localhost에서 제품 랜딩, 가격, 공유 데모, 고객 dashboard 주요 viewport와 legacy DB 호환 API를 확인한다. 실제 DB migration, Vercel deploy, DNS/TLS, Naver live mutation은 명시적 승인 없이는 수행하지 않는다.
