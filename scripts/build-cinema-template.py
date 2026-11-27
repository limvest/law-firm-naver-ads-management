#!/usr/bin/env python3
"""fraud-v2.html → src/templates/fraud-cinema.ts 재생성.
fraud-v2.html이 단일 소스다. 수정 후 반드시 이 스크립트를 실행할 것.
토큰: {{TITLE}}(title+og:title), {{KJSON}}(window.__SLUG_K 주입), <base href="/">.
"""
import json, sys

src = open('fraud-v2.html', encoding='utf-8').read()
t = src

t = t.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<base href="/">\n<link rel="canonical" href="{{CANON}}">\n{{JSONLD}}', 1)
assert t.count('<base href="/">') == 1, 'base 주입 실패'
assert '{{CANON}}' in t and '{{JSONLD}}' in t, 'SEO 토큰 실패'

# H1 서버 렌더 — 크롤러가 JS 없이도 키워드 헤드라인을 본다 (클라 applyK 가 동일 내용으로 재렌더)
t = t.replace('<h1 class="disp" id="c0h" data-cid="C0-H"><span class="ln">투자·거래 후,</span><span class="ln">출금이 막혔습니까?</span></h1>',
              '<h1 class="disp" id="c0h" data-cid="C0-H">{{H1}}</h1>')
assert '{{H1}}' in t, 'H1 토큰 실패'

t = t.replace('<title data-cid="GL-TITLE">사기 피해, 골든타임이 지나기 전에 | 법률사무소 샘플투</title>',
              '<title data-cid="GL-TITLE">{{TITLE}}</title>')
t = t.replace('<meta property="og:title" content="사기 피해, 골든타임이 지나기 전에 | 법률사무소 샘플투">',
              '<meta property="og:title" content="{{TITLE}}">')
assert t.count('{{TITLE}}') == 4, 'TITLE 토큰 실패'

t = t.replace('content="입금 직후가 회수의 골든타임입니다. 증거 보전부터 지급정지 검토, 형사 고소와 회수 절차까지 — 법률사무소 샘플투이 동시에 진행합니다."',
              'content="{{DESC}}"')
assert t.count('{{DESC}}') == 3, 'DESC 토큰 실패 (description+og+twitter)'
assert '{{SITE_NAME}}' in t and '{{OG_IMAGE}}' in t, '공유 메타 토큰 실패'
assert '{{BRAND_ICONS}}' in t, '브랜드 아이콘 토큰 실패'

t = t.replace("<script>\n(() => {\n'use strict';",
              "<script>window.__SLUG_K = {{KJSON}};</script>\n<script>\n(() => {\n'use strict';")
assert '{{KJSON}}' in t, 'KJSON 토큰 실패'

t = t.replace('<!-- ARTICLE-SLOT -->', '{{ARTICLE}}')
assert '{{ARTICLE}}' in t, 'ARTICLE 토큰 실패'

t = t.replace("let kRaw = (params.get('k') || 'default').slice(0, 24);",
              "let kRaw = ((window.__SLUG_K && window.__SLUG_K.key) || params.get('k') || 'default').slice(0, 24);")
assert '__SLUG_K.key' in t, 'kRaw 치환 실패'

for m in ['LFAN', 'LCARDS', 'LAWJS', 'CRED', 'FOOTER']:
    assert t.count(f'<!--FIRM:{m}-->') == 1 and t.count(f'<!--/FIRM:{m}-->') == 1, f'FIRM 마커 {m} 실패'

with open('src/templates/fraud-cinema.ts', 'w', encoding='utf-8') as f:
    f.write('// 자동 생성 — 편집 금지. 소스: fraud-v2.html, 재생성: python3 scripts/build-cinema-template.py\n')
    f.write('export const FRAUD_CINEMA_TEMPLATE: string = ' + json.dumps(t, ensure_ascii=False) + '\n')
print('OK', len(t), 'chars')
