#!/usr/bin/env python3
"""에이전트 운영 대시보드 생성 — data/dashboard.html (로컬 전용, daily.sh 마지막에 재생성).

양쪽 데이터를 한 화면에:
  수집측  keywords.json (관측 일자·출처·형태) — 상세 펼침으로 전 관측 열람
  트래픽측 traffic.json (events/leads DB 내보내기, export-traffic.ts) — slug 퍼널(방문→행동→문의)
DB 미연결이면 트래픽은 "유실 중" 경고로 정면 표시 (숨기지 않는다).
"""
import json, os, html, subprocess
from datetime import datetime, timezone, timedelta
from collections import Counter, defaultdict

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
OUT = os.path.join(ROOT, 'data/dashboard.html')

def load(p, d):
    p = os.path.join(ROOT, p)
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return d

store = load('data/keywords.json', {'keywords': []})
sources = load('data/harvest-sources.json', {'sources': []})
state = load('data/harvest-state.json', {})
traffic = load('data/traffic.json', None)
kws = store['keywords']
now = datetime.now(timezone.utc)

# ── 트래픽 인덱스 (slug → {type: n}, slug → leads n) ──
ev_by_slug, leads_by_slug = defaultdict(dict), {}
if traffic:
    for r in traffic.get('events', []):
        ev_by_slug[r['slug']][r['type']] = r['n']
    for r in traffic.get('leads', []):
        leads_by_slug[r['slug']] = r['n']

def parse_t(s):
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None

# ── 수집측 집계 ──────────────────────────────────────
status_counts = Counter(k['status'] for k in kws)
all_obs = []
momentum_counts = {}
for k in kws:
    recent_14, previous_14 = 0, 0
    for o in k['observations']:
        t = parse_t(o['observedAt'])
        all_obs.append((k, o, t))
        if not t:
            continue
        age_days = (now - t).days
        if age_days <= 14:
            recent_14 += 1
        elif age_days <= 28:
            previous_14 += 1
    momentum_counts[id(k)] = (recent_14, previous_14)
type_counts = Counter(o['sourceType'] for _, o, _ in all_obs)

week_counts = Counter()
for _, o, t in all_obs:
    if t and (now - t).days <= 84:
        week_counts[(t - timedelta(days=t.weekday())).strftime('%Y-%m-%d')] += 1
weeks = sorted(week_counts.keys())

def spark(k):
    """업체별 12주 미니 추이."""
    c = Counter()
    for o in k['observations']:
        t = parse_t(o['observedAt'])
        if t and (now - t).days <= 84:
            c[(t - timedelta(days=t.weekday())).strftime('%Y-%m-%d')] += 1
    if not weeks:
        return ''
    mx = max(c.values(), default=1)
    cells = ''.join(
        f'<i style="height:{max(2, round(16 * c.get(w, 0) / mx))}px" title="{w[5:]} 주 {c.get(w, 0)}건"></i>'
        for w in weeks)
    return f'<span class="spark">{cells}</span>'

def momentum(k):
    r14, p14 = momentum_counts.get(id(k), (0, 0))
    if r14 > p14: return '<span class="up">▲ 증가</span>', r14
    if r14 < p14: return '<span class="dn">▼ 감소</span>', r14
    return '<span class="dim">— 유지</span>', r14

def score(k, r14):
    """광고 우선순위 (내부 지표): 관측수 + 최근14일 관측×2. 게시 카피에는 쓰지 않는다."""
    return len(k['observations']) + r14 * 2

companies = sorted([k for k in kws if k['status'] == 'discovered' and k['observations']],
                   key=lambda k: -(len(k['observations']) + momentum(k)[1] * 2))
published = [k for k in kws if k['status'] in ('published', 'live', 'ad_registered') and k['observations']]

# 오늘 인박스·로그·커밋
today = now.astimezone().strftime('%Y-%m-%d')
p = os.path.join(ROOT, f'data/keyword-inbox/{today}.ndjson')
inbox_n = sum(1 for _ in open(p, encoding='utf-8')) if os.path.exists(p) else 0

def sh(cmd):
    try:
        return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ''
commits = sh(['git', 'log', '--oneline', '-6', '--', 'data/']).splitlines()
lp = os.path.join(ROOT, 'data/keyword-inbox/agent.log')
log_tail = ''.join(open(lp, encoding='utf-8', errors='replace').readlines()[-12:]) if os.path.exists(lp) else ''
launchd_rows = sh(['launchctl', 'list'])
launchd = 'ON' if ('com.lawfirm-ads.daily' in launchd_rows or 'com.lawfirm-ads.click-collection' in launchd_rows) else 'OFF'

# ── 렌더 ──────────────────────────────────────────────
E = html.escape
ACCENT, INK, DIM, BG, RAISED, LINE = '#D4A843', '#EAE6DD', '#8B8F98', '#0C0E12', '#14171E', '#252932'
TYPE_KO = {'community': '커뮤니티', 'news': '뉴스', 'report': '제보/리포트', 'sns': 'SNS', 'etc': '기타'}

def bars(counts, keys):
    if not keys:
        return '<p class="dim">관측 없음</p>'
    mx = max(counts[k] for k in keys) or 1
    return '<div class="chart">' + ''.join(
        f'<div class="col" title="{k} 주: 관측 {counts[k]}건"><div class="v">{counts[k]}</div>'
        f'<div class="bar" style="height:{max(4, round(120 * counts[k] / mx))}px"></div>'
        f'<div class="xl">{k[5:].replace("-", "/")}</div></div>' for k in keys) + '</div>'

def funnel_cells(slug):
    if not traffic:
        return '<td class="dim" colspan="5">유실 중 — DB 대기</td>'
    ev = ev_by_slug.get(f'f/{slug}', {})
    pv = ev.get('page_view', 0)
    calls, kakao = ev.get('call_click', 0), ev.get('kakao_click', 0)
    forms = leads_by_slug.get(f'f/{slug}', 0) + leads_by_slug.get(slug, 0)
    cvr = f'{forms / pv * 100:.1f}%' if pv else '—'
    return (f'<td class="num">{pv}</td><td class="num">{calls}</td>'
            f'<td class="num">{kakao}</td><td class="num">{forms}</td><td class="num">{cvr}</td>')

def obs_detail(k):
    items = sorted(k['observations'], key=lambda o: o['observedAt'], reverse=True)
    lis = ''.join(
        f'<tr><td class="mono">{E(o["observedAt"][:16].replace("T", " "))}</td>'
        f'<td>{E(TYPE_KO.get(o["sourceType"], o["sourceType"]))}</td>'
        f'<td>{E(o.get("title", "") or "(제목 없음)")}</td>'
        f'<td><a href="{E(o["sourceUrl"])}" target="_blank">원문</a></td></tr>' for o in items)
    return (f'<details><summary>{len(items)}건 · 자세히</summary>'
            f'<table class="inner"><tr><th>관측 시각(원문 작성)</th><th>형태</th><th>제목</th><th></th></tr>{lis}</table></details>')

SITE = os.environ.get('NEXT_PUBLIC_SITE_URL', 'https://lawfirm-ads.vercel.app').rstrip('/')
PUBLIC_STATUSES = {'verified', 'generated', 'published', 'ad_registered', 'live'}

def page_link(k):
    """공개 상태면 프로덕션 실 URL, 미공개면 프로덕션 preview URL."""
    if k['status'] in PUBLIC_STATUSES:
        return f'<a href="{SITE}/f/{E(k["slug"])}" target="_blank">/f/{E(k["slug"])}</a>'
    return f'<a href="{SITE}/f/{E(k["slug"])}?preview=1" target="_blank">preview</a>'

def company_rows(items, with_funnel):
    rows = []
    for k in items:
        mo, r14 = momentum(k)
        f = funnel_cells(k['slug']) if with_funnel else ''
        rows.append(
            f'<tr><td><b>{E(k["name"])}</b><div class="mono">{E(k["slug"])} · {E(k["scamType"])}</div></td>'
            f'<td>{spark(k)}</td><td class="num">{score(k, r14)}</td><td>{mo}</td>'
            f'<td class="mono">{(k["firstSeenAt"] or "")[:10]}<br>{(k["lastSeenAt"] or "")[:10]}</td>'
            f'<td>{obs_detail(k)}</td>{f}'
            f'<td>{page_link(k)}</td></tr>')
    return ''.join(rows)

funnel_head = '<th class="num">방문</th><th class="num">전화</th><th class="num">카톡</th><th class="num">문의</th><th class="num">전환율</th>'
traffic_note = (
    f'<div class="stage"><b>트래픽 내보내기</b><span>{E(traffic["exportedAt"][:16])}</span></div>' if traffic else
    '<div class="warn">⚠ 방문·문의 트래킹이 현재 <b>유실 중</b> — 배포 페이지의 events/leads가 DATABASE_URL 미등록으로 저장되지 않는다. '
    'DB 등록 즉시 이 대시보드의 퍼널 열이 자동 점등된다 (export-traffic.ts).</div>')

STATUS_ORDER = ['discovered', 'verified', 'generated', 'published', 'ad_registered', 'live', 'paused', 'blocked']
tiles = ''.join(
    f'<div class="tile"><div class="n">{status_counts.get(s, 0)}</div><div class="l">{s}</div></div>'
    for s in STATUS_ORDER if status_counts.get(s, 0) or s in ('discovered', 'published'))

src_rows = []
for s in sources['sources']:
    if s['type'] == 'naver_cafe':
        for m in s['menus']:
            cursor_key = f"{s['id']}:{m['menuId']}"
            src_rows.append(f'<tr><td>{E(s["name"])} / {E(m["menuName"])}</td><td>naver_cafe</td>'
                            f'<td class="mono">커서 #{state.get(cursor_key, 0)}</td></tr>')
    else:
        fetched_key = f"{s['id']}:fetched"
        fetched_status = '수집됨' if state.get(fetched_key) else '대기/실패'
        src_rows.append(f'<tr><td>{E(s["name"])}</td><td>webpage</td>'
                        f'<td class="mono">{fetched_status}</td></tr>')

doc = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>샘플투 harvester 대시보드</title>
<style>
  * {{ box-sizing: border-box; margin: 0; }}
  body {{ background: {BG}; color: {INK}; font: 14px/1.6 Pretendard, 'Apple SD Gothic Neo', sans-serif; padding: 32px; max-width: 1240px; margin: 0 auto; }}
  h1 {{ font-size: 20px; }} h1 small {{ color: {DIM}; font-weight: 400; font-size: 13px; margin-left: 10px; }}
  h2 {{ font-size: 13px; color: {DIM}; text-transform: uppercase; letter-spacing: .12em; margin: 36px 0 12px; }}
  .pipe {{ display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }}
  .stage, .tile {{ background: {RAISED}; border: 1px solid {LINE}; border-radius: 8px; padding: 10px 14px; }}
  .stage b {{ display: block; font-size: 12px; }} .stage span {{ color: {DIM}; font-size: 12px; }}
  .ok {{ color: #7BB672; }} .off {{ color: #C86A6A; }}
  .warn {{ background: #2A1D14; border: 1px solid #6B4A2B; border-radius: 8px; padding: 12px 16px; margin-top: 14px; color: #E0B58A; font-size: 13px; }}
  .tiles {{ display: flex; gap: 8px; flex-wrap: wrap; }}
  .tile {{ min-width: 96px; padding: 12px 18px; }} .tile .n {{ font-size: 26px; font-weight: 700; }} .tile .l {{ color: {DIM}; font-size: 12px; }}
  .chart {{ display: flex; align-items: flex-end; gap: 10px; padding: 12px 4px 0; overflow-x: auto; }}
  .col {{ text-align: center; }} .col .bar {{ width: 34px; background: {ACCENT}; border-radius: 4px 4px 0 0; }}
  .col .v {{ font-size: 11px; color: {DIM}; margin-bottom: 4px; }} .col .xl {{ font-size: 11px; color: {DIM}; margin-top: 6px; border-top: 1px solid {LINE}; padding-top: 4px; }}
  table {{ width: 100%; border-collapse: collapse; background: {RAISED}; border: 1px solid {LINE}; border-radius: 8px; overflow: hidden; }}
  th, td {{ text-align: left; padding: 8px 12px; border-bottom: 1px solid {LINE}; font-size: 13px; vertical-align: top; }}
  th {{ color: {DIM}; font-weight: 500; font-size: 12px; }} .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .mono {{ font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: {DIM}; }}
  a {{ color: {ACCENT}; }} .dim {{ color: {DIM}; }} .up {{ color: #7BB672; }} .dn {{ color: #C86A6A; }}
  .spark {{ display: inline-flex; align-items: flex-end; gap: 2px; height: 18px; }}
  .spark i {{ display: inline-block; width: 5px; background: {ACCENT}; border-radius: 1px; }}
  details summary {{ cursor: pointer; color: {ACCENT}; font-size: 12.5px; }}
  table.inner {{ margin-top: 8px; border: 1px solid {LINE}; }} table.inner td, table.inner th {{ font-size: 12px; padding: 5px 10px; }}
  .tw {{ overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 8px; }}
  .tw table {{ min-width: 760px; }}
  @media (max-width: 640px) {{
    body {{ padding: 16px 12px; font-size: 13px; }}
    h1 {{ font-size: 17px; }} h1 small {{ display: block; margin: 4px 0 0; }}
    .pipe {{ gap: 6px; }} .stage {{ padding: 8px 10px; flex: 1 1 44%; }}
    .tile {{ min-width: 72px; padding: 10px 12px; flex: 1 1 28%; }} .tile .n {{ font-size: 20px; }}
    .chart {{ gap: 6px; }} .col .bar {{ width: 22px; }}
    pre {{ font-size: 10.5px; }}
  }}
  pre {{ background: {RAISED}; border: 1px solid {LINE}; border-radius: 8px; padding: 14px; font-size: 11.5px; overflow-x: auto; color: {DIM}; }}
</style></head><body>
<h1>사기업체 harvester × URL 퍼널 <small>생성 {now.astimezone().strftime('%Y-%m-%d %H:%M')} · 로컬 전용</small></h1>

<div class="pipe">
  <div class="stage"><b>launchd 08:47</b><span class="{'ok' if launchd == 'ON' else 'off'}">{launchd}</span></div>
  <div class="stage"><b>오늘 인박스</b><span>{inbox_n}건</span></div>
  <div class="stage"><b>스테이징</b><span>keywords {len(kws)} · 관측 {len(all_obs)}</span></div>
  <div class="stage"><b>DB(Neon)</b><span class="{'ok' if traffic else 'off'}">{'연결' if traffic else 'DATABASE_URL 대기'}</span></div>
  <div class="stage"><b>배포 /f/[slug]</b><span>published 공개 · discovered=preview</span></div>
</div>
{traffic_note}

<h2>키워드 상태머신</h2>
<div class="tiles">{tiles}</div>

<h2>게시 중 URL — 수집 × 트래픽 퍼널</h2>
<div class="tw"><table><tr><th>키워드</th><th>12주 추이</th><th class="num">스코어</th><th>모멘텀</th><th>최초/최근</th><th>관측 상세</th>{funnel_head}<th>URL</th></tr>
{company_rows(published, True) or '<tr><td colspan="12" class="dim">게시 중 업체 키워드 없음 (유형 시드는 아래 주간 추이에 포함)</td></tr>'}</table></div>

<h2>발견 업체 — 게시 승인 대기 (스코어 = 관측수 + 최근14일×2 · 내부 지표)</h2>
<div class="tw"><table><tr><th>키워드</th><th>12주 추이</th><th class="num">스코어</th><th>모멘텀</th><th>최초/최근</th><th>관측 상세</th><th>preview</th></tr>
{company_rows(companies[:30], False)}</table></div>

<h2>주간 관측 추이 — 최근 12주 (원문 작성시각 기준)</h2>
{bars(week_counts, weeks)}

<h2>수집 형태</h2>
<div class="tiles">{''.join(f'<div class="tile"><div class="n">{c}</div><div class="l">{E(TYPE_KO.get(t, t))}</div></div>' for t, c in type_counts.most_common())}</div>

<h2>소스 건강</h2>
<div class="tw"><table><tr><th>소스</th><th>타입</th><th>상태</th></tr>{''.join(src_rows)}</table></div>

<h2>최근 데이터 커밋</h2>
<pre>{E(chr(10).join(commits) or '없음')}</pre>

<h2>에이전트 로그 (tail)</h2>
<pre>{E(log_tail or '없음')}</pre>
</body></html>'''

with open(OUT, 'w', encoding='utf-8') as f:
    f.write(doc)
print(f'dashboard: {OUT}')
