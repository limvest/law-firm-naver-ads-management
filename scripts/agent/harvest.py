#!/usr/bin/env python3
"""사기업체 harvester — 소스 레지스트리(data/harvest-sources.json) 순회 수집.

소스 타입:
  naver_cafe  공개 카페 게시판 제목을 cafe-web 공개 JSON API로 수집 (로그인·본문 접근 없음)
  webpage     지정 URL의 HTML 텍스트 발췌 (법무법인 리스트 공유 페이지 등)
  sitemap     공개 사이트맵의 URL·lastmod 메타데이터만 수집 (경쟁사 본문 복제 없음)
  google_news_rss  고정 검색어의 Google News 공개 RSS 제목·링크 수집

출력: data/keyword-inbox/<DATE>.ndjson 에 append (collect.sh 와 동일 스키마 + sourceType)
증분: data/harvest-state.json 에 소스·메뉴별 마지막 articleId 저장 → 재수집 방지
사용: python3 scripts/agent/harvest.py [DATE=today]
"""
import copy, json, os, re, ssl, sys, time, html, zlib, tempfile, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, date, timedelta
from factlib import extract_facts   # 본문 → 구조화 사실 (원문 무저장)
from feedlib import (
    case_name_from_page_title,
    case_name_from_keyword_slug,
    collect_sitemap_entries,
    detect_sitemap_changes,
    extract_html_metadata,
    extract_html_headings,
    extract_detail_text,
    extract_same_origin_links,
    extract_naver_blog_text,
    parse_naver_loose_json,
    sitemap_entry_fingerprints,
    sitemap_title,
)
from source_health import record_source_health

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
args = [a for a in sys.argv[1:] if not a.startswith('--')]
MANUAL_RUN = '--manual' in sys.argv or os.environ.get('MANUAL_COLLECTION') == '1'
SOURCE_ONLY = os.environ.get('COLLECTION_SOURCE_ONLY') == '1'
BACKFILL = 0  # --backfill N: 카페 게시판을 N페이지 소급 수집 (커서 무시, 링크 dedupe 로 안전)
for a in sys.argv[1:]:
    if a.startswith('--backfill'):
        BACKFILL = int(a.split('=')[1]) if '=' in a else 10
DAY = args[0] if args else datetime.now().strftime('%Y-%m-%d')
INBOX_KEY = os.environ.get('KEYWORD_INBOX_KEY', DAY)
INBOX_DIR = os.environ.get('KEYWORD_INBOX_DIR', os.path.join(ROOT, 'data/keyword-inbox'))
OUT = os.path.join(INBOX_DIR, f'{INBOX_KEY}.ndjson')
FACTS_OUT = os.path.join(INBOX_DIR, f'{INBOX_KEY}-facts.json')   # URL→facts (파생, 원문 아님)
MANIFEST_OUT = os.environ.get(
    'COLLECTION_MANIFEST_PATH',
    os.path.join(INBOX_DIR, f'{INBOX_KEY}-collection-manifest.json'),
)
REGISTRY = os.environ.get('HARVEST_REGISTRY_PATH', os.path.join(ROOT, 'data/harvest-sources.json'))
STATE = os.environ.get('HARVEST_STATE_PATH', os.path.join(ROOT, 'data/harvest-state.json'))
STATE_CANDIDATE = os.environ.get(
    'COLLECTION_CHECKPOINT_CANDIDATE_PATH',
    os.path.join(INBOX_DIR, f'{INBOX_KEY}-checkpoint-candidate.json'),
)
HEALTH = os.environ.get('HARVEST_HEALTH_PATH', os.path.join(ROOT, 'data/harvest-health.json'))
UA = 'LawfirmAdsSourceAnalyzer/1.0'
# 선택: 회원전용(등급제한) 글 본문 접근용 네이버 세션 쿠키 (.env.local NAVER_COOKIE="NID_AUT=…; NID_SES=…").
# 계정 밴 리스크 최소화 원칙 — 목록·검색은 무인증 유지, 쿠키는 '본문 API'에만 붙인다.
NAVER_COOKIE = os.environ.get('NAVER_COOKIE', '').strip()

SKIP_TITLE = re.compile(r'임시적으로 게시가 중단|삭제된 게시글')

# Exact, reviewed mirror relationships only. Unknown hosts intentionally fall
# back to their own hostname; fuzzy/registrable-domain grouping is unsafe here.
REVIEWED_MIRROR_FAMILIES = {
    'competitor-d-1.example.com': 'competitord-law',  # competitor-d-1.example.com
    'competitor-d-2.example.com': 'competitord-law',           # competitor-d-2.example.com
    'competitor-d-3.example.com': 'competitord-law',   # competitor-d-3.example.com
    'competitor-d-4.example.com': 'competitord-law',  # competitor-d-4.example.com
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


def _source_hostname(value):
    raw = str(value or '').strip()
    if not raw:
        return ''
    try:
        parsed = urllib.parse.urlsplit(raw if '://' in raw else f'https://{raw}')
        host = (parsed.hostname or '').rstrip('.').lower()
        # URL parsing leaves Unicode hostnames intact on some Python versions.
        return host.encode('idna').decode('ascii').removeprefix('www.')
    except Exception:
        return ''


def source_family(src):
    """Return a conservative source family for a registry source."""
    source_type = str(src.get('type') or '').lower()
    blog_id = str(src.get('blogId') or '').strip().lower()
    source_url = str(src.get('url') or '').strip()
    host = _source_hostname(source_url)
    if host in ('blog.naver.com', 'm.blog.naver.com'):
        try:
            parsed = urllib.parse.urlsplit(source_url)
            blog_id = (urllib.parse.parse_qs(parsed.query).get('blogId') or [blog_id])[0].strip().lower()
            if not blog_id:
                blog_id = parsed.path.strip('/').split('/')[0].lower()
        except Exception:
            pass
    if blog_id and (source_type == 'naver_blog' or host in ('blog.naver.com', 'm.blog.naver.com')):
        return REVIEWED_MIRROR_BLOG_FAMILIES.get(blog_id, f'naver-blog:{blog_id}')
    if host in REVIEWED_MIRROR_FAMILIES:
        return REVIEWED_MIRROR_FAMILIES[host]
    explicit = str(src.get('sourceFamily') or '').strip()
    if explicit:
        return FAMILY_ALIASES.get(explicit.lower(), explicit)
    return host or str(src.get('id') or src.get('name') or 'unknown-source')


def is_auto_discovered_source(src):
    """Discovery rows are review-only, regardless of stale enabled flags."""
    config = src.get('config') if isinstance(src.get('config'), dict) else src
    approval_status = str(config.get('approvalStatus') or src.get('approvalStatus') or '').strip().lower()
    if approval_status == 'approved':
        return False
    discovery = config.get('discovery') if isinstance(config.get('discovery'), dict) else src.get('discovery')
    method = str(discovery.get('method') or '').strip().lower() if isinstance(discovery, dict) else ''
    names = [str(src.get('name') or '').strip(), str(config.get('name') or '').strip()]
    return (
        config.get('autoDiscovered') is True
        or src.get('autoDiscovered') is True
        or config.get('collectionBlocked') == 'auto-discovery'
        or src.get('collectionBlocked') == 'auto-discovery'
        or method == 'naver-web-search'
        or any(re.match(r'^자동발견\s*·', name) for name in names)
    )


def verified_tls_context():
    """Use the platform CA store, with certifi as a verified macOS fallback."""
    paths = ssl.get_default_verify_paths()
    if (paths.cafile and os.path.exists(paths.cafile)) or (paths.capath and os.path.isdir(paths.capath)):
        return ssl.create_default_context()
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


TLS_CONTEXT = verified_tls_context()
UNVERIFIED_TLS_CONTEXT = ssl._create_unverified_context()


def get(url, timeout=20, auth=False, max_bytes=None, allow_invalid_tls=False):
    headers = {'User-Agent': UA}
    if auth and NAVER_COOKIE:
        headers['Cookie'] = NAVER_COOKIE
    parsed = urllib.parse.urlsplit(url)
    request_url = urllib.parse.urlunsplit((
        parsed.scheme,
        parsed.netloc.encode('idna').decode('ascii'),
        urllib.parse.quote(parsed.path, safe='/%:@-._~!$&\'()*+,;='),
        urllib.parse.quote(parsed.query, safe='=&%:@-._~!$\'()*+,;/?'),
        '',
    ))
    req = urllib.request.Request(request_url, headers=headers)
    context = UNVERIFIED_TLS_CONTEXT if allow_invalid_tls else TLS_CONTEXT
    with urllib.request.urlopen(req, timeout=timeout, context=context) as r:
        body = r.read(max_bytes if max_bytes else -1)
        return body.decode('utf-8', errors='replace')


def cafe_body(cafe_id, aid):
    """카페 글 본문 텍스트 — 메모리에서만 사용, 디스크 미기록(스펙 §원문 무저장).
    NAVER_COOKIE 있으면 인증 요청(회원전용 글 접근), 없으면 무인증(공개 글만)."""
    url = ('https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/'
           f'{cafe_id}/articles/{aid}?query=&useCafeId=true&requestFrom=A')
    # 네이버 카페 본문 API는 간헐 JSON 문자열 내 제어문자나
    # CDN chunk 프레이밍을 그대로 노출한다. 목록·블로그 경로와 동일하게
    # strict=False/raw_decode 폴백이 있는 전용 파서를 사용한다.
    a = parse_naver_loose_json(get(url, auth=True))['result']['article']
    c = a.get('contentHtml') or a.get('content') or ''
    return html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', c))).strip()


body_denied = 0  # 무인증 상태의 회원전용(401) — 정상, 제목 폴백
auth_denied = 0  # 쿠키 있는데도 401 — 쿠키 만료 또는 카페 미가입/등급 부족 (조치 필요)


def fetch_facts(subject, cafe_id, aid):
    """제목+본문 → facts. 회원전용 글(401)은 본문 접근 불가 — 제목만으로 추출.
    검색·목록 API 는 제한 게시판 글도 제목을 노출하지만 본문 API 는 멤버십을 요구한다.
    NAVER_COOKIE 가 있는데도 401 이면 쿠키 만료/등급 부족 신호 (2026-07-09 130건, 07-10 원인 확정)."""
    global body_denied, auth_denied
    try:
        text = subject + '\n' + cafe_body(cafe_id, aid)
    except urllib.error.HTTPError as e:
        if e.code != 401:
            raise
        if NAVER_COOKIE:
            auth_denied += 1
        else:
            body_denied += 1
        text = subject
    return extract_facts(text)


def fetch_naver_blog_facts(subject, blog_id, aid):
    """Public Naver Blog detail body → structured facts, without storing source text."""
    # `m.blog.naver.com/{blog}/{logNo}` can return only a frameset shell to a
    # non-browser client. PostView.naver is the public detail document and
    # contains the SmartEditor body selected by the analyzer. Keep a shell
    # fallback for legacy posts whose direct endpoint is unavailable.
    urls = [
        f"https://blog.naver.com/PostView.naver?blogId={urllib.parse.quote(blog_id)}&logNo={aid}&redirect=Dlog&widgetTypeCall=true&noTrackingCode=true&directAccess=false",
        f"https://m.blog.naver.com/{blog_id}/{aid}",
    ]
    last_error = None
    for url in urls:
        try:
            page = get(url, max_bytes=2_000_000)
            body = extract_naver_blog_text(page)
            if body:
                return extract_facts(subject + '\n' + body)
            last_error = ValueError(f"Naver blog body container missing: {blog_id}/{aid}")
        except Exception as error:
            last_error = error
    raise last_error or ValueError(f"Naver blog body container missing: {blog_id}/{aid}")


def source_detail_selector(src):
    spec = src.get('parserSpec') if isinstance(src.get('parserSpec'), dict) else {}
    rule = spec.get('extractionRule') if isinstance(spec.get('extractionRule'), dict) else {}
    return rule.get('articleSelector') if isinstance(rule.get('articleSelector'), str) else None


def page_case_name(page_html, metadata):
    """Resolve a conservative case name from metadata, then H1–H3.

    A number of public legal pages use a site-wide og:title while putting the
    incident title in an article H2. The analyzer records the same fallback;
    keeping harvest's runtime extraction in lockstep prevents a ready parser
    from silently dropping every item at collection time.
    """
    candidates = [metadata.get('title', ''), *extract_html_headings(page_html)]
    for candidate in candidates:
        name = case_name_from_page_title(candidate)
        if name and not SKIP_TITLE.search(name):
            return name, candidate
    return '', ''


_MON = {'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
        'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12}


def parse_add_date(s):
    """검색 API addDate('Tue Jul 07 21:32:24 KST 2026') → epoch ms. 로케일 무관 수동 파싱."""
    m = re.match(r'\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) KST (\d{4})', s or '')
    if not m:
        return None
    from datetime import timezone, timedelta
    kst = timezone(timedelta(hours=9))
    dt = datetime(int(m.group(6)), _MON[m.group(1)], int(m.group(2)),
                  int(m.group(3)), int(m.group(4)), int(m.group(5)), tzinfo=kst)
    return int(dt.timestamp() * 1000)


def seed_slugs():
    """유형 시드 slug 집합 — 표적 검색 대상에서 제외 (일반명사 검색은 소음)."""
    try:
        src = open(os.path.join(ROOT, 'src/lib/scam/seed-data.ts'), encoding='utf-8').read()
        return {m.group(1) for m in re.finditer(r"slug:\s*'([^']+)'", src)}
    except FileNotFoundError:
        return set()


def crawl_due(src, state, day):
    """매일 자동수집을 위한 일 단위 주기 게이트."""
    if src.get('forceNextRun'):
        return True
    days = src.get('recrawlDays')
    if not days:
        return True
    last = state.get(f"{src['id']}:lastCrawl")
    if not last:
        return True
    from datetime import date
    return (date.fromisoformat(day) - date.fromisoformat(last)).days >= days


def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    return default


def atomic_json_dump(value, path):
    """Write a complete JSON document without exposing a partial target."""
    target = os.path.abspath(os.fspath(path))
    directory = os.path.dirname(target) or os.curdir
    os.makedirs(directory, exist_ok=True)
    basename = os.path.basename(target) or 'data.json'
    fd, temporary = tempfile.mkstemp(prefix=f'.{basename}.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=1)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def checkpoint_snapshot(value, source_id):
    """한 소스가 소유한 커서만 잘라 실행 원장에 보관한다."""
    base_id = source_id[:-7] if source_id.endswith(':search') else source_id
    prefixes = (f'{base_id}:', f'search:{base_id}:')
    return {
        key: copy.deepcopy(item)
        for key, item in value.items()
        if key.startswith(prefixes)
    }


def sitemap_checkpoint(previous, entries, selected):
    """Persist URL+lastmod fingerprints without dropping pending changes.

    Older harvest state stores sitemap checkpoints as a URL-only list.  Such
    entries cannot prove a ``lastmod`` value, so leave them out of the new
    fingerprint map and let the normal batch limit reconfirm them over
    subsequent runs.  Existing inbox identities suppress duplicate writes
    while still allowing their fingerprints to be committed.  Once state is a
    fingerprint mapping, update only rows selected for this run; this keeps
    rows beyond ``maxItemsPerRun`` eligible for a later run.
    """
    if isinstance(previous, dict):
        checkpoint = dict(previous)
    else:
        checkpoint = {}
        for item in previous or []:
            if isinstance(item, str):
                loc = item.strip()
            elif isinstance(item, dict):
                loc = str(item.get('loc', item.get('url', '')) or '').strip()
            else:
                loc = ''
            if loc:
                if isinstance(item, dict) and ('lastmod' in item or 'fingerprint' in item or 'sitemapFingerprint' in item):
                    fingerprint = item.get('fingerprint') or item.get('sitemapFingerprint')
                    if fingerprint:
                        checkpoint[loc] = str(fingerprint)
                    elif 'lastmod' in item:
                        checkpoint[loc] = sitemap_entry_fingerprints([item]).get(loc)
                    else:
                        checkpoint[loc] = None
                # URL-only history is intentionally omitted.  It will be
                # reconfirmed in bounded batches instead of being suppressed
                # forever with an unknowable fingerprint.
    for loc, fingerprint in sitemap_entry_fingerprints(selected).items():
        # Re-append changed URLs so the seenLimit retains the latest checkpoint.
        checkpoint.pop(loc, None)
        checkpoint[loc] = fingerprint
    return checkpoint


def search_checkpoint(state, key, newest, day, *, success, backfill=False):
    """Return the search cursor state, advancing it only after full success."""
    next_state = dict(state)
    if not success:
        return next_state
    next_state[key] = newest
    if not backfill:
        next_state[f'{key}:last'] = day
    return next_state


def observation_identity(row):
    """Return the inbox identity, distinguishing sitemap lastmod revisions."""
    link = str(row.get('link', '') or '').strip()
    if not link:
        return '', ''
    if row.get('discoveryTier') == 'metadata':
        return link, str(row.get('pubDate', '') or '').strip()
    return link, ''


def select_appendable_rows(rows, existing_keys):
    """Filter rows to identities not already present, preserving first occurrence."""
    occupied = set(existing_keys)
    appendable = []
    for row in rows:
        key = observation_identity(row)
        if not key[0] or key in occupied:
            continue
        appendable.append(row)
        occupied.add(key)
    return appendable, occupied


def sitemap_commit_entries(selected_rows, occupied_keys):
    """Return sitemap entries whose observation is already or will be persisted."""
    return [
        entry for entry, row in selected_rows
        if observation_identity(row) in occupied_keys
    ]


def search_interval(k):
    """업체 활동성 → 표적검색 주기(일). 마지막 관측이 오래될수록 뜸하게 재검색.
    죽은 사기의 재활성화는 1차 패스(메뉴 크롤+업체명 매칭)가 잡으므로 커버리지 손실 없음.
    hot(≤14d) 매일 · warm(≤60d) 7일 · cool(≤180d) 21일 · cold(그 외) 45일."""
    ts = [o['observedAt'] for o in k.get('observations', []) if o.get('observedAt')]
    if not ts:
        return 1
    try:
        d = (datetime.now(datetime.fromisoformat(max(ts)).tzinfo) - datetime.fromisoformat(max(ts))).days
    except Exception:
        return 1
    return 1 if d <= 14 else 7 if d <= 60 else 21 if d <= 180 else 45


def search_due(k, srcid, state, day):
    """표적검색 주기 게이트. 최초(커서 없음)는 무조건 소급. 레거시(주기 도입 전 검색)는
    crc32(slug) 오프셋으로 스태거 시드해 첫날 몰림을 막고 이후 주기대로 분산."""
    cur = f"search:{srcid}:{k['slug']}"
    if cur not in state:
        return True   # 최초 소급 — 무조건
    interval = search_interval(k)
    lkey = f"{cur}:last"
    last = state.get(lkey)
    if not last:      # 레거시 시드 — 오프셋만큼 과거로 밀어 due 날짜 분산
        off = zlib.crc32(k['slug'].encode()) % interval if interval > 1 else 0
        last = (date.fromisoformat(day) - timedelta(days=off)).isoformat()
    return (date.fromisoformat(day) - date.fromisoformat(last)).days >= interval


def blog_add_date_ms(s):
    """PostTitleListAsync addDate → epoch ms 문자열. 최근 글은 상대시각('12시간 전'),
    과거 글은 점 표기('2026. 7. 3.')로 온다. 해석 불가면 '' (ingest 가 수집시각 폴백)."""
    from datetime import timedelta, timezone
    kst = timezone(timedelta(hours=9))
    now = datetime.now(kst)
    s = (s or '').strip()
    m = re.match(r'(\d+)\s*분 전', s)
    if m:
        return str(int((now - timedelta(minutes=int(m.group(1)))).timestamp() * 1000))
    m = re.match(r'(\d+)\s*시간 전', s)
    if m:
        return str(int((now - timedelta(hours=int(m.group(1)))).timestamp() * 1000))
    if s == '어제':
        return str(int((now - timedelta(days=1)).timestamp() * 1000))
    m = re.match(r'(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?', s)
    if m:
        dt = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=kst)
        return str(int(dt.timestamp() * 1000))
    return ''


state = load_json(STATE, {})
state_before_run = copy.deepcopy(state)
registry = load_json(REGISTRY, {'sources': []})
facts_map = load_json(FACTS_OUT, {})   # URL→facts, 재실행 시 병합

# 오늘 인박스의 기존 링크/관측 identity (collect.sh 산출 포함) — 중복 append 방지
existing_links = set()
existing_observation_keys = set()
if os.path.exists(OUT):
    with open(OUT, encoding='utf-8') as f:
        for line in f:
            try:
                row = json.loads(line)
                existing_links.add(row['link'])
                existing_observation_keys.add(observation_identity(row))
            except Exception:
                pass

rows = []
source_runs = []
sitemap_batches = []

for src in registry['sources']:
    if is_auto_discovered_source(src):
        print(f"SKIP: {src.get('id', src.get('name', 'unknown-source'))} 자동발견 소스는 승인 전 수집 금지", file=sys.stderr)
        continue
    if src.get('enabled') is False:
        continue
    source_id = str(src.get('id') or src.get('name') or 'unknown-source')
    source_started = time.perf_counter()
    source_success = True
    source_attempted = False
    source_state_before = copy.deepcopy(state)
    source_rows_start = len(rows)
    source_sitemap_start = len(sitemap_batches)
    source_fact_keys = set(facts_map)
    try:
        if src['type'] == 'google_news_rss':
            if not MANUAL_RUN and not crawl_due(src, state, DAY):
                continue
            source_attempted = True
            seen_key = f"{src['id']}:seen"
            seen = set(state.get(seen_key, []))
            new_links = []
            for query in src.get('queries', []):
                encoded = urllib.parse.quote(f"{query} when:2d")
                feed_url = f"{src['url']}?q={encoded}&hl=ko&gl=KR&ceid=KR:ko"
                feed = get(feed_url)
                blocks = re.findall(r'<item\b[\s\S]*?</item>', feed, re.I)
                for item in blocks:
                    title_match = re.search(r'<title\b[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>', item, re.S | re.I)
                    link_match = re.search(r'<link\b[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>', item, re.S | re.I)
                    date_match = re.search(r'<pubDate\b[^>]*>(.*?)</pubDate>', item, re.S | re.I)
                    publisher_match = re.search(r'<source\b[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</source>', item, re.S | re.I)
                    if not title_match or not link_match:
                        continue
                    link = html.unescape(link_match.group(1).strip())
                    title = html.unescape(re.sub(r'<[^>]+>', ' ', title_match.group(1))).strip()
                    if not link or link in seen or not title or SKIP_TITLE.search(title):
                        continue
                    rows.append({
                        'query': f"뉴스검색/{query}",
                        'title': title[:300],
                        'link': link,
                        'source': src['name'],
                        'publisher': html.unescape(publisher_match.group(1).strip()) if publisher_match else '',
                        'sourceFamily': source_family(src),
                        'pubDate': date_match.group(1).strip() if date_match else '',
                        'sourceType': src.get('sourceType', 'news'),
                        'extractionMethod': 'google-news-rss-v1',
                    })
                    new_links.append(link)
                time.sleep(float(src.get('queryDelaySeconds', 1)))
            state[seen_key] = (state.get(seen_key, []) + new_links)[-int(src.get('seenLimit', 5000)):]
            state[f"{src['id']}:lastCrawl"] = DAY
            state[f"{src['id']}:lastCrawlAt"] = datetime.now().astimezone().isoformat()

        elif src['type'] == 'naver_cafe':
            source_attempted = True
            for menu in src['menus']:
                key = f"{src['id']}:{menu['menuId']}"
                last_seen = 0 if BACKFILL else state.get(key, 0)
                newest = state.get(key, 0)
                pages = range(1, (BACKFILL or 1) + 1)
                for page in pages:
                    url = ('https://apis.naver.com/cafe-web/cafe2/ArticleListV2dot1.json'
                           f"?search.clubid={src['cafeId']}&search.menuid={menu['menuId']}"
                           f"&search.queryType=lastArticle&search.page={page}&search.perPage={src.get('perPage', 30)}")
                    arts = json.loads(get(url))['message']['result']['articleList']
                    if not arts:
                        break
                    for a in arts:
                        aid = a.get('articleId', 0)
                        subject = html.unescape(a.get('subject', '')).strip()
                        if aid <= last_seen or not subject or SKIP_TITLE.search(subject):
                            continue
                        newest = max(newest, aid)
                        link = f"https://cafe.naver.com/{src['cafeUrl']}/{aid}"
                        rows.append({
                            'query': f"커뮤니티/{menu['menuName']}",
                            'title': subject,
                            'link': link,
                            'source': src['name'],
                            'sourceFamily': source_family(src),
                            'pubDate': str(a.get('writeDateTimestamp', '')),
                            'sourceType': src['sourceType'],
                        })
                        # 본문 → 구조화 사실 (메모리에서만, 원문 디스크 미기록). 회원전용 글은 제목만.
                        if link not in facts_map:
                            try:
                                f = fetch_facts(subject, src['cafeId'], aid)
                                if f['method'] or f['infra'] or f['amounts']:
                                    facts_map[link] = f
                                time.sleep(0.3)
                            except Exception as e:
                                print(f"WARN: body {aid} 추출 실패 — {e}", file=sys.stderr)
                    time.sleep(1)
                state[key] = newest

        elif (src['type'] == 'webpage'
              and isinstance(src.get('parserSpec'), dict)
              and src['parserSpec'].get('adapter') == 'webpage-list'):
            if not MANUAL_RUN and not crawl_due(src, state, DAY):
                continue
            source_attempted = True
            page_param = str(src.get('pageParam') or '').strip()
            max_pages = max(1, min(int(src.get('maxPages', 1)), 1_000))
            def page_url(page_number):
                parsed = urllib.parse.urlsplit(src['url'])
                query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                query = [(key, value) for key, value in query if key != page_param]
                query.append((page_param, str(page_number)))
                return urllib.parse.urlunsplit((
                    parsed.scheme, parsed.netloc, parsed.path,
                    urllib.parse.urlencode(query), '',
                ))
            first_url = page_url(1) if page_param else src['url']
            first_html = get(first_url, max_bytes=1_000_000)
            list_documents = [(first_url, first_html)]
            if page_param:
                page_pattern = re.compile(rf'(?:[?&]|&amp;){re.escape(page_param)}=(\d+)')
                discovered_pages = [int(value) for value in page_pattern.findall(first_html)]
                last_page = min(max(discovered_pages, default=1), max_pages)
                remaining_urls = [page_url(page_number) for page_number in range(2, last_page + 1)]
                concurrency = max(1, min(int(src.get('pageConcurrency', 6)), 12))
                with ThreadPoolExecutor(max_workers=concurrency) as executor:
                    list_documents.extend(zip(remaining_urls, executor.map(
                        lambda url: get(url, max_bytes=1_000_000), remaining_urls,
                    )))
            links = []
            discovered_links = set()
            for page_number, (list_url, list_html) in enumerate(list_documents, start=1):
                page_links = extract_same_origin_links(list_html, src['url'], src.get('includePath', ''))
                fresh = [item for item in page_links if item['url'] not in discovered_links]
                if not fresh and page_number > 1:
                    break
                links.extend(fresh)
                discovered_links.update(item['url'] for item in fresh)
            if not links:
                raise RuntimeError('자동 분석된 일반 목록에서 상세 링크를 찾지 못했습니다')
            seen_key = f"{src['id']}:seen"
            seen = set(state.get(seen_key, []))
            accepted = []
            detail_failures = 0
            selector = source_detail_selector(src)
            for item in links[:int(src.get('maxItemsPerRun', 500))]:
                link = item['url']
                if link in seen:
                    continue
                if src.get('keywordOnly'):
                    title = case_name_from_page_title(item.get('title', ''))
                    if not title or SKIP_TITLE.search(title):
                        continue
                    rows.append({
                        'query': f"웹목록/{src['name']}",
                        'title': title[:300],
                        'link': link,
                        'source': src['name'],
                        'sourceFamily': source_family(src),
                        'pubDate': '',
                        'sourceType': src.get('sourceType', 'report'),
                        'pageTitle': item.get('title', '')[:500],
                        'pageDescription': '',
                        'extractionMethod': 'html-list-anchor-v1',
                    })
                    accepted.append(link)
                    continue
                try:
                    page_html = get(link, max_bytes=1_000_000)
                    metadata = extract_html_metadata(page_html)
                    title, heading_title = page_case_name(page_html, metadata)
                    if not title or SKIP_TITLE.search(title):
                        continue
                    facts_text = f"{metadata['title']}\n{metadata['description']}\n{heading_title}"
                    extraction_method = 'html-metadata-v1'
                    if src.get('fetchPageBodyFacts'):
                        detail_text = extract_detail_text(page_html, selector)
                        if not detail_text:
                            raise RuntimeError(f'자동 분석 본문 선택자 불일치: {selector} · {link}')
                        facts_text += f"\n{detail_text}"
                        extraction_method = f'html-selector-{selector}-facts-v1'
                    facts = extract_facts(facts_text)
                    if facts['method'] or facts['infra'] or facts['amounts']:
                        facts_map[link] = facts
                    rows.append({
                        'query': f"웹목록/{src['name']}",
                        'title': title[:300],
                        'link': link,
                        'source': src['name'],
                        'sourceFamily': source_family(src),
                        'pubDate': '',
                        'sourceType': src.get('sourceType', 'report'),
                        'pageTitle': metadata['title'][:500],
                        'pageDescription': metadata['description'][:500],
                        'extractionMethod': extraction_method,
                    })
                    accepted.append(link)
                except Exception as e:
                    # 하나의 403/timeout/마크업 변경이 성공한 다른 상세 페이지의
                    # checkpoint까지 되돌리지 않게 한다. 실패 URL은 seen에 넣지 않아
                    # 다음 실행에서 다시 시도한다.
                    detail_failures += 1
                    print(f"WARN: {src['id']} 상세 {link} 수집 실패 — {e}", file=sys.stderr)
            if detail_failures and not accepted:
                raise RuntimeError(f'일반 목록 상세 {detail_failures}건 전부 수집 실패')
            state[seen_key] = (state.get(seen_key, []) + accepted)[-int(src.get('seenLimit', 50000)):]
            state[f"{src['id']}:lastCrawl"] = DAY
            state[f"{src['id']}:lastCrawlAt"] = datetime.now().astimezone().isoformat()

        elif src['type'] == 'webpage':
            # recrawlDays 있으면 주기 재수집 (자라나는 업체 리스트 페이지), 없으면 1회 수집
            if src.get('recrawlDays'):
                if not MANUAL_RUN and not crawl_due(src, state, DAY):
                    continue
            elif not MANUAL_RUN and (src['url'] in existing_links or state.get(f"{src['id']}:fetched")):
                continue  # 정적 페이지는 1회 수집 (갱신 감지는 사람이 레지스트리 갱신으로)
            source_attempted = True
            page = get(src['url'])
            text = re.sub(r'<(script|style)[\s\S]*?</\1>', ' ', page)
            text = re.sub(r'<[^>]+>', ' ', text)
            text = re.sub(r'\s+', ' ', html.unescape(text)).strip()
            rows.append({
                'query': f"웹페이지/{src['name']}",
                'title': text[:1500],  # 추출 패스가 읽을 본문 발췌
                'link': src['url'],
                'source': src['name'],
                'sourceFamily': source_family(src),
                'pubDate': '',
                'sourceType': src['sourceType'],
            })
            state[f"{src['id']}:fetched"] = True
            state[f"{src['id']}:lastCrawl"] = DAY
            time.sleep(1)

        elif src['type'] == 'naver_blog':
            # 네이버 블로그 전체 글 목록 — PostTitleListAsync 공개 API (무인증).
            # RSS 는 최신 50개 고정 창이라 과거 글을 못 보지만(2026-07-08 경쟁사B 9,950건 중 50건만 노출),
            # 이 API 는 페이지네이션으로 전량 소급 가능. 커서 {id}:lastLogNo 이하 도달 시 조기 종료.
            # --backfill 은 주기 게이트도 우회한다 (소급이 목적이므로)
            if not BACKFILL and not MANUAL_RUN and not crawl_due(src, state, DAY):
                continue
            source_attempted = True
            bkey = f"{src['id']}:lastLogNo"
            last_seen = 0 if BACKFILL else int(state.get(bkey, 0))
            newest = int(state.get(bkey, 0))
            # rss 시절 커서(seen 링크 목록)의 logNo — URL 꼬리(?fromRss=...)가 달라 링크 dedupe 가
            # 못 잡으므로 여기서 건너뛴다 (관측 중복 방지)
            legacy = set()
            for l in state.get(f"{src['id']}:seen", []):
                m = re.search(r'/(\d+)(?:\?|$)', l)
                if m:
                    legacy.add(m.group(1))
            page, done, seen_aids = 1, False, set()
            page_limit = int(src.get('maxPagesPerRun', 0))
            while not done and (not page_limit or page <= page_limit):
                url = ('https://blog.naver.com/PostTitleListAsync.naver'
                       f"?blogId={src['blogId']}&currentPage={page}&countPerPage=30"
                       '&categoryNo=&parentCategoryNo=&viewdate=')
                d = parse_naver_loose_json(get(url))
                posts = d.get('postList') or []
                if not posts:
                    break
                for p in posts:
                    aid = int(p.get('logNo', 0))
                    if not aid or aid in seen_aids:
                        continue
                    seen_aids.add(aid)
                    newest = max(newest, aid)
                    if aid <= last_seen:
                        done = True     # date 내림차순 → 커서 이하는 이미 본 구간
                        continue
                    if str(aid) in legacy:
                        continue
                    title = urllib.parse.unquote_plus(p.get('title', '')).strip()
                    if not title or SKIP_TITLE.search(title):
                        continue
                    rows.append({
                        'query': f"법무블로그/{src['name']}",
                        'title': title[:300],
                        'link': f"https://blog.naver.com/{src['blogId']}/{aid}",
                        'source': src['name'],
                        'sourceFamily': source_family(src),
                        'pubDate': blog_add_date_ms(p.get('addDate', '')),
                        'sourceType': src.get('sourceType', 'report'),
                    })
                    link = f"https://blog.naver.com/{src['blogId']}/{aid}"
                    if link not in facts_map:
                        try:
                            f = fetch_naver_blog_facts(title, src['blogId'], aid)
                            if f['method'] or f['infra'] or f['amounts']:
                                facts_map[link] = f
                            detail_delay = float(src.get('detailRequestDelaySeconds', 0.1))
                            if detail_delay > 0:
                                time.sleep(detail_delay)
                        except Exception as e:
                            # 삭제·구형 편집기 글 하나가 블로그 전체의 목록과
                            # 정상 본문 checkpoint를 되돌리지 않게 한다. 전체 본문
                            # coverage가 기준 미달이면 소스 단위 품질 게이트가 여전히 차단한다.
                            print(f"WARN: blog body {src['blogId']}/{aid} 추출 실패 — {e}", file=sys.stderr)
                page += 1
                time.sleep(0.4)
            state[bkey] = newest
            state[f"{src['id']}:lastCrawl"] = DAY

        elif src['type'] == 'rss':
            # 법무법인 블로그 등 — 공개 RSS 를 주기(recrawlDays) 수집. 제목이 업체명을 담는 소스.
            # 신규 업체명 추출은 OpenAI Codex 2단계가 담당 (규칙 2·5 — 사칭된 정상 기관명 제외).
            if not MANUAL_RUN and not crawl_due(src, state, DAY):
                continue
            source_attempted = True
            x = get(src['url'])
            seen = set(state.get(f"{src['id']}:seen", []))
            new_links = []
            selector = source_detail_selector(src)
            blocks = re.findall(r'<item\b[\s\S]*?</item>|<entry\b[\s\S]*?</entry>', x, re.I)
            for it in blocks:
                t = re.search(r'<title\b[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>', it, re.S | re.I)
                l = (re.search(r'<link\b[^>]*href=["\']([^"\']+)["\'][^>]*>', it, re.I)
                     or re.search(r'<link\b[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>', it, re.S | re.I))
                d = re.search(r'<(?:pubDate|published|updated)\b[^>]*>(.*?)</(?:pubDate|published|updated)>', it, re.S | re.I)
                if not t or not l:
                    continue
                link = html.unescape(l.group(1).strip())
                title = html.unescape(re.sub(r'<[^>]+>', ' ', t.group(1))).strip()
                if not link or link in seen or not title or SKIP_TITLE.search(title):
                    continue
                row = {
                    'query': f"법무블로그/{src['name']}",
                    'title': title[:300],
                    'link': link,
                    'source': src['name'],
                    'sourceFamily': source_family(src),
                    'pubDate': (d.group(1).strip() if d else ''),   # RFC822 → ingest 가 원문 작성시각으로 파싱
                    'sourceType': src.get('sourceType', 'report'),
                }
                if src.get('fetchPageMetadata'):
                    page_html = get(link, max_bytes=1_000_000)
                    metadata = extract_html_metadata(page_html)
                    case_name, heading_title = page_case_name(page_html, metadata)
                    if not case_name:
                        continue
                    row['title'] = case_name[:300]
                    row['pageTitle'] = metadata['title'][:500]
                    row['pageDescription'] = metadata['description'][:500]
                    facts_text = f"{metadata['title']}\n{metadata['description']}\n{heading_title}"
                    row['extractionMethod'] = 'html-metadata-v1'
                    if src.get('fetchPageBodyFacts'):
                        detail_text = extract_detail_text(page_html, selector)
                        if not detail_text:
                            raise RuntimeError(f'자동 분석 본문 선택자 불일치: {selector} · {link}')
                        facts_text += f"\n{detail_text}"
                        row['extractionMethod'] = f'html-selector-{selector}-facts-v1'
                    facts = extract_facts(facts_text)
                    if facts['method'] or facts['infra'] or facts['amounts']:
                        facts_map[link] = facts
                rows.append(row)
                new_links.append(link)
            state[f"{src['id']}:seen"] = (state.get(f"{src['id']}:seen", []) + new_links)[-400:]
            state[f"{src['id']}:lastCrawl"] = DAY
            state[f"{src['id']}:lastCrawlAt"] = datetime.now().astimezone().isoformat()
            time.sleep(1)

        elif src['type'] == 'sitemap':
            # 사이트맵과 상세 페이지의 공개 title/description 메타데이터만 사용한다.
            # 본문 HTML은 저장하지 않고 사건명과 구조화 facts만 남긴다. sourceFamily 는 동일
            # 운영 주체/미러를 독립 근거로 중복 집계하지
            # 않기 위한 표식이며, 신규 후보 검증 단계가 이를 사용한다.
            if not MANUAL_RUN and not crawl_due(src, state, DAY):
                continue
            source_attempted = True
            sitemap_get = lambda url: get(
                url,
                timeout=int(src.get('sitemapTimeoutSeconds', 20)),
                allow_invalid_tls=bool(src.get('allowInvalidTls')),
            )
            entries = collect_sitemap_entries(
                sitemap_get,
                src['url'],
                max_sitemaps=int(src.get('maxSitemaps', 10)),
            )
            skey = f"{src['id']}:seen"
            fkey = f"{src['id']}:fingerprints"
            # Keep the legacy URL list for dashboard/consumer compatibility;
            # the fingerprint map is the change-detection checkpoint.
            previous = state.get(fkey)
            if previous is None:
                previous = state.get(skey, [])
            # Keep the previous selector's newest-lastmod-first ordering while
            # allowing detect_sitemap_changes to include lastmod updates.
            ordered_entries = sorted(
                entries,
                key=lambda item: item.get('lastmod', ''),
                reverse=True,
            )
            selected = detect_sitemap_changes(
                ordered_entries,
                previous,
                include_path=src.get('includePath', ''),
                limit=int(src.get('maxItemsPerRun', 500)),
            )
            selected_rows = []
            metadata_attempts = 0
            metadata_fetches = 0
            for entry in selected:
                link = entry['loc']
                url_title = sitemap_title(
                    link,
                    src.get('sitemapTitleStrategy', 'last-segment'),
                    src.get('sitemapTitleQueryParam', 'name'),
                )
                page_title = ''
                page_description = ''
                if src.get('fetchPageMetadata'):
                    metadata_attempts += 1
                    try:
                        page_html = get(link, max_bytes=1_000_000)
                        metadata = extract_html_metadata(page_html)
                        metadata_fetches += 1
                        page_title = metadata['title']
                        page_description = metadata['description']
                        title, heading_title = page_case_name(page_html, metadata)
                    except Exception as e:
                        print(f"WARN: sitemap metadata {link} 추출 실패 — {e}", file=sys.stderr)
                        continue
                else:
                    title = case_name_from_keyword_slug(url_title) if src.get('keywordOnly') else url_title
                if not title or SKIP_TITLE.search(title):
                    continue
                row = {
                    'query': f"사이트맵/{src['name']}",
                    'title': title[:300],
                    'link': link,
                    'source': src['name'],
                    'sourceFamily': source_family(src),
                    'pubDate': entry.get('lastmod', ''),
                    'sourceType': src.get('sourceType', 'report'),
                    'discoveryTier': 'sitemap-keyword-only' if src.get('keywordOnly') else 'metadata',
                }
                if page_title:
                    row['pageTitle'] = page_title[:500]
                    row['pageDescription'] = page_description[:500]
                    row['urlCandidate'] = url_title[:300]
                    facts_text = f"{page_title}\n{page_description}\n{heading_title}"
                    row['extractionMethod'] = 'html-metadata-v1'
                    if src.get('fetchPageBodyFacts'):
                        selector = source_detail_selector(src) or 'article'
                        article_text = extract_detail_text(page_html, selector)
                        if article_text:
                            facts_text += f"\n{article_text}"
                            row['extractionMethod'] = f'html-selector-{selector}-facts-v1'
                            row['articleTextLength'] = len(article_text)
                        else:
                            raise RuntimeError(f'자동 분석 본문 선택자 불일치: {selector} · {link}')
                    facts = extract_facts(facts_text)
                    if facts['method'] or facts['infra'] or facts['amounts']:
                        facts_map[link] = facts
                rows.append(row)
                selected_rows.append((entry, row))
            if src.get('fetchPageMetadata') and metadata_attempts and metadata_fetches == 0:
                raise RuntimeError(f'상세 페이지 메타데이터 {metadata_attempts}건 전부 접근 실패')
            sitemap_batches.append({
                'source_id': str(src['id']),
                'skey': skey,
                'fkey': fkey,
                'previous': previous,
                'entries': entries,
                'selected_rows': selected_rows,
                'seen_limit': int(src.get('seenLimit', 50000)),
            })
            time.sleep(0.5)
        source_rows = rows[source_rows_start:]
        requires_fact_quality = src.get('fetchPageBodyFacts') or src.get('type') == 'naver_blog'
        if source_attempted and requires_fact_quality and len(source_rows) >= 3:
            fact_rows = sum(1 for row in source_rows if row.get('link') in facts_map)
            min_coverage = float(src.get('minFactCoverage', 0.6))
            coverage = fact_rows / len(source_rows)
            if coverage < min_coverage:
                raise RuntimeError(
                    f"관측정보 품질 미달: {fact_rows}/{len(source_rows)} "
                    f"({coverage:.0%} < {min_coverage:.0%})"
                )
    except Exception as e:
        source_success = False
        # 체크포인트는 소스 단위 전체 성공 뒤에만 확정한다. 부분 수집 행과
        # 후보 커서는 모두 버려 다음 실행이 동일 체크포인트에서 다시 시작한다.
        state = source_state_before
        del rows[source_rows_start:]
        del sitemap_batches[source_sitemap_start:]
        for key in set(facts_map) - source_fact_keys:
            facts_map.pop(key, None)
        print(f"WARN: {source_id} 수집 실패 — {e}", file=sys.stderr)
    finally:
        source_runs.append({
            'source_id': source_id,
            'source_name': str(src.get('name', '')),
            'attempted': source_attempted,
            'success': source_success,
            'latency_ms': (time.perf_counter() - source_started) * 1000,
        })

# ── 2차 패스: 키워드 표적 검색 (피드백 루프) ──────────────────────────────────
# 다른 소스에서 발견된 업체명을 카페 내 검색해 관측을 소급·증분 수집한다.
# 목적 = 업체별 정확한 시계열: 증분 커서가 못 보는 '커서 이전 과거 언급'을 업체 단위로 채운다
# (dossier '언제부터 언급'의 근거). 유형 시드·blocked 제외, 레지스트리 "search": true 카페만.
SEARCH_FIRST_PAGES = 25  # 첫 소급 안전 상한 (perPage 20 × 25 = 이름당 최대 500건) — 빈 페이지에서 조기 종료하므로 평소 비용 동일
SEARCH_INCR_PAGES = 5    # 증분 상한 — 커서(hit_old)에서 조기 종료. 하루 20건+ 급증도 안 놓침
SEARCH_PER_PAGE = 20

kw_store = load_json(os.path.join(ROOT, 'data/keywords.json'), {'keywords': []})
_seeds = seed_slugs()
targets = [] if SOURCE_ONLY else [k for k in kw_store['keywords']
           if k['slug'] not in _seeds and k['status'] != 'blocked' and len(k['name']) >= 2]
gated = 0   # 주기 게이트로 오늘 스킵된 업체 수 (요약 보고용)
search_runs = []

for src in registry['sources']:
    if is_auto_discovered_source(src):
        continue
    if src['type'] != 'naver_cafe' or not src.get('search'):
        continue
    search_started = time.perf_counter()
    search_attempted = False
    search_failures = 0
    for k in targets:
        skey = f"search:{src['id']}:{k['slug']}"
        # 활동성 주기 게이트 — 활성 업체만 매일, 오래된 건 뜸하게 (표적검색 요청량 급감)
        if not BACKFILL and not search_due(k, src['id'], state, DAY):
            gated += 1
            continue
        search_attempted = True
        last_seen = 0 if BACKFILL else state.get(skey, 0)
        newest = state.get(skey, 0)
        seen_aids = set()
        names = [k['name']] + [a for a in k.get('aliases', []) if len(a) >= 3]
        search_success = True
        try:
            for name in names:
                max_pages = SEARCH_FIRST_PAGES if not last_seen else SEARCH_INCR_PAGES
                for page in range(1, max_pages + 1):
                    url = ('https://apis.naver.com/cafe-web/cafe-mobile/CafeMobileWebArticleSearchListV3'
                           f"?cafeId={src['cafeId']}&query={urllib.parse.quote(name)}&searchBy=1"
                           f"&sortBy=date&page={page}&perPage={SEARCH_PER_PAGE}&adUnit=MW_CAFE_ARTICLE_LIST_RS")
                    arts = json.loads(get(url))['message']['result'].get('articleList', [])
                    if not arts:
                        break
                    hit_old = False
                    for a in arts:
                        aid = a.get('articleId', 0)
                        if aid in seen_aids:
                            continue
                        seen_aids.add(aid)
                        if aid <= last_seen:      # date 내림차순 → 이하는 이미 본 구간
                            hit_old = True
                            continue
                        subject = html.unescape(re.sub(r'</?em>', '', a.get('subject', ''))).strip()
                        if not subject or SKIP_TITLE.search(subject):
                            continue
                        newest = max(newest, aid)
                        link = f"https://cafe.naver.com/{src['cafeUrl']}/{aid}"
                        ts = parse_add_date(a.get('addDate', ''))
                        rows.append({
                            'query': f"검색/{k['slug']}",     # ingest 가 slug 로 확정 부착 (형태소 매칭 히트 대비)
                            'title': subject,
                            'link': link,
                            'source': src['name'],
                            'sourceFamily': source_family(src),
                            'pubDate': str(ts or ''),         # 원문 작성시각(ms) — 시계열 축
                            'sourceType': 'community',
                        })
                        if link not in facts_map:             # 본문 → facts (메모리에서만, 원문 미기록). 회원전용 글은 제목만.
                            try:
                                f = fetch_facts(subject, src['cafeId'], aid)
                                if f['method'] or f['infra'] or f['amounts']:
                                    facts_map[link] = f
                                time.sleep(0.3)
                            except Exception as e:
                                print(f"WARN: body {aid} 추출 실패 — {e}", file=sys.stderr)
                    if hit_old:
                        break
                    time.sleep(0.5)
        except Exception as e:
            search_success = False
            search_failures += 1
            print(f"WARN: 검색 {k['slug']} 실패 — {e}", file=sys.stderr)
        state = search_checkpoint(
            state,
            skey,
            newest,
            DAY,
            success=search_success,
            backfill=BACKFILL,
        )
    if search_attempted:
        search_runs.append({
            'source_id': f"{src['id']}:search",
            'source_name': str(src.get('name', '')),
            'attempted': True,
            'success': search_failures == 0,
            'search': True,
            'latency_ms': (time.perf_counter() - search_started) * 1000,
        })

appendable_rows, occupied_observation_keys = select_appendable_rows(
    rows,
    existing_observation_keys,
)

# A sitemap checkpoint advances only for observations already present in the
# inbox or accepted for this run.  A failed source never commits its deferred
# sitemap batch, so the next run can retry it.
successful_source_ids = {
    run['source_id'] for run in source_runs if run['attempted'] and run['success']
}
for batch in sitemap_batches:
    if batch['source_id'] not in successful_source_ids:
        continue
    committed = sitemap_commit_entries(
        batch['selected_rows'],
        occupied_observation_keys,
    )
    checkpoint = sitemap_checkpoint(batch['previous'], batch['entries'], committed)
    seen_limit = batch['seen_limit']
    if seen_limit > 0 and len(checkpoint) > seen_limit:
        checkpoint = dict(list(checkpoint.items())[-seen_limit:])
    state[batch['fkey']] = checkpoint
    seen = state.get(batch['skey'], [])
    if isinstance(seen, dict):
        seen = list(seen)
    elif isinstance(seen, list):
        seen = list(seen or [])
    else:
        seen = []
    for entry in committed:
        loc = entry['loc']
        if loc in seen:
            seen.remove(loc)
        seen.append(loc)
    if seen_limit > 0:
        seen = seen[-seen_limit:]
    state[batch['skey']] = seen
    source_id = batch['source_id']
    state[f"{source_id}:lastCrawl"] = DAY
    state[f"{source_id}:lastCrawlAt"] = datetime.now().astimezone().isoformat()

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'a', encoding='utf-8') as f:
    for r in appendable_rows:
        f.write(json.dumps(r, ensure_ascii=False) + '\n')

if facts_map:
    atomic_json_dump(facts_map, FACTS_OUT)
# 수집 단계에서는 확정 체크포인트를 직접 덮어쓰지 않는다. DB 적재와 변경 사건
# 후속 처리가 모두 성공한 뒤 commit-collection-checkpoints.py가 이 후보를 확정한다.
atomic_json_dump(state, STATE_CANDIDATE)

run_mode = os.environ.get('COLLECTION_MODE') or ('bootstrap' if not state_before_run else 'incremental')
manifest_runs = []
for run in source_runs + search_runs:
    is_search_run = bool(run.get('search'))
    changed_items = sum(
        1 for row in appendable_rows
        if row.get('source') == run['source_name']
        and str(row.get('query', '')).startswith('검색/') == is_search_run
    )
    before = checkpoint_snapshot(state_before_run, run['source_id'])
    after = checkpoint_snapshot(state, run['source_id']) if run['success'] else before
    manifest_runs.append({
        'sourceId': run['source_id'],
        'sourceName': run['source_name'],
        'attempted': run['attempted'],
        'mode': 'bootstrap' if not before else 'incremental',
        'status': ('skipped' if not run['attempted'] else ('succeeded' if run['success'] else 'failed')),
        'checkpointBefore': before,
        'checkpointCandidate': after,
        'checkpointCommitted': before,
        'changedItemCount': changed_items,
        'latencyMs': round(run['latency_ms']),
    })
atomic_json_dump({
    'schemaVersion': 1,
    'runKey': INBOX_KEY,
    'trigger': 'click' if MANUAL_RUN else 'daily',
    'mode': run_mode,
    'changedItemCount': len(appendable_rows),
    'changedCaseIds': [],
    'sourceRuns': manifest_runs,
}, MANIFEST_OUT)

for run in source_runs + search_runs:
    if not run['attempted']:
        continue
    is_search_run = bool(run.get('search'))
    new_items = sum(
        1 for row in appendable_rows
        if row.get('source') == run['source_name']
        and str(row.get('query', '')).startswith('검색/') == is_search_run
    )
    try:
        record_source_health(
            HEALTH,
            run['source_id'],
            success=run['success'],
            new_items=new_items,
            latency_ms=run['latency_ms'],
        )
    except Exception as e:
        # Health telemetry must never prevent another source from running.
        print(f"WARN: {run['source_id']} health 기록 실패 — {e}", file=sys.stderr)

denied = f' · 회원전용 본문 제목만 {body_denied}건' if body_denied else ''
gatenote = f' · 주기게이트 스킵 {gated}업체' if gated else ''
searched = sum(1 for row in appendable_rows if str(row.get('query', '')).startswith('검색/'))
print(f'harvest: +{len(appendable_rows)}건 (표적검색 {searched}건) → {OUT} · facts {len(facts_map)}건{denied}{gatenote}')
if auth_denied:  # 쿠키 있는데 401 — 조치 신호이므로 WARN 으로 승격 (report-run 이 warn 판정)
    print(f'WARN: NAVER_COOKIE 인증 실패 {auth_denied}건 — 쿠키 만료 또는 카페 미가입/등급 부족. .env.local NAVER_COOKIE 갱신 필요', file=sys.stderr)
