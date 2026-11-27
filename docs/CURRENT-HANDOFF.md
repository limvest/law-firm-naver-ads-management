# 현재 작업 인수인계

최종 갱신: 2026-09-04 (Asia/Seoul)

이 문서는 새 작업 세션에서 가장 먼저 확인할 현재 상태 요약이다. 구체적인 서버 접속, 배포, 롤백 절차는 `docs/PRODUCTION-OPERATIONS.md`를 따른다. 비밀키와 로그인 정보는 저장소에 넣지 않고 A1 운영 환경과 암호화된 운영 DB에서만 관리한다.

## 현재 운영 구조

- 운영 웹·API·PostgreSQL·수집/텔레그램 작업은 A1 서버가 담당한다.
- Cloudflare가 `sampleone.attorney` 및 사건명 서브도메인의 DNS·프록시·TLS를 담당한다.
- Vercel은 현재 운영 원본이 아니다.
- 운영 배포는 저장소 코드를 A1의 새 release 디렉터리로 전송하고, 검증 후 `current` 심볼릭 링크를 전환하는 방식이다.
- 마지막으로 확인한 A1 release는 `/opt/lawfirm-ads/releases/20260902-1119-naver-channel-shape`다. 실제 작업 전에는 서버의 `current` 값을 다시 확인한다.

## 랜딩과 데이터

- 법무법인 샘플원 공개 콘텐츠만 `sampleone.attorney`에 연결한다.
- 사건명 랜딩은 사건명 서브도메인을 기본 주소로 사용하고 `/f/{slug}`는 호환 경로로 유지한다.
- `/`, `/image`, `/version3`는 비교용 랜딩 버전이다.
- 문의, CTA 클릭, 체류, 유입 키워드와 세션은 운영 PostgreSQL에 기록하고 텔레그램에서 신규 문의 및 `/v` 방문자 현황을 조회한다.
- 자동 운영 보고는 한국시간 09:00와 18:00에 전송한다.

## 네이버 검색광고 준비 상태

- 원본 사건명: 27,526개
- 실등록 후보: 26,085개
- 제외: 435개
- 중복 통합: 1,006개
- 계획된 광고그룹: 64개(그룹당 약 367~467개)
- 캠페인과 광고 객체는 아직 생성하지 않았다.
- 비즈니스 채널 `법무법인샘플원`은 `https://sampleone.attorney`로 등록되었으며 마지막 확인 당시 PC·모바일 모두 심사 대기 상태였다.
- 채널 승인 전에는 live 등록을 시도하지 않는다. 승인 뒤 `/workspace`의 검색광고 탭에서 상태를 다시 동기화하고 paused 상태로 생성·검수한다.
- 준비 스크립트는 `scripts/engine/prepare-exact-search-campaign.ts`, 성과 동기화는 `scripts/engine/sync-exact-search-stats.ts`다. 외부 변경은 기본 dry-run이며 명시적 live 플래그 없이는 수행하지 않는다.

## API와 비밀정보

| 연동 | GitHub에 포함되는 것 | 실제 비밀정보 위치 |
|---|---|---|
| 네이버 검색광고 | 클라이언트, 서명, 채널 확인, 캠페인 준비·성과 동기화 코드 | A1 PostgreSQL `firm_credentials`의 암호문. 복호화 키는 `/etc/lawfirm-ads/agent.env`의 `CRED_ENC_KEY` |
| 텔레그램 | webhook, 신규 문의, `/v`, 09:00·18:00 보고 코드와 timer | A1 `/etc/lawfirm-ads/agent.env` |
| 방문·문의 | `/api/events`, `/api/engagement`, `/api/leads`와 DB schema | A1 PostgreSQL 및 `/etc/lawfirm-ads/agent.env` |
| Cloudflare | A1 Tunnel을 전제로 한 운영 문서와 호스트 라우팅 코드 | Cloudflare 계정과 A1의 `cloudflared` 설정 |
| 분석 태그 | GTM·Naver WCS 연동 자리와 환경변수 예시 | A1 `/etc/lawfirm-ads/agent.env` |

실제 토큰·API 키·DB 비밀번호는 Git commit에 넣지 않는다. 이미 A1에 설치된 값은 새 release가 같은 `/etc/lawfirm-ads/*.env`와 운영 PostgreSQL을 사용하므로 재입력할 필요가 없다. 새 서버를 구축할 때는 `deploy/a1/agent.env.example`과 `deploy/a1/postgres.env.example`을 복사해 서버에서만 값을 채운다. 네이버 자격증명을 교체해야 할 때는 평문 파일을 만들지 말고 `scripts/engine/store-naver-credentials-from-stdin.ts`로 표준입력해 즉시 암호화 저장한다.

## 바로 이어서 할 일

1. `git pull --ff-only` 후 이 문서와 `docs/PRODUCTION-OPERATIONS.md`를 읽는다.
2. A1의 실제 `current` release, 서비스 상태, 운영 DB 연결 상태를 읽기 전용으로 확인한다.
3. 네이버 비즈니스 채널 심사 상태를 동기화한다.
4. 승인되었으면 exact campaign 계획을 다시 dry-run하고 수량·URL·제외 목록을 검수한다.
5. 사용자 승인 범위 안에서만 live 등록하며 최초 생성물은 paused 상태로 둔다.
6. 광고 집행 뒤 비용·클릭·문의·고관심 세션의 키워드별 귀속을 `/workspace`와 텔레그램 보고에서 확인한다.

## 주요 진입점

- 운영 작업 화면: `https://sampleone.attorney/workspace`
- 운영 절차: `docs/PRODUCTION-OPERATIONS.md`
- 전체 구현 상태: `docs/IMPLEMENTATION-STATUS.md`
- exact campaign 계획: `src/domains/advertising/exact-search-plan.ts`
- 네이버 연동: `src/platform/integrations/naver-searchad-client.ts`
- A1 배포 도구: `infra/a1/`
