#!/bin/zsh
# 사기 키워드 수집기 — Google News RSS (무인증) → data/keyword-inbox/YYYY-MM-DD.ndjson
# 각 줄: {"query","title","link","source","pubDate"}
set -e
cd "$(dirname "$0")/../.."
DAY=$(date +%F)
OUT="data/keyword-inbox/${DAY}.ndjson"
mkdir -p data/keyword-inbox
# 뉴스 행(자기 산출, sourceType 없음)만 비우고 harvest 산출 행(sourceType 보유)은 보존.
# 통째 truncate는 같은 날 먼저 돌린 harvest 수집분을 파괴한다 (2026-07-08 블로그 123건 유실 사고).
python3 - "$OUT" <<'PY'
import json, os, sys
p = sys.argv[1]
keep = []
if os.path.exists(p):
    for line in open(p, encoding='utf-8'):
        try:
            if 'sourceType' in json.loads(line):
                keep.append(line)
        except Exception:
            pass
open(p, 'w', encoding='utf-8').writelines(keep)
PY

QUERIES=(
  "리딩방 사기 거래소"
  "코인 사기 출금 거절"
  "투자 사기 앱 피해"
  "로맨스 스캠 피해"
  "중고거래 사기 안전결제"
  "주식 리딩 사기 피해"
)

FAILURES=0
for q in "${QUERIES[@]}"; do
  enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$q")
  RSS_TMP=$(mktemp "${TMPDIR:-/tmp}/lawfirm-ads-rss.XXXXXX")
  if ! curl -fsSL -m 20 "https://news.google.com/rss/search?q=${enc}+when:2d&hl=ko&gl=KR&ceid=KR:ko" > "$RSS_TMP"; then
    echo "ERROR: RSS fetch failed: $q" >&2
    FAILURES=$((FAILURES + 1))
    rm -f "$RSS_TMP"
    continue
  fi
  if ! python3 -c "
import sys, json, html
try:
    from defusedxml import ElementTree as ET   # XXE/entity 폭탄 방어
except ImportError:
    import xml.etree.ElementTree as ET
q = sys.argv[1]
raw = open(sys.argv[2], encoding='utf-8').read()
if '<!DOCTYPE' in raw or '<!ENTITY' in raw:    # RSS에 DTD가 있을 이유 없음 — 방어적 거부
    sys.exit(2)
try:
    root = ET.fromstring(raw)
except Exception:
    sys.exit(3)
for item in root.iter('item'):
    g = lambda tag: (item.findtext(tag) or '').strip()
    title = html.unescape(g('title'))
    src = ''
    s = item.find('{https://news.google.com/rss}source')
    if s is None:
        s = item.find('source')
    if s is not None and s.text:
        src = s.text.strip()
    print(json.dumps({'query': q, 'title': title, 'link': g('link'), 'source': src, 'pubDate': g('pubDate')}, ensure_ascii=False))
" "$q" "$RSS_TMP" >> "$OUT"; then
    echo "ERROR: RSS parse failed: $q" >&2
    FAILURES=$((FAILURES + 1))
  fi
  rm -f "$RSS_TMP"
  sleep 1
done

wc -l < "$OUT" | xargs echo "collected items:"
echo "$OUT"
if [ "$FAILURES" -gt 0 ]; then
  echo "ERROR: RSS source failures: ${FAILURES}/${#QUERIES[@]}" >&2
  exit 1
fi
