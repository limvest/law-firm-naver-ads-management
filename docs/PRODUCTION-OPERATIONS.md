# 프로덕션 운영 구조와 배포 절차

> **2026-10-15 프로젝트 종료:** prod-a1의 프로젝트 서비스와 예약 작업을 정지했습니다. 아래 배포 절차는 과거 운영·복구 참고용입니다. 보관 위치와 종료 검증은 [프로젝트 종료 기록](PROJECT-SHUTDOWN-20261015.md)을 확인하세요.

운영 구조 최종 확인: 2026-09-02 KST · 디스크 운영 절차 확인: 2026-09-28 KST

이 문서는 `sampleone.attorney` 계열 사이트, 사건명 서브도메인, A1 데이터베이스와 수집기의 실제 운영 구조를 기록한다. 프로덕션 관련 작업을 시작하기 전에 반드시 이 문서를 먼저 읽는다.

## 1. 핵심 결론

- 실제 `sampleone.attorney` 트래픽의 원본 서버는 Vercel이 아니라 **A1 서버**다.
- Cloudflare의 루트·와일드카드·핀테크 DNS가 모두 **Cloudflare Tunnel**을 가리킨다.
- Vercel `lawfirm-ads` 프로젝트와 도메인 별칭은 남아 있지만, 현재 DNS 경로에서는 Vercel 배포만으로 실사이트가 변경되지 않는다.
- 일반 화면 변경은 A1의 Docker Compose `web` 서비스만 배포한다.
- PostgreSQL과 수집 서비스는 웹 배포와 분리한다.

## 2. 실제 요청 경로

```text
사용자 브라우저
  → Cloudflare DNS·프록시·TLS
  → Cloudflare Tunnel
  → A1 Docker network: internal
  → lawfirm-ads-web:3000 (정적 랜딩 게이트웨이)
  → 사건명 `/`는 게시된 HTML, 나머지는 Next.js :3001
  → A1 PostgreSQL (필요한 동적 데이터 조회)
```

### 2.1 사건명 랜딩의 최종 디자인 정본

- 2026-09-28 실제 운영 소스 확인: 9월 11일부터 사건명 호스트 기본 `/`는 `sampleone-benchmark-case-render.ts`를 사용한다. 밝은 Version 3는 비교 이력으로 남아 있다.
- 기본 렌더러는 A1 PostgreSQL의 사건명·관측 건수·변호사 프로필과 상담 라우팅 정보를 주입한다. 공개 사건명 `/`는 생성된 정적 HTML을 게이트웨이가 제공하며, 파일은 `/var/lib/lawfirm-ads/data/static-landings/current`에 있다. 웹 배포만으로 이미 생성된 HTML이 갱신되지는 않으므로 공통 문구·프로필 변경 시 정적 게시본도 갱신한다.
- `/version3`는 비교 이력용 검수 URL이며 `noindex`다. 검색·광고의 정식 주소는 사건명 호스트의 `/`다.
- `/image`, `/light`, `/reference`는 과거 비교판이며 기본 운영 디자인으로 사용하지 않는다.
- `fintech.sampleone.attorney`, `/fraud`, `/scam`, `/workspace`와 과거 비교·운영 경로는 공개하지 않는다.
- 상단 샘플원 헤더의 최종 높이는 데스크톱 54px(스크롤 후에도 54px), 모바일 52px이며 모바일 사건명 바는 36px다.

확인된 DNS:

| 호스트 | Cloudflare 원본 |
|---|---|
| `sampleone.attorney` | Cloudflare Tunnel CNAME |
| `*.sampleone.attorney` | 동일 Tunnel CNAME |
| `www.sampleone.attorney` | 동일 Tunnel CNAME |
| `fintech.sampleone.attorney` | 동일 Tunnel CNAME |

Cloudflare는 프록시 상태이며 외부 DNS 조회에는 Cloudflare Anycast 주소가 보인다. 실제 원본 판정은 DNS 레코드의 CNAME과 A1의 `cloudflared` 컨테이너를 함께 확인해야 한다.

## 3. A1 서버

- SSH 별칭: `prod-a1`
- 애플리케이션 루트: `/opt/lawfirm-ads`
- 현재 릴리스 링크: `/opt/lawfirm-ads/current`
- 보존 릴리스: `/opt/lawfirm-ads/releases/<release-name>`
- Compose 파일: `deploy/a1/docker-compose.yml`
- 웹 로컬 포트: `127.0.0.1:3100 → container:3000`
- 공유 Tunnel 네트워크: Docker external network `internal`
- Tunnel에서 접근하는 웹 별칭: `lawfirm-ads-web`

`current`가 릴리스 디렉터리를 바로 가리킬 수도 있고, 과거 작업명 심볼릭 링크를 한두 단계 거쳐 실제 릴리스에 도달할 수도 있다. 현재 실체를 확인할 때는 다음 명령을 사용한다.

```bash
ssh prod-a1 'readlink /opt/lawfirm-ads/current; readlink -f /opt/lawfirm-ads/current'
```

## 4. Docker 서비스 역할

| 서비스 | 역할 | 일반 웹 배포 시 처리 |
|---|---|---|
| `web` | Next.js 사이트와 API | 새 이미지 빌드·재생성 |
| `postgres` | 사건명, 관측, 고객사, 리드의 정본 DB | 건드리지 않음 |
| `click-listener` | 클릭 기반 수집 작업 | 건드리지 않음 |
| `daily` | 예약 수집 파이프라인 | 건드리지 않음 |
| `cloudflared` | Cloudflare Tunnel ingress | 건드리지 않음 |

웹 컨테이너는 두 네트워크에 연결된다.

- `lawfirm-ads-agent_default`: PostgreSQL과 내부 서비스 통신
- `internal`: Cloudflare Tunnel과 통신

## 5. PostgreSQL과 비밀정보

- PostgreSQL 17 컨테이너가 A1에서 실행된다.
- 데이터는 Docker volume `postgres-data`에 보존된다.
- PostgreSQL 5432 포트는 인터넷이나 호스트 외부에 공개하지 않는다.
- 웹과 수집기는 Docker 내부 서비스 이름으로 DB에 접근한다.
- 운영 비밀정보는 `/etc/lawfirm-ads/agent.env`와 `/etc/lawfirm-ads/postgres.env`에 별도 설치되어 있다.
- 로컬 `.env*` 파일이나 자격 증명을 릴리스에 복사하지 않는다.
- 백업은 `lawfirm-ads-db-backup.timer`와 `deploy/a1/backup-postgres.sh`가 담당한다.
- GitHub에는 소스와 DB 마이그레이션이 있으며 운영 중 계속 바뀌는 PostgreSQL 데이터의 덤프는 없다. GitHub 커밋만으로 운영 DB를 복구할 수 없으므로 DB 백업은 별도로 필요하다.
- 텔레그램 보트는 `TELEGRAM_CHAT_ID`로 지정한 그룹에서만 `/v`(방문자현황)에 응답하며, webhook은 `TELEGRAM_WEBHOOK_SECRET`로 검증한다.
- 자동 운영 보고는 `lawfirm-ads-telegram-digest.timer`가 매일 09:00·18:00(KST)에 발송한다. 09:00 보고는 전날 18:00~당일 09:00, 18:00 보고는 당일 09:00~18:00를 집계한다.
- 이전 09:05 전일 보고용 `lawfirm-ads-telegram-daily.timer`는 중복 방지를 위해 운영 서버에서 비활성화한다.

DB 마이그레이션이 없는 화면·문구 변경에서는 PostgreSQL을 재시작하거나 Compose 전체를 내리지 않는다.

## 6. Vercel의 현재 역할

- 프로젝트: `example-team/lawfirm-ads`
- Vercel 배포는 빌드 검증 또는 별도 미러/미리보기 용도로 사용할 수 있다.
- Vercel에 `sampleone.attorney` 별칭이 보여도 Cloudflare DNS가 Tunnel을 가리키는 동안 실서비스 원본은 A1이다.
- 따라서 Vercel `READY`와 실사이트 반영 완료를 동일하게 취급하지 않는다.

## 7. 표준 웹 배포 절차

### 7.1 사전 검증

```bash
npm test -- --run <관련 테스트>
npm run build
ssh prod-a1 'docker compose -f /opt/lawfirm-ads/current/deploy/a1/docker-compose.yml ps'
ssh prod-a1 'df -h /; docker system df; readlink -f /opt/lawfirm-ads/current'
```

서버에서 다른 Docker 빌드가 진행 중이면 기다린다. 웹 빌드 시작 전 루트 파일시스템의 **여유 공간이 15GiB 이상**이어야 한다. 부족하면 11절의 대상 확인과 정리 절차를 먼저 마친다. GitHub 커밋은 A1의 릴리스 복사본, Docker 캐시, 생성 데이터 또는 백업을 지우지 않는다.

### 7.2 새 릴리스 생성·전송

릴리스명은 날짜·시간·목적을 포함한다.

```text
/opt/lawfirm-ads/releases/YYYYMMDD-HHMM-<purpose>
```

전송 시 `deploy/a1/release-excludes.txt`를 사용한다. 이미 A1에 있는 릴리스를 기준으로 만들 때는 `bash deploy/a1/prepare-release.sh <원본 디렉터리> YYYYMMDD-HHMM-<purpose>`를 사용한다. 이 스크립트는 새 경로와 15GiB 여유 공간을 확인하고 제외 목록을 적용한다. 기존 실체 디렉터리가 2개보다 많으면 새 릴리스를 만들지 않으므로, 이전 배포의 정리를 마친 후 다음 배포를 시작한다. 로컬에서 직접 전송할 때도 같은 개수·공간 조건을 먼저 확인한다. 주요 제외 항목은 다음과 같다.

```text
.git
.next
.vercel
node_modules
.env*
assets/previz
data/keyword-inbox
data/static-landings
BOOSTER
운영 중 생성된 임시·비밀 파일
```

기존 릴리스 위에 덮어쓰지 않는다.

### 7.3 롤백 이미지 보존

새 이미지를 빌드하기 전에 현재 웹 이미지를 별도 태그로 보존한다.

```bash
docker image tag lawfirm-ads-web:current lawfirm-ads-web:rollback-<release-name>
```

### 7.4 웹만 빌드·교체

새 릴리스 디렉터리에서 다음과 같이 웹만 처리한다.

```bash
docker compose -f deploy/a1/docker-compose.yml build web
docker compose -f deploy/a1/docker-compose.yml up -d --no-deps web
```

다음 명령은 일반 웹 배포에 사용하지 않는다.

```text
docker compose down
docker compose up -d            # 서비스 전체 재생성 가능
postgres 재시작
click-listener 재시작
volume 삭제
docker system prune --volumes
```

### 7.5 A1 내부 검증

Cloudflare를 거치기 전에 실제 Host 라우팅을 확인한다.

```bash
curl -I -H 'Host: sampleone.attorney' http://127.0.0.1:3100/
curl -I -H 'Host: <사건호스트>.sampleone.attorney' http://127.0.0.1:3100/
curl -sS -H 'Host: <사건호스트>.sampleone.attorney' http://127.0.0.1:3100/ | rg '<검증문구>'
```

상태 코드, `x-middleware-rewrite`, 실제 문구, 전화 링크, 상담 폼을 확인한다.

### 7.6 현재 릴리스 전환

내부 검증이 성공한 뒤에만 `current` 링크를 새 릴리스로 원자적으로 교체한다.

```bash
ln -sfn /opt/lawfirm-ads/releases/<release-name> /opt/lawfirm-ads/current.next
mv -Tf /opt/lawfirm-ads/current.next /opt/lawfirm-ads/current
```

### 7.7 외부 검증

Cloudflare 경로를 포함한 공개 URL을 캐시 구분용 쿼리와 함께 확인한다.

```bash
curl -I 'https://sampleone.attorney/?verify=<timestamp>'
curl -sS 'https://<사건호스트>.sampleone.attorney/?verify=<timestamp>' | rg '<검증문구>'
curl -o /dev/null -sS -w '%{http_code}\n' 'https://<미등록호스트>.sampleone.attorney/robots.txt?verify=<timestamp>'
```

최종 확인 항목:

- 루트 도메인 200
- 사건명 서브도메인 200
- 승인되지 않은 호스트는 404
- 승인되지 않은 호스트의 `robots.txt`도 404 (`Bot Management`의 `cf_robots_variant=off`)
- 사건명과 법무법인 샘플원 표시
- `tel:010-0000-0009`
- `#form` 이동과 폼 제출 경로
- 요청한 신규 문구 노출 및 삭제 문구 미노출
- DB·click-listener·cloudflared 상태 유지

검증 직후 `df -h /`와 `docker system df`를 다시 확인하고, 11절에 따라 이번 배포의 직전 릴리스와 롤백 이미지를 남긴 뒤 이전 배포 산출물의 정리 대상을 확인한다. 정리가 필요한데 다른 작업이 해당 릴리스나 빌드를 사용 중이면 해당 작업이 끝난 뒤 처리한다.

## 8. 롤백

새 웹 컨테이너에 문제가 있으면 새 배포 전에 보존한 이미지를 `current`로 다시 태그하고 웹만 재생성한다.

```bash
docker image tag lawfirm-ads-web:rollback-<release-name> lawfirm-ads-web:current
docker compose -f <이전 릴리스>/deploy/a1/docker-compose.yml up -d --no-deps --force-recreate web
```

그 다음 `/opt/lawfirm-ads/current`를 이전 릴리스로 되돌리고 내부·외부 검증을 반복한다. DB volume과 수집 서비스는 롤백 대상이 아니다.

## 9. 장애 진단 순서

실사이트가 이전 내용을 반환할 때는 다음 순서로 본다.

1. A1 `127.0.0.1:3100`이 새 내용을 반환하는가
2. `web` 컨테이너가 새 이미지 ID를 사용하는가
3. `cloudflared`와 `web`이 `internal` 네트워크에 함께 연결됐는가
4. Cloudflare DNS의 루트·와일드카드가 Tunnel을 가리키는가
5. 공개 URL이 A1 내부와 다른 응답을 반환하는가
6. 마지막으로 Cloudflare 캐시·Tunnel ingress 설정을 확인한다

Vercel 배포 상태는 이 진단 순서에 포함하지 않는다. DNS가 Vercel로 변경된 경우에만 Vercel을 실서비스 원본으로 다시 분류한다.

## 10. 변경 금지 원칙

- 실서비스 원본을 확인하지 않고 배포하지 않는다.
- 자격 증명 값을 로그·문서·명령 출력에 노출하지 않는다.
- 웹 문구 변경 때문에 DB, 수집기 또는 Tunnel을 재시작하지 않는다.
- 기존 릴리스와 롤백 이미지를 검증 전에 삭제하지 않는다.
- 공개 웹에 관측 건수를 실제 피해 신고·상담 접수 건수로 오인시키는 문구를 사용하지 않는다.

## 11. A1 디스크 용량과 배포 산출물 관리

### 11.1 공간을 차지하는 네 종류

| 위치 | 내용 | 보존 기준 |
|---|---|---|
| `/opt/lawfirm-ads/releases/` | 배포마다 복사한 소스와 자산. GitHub의 커밋과 별개로 디스크를 차지한다. | `current`가 가리키는 릴리스, 직전 롤백 릴리스, 진행 중인 배포 릴리스만 유지한다. 실제 참조 여부를 확인하기 전에는 정리하지 않는다. |
| `/var/lib/containerd/` | Docker 이미지 계층과 BuildKit 빌드 캐시. 이미지 크기와 캐시 크기는 공유 계층이 있어 단순 합산하지 않는다. | 빌드가 끝난 뒤 `docker system df`로 사용 중인 이미지와 회수 가능한 캐시를 구분한다. 캐시만 필요한 범위에서 정리하며 실행 중인 컨테이너와 볼륨은 유지한다. |
| `/var/lib/lawfirm-ads/data/static-landings/` | 사건명 호스트별 HTML과 gzip 파일. `current` 심볼릭 링크가 게시본을 가리킨다. | 게시본과 직전 게시본 두 버전을 유지한다. 미완성 `.build-*`는 실행 중인 생성 작업이 없음을 확인하고 다룬다. |
| `/var/backups/lawfirm-ads/` 및 Docker PostgreSQL 볼륨 | 복구용 DB 백업과 정본 데이터. | 백업 스크립트의 `-mtime +14` 정책에 따라 오래된 덤프를 다음 백업 때 정리한다. 백업 성공 및 복구 가능성을 확인하지 않고 수동 삭제하지 않는다. PostgreSQL 볼륨은 정리 대상이 아니다. |

2026-09-28 확인 당시 96GiB 루트 디스크에서 릴리스 25개가 약 27GiB, containerd가 빌드 중 19~21GiB, 정적 랜딩이 약 9.5GiB였다. 정적 랜딩 게시본 하나는 약 34,098개 호스트의 HTML과 gzip을 포함해 약 2.3GiB였다. 이 숫자는 진단 기록이며 다음 작업 때 다시 측정한다.

### 11.2 매 배포와 일일 작업의 용량 기준

1. 배포 전 `df -h /`, `df -ih /`, `docker system df`, `readlink -f /opt/lawfirm-ads/current`를 확인한다. 여유 공간 20GiB 미만이면 증가 원인을 조사하고, **15GiB 미만에서는 새 웹 빌드를 시작하지 않는다**. 동시에 진행 중인 빌드와 정적 랜딩 생성 작업도 확인한다.
2. 릴리스는 새 디렉터리에 만들되, 운영 검증과 롤백 확인이 끝난 뒤 과거 릴리스가 계속 누적되지 않도록 보존 대상을 재확인한다. `current`, 직전 롤백, 진행 중인 작업이 사용하는 경로와 systemd의 직접 참조를 먼저 확인한다. 원격 Git 이력은 배포 소스 복구에 쓰고, 서버에는 필요한 실행·롤백 산출물만 둔다.
3. Docker 빌드는 한 번에 하나만 실행한다. 배포가 끝난 뒤 `docker buildx du --verbose`의 `Private`와 `Shared`를 구분하고, 빌드가 없는 상태에서 전용 캐시를 약 5GiB 이내로 관리한다. 정리 대상과 용량을 승인받은 경우에만 `docker buildx prune --max-used-space 5gb --force`를 실행하고 전후 `docker system df`를 비교한다. 이미지와 공유하는 계층 때문에 `docker system df`의 Build Cache 합계는 5GiB보다 크게 보일 수 있다. `docker system prune --volumes`나 실행 중인 이미지·컨테이너·볼륨을 대상으로 한 포괄 정리는 하지 않는다.
4. 정적 랜딩은 서비스 사용자(현재 호스트 UID 1000)가 생성한다. root로 수동 생성하면 보존 정리가 권한 오류로 멈출 수 있다. 게시 후 `current`가 새 버전을 가리키는지, 게시본과 직전본만 남았는지, `static landing retention cleanup failed` 로그가 없는지 확인한다. 실패한 `.build-*`가 남으면 생성 프로세스가 끝났는지 확인한다.
5. 다음 일일 작업 전에 15GiB 미만으로 내려갔거나 정적 랜딩 생성에서 `ENOSPC`가 났다면, 공간을 확보하고 실패 원인을 확인하기 전까지 같은 작업을 무작정 재시도하지 않는다. DB 백업은 계속 보존한다.
6. DB 정기 백업은 매일 03:20 KST에 한 번 실행된다. 스크립트의 `find -mtime +14`는 대략 15일 이상 된 덤프를 다음 백업 때 정리한다. 별도 DB 변경 전 복구 지점이 필요한 경우에는 최신 정기 백업 시각을 먼저 확인하고, 추가 덤프의 목적·경로·정리 시점을 작업 기록에 남긴다. 같은 날 반복해서 덤프를 만들거나 `/home/ubuntu/backups`에 별도 복사본을 쌓는 일을 기본 절차로 삼지 않는다. 보존 기간 변경은 복구 필요성과 다른 위치의 백업을 확인한 뒤 결정한다.

### 11.3 정리 전 확인과 사후 검증

정리 후보를 **경로별 용량·소유자·수정 시각·현재 참조 여부**와 함께 적고 승인받는다. 여러 항목을 한 번에 지우거나 재귀적으로 지워야 하면 그 목록에 대한 명시적 승인을 먼저 받는다. 실제 삭제는 한 명시적 경로씩 별도 명령으로 실행한다. 와일드카드 삭제, 일괄 삭제 루프, 볼륨 삭제, 전체 Docker prune은 사용하지 않는다.

예외: 2026-09-28 사용자가 승인한 11.6절의 완료 수집 기록 보존 정책은 `maintain-inbox.py`가 자동 처리한다. 이 승인은 매니페스트의 검증 후 압축 대체와 30일 지난 압축본 만료에 한정하며, 릴리스나 DB 백업의 자동 삭제로 확대하지 않는다.

정리 직전에는 `current`와 정적 랜딩 `current` 링크, 실행 중인 빌드·생성 작업, 백업 타이머를 다시 확인한다. 정리 후에는 `df -h /`, `docker system df`, 해당 릴리스의 `docker compose -f deploy/a1/docker-compose.yml ps`, A1 내부의 실제 `Host` 헤더 요청, 공개 URL을 확인한다. 용량 회수량과 보존한 롤백 경로를 작업 기록에 남긴다.

### 11.4 2026-09-28 정리 기록

- 사용자 승인 범위에서 미참조 릴리스 19개, 미사용 정적 랜딩 디렉터리 5개, 사용하지 않는 Docker 빌드 캐시를 정리했다. 삭제는 릴리스와 랜딩을 각각 명시한 단일 경로별로 실행했다. DB 볼륨·백업·운영 컨테이너는 건드리지 않았다.
- 루트 디스크는 정리 직전 **96% 사용·4.2GiB 여유**에서 **66% 사용·33GiB 여유**로 바뀌었다. 릴리스는 25개·27GiB에서 6개·7.4GiB로, 정적 랜딩은 9.5GiB에서 두 게시본·4.5GiB로 줄었다. containerd는 약 14GiB이며, BuildKit의 `Private` 약 5.0GB와 이미지 공유분 약 2.7GB를 포함한다.
- 당시 `current`는 `20260928-1543-direct-stock-cases`, 정적 랜딩 `current`는 `landing-20260927T000555Z`였다. 직전 웹 릴리스와 실행 중인 클릭 수집기·자동 입찰이 참조하는 릴리스도 보존했다. 내부·공개 사건명 호스트는 HTTP 200, 공개 루트는 HTTP 200, DB·백업 타이머는 정상 상태였다. 이날 앞서 디스크 부족으로 실패한 `lawfirm-ads-daily.service`는 재실행하지 않았다.

### 11.5 정리 후에도 남은 약 63GiB의 구성

2026-09-28 16:18 KST의 `df -B1 /` 사용량은 67,476,799,488바이트(약 62.8GiB, 66%)였다. 같은 시각 `du -sxB1`로 측정한 최상위 경로는 다음과 같다. 하위 항목을 최상위 경로에 다시 더하지 않는다.

| 최상위 경로 | 사용량(반올림) | 주요 하위 항목 |
|---|---:|---|
| `/var` | 35.1GiB | containerd 약 14GiB, 법무법인 앱 데이터 약 8.4GiB, DB 백업 약 6GiB, Docker 볼륨 등을 포함한 `/var/lib/docker` 약 4GiB |
| `/home` | 10.8GiB | 이전 `tele8210` 복사본 3.2GiB, 별도 백업 2.6GiB, 운영 중인 `tele8210bot` 2.3GiB, 사용자 캐시 1.6GiB |
| `/opt` | 7.7GiB | 참조 때문에 보존한 릴리스 6개 7.4GiB |
| `/swapfile` | 4.0GiB | 시스템 스왑 파일 |
| `/usr` | 2.9GiB | 운영체제와 설치된 프로그램 |
| `/root` | 2.4GiB | 보안 점검용 파일 약 1.2GiB와 root의 Trivy 캐시 약 1.3GiB |

남은 공간 전부가 필수 운영 데이터라는 뜻은 아니다. 이전 봇 복사본, 별도 백업, 세 위치에 각각 있는 Trivy DB 캐시(`/var/lib/trivy`, `/home/ubuntu/.cache/trivy`, `/root/.cache/trivy`)와 root의 점검용 파일은 **추가 검토 후보**다. 이번 승인 범위 밖이므로 삭제하지 않았고, 사용처와 복구 필요성을 확인한 뒤 별도로 판단한다.

2026-09-28 확인 당시 `/var/backups/lawfirm-ads`에는 9월 19~27일 덤프 14개가 있었고, 이 중 5개는 정기 백업 시각인 03:20 KST 외에 생성됐다. 생성 주체와 당시 복구 목적은 확인되지 않았으므로 정기 백업과 동일하게 취급하거나 임의로 삭제하지 않는다. `/home/ubuntu/backups`의 2.6GiB는 별도 시점의 백업 파일이며 GitHub에는 포함되지 않는다.

### 11.6 저장 구조 효율화

- 배포 원본의 `assets/previz`는 릴리스당 약 664MiB의 제작용 영상 원본이며, 확인한 웹·수집 코드에 사용 경로가 없었다. 릴리스 전송과 기본 Docker 빌드 대상에서 제외한다. 운영 수집기는 별도 `Dockerfile.agent.dockerignore`가 이미 `assets`를 제외하고 있었으므로 이번 수집기 이미지 크기는 거의 변하지 않았다. `public/assets`의 실제 제공 파일은 유지한다.
- 정적 랜딩 생성기는 이전 게시본과 바이트가 같은 HTML·gzip을 하드링크로 공유한다. 일부 호스트만 갱신할 때도 그대로인 파일은 복사하지 않는다. 게시 파일을 직접 덮어쓰면 다른 버전까지 바뀌므로 모든 변경은 임시 파일 작성 후 rename으로 교체한다. 권한이나 파일시스템 때문에 링크가 불가능하면 일반 복사로 대체한다.
- 9월 26·27일 게시본 비교에서 공통 33,808개 중 33,384개 HTML이 같았다. 두 버전을 유지하면서 약 2.1GiB를 공유할 수 있었다. 게시 디렉터리 각각의 논리 크기보다 `du -sh /var/lib/lawfirm-ads/data/static-landings`의 실제 합계를 확인한다.
- 수집 매니페스트는 하루 약 100MiB이며 체크포인트의 이전·후보·확정 상태를 포함한다. 수집 로직과 체크포인트 형식을 변경하지 않고 `deploy/a1/maintain-inbox.py`로 완료 기록을 압축한다. 최근 48시간, 체크포인트 미확정, 후보 파일이 남아 있는 기록은 보존한다. gzip은 원본과 압축 해제 결과의 SHA-256이 일치한 뒤 원본을 대체한다.
- 압축본은 원본 수정 시각 기준 30일간 보존하고, 완료 시각·처리 통계·원본 해시를 담은 작은 요약 파일은 남긴다. 오래된 기록을 재처리하려면 유지관리 타이머를 잠시 멈추고 필요한 gzip 한 파일을 복원·검증한 뒤 수정 시각을 갱신한다. 실패 기록은 자동 삭제하지 않는다.
- 유지관리 실행 전 기본 모드에서 대상 목록을 확인한다. `--apply`는 승인된 보존 정책을 실제 적용한다. 일일 타이머는 매일 14:10 KST 이후 실행하고 수집 파이프라인이 실행 중이면 건너뛴다. 이 정책의 서버 설치·적용 결과는 아래 작업 기록에 별도로 남긴다.
- 웹·수집기 롤백 이미지를 각각 유지한다. 장기 실행되는 수집기와 입찰 서비스의 호스트 `WorkingDirectory`는 `/opt/lawfirm-ads`로 고정하고 Compose 파일은 `/opt/lawfirm-ads/current/deploy/a1/docker-compose.yml` 절대 경로로 지정한다. 이렇게 하면 웹 배포 뒤에도 호스트 프로세스가 옛 릴리스 디렉터리를 작업 폴더로 붙잡지 않는다. 기존 systemd drop-in의 상대 Compose 경로도 함께 바꾼다. 단순 웹 배포 때문에 수집기를 재시작하지 않으며, 수집기 자체 배포 때만 순차 재시작하고 실제 참조를 재확인한다.

### 11.7 2026-09-28 효율화 적용 결과

사용자는 현재·직전 릴리스와 30일 수집 기록을 보존하는 전체 적용을 승인했다. A1의 `20260928-1543-direct-stock-cases` 운영 소스를 기준으로 효율화 파일만 반영한 `20260928-1702-storage-efficiency`를 만들었다. 로컬 main 전체를 서버에 덮어쓰지 않았다.

| 항목 | 적용 전 | 적용 후 |
|---|---:|---:|
| 루트 파일시스템 사용률 | 66% | 57% |
| 여유 공간 | 약 33GiB | 약 41.8GiB |
| 릴리스 실체 디렉터리 | 6개 · 약 7.4GiB | 2개 · 약 1.5GiB |
| 정적 랜딩 두 게시본 합계 | 약 4.5GiB | 약 2.3GiB |
| keyword-inbox | 약 2.2GiB | 약 0.71GiB |
| DB·DB 덤프·Docker 저장소를 제외한 릴리스+앱 파일 | 약 15.8GiB | 약 6.2GiB |

- 최종 측정: 루트 사용 58,033,061,888바이트, 가용 44,838,256,640바이트. 앞선 66% 측정값보다 약 8.8GiB의 여유 공간을 확보했다. 앱 디렉터리와 그 하위 항목은 중복 합산하지 않는다.
- 새 릴리스는 427MiB다. 승인된 `20260909-storage-fix`, `20260910-0612-local-host-only`, `20260914-telegram-copy`, `20260922-0006-shared-direct-group`, `20260922-0013-shared-direct-mirror`는 프로세스 작업 폴더·열린 파일·컨테이너 마운트 참조가 없음을 확인한 후 각각 삭제했다. 현재본과 직전 `20260928-1543-direct-stock-cases`를 보존했다.
- 정적 랜딩 9월 26·27일 두 버전의 동일 HTML·gzip 66,768개를 실제 바이트 비교 후 공유해 2,330,640,384바이트의 할당 공간을 회수했다. 게시 대상과 HTML 내용은 그대로다. 생성기의 실제 호스트 1개 검증도 두 파일을 공유했으며, 게시하지 않은 검증 디렉터리는 제거했다.
- 완료 매니페스트 28개는 gzip 복원 해시 검증 후 압축했다. 이 중 30일을 지난 4개의 압축본은 승인 정책에 따라 만료했고 요약은 보존했다. 최종 상태는 원본 4개, 압축본 24개, 요약 28개다. 원본에는 최근 실행과 미확정·실패 기록이 남아 있다.
- `lawfirm-ads-storage-maintenance.timer`가 매일 14:10~14:20 KST에 정책을 실행한다. 압축과 만료 작업은 모두 `Result=success`, `ExecMainStatus=0`으로 끝났다. 수집 중이면 건너뛴다.
- 수집기와 입찰 서비스는 새 이미지와 고정 작업 경로로 전환했다. 입찰의 기존 정책·오버레이는 유지했다. 수집기는 요청 대기 중이고 입찰은 처리 재개 및 `failures=0`을 확인했다. 새 이미지가 적용된 뒤 기존 이미지는 `lawfirm-ads-agent:rollback-20260928-storage-efficiency`로 보존했다.
- 웹과 PostgreSQL의 컨테이너 ID·시작 시각은 그대로다. 정리 후 내부 사건 페이지, 공개 사건 페이지, 공개 루트는 HTTP 200이다. 내부·공개 사건 HTML은 게시 파일과 해시가 같았다. DB 백업 타이머도 활성 상태다.
- 빌드 캐시는 5GB 상한의 제한 정리를 다시 실행했으며 추가 회수량은 0B였다. DB 데이터와 DB 백업 보존 정책은 변경하지 않았다. 앞서 ENOSPC로 실패한 당일 일일 수집은 별도로 재실행하지 않았으며 다음 예약 실행은 새 수집기 이미지를 사용한다.

### 11.8 2026-09-28 적용 후 기능 점검

18:10 KST 무렵 읽기 전용 점검과 입력 거부 확인을 수행했다. 이번 저장 구조 변경으로 발생한 기능 손상은 발견하지 못했으나, 아래 미검증 구간과 기존 실패 때문에 모든 기능의 무결점 동작을 보장하는 결과는 아니다.

- **랜딩 전체 무결성:** 9월 26일 33,808개와 27일 34,098개, 합계 67,906개 HTML의 SHA-256이 각 매니페스트와 일치했다. 모든 gzip을 압축 해제한 내용도 해당 HTML과 같았다. 변경 페이지를 교체해도 이전 게시본의 내용·inode가 보존되는 저장 헬퍼 테스트 2개가 통과했다.
- **웹 제공:** 루트·텔레그램·대표 사건 호스트는 A1 내부 실제 Host 요청과 공개 URL 모두 HTTP 200이었다. 사건 페이지의 실제 이미지 5개, robots.txt, sitemap.xml도 200이었다. 사건 HTML은 내부 응답이 저장 파일과 같았고, 공개 응답에는 Cloudflare 분석 스크립트 367바이트만 추가됐다. `fintech`와 `/dashboard`의 404는 기존 공개 경로 제한과 일치하며, 로그인 후 운영 기능을 검증한 것은 아니다.
- **문의 API:** 실제 서버의 `/api/leads`에 빈 객체를 보내 400 `invalid_input`을 확인했다. 소스상 이 검증은 DB 저장·상담 알림보다 앞선다. 정상 상담 접수의 DB 저장과 알림 수신까지는 실행하지 않았다.
- **압축 기록:** 남은 gzip 24개를 모두 복원해 요약의 SHA-256과 대조했으며 오류가 없었다. DB의 미완료 변경 이벤트 1,899개는 모두 9월 28일 생성분이고, 해당 일자의 미확정 원본은 압축하지 않았다. 이전 실행의 개별 소스 실패도 압축된 전체 기록 안에 보존된다. 보관 판단의 완료 기준은 체크포인트 확정이며, 개별 소스 전부의 성공을 뜻하지 않는다.
- **수집·입찰:** 클릭 수집 서비스는 요청 대기 중이다. 자동 입찰은 새 이미지에서 실제 처리 중이며 18:05 KST 로그에 처리 1,193개·반영 381개·실패 0개를 확인했다. 새 클릭 수집이나 일일 전체 파이프라인은 강제로 실행하지 않았다.
- **백업·예약:** 최신 DB 덤프 `lawfirm-ads-20260927T182311Z.dump`는 538,994,180바이트이며 `pg_restore --list`가 정상 종료하고 목차 557개를 읽었다. 실제 DB 복원 검증은 아니다. 정기 백업과 보관 타이머는 활성 상태이며, 18:00 KST 텔레그램 요약 서비스는 정상 종료했다. 수신 단말 확인은 하지 않았다. 삭제한 다섯 릴리스를 가리키는 문자열은 확인한 systemd·cron·nginx·Cloudflare 설정에서 발견되지 않았다.
- **기존 실패:** 오늘 일일 수집은 변경 전 정적 랜딩 생성 중 ENOSPC로 실패했고 아직 전체 재실행 성공을 확인하지 않았다. 다음 예약은 9월 29일 08:50 KST 무렵이다. 수동 캠페인 정산 3개는 변경 전부터 `remote contract mismatch`로 실패했다. 텔레그램 비즈채널 전환 작업도 변경 전부터 실패했으며, 현재는 자동 입찰이 점유한 동일 잠금을 nonblocking으로 요구하는 구성이 확인됐다. 광고 정책이나 잠금 규칙을 이번 저장 공간 점검에서 바꾸지 않았다.

### 11.9 2026-09-28 변호사·학력 정보 반영

- 공식 구성원 페이지 <https://sampleone-law.example.com/members>를 확인해 장구번 변호사의 사진·경력·학력을 추가했다. 정오번·강육번·조칠번·윤팔번의 누락된 학력도 추가해 총 5명·14개 학력 항목을 표시한다. `scripts/engine/update-sampleone-members-20260928.sql`은 샘플원 법무법인(id 289283342)의 프로필 JSON만 트랜잭션으로 수정하며 기존 설정을 보존한다.
- 실제 기본 사건 렌더러는 A1의 `sampleone-benchmark-case-render.ts`였다. 해당 운영 파일을 Git에도 기록하고 로컬 기본 렌더러 선택을 운영과 맞췄다. 기본판·V3 공용 프로필 렌더링에 경력과 학력 구분을 추가했다. A1에는 운영 소스 기준으로 변경한 두 렌더러·사진·SQL만 전송했다.
- 현재 릴리스는 `20260928-1815-members-education`, 직전은 `20260928-1702-storage-efficiency`다. `lawfirm-ads-web:rollback-20260928-members-education`을 보존하고 웹만 빌드·교체했다. 수집기·자동입찰·DB·Tunnel 컨테이너 ID는 유지됐다.
- 게시된 34,098개 사건 페이지는 기존 HTML의 변호사 영역과 관련 스타일만 갱신했다. 각 파일의 기존 매니페스트 해시, 변호사 영역 외 내용 불변, 생성 gzip의 복원 일치를 확인한 뒤 `landing-20260928-members-education`으로 원자 게시했다. `landing-20260927T000555Z`를 롤백용으로 유지한다. HTML이 모두 바뀌어 두 게시본의 실제 합계는 약 4.6GiB이며, 이후 동일한 페이지는 기존 생성기의 하드링크 정책으로 공유한다.
- 웹 빌드·타입 검사, 5명과 학력 14개 렌더 확인, 실제 Host 내부·공개 HTTP 200, 신규 사진 200, 공개 브라우저의 경력·학력 표시를 확인했다. 상담 폼과 전화 링크는 보존했으며 실제 상담은 제출하지 않았다.
- 사용자 추가 승인 후 `20260928-1543-direct-stock-cases`와 `landing-20260926T000535Z`를 각 명시 경로별로 삭제했다. 빌드 캐시 제한 정리로 2.217GB를 회수했다. 최종 디스크는 59% 사용·약 40GiB 여유, 릴리스 합계 854MiB다. 별도 전체 DB 덤프는 만들지 않았다.
