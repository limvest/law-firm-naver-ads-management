#!/usr/bin/env python3
"""후속 처리까지 성공한 수집 런의 체크포인트 후보를 원자적으로 확정한다."""
import json
import os
import tempfile
from datetime import datetime

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
DAY = os.environ.get('SOURCE_RUN_DAY') or datetime.now().strftime('%Y-%m-%d')
INBOX_KEY = os.environ.get('KEYWORD_INBOX_KEY', DAY)
STATE = os.environ.get(
    'HARVEST_STATE_PATH',
    os.path.join(ROOT, 'data/harvest-state.json'),
)
CANDIDATE = os.environ.get(
    'COLLECTION_CHECKPOINT_CANDIDATE_PATH',
    os.path.join(ROOT, f'data/keyword-inbox/{INBOX_KEY}-checkpoint-candidate.json'),
)
MANIFEST = os.environ.get(
    'COLLECTION_MANIFEST_PATH',
    os.path.join(ROOT, f'data/keyword-inbox/{INBOX_KEY}-collection-manifest.json'),
)


def read_json(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def atomic_json_dump(value, path):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.checkpoint-', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    if not os.path.exists(CANDIDATE) or not os.path.exists(MANIFEST):
        raise SystemExit('checkpoint candidate 또는 collection manifest가 없습니다')
    candidate = read_json(CANDIDATE)
    manifest = read_json(MANIFEST)
    if manifest.get('runKey') != INBOX_KEY:
        raise SystemExit('checkpoint candidate와 manifest 실행 키가 일치하지 않습니다')

    atomic_json_dump(candidate, STATE)
    for run in manifest.get('sourceRuns', []):
        if run.get('status') == 'succeeded':
            run['checkpointCommitted'] = run.get('checkpointCandidate', {})
    manifest['checkpointCommittedAt'] = datetime.now().astimezone().isoformat()
    atomic_json_dump(manifest, MANIFEST)
    os.unlink(CANDIDATE)
    print(f'checkpoint-commit: {INBOX_KEY} · {len(manifest.get("sourceRuns", []))}개 소스 확정')


if __name__ == '__main__':
    main()
