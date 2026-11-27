# Keyword search coverage ledger

`source_runs.checkpoint_after`는 다음 조회 위치를 가리키는 힌트이고, 전체 검색
커버리지의 정본이 아니다. 커서가 끝에서 처음으로 wrap되거나 일부 seed가
실패·재시도되면 커서만으로는 같은 keyword를 다시 센다.

## 기록 계약

- `keyword_search_coverage_runs`는 한 `coverage_key + run_key` 순환의 시작 시점에
  eligible seed ID를 스냅샷한다. 기본 eligible 집합은 `keywords.status <> blocked`이며
  `observations`가 하나 이상 있는 keyword다.
- `keyword_search_coverage_batches`는 할당된 seed ID와 최신 성공·최종 실패·재시도
  대기 ID를 보관한다. `seed_ids`와 `batch_key`가 배치의 멱등 경계다.
- `keyword_search_coverage_attempts`는 `batch_id + attempt_key`가 유일한 시도 이벤트다.
  같은 결과를 재전송해도 시도·retry·processed 수가 증가하지 않는다.
- `processed_count`는 성공 또는 재시도하지 않는 최종 실패로 닫힌 고유 seed 수다.
  일시 실패는 `pending_retry_count`와 `pending_seed_ids`에 남고 `remaining_count`에서
  빠지지 않는다. 따라서 `remaining_count = total_eligible - processed_count`가 항상
  성립한다.
- 성공·실패 배열은 배치 단위로, 전체 수치는 모든 배치의 고유 ID를 합집합해 계산한다.
  겹친 배치나 오래된 커서가 있어도 성공 ID를 중복 집계하지 않는다.

## 운영 표면

`readKeywordSearchCoverage()`/`getKeywordSearchCoverage()`는 커서와 독립적으로
정확한 수치를 반환한다. 총운영자 `/operator` 통합 현황에는 전체·성공·최종 실패·재시도
대기·잔여·진행률과 최근 배치 seed ID가 표시되고, `report-run.ts`의 agent report
counts에도 같은 스냅샷이 포함된다.

이 계층은 검색 클라이언트, 소스 활성화, 수집, keyword insert를 호출하지 않는다. 검색
worker가 별도로 얻은 결과를 명시적인 attempt로 기록할 때만 ledger가 변한다.
