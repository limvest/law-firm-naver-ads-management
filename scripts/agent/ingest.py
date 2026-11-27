#!/usr/bin/env python3
"""수집 인박스 → data/keywords.json 적재 (파일 기반 DB 미러 — DATABASE_URL 연결 전 스테이징).

입력:
  data/keyword-inbox/<DATE>.ndjson             수집 원본 (collect.sh)
  data/keyword-inbox/<DATE>-extracted.json     (선택) 에이전트 LLM 2패스 추출 결과:
      [{"name","slug","scamType","aliases":[],"evidenceLinks":[]}]
규칙:
  - 신규 업체명 키워드는 status='discovered' 로만 적재 (게시는 별도 승인 게이트 — BLUEPRINT 상태머신)
  - 업체명은 금지어 린트 대상 아님(게시 아님)이나 slug 는 URL-safe 검증
  - observations: (sourceUrl) 단위 dedupe, sourceType='news'
사용: python3 scripts/agent/ingest.py [DATE=today]
"""
import json, sys, re, os, tempfile, urllib.parse
from datetime import datetime, timezone

from keyword_matcher import MultiPatternMatcher

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
DAY = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime('%Y-%m-%d')
INBOX_KEY = os.environ.get('KEYWORD_INBOX_KEY', DAY)
INBOX = os.path.join(ROOT, f'data/keyword-inbox/{INBOX_KEY}.ndjson')
EXTRACTED = os.path.join(ROOT, f'data/keyword-inbox/{INBOX_KEY}-extracted.json')
FACTS = os.path.join(ROOT, f'data/keyword-inbox/{INBOX_KEY}-facts.json')  # URL→구조화 사실 (harvest 산출)
STORE = os.path.join(ROOT, 'data/keywords.json')

QUERY_TO_SLUG = {
    '리딩방 사기 거래소': 'leading-room',
    '코인 사기 출금 거절': 'coin-exchange',
    '투자 사기 앱 피해': 'stock-leading',
    '로맨스 스캠 피해': 'romance-scam',
    '중고거래 사기 안전결제': 'secondhand',
    '주식 리딩 사기 피해': 'stock-leading',
}

# Keep legacy inbox ingestion aligned with harvest.py. Exact reviewed mirrors
# only; an unknown domain remains its own hostname family.
REVIEWED_MIRROR_FAMILIES = {
    'competitor-d-1.example.com': 'competitord-law',
    'competitor-d-2.example.com': 'competitord-law',
    'competitor-d-3.example.com': 'competitord-law',
    'competitor-d-4.example.com': 'competitord-law',
    'competitor-b-office.kr.example.com': 'competitorb-law',
    'competitor-b-office.co.example.com': 'competitorb-law',
    'competitor-b-office.com.example.com': 'competitorb-law',
    'competitor-b-office.org.example.com': 'competitorb-law',
    'competitor-b-office.biz.example.com': 'competitorb-law',
    'competitor-b-office.net.example.com': 'competitorb-law',
    'competitor-b.example.com': 'competitorb-law',
    'competitor-a-victimcare.example.com': 'competitora-law',
    'competitor-a-fraud.example.com': 'competitora-law',
    'competitor-a-fincrime.example.com': 'competitora-law',
    'competitor-a-fintech.example.com': 'competitora-law',
    'competitor-a-light.example.com': 'competitora-law',
    'competitor-a-response.example.com': 'competitora-law',
    'competitor-c.example.com': 'competitorc-law',
    'competitor-c-crimes.example.com': 'competitorc-law',
}
REVIEWED_MIRROR_BLOG_FAMILIES = {'sampleblog1': 'competitorb-law'}
FAMILY_ALIASES = {
    'competitord': 'competitord-law', '경쟁사D': 'competitord-law',
    'competitorb': 'competitorb-law', '경쟁사B': 'competitorb-law',
    'competitora': 'competitora-law', '경쟁사A': 'competitora-law',
    'competitorc': 'competitorc-law', '경쟁사C': 'competitorc-law',
}


def source_family_for_row(row):
    raw = str(row.get('link') or '').strip()
    try:
        parsed = urllib.parse.urlsplit(raw if '://' in raw else f'https://{raw}')
        host = (parsed.hostname or '').rstrip('.').lower().encode('idna').decode('ascii').removeprefix('www.')
    except Exception:
        host = ''
        parsed = None
    if host in ('blog.naver.com', 'm.blog.naver.com') and parsed is not None:
        query = urllib.parse.parse_qs(parsed.query)
        blog_id = (query.get('blogId') or [parsed.path.strip('/').split('/')[0]])[0].strip().lower()
        if blog_id:
            return REVIEWED_MIRROR_BLOG_FAMILIES.get(blog_id, f'naver-blog:{blog_id}')
    if host in REVIEWED_MIRROR_FAMILIES:
        return REVIEWED_MIRROR_FAMILIES[host]
    explicit = str(row.get('sourceFamily') or '').strip()
    if explicit:
        return FAMILY_ALIASES.get(explicit.lower(), explicit)
    return host

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def atomic_json_dump(value, path):
    """독자가 항상 완성된 JSON만 보도록 같은 디렉터리에서 원자적으로 교체한다."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix='.keywords-', suffix='.tmp', dir=directory)
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

def obs_time(it):
    """관측 시각 = 원문 작성 시각 우선 (빈도 분석의 시간축), 없으면 수집 시각."""
    p = it.get('pubDate', '')
    if re.fullmatch(r'\d{13}', str(p)):  # 카페 writeDateTimestamp(ms)
        return datetime.fromtimestamp(int(p) / 1000, tz=timezone.utc).isoformat()
    if p:
        try:
            # sitemap lastmod (ISO-8601). RFC822 parser below is kept for RSS.
            return datetime.fromisoformat(str(p).replace('Z', '+00:00')).isoformat()
        except ValueError:
            pass
        try:
            from email.utils import parsedate_to_datetime
            return parsedate_to_datetime(p).isoformat()  # RSS pubDate
        except Exception:
            pass
    return now_iso()

store = {'keywords': []}
if os.path.exists(STORE):
    store = json.load(open(STORE, encoding='utf-8'))
by_slug = {k['slug']: k for k in store['keywords']}
facts_map = json.load(open(FACTS, encoding='utf-8')) if os.path.exists(FACTS) else {}
registry_path = os.environ.get('HARVEST_REGISTRY_PATH', os.path.join(ROOT, 'data/harvest-sources.json'))
registry = {'sources': []}
competitor_families = set()
blocked_source_names = set()

def auto_discovered_source(source):
    config = source.get('config') if isinstance(source.get('config'), dict) else source
    approval_status = str(config.get('approvalStatus') or source.get('approvalStatus') or '').strip().lower()
    if approval_status == 'approved':
        return False
    discovery = config.get('discovery') if isinstance(config.get('discovery'), dict) else source.get('discovery')
    method = str(discovery.get('method') or '').strip().lower() if isinstance(discovery, dict) else ''
    names = [str(source.get('name') or '').strip(), str(config.get('name') or '').strip()]
    return (
        config.get('autoDiscovered') is True
        or source.get('autoDiscovered') is True
        or config.get('collectionBlocked') == 'auto-discovery'
        or source.get('collectionBlocked') == 'auto-discovery'
        or method == 'naver-web-search'
        or any(re.match(r'^자동발견\s*·', name) for name in names)
    )

if os.path.exists(registry_path):
    registry = json.load(open(registry_path, encoding='utf-8'))
    competitor_families = {
        source.get('sourceFamily') for source in registry.get('sources', [])
        if source.get('competitorKeywordSource') is True
        and source.get('sourceFamily')
        and not auto_discovered_source(source)
    }
blocked_source_names = {
    str(source.get('name')).strip() for source in registry.get('sources', [])
    if auto_discovered_source(source) and source.get('name')
}

def ensure_keyword(slug, name, scam_type, status):
    if slug not in by_slug:
        by_slug[slug] = {
            'name': name, 'slug': slug, 'scamType': scam_type, 'aliases': [],
            'status': status, 'firstSeenAt': None, 'lastSeenAt': None, 'observations': [],
        }
        store['keywords'].append(by_slug[slug])
    return by_slug[slug]

# 시드(유형) 키워드 보장 — 유형 관측의 수신처
try:
    seeds_src = open(os.path.join(ROOT, 'src/lib/scam/seed-data.ts'), encoding='utf-8').read()
    for m in re.finditer(r"name:\s*'([^']+)',\s*slug:\s*'([^']+)',\s*scamType:\s*'([^']+)'", seeds_src):
        ensure_keyword(m.group(2), m.group(1), m.group(3), 'published')
except FileNotFoundError:
    pass

added_obs = 0
link_source_type = {}  # 추출 evidenceLinks 의 sourceType 역참조용
link_source_family = {} # 동일 운영 주체/미러를 독립 근거로 중복 집계하지 않기 위한 그룹
link_time = {}          # 추출 evidenceLinks 의 원문 작성시각 역참조용
blocked_links = set()   # 자동발견 소스의 기존 inbox 행 — 후보/관측 적재 금지
if os.path.exists(INBOX):
    for line in open(INBOX, encoding='utf-8'):
        it = json.loads(line)
        source_name = str(it.get('source') or '').strip()
        if source_name in blocked_source_names or re.match(r'^자동발견\s*·', source_name):
            if it.get('link'):
                blocked_links.add(it['link'])
            continue
        family = source_family_for_row(it)
        link_source_type[it['link']] = it.get('sourceType', 'news')
        link_source_family[it['link']] = family
        link_time[it['link']] = obs_time(it)
        q = it['query']
        # '검색/{slug}' = harvest 표적 검색 산출 — 해당 업체에 확정 부착 (형태소 매칭 히트는 제목에 업체명이 없을 수 있음)
        slug = QUERY_TO_SLUG.get(q) or (q.split('/', 1)[1] if q.startswith('검색/') else None)
        if not slug or slug not in by_slug:
            continue
        k = by_slug[slug]
        if any(o['sourceUrl'] == it['link'] for o in k['observations']):
            continue  # dedupe
        k['observations'].append({
            'observedAt': obs_time(it), 'sourceUrl': it['link'],
            'sourceType': it.get('sourceType', 'news'), 'title': it['title'][:200], 'origin': it.get('source', ''),
            'sourceFamily': family,
        })
        k['firstSeenAt'] = k['firstSeenAt'] or now_iso()
        k['lastSeenAt'] = now_iso()
        added_obs += 1

added_kw = 0
if os.path.exists(EXTRACTED):
    for c in json.load(open(EXTRACTED, encoding='utf-8')):
        evidence_links = [link for link in c.get('evidenceLinks', []) if link]
        # An extraction candidate backed only by review-only discovery rows is
        # not allowed to create a keyword, even when the LLM output file was
        # written before the source gate ran. Mixed evidence remains eligible.
        if evidence_links and all(link in blocked_links for link in evidence_links):
            continue
        slug = c['slug']
        assert re.fullmatch(r'[a-z0-9-]{2,60}', slug), f'unsafe slug: {slug}'
        k = ensure_keyword(slug, c['name'], c['scamType'], 'published')  # 자동 게시 (발주자 지시 2026-07-06 — 제동장치는 blocklist·관측언어 린트)
        k['aliases'] = sorted(set(k.get('aliases', []) + c.get('aliases', [])))
        for link in evidence_links:
            if link in blocked_links:
                continue
            if not any(o['sourceUrl'] == link for o in k['observations']):
                k['observations'].append({'observedAt': link_time.get(link) or now_iso(), 'sourceUrl': link, 'sourceType': link_source_type.get(link, 'news'), 'title': '', 'origin': '', 'sourceFamily': link_source_family.get(link, '')})
        k['firstSeenAt'] = k['firstSeenAt'] or now_iso()
        k['lastSeenAt'] = now_iso()
        added_kw += 1

# blocklist 강제 — data/blocklist.json ["slug", ...] 에 있으면 무조건 blocked (게시중지 요청 대응)
blocklist = set()
bl_path = os.path.join(ROOT, 'data/blocklist.json')
if os.path.exists(bl_path):
    blocklist = set(json.load(open(bl_path, encoding='utf-8')))
for k in store['keywords']:
    if k['slug'] in blocklist and k['status'] != 'blocked':
        k['status'] = 'blocked'
        print(f"blocklist: {k['slug']} → blocked")

# 언급 매칭 패스 — 기존 업체명/별칭이 제목에 등장하면 관측 추가 (LLM 불필요, 빈도의 원천)
def norm(s):
    return re.sub(r'\s+', '', s.lower())

matched_obs = 0
if os.path.exists(INBOX):
    company_kws = [k for k in store['keywords'] if k['status'] != 'blocked' and k.get('observations') is not None]
    company_by_slug = {k['slug']: k for k in company_kws}
    patterns = []
    for k in company_kws:
        for name in [k['name']] + k.get('aliases', []):
            minimum_length = 5 if k.get('competitorManaged') else 3
            if len(name) >= 3 and len(norm(name)) >= minimum_length:
                patterns.append((norm(name), k['slug']))
    matcher = MultiPatternMatcher(patterns)
    for line in open(INBOX, encoding='utf-8'):
        it = json.loads(line)
        source_name = str(it.get('source') or '').strip()
        if it.get('link') in blocked_links or source_name in blocked_source_names or re.match(r'^자동발견\s*·', source_name):
            continue
        t = norm(it['title'])
        for slug in matcher.find(t):
            k = company_by_slug[slug]
            if k.get('competitorManaged') and it.get('sourceFamily') in competitor_families:
                continue  # union importer already owns canonical competitor provenance
            if any(o['sourceUrl'] == it['link'] for o in k['observations']):
                continue
            k['observations'].append({
                'observedAt': obs_time(it), 'sourceUrl': it['link'],
                'sourceType': it.get('sourceType', 'news'), 'title': it['title'][:200], 'origin': it.get('source', ''),
                'sourceFamily': source_family_for_row(it),
            })
            matched_obs += 1

# 기존 관측 시각 정정 — 같은 링크의 원문 작성시각을 알게 되면 소급 반영 (멱등)
for k in store['keywords']:
    for o in k['observations']:
        t = link_time.get(o['sourceUrl'])
        if t and t < o['observedAt']:
            o['observedAt'] = t

# 관측별 구조화 사실 부착 — <DATE>-facts.json (URL 키). 멱등: 있으면 갱신 (원문 아님, 파생 사실만)
facts_attached = 0
if facts_map:
    for k in store['keywords']:
        for o in k['observations']:
            fm = facts_map.get(o['sourceUrl'])
            if fm and o.get('facts') != fm:
                o['facts'] = fm
                facts_attached += 1

# first/lastSeenAt 재계산 — 항상 관측 시각의 min/max (수집 시각 아님)
for k in store['keywords']:
    times = sorted(o['observedAt'] for o in k['observations'] if o.get('observedAt'))
    if times:
        k['firstSeenAt'], k['lastSeenAt'] = times[0], times[-1]

atomic_json_dump(store, STORE)
total_obs = sum(len(k['observations']) for k in store['keywords'])
print(f'keywords: {len(store["keywords"])} (+{added_kw} discovered) · observations: {total_obs} (+{added_obs} 유형매칭, +{matched_obs} 업체명매칭) · facts +{facts_attached}건')
