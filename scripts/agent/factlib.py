#!/usr/bin/env python3
"""사기 관측 본문 → 구조화 사실 추출 (결정적, LLM 불필요).

계약: 원문과 개인정보를 저장하지 않고 수법·인프라·금액만 구조화한다.

출력: {"method": [...], "infra": [{"type","value"}], "amounts": [...]}
  method   수법 태그 (키워드 규칙)
  infra    사기 인프라 — company/app/site/telegram/kakao/bank/wallet
  amounts  원문에 명시된 금액 문자열 원문 그대로 (집계·단정 금지)

컴플라이언스 (스펙 §컴플라이언스 게이트):
  - 전화번호·계좌번호 패턴은 절대 추출하지 않는다 (infra 타입에 없음, 정규식에도 없음).
  - 피해자 개인 식별정보(이름·나이·직업)는 추출 대상이 아니다.
  - 은행 infra 값은 은행'명'만 — 계좌번호 아님.
"""
import re
import sys

# ── 수법 규칙: (태그, [트리거 정규식 …]) — 하나라도 매치하면 태그 부여 ──
_METHOD_RULES = [
    ('출금거절',  [r'출금[^\n]{0,12}(거절|안\s?되|안돼|막[혔았]|정지|보류|지연|불가|묶)']),
    ('선입금요구', [r'(수수료|세금|보증금|수익금|인증금|전환금|출금비|해지금|참여비|초대비용)[^\n]{0,20}(입금|내라|납부|요구|요청|송금|선입금|먼저|금전)',
                r'선\s?입금']),
    ('리딩방',    [r'리딩\s?방', r'종목\s?추천', r'주식\s?리딩', r'전문가\s?방', r'단톡방']),
    ('원금보장',  [r'원금\s?보장', r'손실\s?없', r'무손실', r'확정\s?수익']),
    ('안전결제사칭', [r'안전\s?결제', r'안전\s?거래']),
    ('코인전환',  [r'코인', r'가상\s?화폐', r'가상자산', r'비트코인', r'usdt', r'테더', r'선물\s?거래']),
    ('텔레그램유인', [r'텔레그램', r'telegram', r'텔레\s?방']),
    ('로맨스',    [r'로맨스', r'애인|연인', r'소개팅|데이팅']),
    ('신분증요구', [r'(신분증|주민등록증|운전면허증|여권)[^\n]{0,20}(요구|등록|제출|업로드|입력)']),
    ('개인정보요구', [r'(개인\s*정보|전화번호|아이디)[^\n]{0,20}(요구|등록|제출|업로드|입력)']),
    ('앱설치유도', [r'(앱|어플|애플리케이션)[^\n]{0,20}(설치|다운로드)']),
    ('고수익유인', [r'고수익', r'(수익률|높은\s*수익)[^\n]{0,12}(보장|확정|약속)', r'단기간[^\n]{0,10}수익']),
    ('신뢰형성후금전요구', [r'신뢰[^\n]{0,80}(쌓|형성|구축)[^\n]{0,100}금전[^\n]{0,15}(요구|갈취)',
                       r'신뢰[^\n]{0,40}(후|뒤)[^\n]{0,80}금전[^\n]{0,15}(요구|갈취)']),
    ('SNS·메신저접근', [r'(소셜\s*미디어|소셜네트워크|SNS|메신저|문자\s*메시지|이메일)[^\n]{0,80}(접근|유인|광고|프로모션|연락)']),
    ('가짜사이트유인', [r'가짜\s*(?:웹\s*)?사이트', r'(홈페이지|웹사이트)[^\n]{0,80}(실제처럼|위장|조작)']),
    ('상품미배송·연락두절', [r'(구매|결제|상품)[^\n]{0,100}(배송되지|미배송)[^\n]{0,100}연락[^\n]{0,20}두절']),
    ('저가상품결제후미제공', [r'(가격[^\n]{0,20}(낮춰|할인)|저렴한\s*가격)[^\n]{0,160}결제[^\n]{0,100}(받지\s*못|미제공|미배송)']),
    ('지인관계악용·긴급상황연출', [r'지인[^\n]{0,40}(접근|연락)[^\n]{0,50}긴급한?\s*상황[^\n]{0,20}(연출|가장)']),
    ('거래소·프로토콜사칭', [r'(거래소|프로토콜)[^\n]{0,80}(사칭|명칭과 화면 구성을 사용|위장)',
                           r'(사칭|위장)[^\n]{0,80}(거래소|프로토콜)']),
    ('스테이킹예치유도', [r'스테이킹[^\n]{0,80}(예치|입금|전송)', r'(예치|입금)[^\n]{0,80}스테이킹']),
    ('사이트폐쇄', [r'(사이트|플랫폼|거래소)[^\n]{0,30}(폐쇄|사라졌|접속[^\n]{0,8}불가)',
                  r'(폐쇄|사라진)[^\n]{0,30}(사이트|플랫폼|거래소)']),
    ('예치자산미반환', [r'(예치한?\s*자산|투자금|자산)[^\n]{0,40}(돌려받지 못|반환[^\n]{0,12}(않|불가|거절))']),
    ('먹튀정황', [r'먹튀']),
]

# ── 은행명(대포통장 정황) — 값은 은행명만, 계좌번호는 절대 저장 안 함.
#    "하나/우리" 등 일상어 오인 방지를 위해 은행 접미사 포함 완전 토큰만 매치(긴 것 우선) ──
_BANKS = sorted(['국민은행', '신한은행', '우리은행', '하나은행', 'NH농협', '농협은행', '농협',
                 '기업은행', 'IBK', '카카오뱅크', '케이뱅크', '토스뱅크', '새마을금고',
                 '부산은행', '대구은행', 'iM뱅크', '광주은행', '수협은행', '수협', '우체국',
                 'SC제일은행', '제일은행', '씨티은행', '산업은행', '전북은행', '경남은행',
                 '제주은행', '신협'], key=len, reverse=True)
_BANK_CTX = re.compile(r'대포통장|지급정지|송금|이체|입금.*계좌|계좌.*입금')

# ── URL / 도메인 (사이트 인프라). 검색·플랫폼·뉴스 호스트는 제외 ──
_SAFE_HOSTS = ('naver.com', 'daum.net', 'google.', 'youtube.', 'youtu.be', 'kakao.com',
               'tistory.com', 'blog.', 'facebook.com', 'instagram.com', 'gov.kr', 'police',
               'wikipedia', 'namu.wiki')
_NEWS_HOSTS = ('kmib', 'chosun', 'donga', 'joins', 'joongang', 'hani.co', 'yna.co', 'yonhap',
               'news1', 'newsis', 'mk.co', 'hankyung', 'sedaily', 'edaily', 'mt.co', 'seoul.co',
               'khan.co', 'ohmynews', 'nocutnews', 'jtbc', 'ytn', 'wikitree', 'insight.co', 'nate')
_NEWS_PATH = re.compile(r'arcid|/article|/view|/news/|\.asp|/read', re.I)
_URL = re.compile(r'\b((?:https?://)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|kr|xyz|vip|top|cc|me|app|info|site|online|shop|biz)(?:/[^\s"\'<>]*)?)', re.I)
_TELEGRAM = re.compile(r'(?:(?<![\w.])@([A-Za-z][A-Za-z0-9_]{3,31})|t\.me/([A-Za-z0-9_+]{3,}))')
_KAKAO = re.compile(r'open\.kakao\.com/[^\s"\'<>]+', re.I)
_WALLET = re.compile(r'\b(0x[a-fA-F0-9]{40}|bc1[a-z0-9]{20,60}|T[A-Za-z0-9]{33})\b')

# ── 금액: 반드시 만/백만/천만/억 단위 (원문 인용, 집계 금지). 전화·계좌는 단위 없어 매치 안 됨 ──
_AMOUNT = re.compile(r'\d{1,4}(?:,\d{3})*\s*(?:억(?:\s*\d{1,4}\s*천?만?\s*원?)?|천만\s*원?|백만\s*원?|만\s*원)')


def _dedup(seq):
    seen, out = set(), []
    for x in seq:
        k = x if isinstance(x, str) else (x['type'], x['value'])
        if k not in seen:
            seen.add(k)
            out.append(x)
    return out


def extract_facts(body: str) -> dict:
    """본문 텍스트 → {method, infra, amounts}. 빈 사실이면 빈 리스트."""
    if not body:
        return {'method': [], 'infra': [], 'amounts': []}
    t = re.sub(r'\s+', ' ', body)
    # 일부 예방 글은 링크화를 피하려고 ``example .com``처럼 점 앞뒤를 띄운다.
    # 영문·숫자 호스트 조각 사이의 공백만 복원해 일반 문장부호에는 영향이 없게 한다.
    t = re.sub(r'(?<=[A-Za-z0-9-])\s*\.\s*(?=[A-Za-z0-9-])', '.', t)
    low = t.lower()

    method = [tag for tag, pats in _METHOD_RULES if any(re.search(p, t, re.I) for p in pats)]
    if '스테이킹예치유도' in method and '사이트폐쇄' in method:
        method.insert(0, '스테이킹거래소예치유도후폐쇄')

    infra = []
    for m in _URL.finditer(t):
        raw = m.group(1).rstrip('.,)')
        host = re.sub(r'^https?://', '', raw).split('/')[0].lower()
        if host.startswith('www.'):
            host = host[4:]
        if any(s in host for s in _SAFE_HOSTS) or any(s in host for s in _NEWS_HOSTS) or _NEWS_PATH.search(raw):
            continue
        infra.append({'type': 'site', 'value': host})   # 호스트만 — 스킴·경로 차이로 중복 방지
    for m in _TELEGRAM.finditer(t):
        h = m.group(1) or m.group(2)
        infra.append({'type': 'telegram', 'value': '@' + h if m.group(1) else 't.me/' + h})
    for m in _KAKAO.finditer(t):
        infra.append({'type': 'kakao', 'value': m.group(0).rstrip('.,)')})
    for m in _WALLET.finditer(t):
        infra.append({'type': 'wallet', 'value': m.group(1)})
    if _BANK_CTX.search(t):
        daepo = '대포통장' in t
        for b in _BANKS:
            if b in t:
                infra.append({'type': 'bank', 'value': b + ('(대포통장)' if daepo else '')})
                break  # 은행 1종만 대표로 (계좌 나열 방지)

    amounts = [re.sub(r'\s+', '', m.group(0)) for m in _AMOUNT.finditer(t)]

    return {'method': _dedup(method), 'infra': _dedup(infra)[:12], 'amounts': _dedup(amounts)[:6]}


def _selftest():
    b = ('리딩방에서 종목 추천 받고 전용 거래소 app.mock-case-07.example.com 에 가입했습니다. '
         '텔레그램 @sample_master 로 유인당했고, 출금하려니 세금 먼저 입금하라며 출금이 막혔습니다. '
         '국민은행 대포통장으로 3,000만원, 추가로 500만원 송금했습니다. '
         '제 번호 010-1234-5678, 계좌 123-4567-8901 로 연락 왔어요.')
    f = extract_facts(b)
    assert '출금거절' in f['method'] and '선입금요구' in f['method'] and '리딩방' in f['method'], f['method']
    assert '텔레그램유인' in f['method'], f['method']
    vals = {i['value'] for i in f['infra']}
    assert any('mock-case-07.example.com' in v for v in vals), vals
    assert '@sample_master' in vals, vals
    assert any('국민은행' in v for v in vals), vals
    assert '3,000만원' in f['amounts'] and '500만원' in f['amounts'], f['amounts']
    # 컴플라이언스: 전화·계좌 번호가 어떤 필드에도 새지 않는다
    blob = str(f)
    assert '010-1234-5678' not in blob and '1234' not in blob and '123-4567' not in blob, f'PII 유출: {blob}'
    # 은행 infra 값은 은행명만 (숫자 없음)
    for i in f['infra']:
        if i['type'] == 'bank':
            assert not re.search(r'\d', i['value']), i
    staking = extract_facts(
        '실제 프로토콜의 명칭과 화면 구성을 사용한 거래소에서 스테이킹 명목으로 자산을 예치하게 했습니다. '
        '이후 사이트가 폐쇄됐고 예치한 자산을 돌려받지 못했으며 먹튀 주의가 필요합니다.'
    )
    assert '스테이킹거래소예치유도후폐쇄' in staking['method'], staking
    assert '거래소·프로토콜사칭' in staking['method'], staking
    assert '예치자산미반환' in staking['method'] and '먹튀정황' in staking['method'], staking
    social = extract_facts(
        'SNS 광고로 접근해 신뢰를 쌓은 뒤 높은 수익을 약속하며 금전을 요구했습니다. '
        '가짜 웹사이트에서 보증금 명목으로 금전을 요구했고 상품은 미배송된 채 연락이 두절됐습니다.'
    )
    assert '신뢰형성후금전요구' in social['method'], social
    assert 'SNS·메신저접근' in social['method'] and '가짜사이트유인' in social['method'], social
    assert '고수익유인' in social['method'] and '선입금요구' in social['method'], social
    assert '상품미배송·연락두절' in social['method'], social
    ticket = extract_facts(
        '티켓 가격을 대폭 낮춰 광고하고 저렴한 가격에 이끌린 피해자가 결제했지만 티켓을 받지 못했습니다.'
    )
    assert '저가상품결제후미제공' in ticket['method'], ticket
    urgent = extract_facts('알고 있는 지인처럼 접근한 뒤 긴급한 상황을 연출해 초대비용 송금을 요청했습니다.')
    assert '지인관계악용·긴급상황연출' in urgent['method'] and '선입금요구' in urgent['method'], urgent
    print('factlib selftest OK:', f)


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        _selftest()
