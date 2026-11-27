#!/usr/bin/env python3
"""1회 백필 — 기존 카페 관측 본문을 무인증 재수집해 facts 소급 부착.

계약: 원문은 저장하지 않고 구조화 사실만 보존한다.
- data/keywords.json 의 cafe.naver.com 관측 중 facts 없는 것만 대상.
- 본문은 메모리에서만 사용, 원문 디스크 미기록. 파생 facts 만 keywords.json + <today>-facts.json 에 기록.
- 멱등: 이미 facts 있으면 건너뜀. 재실행 안전.
사용: python3 scripts/agent/backfill-facts.py
"""
import json, os, re, sys, time, html, tempfile, urllib.request
from datetime import datetime
from factlib import extract_facts

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
STORE = os.path.join(ROOT, 'data/keywords.json')
SOURCES = os.path.join(ROOT, 'data/harvest-sources.json')
DAY = datetime.now().strftime('%Y-%m-%d')
FACTS_OUT = os.path.join(ROOT, f'data/keyword-inbox/{DAY}-facts.json')
UA = 'Mozilla/5.0 (Macintosh) lawfirm-ads-harvester/1.0'

# cafeUrl(예: samplecafe) → cafeId(clubid) 매핑
srcs = json.load(open(SOURCES, encoding='utf-8'))['sources']
CAFE_ID = {s['cafeUrl']: s['cafeId'] for s in srcs if s.get('type') == 'naver_cafe'}


def atomic_json_dump(value, path):
    """페이지 빌드가 갱신 중인 JSON의 일부를 읽지 않도록 원자적으로 교체한다."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix='.facts-', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=1)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def cafe_body(cafe_id, aid):
    url = ('https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/'
           f'{cafe_id}/articles/{aid}?query=&useCafeId=true&requestFrom=A')
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        a = json.loads(r.read().decode('utf-8', 'replace'))['result']['article']
    c = a.get('contentHtml') or a.get('content') or ''
    return html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', c))).strip()


store = json.load(open(STORE, encoding='utf-8'))
facts_map = json.load(open(FACTS_OUT, encoding='utf-8')) if os.path.exists(FACTS_OUT) else {}
CAFE_RE = re.compile(r'cafe\.naver\.com/([^/]+)/(\d+)')

done = skipped = failed = 0
for k in store['keywords']:
    for o in k['observations']:
        if o.get('facts'):
            skipped += 1
            continue
        m = CAFE_RE.search(o.get('sourceUrl', ''))
        if not m or m.group(1) not in CAFE_ID:
            continue
        try:
            body = cafe_body(CAFE_ID[m.group(1)], int(m.group(2)))
            f = extract_facts((o.get('title') or '') + '\n' + body)
            if f['method'] or f['infra'] or f['amounts']:
                o['facts'] = f
                facts_map[o['sourceUrl']] = f
                done += 1
            time.sleep(0.3)
        except Exception as e:
            failed += 1
            print(f"WARN: {o['sourceUrl']} — {e}", file=sys.stderr)

atomic_json_dump(store, STORE)
if facts_map:
    atomic_json_dump(facts_map, FACTS_OUT)
print(f'backfill: facts +{done}건 · 기존보유 {skipped} · 실패 {failed} → keywords.json, {FACTS_OUT}')
