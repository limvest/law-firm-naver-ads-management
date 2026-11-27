#!/usr/bin/env python3
import unittest
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from feedlib import (
    collect_sitemap_entries,
    case_name_from_page_title,
    case_name_from_keyword_slug,
    parse_naver_loose_json,
    detect_sitemap_changes,
    has_sitemap_changed,
    parse_sitemap,
    select_new_entries,
    sitemap_entry_fingerprint,
    sitemap_entry_fingerprints,
    sitemap_fingerprint,
    sitemap_title,
    extract_html_metadata,
    extract_html_headings,
    extract_article_text,
    extract_detail_text,
    extract_same_origin_links,
    extract_naver_blog_text,
)


URLSET = """<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/cases/old-case</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://example.com/cases/new-case</loc><lastmod>2026-02-01</lastmod></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>"""


class FeedlibTest(unittest.TestCase):
    def test_parse_naver_loose_json_accepts_naver_dialect(self):
        self.assertEqual(parse_naver_loose_json('{"title":"it\\\'s\ncase"}\nignored')["title"], "it's\ncase")

    def test_parse_naver_loose_json_removes_exposed_chunk_size(self):
        parsed = parse_naver_loose_json('{"title":"cherry\r\n1FF8\r\nroom"}')
        self.assertEqual(parsed['title'], 'cherryroom')

    def test_sitemap_parser_removes_exposed_chunk_size(self):
        kind, entries = parse_sitemap(
            '<?xml version="1.0"?><urlset><url><loc>https://x.test/a</loc>'
            '<lastmod>2026-05-\r\n7fe0\r\n31</lastmod></url></urlset>'
        )
        self.assertEqual(kind, 'urlset')
        self.assertEqual(entries[0]['lastmod'], '2026-05-31')

    def test_keyword_only_slug_normalizes_suffixes_and_compact_domains(self):
        self.assertEqual(case_name_from_keyword_slug('가상종합증권사칭'), '가상종합증권')
        self.assertEqual(case_name_from_keyword_slug('mockmarketkoreacom'), 'mockmarketkorea.com')
        self.assertEqual(case_name_from_keyword_slug('티켓사기'), '')

    def test_extract_article_text_excludes_surrounding_content_and_contacts(self):
        text = extract_article_text(
            '<main>메뉴<article><h1>사건</h1><p>신분증 등록을 요구했습니다.</p>'
            '<script>관련사건.example</script><p>010-1234-5678</p></article>'
            '<section>다른 사건 bad.example</section></main>'
        )
        self.assertIn('신분증 등록', text)
        self.assertIn('[전화번호]', text)
        self.assertNotIn('bad.example', text)
        self.assertNotIn('관련사건.example', text)

    def test_extract_article_text_keeps_article_boundary_after_void_tags(self):
        text = extract_article_text(
            '<main><article><p>출금이 거절됐습니다.</p><br><img src="/logo.png">'
            '</article><footer>footer.example</footer></main>'
        )
        self.assertIn('출금이 거절', text)
        self.assertNotIn('footer.example', text)

    def test_extract_article_text_is_empty_without_article(self):
        self.assertEqual(extract_article_text('<main>관련 사건 bad.example</main>'), '')

    def test_extract_naver_blog_text_uses_editor_body_only(self):
        text = extract_naver_blog_text(
            '<header>관련글 outside.example</header>'
            '<div class="se-main-container"><p class="se-text-paragraph">'
            '스테이킹 예치를 유도한 뒤 거래소가 폐쇄됐고 3,000만원을 돌려받지 못했습니다.'
            '</p><script>bad.example</script><p>010-1234-5678</p></div>'
            '<footer>광고 footer.example</footer>'
        )
        self.assertIn('스테이킹 예치', text)
        self.assertIn('3,000만원', text)
        self.assertIn('[전화번호]', text)
        self.assertNotIn('outside.example', text)
        self.assertNotIn('bad.example', text)
        self.assertNotIn('footer.example', text)

    def test_extract_naver_blog_text_supports_legacy_container(self):
        self.assertEqual(
            extract_naver_blog_text('<div id="postViewArea"><p>출금이 거절됐습니다.</p></div>'),
            '출금이 거절됐습니다.',
        )

    def test_extract_naver_blog_text_keeps_editor_boundary_after_void_tags(self):
        text = extract_naver_blog_text(
            '<div class="se-main-container"><p>거래소가 폐쇄됐습니다.</p><br><img src="/logo.png">'
            '</div><footer>footer.example</footer>'
        )
        self.assertIn('거래소가 폐쇄', text)
        self.assertNotIn('footer.example', text)

    def test_extract_detail_text_uses_analyzed_class_selector(self):
        text = extract_detail_text(
            '<nav>outside.example</nav><div class="entry-content"><p>입금 후 출금이 거절됐습니다.</p>'
            '<br><span>010-1234-5678</span></div><footer>footer.example</footer>',
            'entry-content',
        )
        self.assertIn('출금이 거절', text)
        self.assertIn('[전화번호]', text)
        self.assertNotIn('outside.example', text)
        self.assertNotIn('footer.example', text)

    def test_extract_detail_text_does_not_close_container_on_void_tag(self):
        text = extract_detail_text(
            '<main><header><img src="/logo.png" /></header>'
            '<section><p>스테이킹 거래소 폐쇄 후 출금이 거절됐습니다.</p></section></main>',
            'main',
        )
        self.assertIn('거래소 폐쇄', text)
        self.assertIn('출금이 거절', text)

    def test_extract_same_origin_links_filters_to_analyzed_path(self):
        links = extract_same_origin_links(
            '<a href="/about">소개</a><a href="/fraud/a">A 사건</a>'
            '<a href="https://other.test/fraud/b">외부</a><a href="/fraud/a#top">중복</a>'
            '<a href="/x/fraud/b">부분일치</a><a href="/fraudulent/c">경계오류</a>',
            'https://example.test/fraud/',
            '/fraud/',
        )
        self.assertEqual(links, [{'url': 'https://example.test/fraud/a', 'title': 'A 사건'}])

    def test_parse_and_select_new_entries(self):
        kind, entries = parse_sitemap(URLSET)
        self.assertEqual(kind, "urlset")
        selected = select_new_entries(
            entries,
            {"https://example.com/cases/old-case"},
            include_path="/cases/",
            limit=10,
        )
        self.assertEqual([x["loc"] for x in selected], ["https://example.com/cases/new-case"])

    def test_index_follows_only_same_host(self):
        index = """<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/one.xml</loc></sitemap>
          <sitemap><loc>https://other.example/two.xml</loc></sitemap>
        </sitemapindex>"""
        pages = {"https://example.com/index.xml": index, "https://example.com/one.xml": URLSET}
        entries = collect_sitemap_entries(pages.__getitem__, "https://example.com/index.xml")
        self.assertEqual(len(entries), 3)

    def test_nested_index_is_recursive_and_cap_never_silently_truncates(self):
        index = """<sitemapindex><sitemap><loc>https://example.com/nested.xml</loc></sitemap></sitemapindex>"""
        nested = """<sitemapindex><sitemap><loc>https://example.com/one.xml</loc></sitemap></sitemapindex>"""
        pages = {
            "https://example.com/index.xml": index,
            "https://example.com/nested.xml": nested,
            "https://example.com/one.xml": URLSET,
        }
        self.assertEqual(
            len(collect_sitemap_entries(pages.__getitem__, "https://example.com/index.xml", max_sitemaps=3)),
            3,
        )
        with self.assertRaisesRegex(ValueError, "exceeds max_sitemaps"):
            collect_sitemap_entries(pages.__getitem__, "https://example.com/index.xml", max_sitemaps=2)

    def test_title_decodes_slug(self):
        self.assertEqual(sitemap_title("https://x.test/cases/%EC%95%8C%ED%8C%8C-trade_fraud"), "알파 trade fraud")
        self.assertEqual(sitemap_title("https://x.test/"), "")

    def test_title_can_select_first_seo_slug_token(self):
        self.assertEqual(
            sitemap_title(
                "https://x.test/fraud/rocket-가상업체D-사칭-피해-a52d11",
                "first-slug-token",
            ),
            "rocket",
        )

    def test_title_can_select_decoded_query_parameter(self):
        self.assertEqual(
            sitemap_title(
                "https://x.test/fraud_detail?slug=rocket&name=%EA%B0%80%EC%83%81%20%EC%82%AC%EC%B9%AD%20%EC%82%AC%EA%B8%B0",
                "query-param",
                "name",
            ),
            "가상 사칭 사기",
        )

    def test_extracts_bounded_html_metadata_and_case_name(self):
        metadata = extract_html_metadata(
            '<html><head><title>fallback</title><meta property="og:title" content="Mock Pool 사칭 사기 | 경쟁사B">'
            '<meta name="description" content="mock-case-05.example.com 출금 거절 피해 010-1234-5678 a@b.com"></head></html>'
        )
        self.assertEqual(metadata, {
            'title': 'Mock Pool 사칭 사기 | 경쟁사B',
            'description': 'mock-case-05.example.com 출금 거절 피해 [전화번호] [이메일]',
        })
        self.assertEqual(case_name_from_page_title(metadata['title']), 'Mock Pool')
        self.assertEqual(
            case_name_from_page_title('가상종합증권사칭 사기(사칭) 피해 집단소송 | 금명'),
            '가상종합증권',
        )
        self.assertEqual(case_name_from_page_title('mockmarketkoreacom 사기(사칭) 금융투자 사기'), 'mockmarketkorea.com')
        self.assertEqual(case_name_from_page_title('고수익알바 사기 피해 대응'), '')
        self.assertEqual(case_name_from_page_title('정부지원금부정수급 사기 피해 대응'), '')
        self.assertEqual(case_name_from_page_title('가상리딩방A 텔레그램 리딩방 투자 주의'), '가상리딩방A')
        self.assertEqual(case_name_from_page_title('가상트레이딩A계좌사칭 사기 피해 대응'), '가상트레이딩A')
        self.assertEqual(case_name_from_page_title('가상화폐도지코인사칭 사기 피해 대응'), '')
        self.assertEqual(case_name_from_page_title('법무법인 경쟁사C 투자사기'), '')

    def test_extract_html_headings_supports_site_wide_title_fallback(self):
        headings = extract_html_headings(
            '<h1>금융범죄</h1><script><h2>가짜 사기</h2></script>'
            '<article><h2>가상업체C 투자 사기, mock-case-06.example.com 피해</h2></article>'
        )
        self.assertEqual(headings, ['금융범죄', '가상업체C 투자 사기, mock-case-06.example.com 피해'])

    def test_doctype_rejected(self):
        with self.assertRaises(ValueError):
            parse_sitemap("<!DOCTYPE foo><urlset></urlset>")

    def test_trailing_cdn_diagnostic_after_complete_sitemap_is_ignored(self):
        kind, entries = parse_sitemap(URLSET + "\n<!-- edge diagnostic -->")
        self.assertEqual(kind, "urlset")
        self.assertEqual(len(entries), 3)

    def test_malformed_urlset_skips_strict_xml_but_keeps_valid_public_rows(self):
        malformed = (
            '<urlset><url><loc>https://example.com/case?a=1&b=2</loc>'
            '<lastmod>2026-08-29</lastmod></url></urlset>'
        )
        kind, entries = parse_sitemap(malformed)
        self.assertEqual(kind, 'urlset')
        self.assertEqual(entries, [{
            'loc': 'https://example.com/case?a=1&b=2',
            'lastmod': '2026-08-29',
        }])

    def test_entry_fingerprint_changes_when_url_or_lastmod_changes(self):
        entry = {"loc": "https://example.com/cases/one", "lastmod": "2026-02-01"}
        original = dict(entry)
        fingerprint = sitemap_entry_fingerprint(entry)
        self.assertEqual(fingerprint, sitemap_entry_fingerprint(dict(entry)))
        self.assertEqual(fingerprint, sitemap_entry_fingerprint(url=entry["loc"], lastmod=entry["lastmod"]))
        self.assertNotEqual(fingerprint, sitemap_entry_fingerprint({**entry, "lastmod": "2026-02-02"}))
        self.assertNotEqual(fingerprint, sitemap_entry_fingerprint({**entry, "loc": "https://example.com/cases/two"}))
        self.assertEqual(entry, original)

    def test_sitemap_fingerprint_is_order_independent_but_detects_changes(self):
        _, entries = parse_sitemap(URLSET)
        self.assertEqual(sitemap_fingerprint(entries), sitemap_fingerprint(list(reversed(entries))))
        changed = [{**entry, "lastmod": "2026-12-31"} if entry["loc"].endswith("new-case") else entry for entry in entries]
        self.assertNotEqual(sitemap_fingerprint(entries), sitemap_fingerprint(changed))
        self.assertTrue(has_sitemap_changed(changed, sitemap_fingerprint(entries)))
        self.assertFalse(has_sitemap_changed(entries, sitemap_fingerprint(entries)))

    def test_detect_sitemap_changes_returns_new_and_lastmod_changed_rows(self):
        previous = [
            {"loc": "https://example.com/cases/old-case", "lastmod": "2026-01-01"},
            {"loc": "https://example.com/cases/new-case", "lastmod": "2026-02-01"},
        ]
        current = [
            previous[0],
            {"loc": "https://example.com/cases/new-case", "lastmod": "2026-02-02"},
            {"loc": "https://example.com/cases/brand-new", "lastmod": "2026-02-03"},
        ]
        changed = detect_sitemap_changes(current, sitemap_entry_fingerprints(previous))
        self.assertEqual(
            [entry["loc"] for entry in changed],
            ["https://example.com/cases/new-case", "https://example.com/cases/brand-new"],
        )

        compact_state = {entry["loc"]: entry["lastmod"] for entry in previous}
        self.assertEqual(
            [entry["loc"] for entry in detect_sitemap_changes(previous, compact_state)],
            [],
        )

    def test_detect_sitemap_changes_accepts_previous_rows_and_path_limit(self):
        previous = [{"loc": "https://example.com/about", "lastmod": "2026-01-01"}]
        current = [
            {"loc": "https://example.com/cases/a", "lastmod": "2026-01-01"},
            {"loc": "https://example.com/cases/b", "lastmod": "2026-01-02"},
            {"loc": "https://example.com/about", "lastmod": "2026-02-01"},
        ]
        changed = detect_sitemap_changes(current, previous, include_path="/cases/", limit=1)
        self.assertEqual([entry["loc"] for entry in changed], ["https://example.com/cases/a"])
        self.assertEqual(detect_sitemap_changes(current, previous, limit=0), [])


if __name__ == "__main__":
    unittest.main()
