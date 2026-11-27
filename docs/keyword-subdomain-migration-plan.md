# 키워드 서브도메인 전환 전체 계획

> 상태: 2026-09-01 전체 전환 완료. A1 PostgreSQL의 추적 사건 27,526건을 모두 공개 호스트로 발행했고, Cloudflare 와일드카드 DNS·Tunnel과 308 canonical 리디렉션을 프로덕션에 적용했다. `fintech.sampleone.attorney`는 기존 앱을 유지한다.

## 1. 최종 목표 구조

현재 URL:

```text
https://domain.com/f/mocksite-cp-com
```

변경 URL:

```text
https://mocksite-cp-com-k7p3x9.domain.com/
```

| 요청 | 처리 |
|---|---|
| 등록·공개 승인 키워드 | `200` 사건 상세페이지 |
| 존재하지만 미승인 키워드 | 루트 도메인으로 `302` |
| 미등록 서브도메인 | 루트 도메인으로 `302` |
| 기존 `/f/[slug]` | 신규 서브도메인으로 리디렉션 |
| 서브도메인 sitemap | 해당 키워드 URL 한 건만 반환 |
| 루트 sitemap | 키워드 목록 제외 |
| 알려진 AI 크롤러 | WAF에서 차단 |
| 대량 서브도메인 조회 | 속도 제한·Challenge |

단순 `키워드.domain.com`은 사전 대입으로 등록 여부를 검사할 수 있으므로 사용하지 않는다.

## 2. 1단계: 현재 노출면 전수조사

키워드 전체 목록이 노출되는 모든 경로를 조사한다.

- `app/sitemap.ts`
- `/f`
- `/f/page/*`
- `/f/type/*`
- `/scam/*`
- `/case/*`
- 공개 API
- 페이지 내부 관련 사건 링크
- JSON-LD와 클라이언트 상태
- `robots.txt`
- 정적 데이터 파일
- Next.js 클라이언트 번들
- 기존 27,700개 URL

각 경로를 다음 중 하나로 분류한다.

```text
공개 유지
호스트별 격리
루트로 리디렉션
noindex
삭제
인증 필요
```

## 3. 2단계: 서브도메인 키 생성 규칙

### 3.1 호스트 형식

```text
{읽을 수 있는 키워드 slug}-{비밀 식별값}.{법무법인 도메인}
```

예시:

```text
mockf-k7p3x9.sampleone.attorney
mockqib-r4m8q2.sampleone.attorney
mocksite-cp-com-a9d2w7.sampleone.attorney
```

### 3.2 비밀 식별값

서버 비밀키를 이용한 HMAC으로 생성한다.

```text
HMAC(
  KEYWORD_HOST_SIGNING_KEY,
  firmId + ":" + keywordId
)
```

결과 일부를 Base32로 변환해 8~10자만 사용한다.

- 키워드명만 알아도 URL을 계산할 수 없음
- 법무법인마다 다른 식별값 생성
- DB 순번 노출 방지
- 다른 법무법인의 URL 매핑 추측 방지
- 키워드 이름이 바뀌어도 기존 URL 유지

### 3.3 DNS 길이 제한

DNS label은 최대 63자이므로 다음 기준을 사용한다.

```text
keywordSlug 최대 48자
-
HMAC token 10자
총 59자 이내
```

점·공백·한글은 DNS용 slug로 정규화한다.

## 4. 3단계: DB 구조 추가

기존 `firm_keywords` 관계에 다음 필드를 추가한다.

```text
public_host_label
host_status
host_key_version
host_published_at
host_redirected_at
```

상태:

```text
pending
preview
public
paused
retired
```

제약조건:

- `(firm_id, public_host_label)` UNIQUE
- 공개 상태 키워드만 `200`
- 비공개·중지·차단 키워드는 리디렉션
- host label은 외부 요청으로 변경 불가
- 관리자 또는 게시 파이프라인만 생성 가능

비밀키 교체를 대비해 예전 호스트를 보관하는 alias 테이블도 둔다.

## 5. 4단계: 와일드카드 DNS·SSL

각 법무법인 도메인에 다음을 연결한다.

```text
*.domain.com
```

Vercel에 wildcard domain과 wildcard TLS 인증서를 설정한다. 기존 서비스 호스트가 먼저 처리되도록 라우팅 우선순위를 둔다.

예약 서브도메인은 키워드로 사용하지 않는다.

```text
www
api
admin
operator
workspace
assets
static
mail
fintech
sitemap
robots
```

초기 파일럿은 충돌을 줄이기 위해 다음 구조도 고려한다.

```text
키워드.case.domain.com
```

안정화 후 `키워드.domain.com`으로 확장할 수 있다.

## 6. 5단계: Host 기반 라우팅

`proxy.ts`에서는 DB를 직접 조회하지 않고 호스트만 안전하게 분리한다.

```text
mockf-k7p3x9.domain.com/
          ↓ 내부 rewrite
/_keyword-host/mockf-k7p3x9
```

내부 Route Handler가 다음을 확인한다.

1. 요청 Host가 승인된 법무법인 도메인의 자식인가
2. 서브도메인이 한 단계인가
3. 예약어가 아닌가
4. DB에 정확히 일치하는 host label이 있는가
5. 법무법인이 `active`·`landingReady`인가
6. 키워드가 공개 승인 상태인가

통과하면 상세페이지를 렌더링한다. 실패하면 항상 같은 주소로 리디렉션한다.

```http
HTTP/1.1 302 Found
Location: https://domain.com/
Cache-Control: private, no-store
X-Robots-Tag: noindex, nofollow
```

미등록값에는 DB 오류, 유사 키워드, 존재 여부 사유를 노출하지 않는다.

## 7. 6단계: 페이지 canonical 전환

등록 키워드의 정본 URL을 다음으로 변경한다.

```html
<link rel="canonical"
      href="https://mockf-k7p3x9.domain.com/">
```

같이 변경할 항목:

- Open Graph URL
- JSON-LD WebPage URL
- Article URL
- Breadcrumb URL
- 공유 URL
- 상담 유입 URL
- 광고 랜딩 URL
- 이벤트·전환 귀속 URL

`app/f/[slug]/route.ts`의 canonical 생성부도 호스트 루트 기준으로 변경한다.

## 8. 7단계: sitemap·robots 분리

### 8.1 루트 도메인 sitemap

키워드를 모두 제거한다.

```text
https://domain.com/
https://domain.com/privacy
https://domain.com/lawyers
```

### 8.2 키워드 서브도메인 sitemap

해당 사건 한 건만 제공한다.

```xml
<urlset>
  <url>
    <loc>https://mockf-k7p3x9.domain.com/</loc>
  </url>
</urlset>
```

### 8.3 미등록 서브도메인

```text
/sitemap.xml → 루트로 302 또는 404
/robots.txt  → noindex 정책
```

### 8.4 검색 노출 트레이드오프

중앙 sitemap을 없애면 전체 키워드 목록 노출은 차단되지만 신규 URL의 자연검색 발견 속도는 느려질 수 있다.

- 실제 광고 집행·공개 승인 키워드만 색인 대상으로 운용
- Search Console은 루트 Domain Property로 모든 서브도메인 통합 관찰
- 중앙 sitemap index는 만들지 않음
- 페이지 간 전체 사건 링크도 만들지 않음

검색엔진에 27,700개를 한 번에 알려주면서 그 목록을 외부에는 숨기는 것은 불가능하다.

## 9. 8단계: 공개 목록 제거

다음 경로가 전체 키워드 스크랩 통로가 되지 않도록 변경한다.

```text
/f
/f/page/*
/f/type/*
/scam
공개 검색 API
전체 사건 JSON
관련 사건 전체 링크
```

정책:

- 법무법인 루트 홈페이지에는 전체 사건 목록 미제공
- 사용자 검색은 서버 측 제한 검색으로 제공하거나 인증 필요
- 클라이언트 번들에 사건 배열을 넣지 않음
- 키워드 수와 내부 ID를 HTML에 포함하지 않음
- 관리자 페이지는 기존 인증 유지

## 10. 9단계: WAF·AI 봇 방어

처음부터 차단하지 않고 다음 순서로 적용한다.

### 10.1 로그

- 동일 IP의 전체 요청 수
- 짧은 시간 동안 요청한 서로 다른 Host 수
- 미등록 호스트 리디렉션 비율
- User-Agent와 JA4
- 국가·ASN
- 알려진 AI 크롤러

### 10.2 Challenge

초기 관찰 기준 예시:

```text
1분에 30개 이상 서로 다른 서브도메인 조회
미등록 호스트 연속 20회
정상 페이지 접근 없이 리디렉션만 반복
```

### 10.3 차단

- 알려진 AI 학습 크롤러
- 대량 열거 패턴
- 반복 challenge 실패
- 악성 IP·네트워크

정상 Google·Bing 검색봇은 검증된 경우 허용한다.

Vercel WAF 규칙은 반드시 다음 순서로 적용한다.

```text
로그 → Preview 차단 → Production 로그 → Production 차단
```

## 11. 10단계: 기존 URL 이전

기존 URL을 바로 영구 리디렉션하지 않는다.

### 11.1 파일럿

```text
/f/mockf → 307 → mockf-k7p3x9.domain.com
```

### 11.2 안정화 후

```text
/f/mockf → 308 → mockf-k7p3x9.domain.com
```

기존 검색 신호를 새 URL로 이전한다. 중지·차단된 키워드는 신규 호스트로 보내지 않고 루트 또는 적절한 안내 페이지로 처리한다.

## 12. 11단계: 로컬 검증

로컬에서는 다음 Host를 사용한다.

```text
mockf-k7p3x9.localhost:3000
unknown.localhost:3000
```

검증 항목:

- 등록 Host `200`
- 미등록 Host `302`
- 비공개 키워드 `302`
- 다른 법무법인 키워드 혼선 없음
- canonical 정확성
- sitemap 한 건
- robots 정확성
- Host 헤더 변조 방지
- `evil-domain.com` suffix 우회 방지
- 포트 포함 Host 처리
- 대문자·점·Unicode 처리
- `Vary: Host`
- CDN 캐시 간 법무법인 혼선 없음
- 상담이 정확한 `firmId`·`keywordId`로 기록됨

## 13. 12단계: 보안 테스트

- HMAC 결정성
- 다른 firm에서 다른 token 생성
- 비밀키 없을 때 실행 중단
- host label 충돌 검사
- 63자 DNS 제한
- 예약어 차단
- 미등록 호스트 정보 누설 없음
- 전체 sitemap 키워드 노출 없음
- 공개 API 전체 목록 없음
- 응답 시간 차이를 통한 DB 존재 추정 최소화
- 대량 Host 요청 rate limit
- AI Bot 차단과 Googlebot 허용

프로덕션 소스맵, 기술 식별 헤더 및 상세 오류 메시지도 제거한다.

## 14. 13단계: 단계적 배포

### Stage A — Shadow

- wildcard DNS 연결
- 신규 URL은 `noindex`
- 기존 URL 정본 유지
- 내부 검수만 진행

### Stage B — 50개 파일럿

- 공개 키워드 50개만 신규 Host 활성화
- 기존 URL은 307
- 상담·광고·분석 귀속 검사
- WAF는 로그만 수집

### Stage C — 500개 확대

- 색인·크롤링·리디렉션 확인
- 잘못된 Host, 캐시 혼선, 상담 귀속 확인
- WAF Challenge 적용

### Stage D — 전체 배치

- 한 번에 27,700개를 전환하지 않고 배치 처리
- 실패 시 해당 배치만 중단
- 키워드별 이전 상태 DB 기록
- 최종적으로 기존 URL을 308 전환

## 15. 모니터링 지표

- 등록 Host `200` 비율
- 미등록 Host 리디렉션 수
- IP별 고유 Host 요청 수
- WAF Challenge·차단 수
- Googlebot 크롤링 수
- 신규 Host 색인 수
- 기존 URL 대비 트래픽 변화
- 상담 전환 귀속 누락
- Host별 404·500
- canonical 불일치
- 중복 페이지 판정
- 페이지 응답속도

## 16. 롤백 계획

기능 플래그:

```text
KEYWORD_SUBDOMAIN_MODE=off
KEYWORD_SUBDOMAIN_MODE=shadow
KEYWORD_SUBDOMAIN_MODE=redirect
KEYWORD_SUBDOMAIN_MODE=canonical
```

장애 시:

1. `canonical → shadow` 전환
2. 기존 `/f/[slug]`를 다시 `200` 정본으로 복원
3. 신규 Host는 기존 URL로 `302`
4. WAF 신규 규칙 비활성화
5. wildcard DNS는 유지
6. DB host 매핑은 삭제하지 않고 보존

영구 리디렉션인 308은 파일럿 완료 전 사용하지 않는다.

## 17. 완료 조건

- 루트 sitemap에서 키워드 0건
- 공개 전체 목록 경로 0개
- 등록된 신규 Host만 `200`
- 미등록·미승인 Host는 동일 리디렉션
- Host별 sitemap 한 건
- 기존 URL 검색 신호 이전
- 법무법인 간 데이터 혼선 0건
- 상담 귀속 누락 0건
- 알려진 AI 크롤러 차단
- 대량 Host 열거 Challenge 작동
- 전체 테스트와 프로덕션 빌드 통과
- 롤백 기능 실제 검증 완료

외부에 보이는 것은 개별 사건 페이지뿐이고, 전체 키워드 목록·URL 생성 규칙·미공개 매핑·HMAC 비밀키는 서버 내부에만 남게 하는 것이 최종 목표다.
