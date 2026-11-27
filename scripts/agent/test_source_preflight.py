#!/usr/bin/env python3
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

from source_preflight import EXIT_FATAL, EXIT_OK, main, run_preflight, validate_health, validate_registry


NOW = "2026-08-11T00:00:00+00:00"


def source_registry() -> dict[str, object]:
    return {
        "sources": [
            {
                "id": "cafe",
                "type": "naver_cafe",
                "name": "Cafe",
                "sourceType": "community",
                "cafeId": 12345,
                "cafeUrl": "example_cafe",
                "menus": [{"menuId": 1, "menuName": "Board"}],
                "perPage": 30,
                "recrawlDays": 1,
            },
            {
                "id": "blog",
                "type": "naver_blog",
                "name": "Blog",
                "sourceType": "report",
                "blogId": "example_blog",
                "recrawlDays": 7,
            },
            {
                "id": "rss",
                "type": "rss",
                "name": "RSS",
                "sourceType": "report",
                "url": "https://example.test/feed.xml",
                "recrawlDays": 1,
            },
            {
                "id": "sitemap",
                "type": "sitemap",
                "name": "Sitemap",
                "sourceType": "report",
                "url": "https://example.test/sitemap.xml",
                "recrawlDays": 1,
                "maxSitemaps": 10,
                "maxItemsPerRun": 100,
            },
            {
                "id": "page",
                "type": "webpage",
                "name": "Page",
                "sourceType": "report",
                "url": "https://example.test/page",
            },
        ]
    }


def health_record(*, last_success: object = NOW) -> dict[str, object]:
    return {
        "successes": 1,
        "failures": 0,
        "new_items": 2,
        "latency_ms": 10.5,
        "last_success": last_success,
    }


class SourcePreflightTest(unittest.TestCase):
    def write_json(self, path: Path, value: object) -> None:
        path.write_text(json.dumps(value), encoding="utf-8")

    def run_files(
        self,
        registry: object,
        health: object | None = None,
        *,
        health_missing: bool = False,
    ) -> dict[str, object]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry_path = root / "registry.json"
            health_path = root / "health.json"
            self.write_json(registry_path, registry)
            if not health_missing:
                self.write_json(health_path, {} if health is None else health)
            return run_preflight(registry_path, health_path, now=NOW)

    def test_valid_registry_supports_all_collector_types(self):
        sources, errors = validate_registry(source_registry())
        self.assertEqual(len(sources), 5)
        self.assertEqual(errors, [])

    def test_query_param_sitemap_title_strategy_is_supported(self):
        registry = source_registry()
        sitemap = registry["sources"][3]
        sitemap["sitemapTitleStrategy"] = "query-param"
        sitemap["sitemapTitleQueryParam"] = "name"
        summary = self.run_files(registry)
        self.assertEqual(summary["exit_code"], EXIT_OK)
        self.assertEqual(summary["errors"], [])

        sitemap.pop("sitemapTitleQueryParam")
        summary = self.run_files(registry)
        self.assertEqual(summary["exit_code"], EXIT_FATAL)
        self.assertIn("missing_sitemap_title_query_param", {error["code"] for error in summary["errors"]})

    def test_registry_shape_ids_and_supported_type_are_fatal(self):
        registry = source_registry()
        registry["sources"] = [
            {"id": "", "type": "rss"},
            {"id": "same", "type": "unsupported"},
            {"id": "same", "type": "rss"},
        ]
        summary = self.run_files(registry)
        self.assertEqual(summary["status"], "fatal")
        self.assertEqual(summary["exit_code"], EXIT_FATAL)
        codes = {error["code"] for error in summary["errors"]}
        self.assertIn("invalid_source_id", codes)
        self.assertIn("unsupported_source_type", codes)
        self.assertIn("duplicate_source_id", codes)

    def test_required_urls_and_naver_identifiers_are_checked_without_network(self):
        registry = source_registry()
        sources = registry["sources"]
        assert isinstance(sources, list)
        sources[0]["cafeUrl"] = "https://cafe.naver.com/example"
        sources[1]["blogId"] = "https://blog.naver.com/example"
        sources[2]["url"] = "http://example.test/feed.xml"
        summary = self.run_files(registry)
        codes = {error["code"] for error in summary["errors"]}
        self.assertEqual(summary["exit_code"], EXIT_FATAL)
        self.assertIn("invalid_naver_identifier", codes)
        self.assertIn("invalid_https_url", codes)

    def test_cadence_and_limits_must_be_positive(self):
        registry = source_registry()
        sources = registry["sources"]
        assert isinstance(sources, list)
        sources[1]["recrawlDays"] = 0
        sources[3]["maxSitemaps"] = -1
        sources[3]["maxItemsPerRun"] = True
        summary = self.run_files(registry)
        codes = {error["code"] for error in summary["errors"]}
        self.assertEqual(summary["exit_code"], EXIT_FATAL)
        self.assertIn("invalid_positive_cadence", codes)
        self.assertIn("invalid_positive_limit", codes)

    def test_minute_cadence_is_rejected_after_single_daily_agent_migration(self):
        registry = source_registry()
        sources = registry["sources"]
        assert isinstance(sources, list)
        sources[2].pop("recrawlDays", None)
        sources[2]["recrawlMinutes"] = 15
        summary = self.run_files(registry)
        self.assertEqual(summary["exit_code"], EXIT_FATAL)
        self.assertIn("unsupported_minute_cadence", {error["code"] for error in summary["errors"]})

    def test_missing_health_is_nonfatal_and_explicitly_classified(self):
        summary = self.run_files(source_registry(), health_missing=True)
        self.assertEqual(summary["status"], "warning")
        self.assertEqual(summary["exit_code"], EXIT_OK)
        self.assertEqual(
            {source["status"] for source in summary["health"]["sources"]},
            {"missing"},
        )
        self.assertEqual(len(summary["warnings"]), 5)

    def test_missing_source_record_is_first_run_and_stale_record_is_nonfatal(self):
        health = {
            "cafe": health_record(last_success="2026-08-08T23:40:00+00:00"),
            "blog": health_record(last_success="2026-08-01T00:00:00+00:00"),
            "derived:search": health_record(),
        }
        summary = self.run_files(source_registry(), health)
        by_id = {source["id"]: source for source in summary["health"]["sources"]}
        self.assertEqual(summary["status"], "warning")
        self.assertEqual(summary["exit_code"], EXIT_OK)
        self.assertEqual(by_id["cafe"]["status"], "stale")
        self.assertEqual(by_id["blog"]["status"], "stale")
        self.assertEqual(by_id["rss"]["status"], "first_run")
        self.assertEqual(by_id["page"]["status"], "first_run")
        self.assertEqual(summary["health"]["unmatched_records"], ["derived:search"])

    def test_recent_health_is_healthy_and_no_warning(self):
        health = {
            "cafe": health_record(last_success="2026-08-10T23:59:59+00:00"),
            "blog": health_record(last_success="2026-08-10T00:00:01+00:00"),
            "rss": health_record(last_success="2026-08-10T23:59:59+00:00"),
            "sitemap": health_record(last_success="2026-08-10T23:59:59+00:00"),
            "page": health_record(last_success="2020-01-01T00:00:00+00:00"),
        }
        summary = self.run_files(source_registry(), health)
        by_id = {source["id"]: source for source in summary["health"]["sources"]}
        self.assertEqual(summary["status"], "ok")
        self.assertEqual(summary["exit_code"], EXIT_OK)
        self.assertEqual(by_id["cafe"]["status"], "healthy")
        self.assertEqual(by_id["blog"]["status"], "healthy")
        self.assertEqual(by_id["rss"]["status"], "healthy")
        self.assertEqual(by_id["sitemap"]["status"], "healthy")
        self.assertEqual(by_id["page"]["status"], "healthy")
        self.assertEqual(summary["warnings"], [])

    def test_unreadable_or_invalid_health_is_fatal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry_path = root / "registry.json"
            health_path = root / "health.json"
            self.write_json(registry_path, source_registry())
            health_path.write_text("{not json", encoding="utf-8")
            summary = run_preflight(registry_path, health_path, now=NOW)
            self.assertEqual(summary["exit_code"], EXIT_FATAL)
            self.assertEqual(summary["health"]["state"], "invalid")
            self.assertIn("invalid_health_json", {error["code"] for error in summary["errors"]})

            health_path.write_text(json.dumps([]), encoding="utf-8")
            summary = run_preflight(registry_path, health_path, now=NOW)
            self.assertEqual(summary["exit_code"], EXIT_FATAL)
            self.assertIn("invalid_health_shape", {error["code"] for error in summary["errors"]})

    def test_health_record_schema_is_strict_for_recorder_metrics(self):
        records, errors = validate_health({"cafe": {"successes": 1}})
        self.assertEqual(records, {})
        self.assertEqual(
            {error["code"] for error in errors},
            {"missing_health_field"},
        )
        records, errors = validate_health({"cafe": health_record(last_success="not-a-date")})
        self.assertEqual(records, {})
        self.assertEqual({error["code"] for error in errors}, {"invalid_health_timestamp"})

    def test_cli_emits_json_and_uses_fatal_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry_path = root / "registry.json"
            health_path = root / "health.json"
            self.write_json(registry_path, {"sources": []})
            self.write_json(health_path, {})
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                exit_code = main(["--registry", str(registry_path), "--health", str(health_path), "--now", NOW])
            self.assertEqual(exit_code, EXIT_FATAL)
            parsed = json.loads(output.getvalue())
            self.assertEqual(parsed["status"], "fatal")
            self.assertEqual(parsed["exit_code"], EXIT_FATAL)


if __name__ == "__main__":
    unittest.main()
