# 샘플원 운영 보안 관제 런북

실제 운영 로그 원본은 Cloudflare Tunnel 뒤 A1의 `lawfirm-ads-agent-web-1`이다. 일반 요청과 차단 요청은 한 줄 JSON `security_event` 형식으로 기록되며, query string·Cookie·Authorization·이름·전화번호·상담 본문은 포함하지 않는다.

## 실시간 감시

```bash
scripts/security/watch-production.sh 15m
```

A1에서는 `lawfirm-security-log-collector.service`가 전체 구조화 이벤트를 상시 수집하고, `lawfirm-security-alert.timer`가 1분마다 최근 5분 임계치를 평가한다. 이벤트와 경보는 `/var/log/lawfirm-security`에 root 전용 권한으로 기록하고 매일 압축하여 30일 보존한다. Docker 원본 로그도 `50 MB x 5`로 회전시켜 대량 공격에 의한 디스크 고갈을 제한한다.

```bash
ssh prod-a1 'sudo systemctl status lawfirm-security-log-collector.service lawfirm-security-alert.timer'
ssh prod-a1 'sudo tail -f /var/log/lawfirm-security/alerts.jsonl'
```

자동 텔레그램 경보에는 집계 수치와 IP HMAC 앞 12자리만 포함하며 원 IP, 상담정보, Cookie, Authorization은 전송하지 않는다. 동일 상황의 반복 알림은 기본 15분 동안 억제한다.

원문 IP가 포함될 수 있는 출력은 사건 대응 담당자만 열람한다. 채팅·이슈·공개 문서에 복사하지 않는다. 일반 방문은 IP HMAC으로 묶고, 원 IP는 `forbidden`, `bot_block`, `rate_limit_exceeded`, `csrf_failure` 같은 제한 사건에만 기록한다.

## 우선순위

- 즉시: 5분 내 동일 `ip_hmac`의 `host_mismatch`·`csrf_failure`·`rate_limit_exceeded`가 20건 이상, 또는 5xx가 연속 3건 이상
- 긴급: 등록 키워드 호스트가 404로 바뀌거나 상담 API 정상 요청이 403/5xx로 상승
- 관찰: 단발성 폐쇄 경로 404, 검색봇의 존재하지 않는 URL 요청

## 1차 대응

1. `request_id`, `ray_id`, `ip_hmac`, Host, path, 시각을 보존한다.
2. 정상 네이버 광고 URL과 동일한 Host인지 확인한다. UTM 값은 보안 로그에 기록하지 않는다.
3. Cloudflare에서 동일 Ray ID와 WAF 판단을 확인한다.
4. 대량 요청이면 Cloudflare rate-limit/WAF 차단 규칙을 적용한다. 정상 상담 요청은 차단하지 않는다.
5. 앱 장애면 현재 웹 이미지와 롤백 태그를 확인하고 `docs/PRODUCTION-OPERATIONS.md` 절차로 웹만 롤백한다.

## Cloudflare 플랫폼 제한

Cloudflare Free 플랜은 HTTP Request Logpush를 제공하지 않는다. 일반 보안 설정 변경에는 해당 존으로 제한된 `Zone Settings Edit`, `Zone WAF Edit` API 토큰이 필요하다. Cloudflare의 `robots.txt` 대체 생성을 제어하는 `cf_robots_variant` 변경에는 `Bot Management Edit`가 추가로 필요하며 운영값은 `off`다. 원본 요청의 장기 보존과 자동 경보는 위 A1 상시 관제가 담당한다.
