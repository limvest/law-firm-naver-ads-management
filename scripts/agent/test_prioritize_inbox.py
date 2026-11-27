#!/usr/bin/env python3
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

from prioritize_inbox import (  # noqa: E402
    canonicalize_link,
    explain_row,
    main,
    parse_pub_date,
    prioritize_rows,
    rank_rows,
    read_ndjson,
    score_row,
    write_ndjson,
)


NOW = "2026-08-10T00:00:00+00:00"


def row(
    name: str,
    *,
    query: str = "리딩방 사기 거래소",
    title: str | None = None,
    link: str | None = None,
    source: str = "news.example",
    pub_date: str = "2026-08-09T00:00:00Z",
    source_type: str = "news",
    **extra: object,
) -> dict[str, object]:
    return {
        "query": query,
        "title": title if title is not None else name,
        "link": link if link is not None else f"https://example.test/{name}",
        "source": source,
        "pubDate": pub_date,
        "sourceType": source_type,
        **extra,
    }


class PrioritizeInboxTest(unittest.TestCase):
    def test_canonical_link_removes_tracking_fragment_and_root_slash(self):
        first = "HTTPS://Example.TEST/article/?utm_source=rss&b=2&a=1#comments"
        second = "https://example.test/article?a=1&b=2&utm_medium=email"
        self.assertEqual(canonicalize_link(first), "https://example.test/article?a=1&b=2")
        self.assertEqual(canonicalize_link(first), canonicalize_link(second))

    def test_dedupe_search_filter_and_output_schema(self):
        duplicate = row("same", link="https://EXAMPLE.test/same/?utm_source=x#part")
        duplicate["title"] = "first title"
        duplicate_later = row("same-later", link="https://example.test/same", title="later title")
        search = row("known", query="검색/known", link="https://example.test/known")
        original_keys = list(duplicate)

        output = prioritize_rows([duplicate, duplicate_later, search], now=NOW)

        self.assertEqual(len(output), 1)
        self.assertEqual(list(output[0]), original_keys)
        self.assertNotIn("score", output[0])
        self.assertNotIn("reasons", output[0])
        self.assertEqual(output[0]["link"], duplicate["link"])

    def test_default_keeps_all_unique_non_search_rows_and_limit_is_opt_in(self):
        rows = [row(str(index), link=f"https://example.test/{index}") for index in range(4)]
        rows.append(row("search", query="검색/already-known", link="https://example.test/search"))

        self.assertEqual(len(prioritize_rows(rows, now=NOW)), 4)
        self.assertEqual(len(prioritize_rows(rows, now=NOW, limit=2)), 2)
        self.assertEqual(prioritize_rows(rows, now=NOW, limit=0), [])

    def test_recency_source_independence_and_report_concentration_are_explainable(self):
        recent_community = row(
            "community",
            title='"Acme123" 피해 신고',
            link="https://example.test/community",
            source="피해자 커뮤니티",
            source_type="community",
            pub_date=NOW,
        )
        old_news = row(
            "news",
            link="https://example.test/news",
            source="독립 뉴스",
            source_type="news",
            pub_date="2025-01-01",
        )
        reports = [
            row(
                f"report-{index}",
                link=f"https://law.example/report-{index}",
                title=f"보고서 {index}",
                source="법무법인 한곳 블로그",
                source_type="report",
                pub_date=NOW,
            )
            for index in range(4)
        ]
        ranked = rank_rows([old_news, *reports, recent_community], now=NOW)
        self.assertEqual(ranked[0].row, recent_community)
        self.assertEqual(ranked[0].row["sourceType"], "community")
        self.assertTrue(any(reason.startswith("recency: <=1d") for reason in ranked[0].reasons))
        self.assertTrue(any("independent-source" in reason for reason in ranked[0].reasons))
        self.assertTrue(any("quoted name" in reason for reason in ranked[0].reasons))
        self.assertTrue(any("alphanumeric brand" in reason for reason in ranked[0].reasons))
        self.assertTrue(any("report concentration" in reason for reason in ranked[-1].reasons))
        self.assertGreater(score_row(recent_community, now=NOW, corpus=[recent_community, *reports]), score_row(reports[0], now=NOW, corpus=[recent_community, *reports]))

    def test_fixed_now_makes_result_and_explanation_repeatable(self):
        rows = [
            row("b", title="plain", link="https://example.test/b", pub_date="2026-08-01"),
            row("a", title='"Acme123"', link="https://example.test/a", pub_date="2026-08-01"),
        ]
        first = rank_rows(rows, now=NOW)
        second = rank_rows(list(reversed(rows)), now=NOW)
        self.assertEqual([item.row for item in first], [item.row for item in second])
        self.assertEqual([(item.score, item.reasons) for item in first], [(item.score, item.reasons) for item in second])
        self.assertEqual(explain_row(rows[0], now=NOW), explain_row(rows[0], now=NOW))

    def test_date_parser_covers_epoch_iso_and_rfc822(self):
        epoch_ms = str(int(datetime(2026, 8, 9, tzinfo=timezone.utc).timestamp() * 1000))
        self.assertEqual(parse_pub_date(epoch_ms), datetime(2026, 8, 9, tzinfo=timezone.utc))
        self.assertEqual(parse_pub_date("2026-08-09T00:00:00Z"), datetime(2026, 8, 9, tzinfo=timezone.utc))
        self.assertIsNotNone(parse_pub_date("Sun, 09 Aug 2026 00:00:00 GMT"))
        self.assertIsNone(parse_pub_date("not a date"))

    def test_ndjson_helpers_preserve_fields_without_metadata(self):
        rows = [row("one", extraField="keep me"), row("two")]
        source = io.StringIO()
        write_ndjson(rows, source)
        parsed = read_ndjson(io.StringIO(source.getvalue()))
        self.assertEqual(parsed, rows)
        self.assertNotIn("score", parsed[0])

    def test_cli_supports_stdin_stdout_and_file_paths(self):
        payload = "\n".join(json.dumps(item, ensure_ascii=False) for item in [row("old", pub_date="2025-01-01"), row("new", pub_date=NOW)]) + "\n"
        script = Path(__file__).with_name("prioritize_inbox.py")
        completed = subprocess.run(
            [sys.executable, str(script), "--now", NOW],
            input=payload,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        output = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(output[0]["title"], "new")

        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "in.ndjson"
            output_path = Path(directory) / "out.ndjson"
            input_path.write_text(payload, encoding="utf-8")
            self.assertEqual(main(["-i", str(input_path), "-o", str(output_path), "--now", NOW, "--limit", "1"]), 0)
            file_output = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(file_output), 1)
            self.assertEqual(file_output[0]["title"], "new")


if __name__ == "__main__":
    unittest.main()
