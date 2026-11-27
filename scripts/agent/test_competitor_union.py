#!/usr/bin/env python3
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

from competitor_union import (  # noqa: E402
    accumulate_union,
    build_union,
    clean_display_title,
    iter_ndjson_rows,
    load_competitor_families,
    normalize_keyword,
    write_outputs,
)


class CompetitorUnionTest(unittest.TestCase):
    def test_competitor_families_are_discovered_from_registry_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = Path(directory) / "sources.json"
            registry.write_text(json.dumps({"sources": [
                {"type": "sitemap", "sourceFamily": "one", "competitorKeywordSource": True},
                {"type": "rss", "sourceFamily": "ignored", "competitorKeywordSource": True},
                {"type": "sitemap", "sourceFamily": "two", "competitorKeywordSource": True},
            ]}), encoding="utf-8")
            self.assertEqual(load_competitor_families(registry), ("one", "two"))

    def test_normalization_collapses_known_sitemap_variants(self):
        self.assertEqual(clean_display_title("https://www.Example.comfraud"), "Example.com")
        self.assertEqual(normalize_keyword("Example.com fraud"), "examplecom")
        self.assertEqual(normalize_keyword("Ｅｘａｍｐｌｅ．ｃｏｍ"), "examplecom")

    def test_union_intersections_and_provenance(self):
        rows = [
            {"title": "Alpha fraud", "link": "https://day/scam/alpha", "pubDate": "1", "sourceFamily": "day"},
            {"title": "ALPHA", "link": "https://yoon/recovery/alpha", "pubDate": "2", "sourceFamily": "yoon"},
            {"title": "Beta", "link": "https://yoon/recovery/beta", "pubDate": "3", "sourceFamily": "yoon"},
            {"title": "Beta", "link": "https://scam/cases/beta", "pubDate": "4", "sourceFamily": "scam"},
            {"title": "Gamma", "link": "https://scam/cases/gamma", "pubDate": "5", "sourceFamily": "scam"},
        ]
        report = build_union(rows, ("day", "yoon", "scam"))
        self.assertEqual(report["stats"]["union"], 3)
        self.assertEqual(report["stats"]["pairwiseIntersections"]["day__yoon"], 1)
        self.assertEqual(report["stats"]["pairwiseIntersections"]["yoon__scam"], 1)
        self.assertEqual(report["stats"]["allFamiliesIntersection"], 0)
        alpha = next(item for item in report["keywords"] if item["normalized"] == "alpha")
        self.assertEqual(alpha["sourceFamilies"], ["day", "yoon"])
        self.assertEqual(len(alpha["observations"]), 2)

    def test_ndjson_filter_and_atomic_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "rows.ndjson"
            source.write_text(
                "\n".join(
                    json.dumps(row, ensure_ascii=False)
                    for row in [
                        {"title": "가나다 fraud", "link": "https://a/1", "pubDate": "", "sourceFamily": "a"},
                        {"title": "제외", "link": "https://x/1", "pubDate": "", "sourceFamily": "x"},
                        {"title": "라마바", "link": "https://b/1", "pubDate": "", "sourceFamily": "b"},
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            report = build_union(iter_ndjson_rows([source], {"a", "b"}), ("a", "b"))
            json_output = root / "out.json"
            text_output = root / "out.txt"
            write_outputs(report, json_output, text_output)
            self.assertEqual(json.loads(json_output.read_text())["stats"]["union"], 2)
            self.assertEqual(text_output.read_text(encoding="utf-8").splitlines(), ["가나다", "라마바"])

    def test_accumulation_retains_removed_keys_and_adds_new_keys(self):
        families = ("day", "yoon")
        first = accumulate_union(
            [
                {"title": "Old fraud", "link": "https://day/old", "pubDate": "1", "sourceFamily": "day"},
                {"title": "Shared", "link": "https://yoon/shared", "pubDate": "1", "sourceFamily": "yoon"},
            ],
            families,
        )
        second = accumulate_union(
            [
                {"title": "Shared", "link": "https://yoon/shared", "pubDate": "2", "sourceFamily": "yoon"},
                {"title": "New", "link": "https://day/new", "pubDate": "2", "sourceFamily": "day"},
            ],
            families,
            first,
        )

        self.assertEqual(second["stats"]["union"], 3)
        self.assertEqual(second["currentSnapshotStats"]["union"], 2)
        self.assertEqual(second["delta"]["newNormalizedKeywords"], 1)
        self.assertEqual(second["delta"]["historicalKeywordsAbsentFromCurrentSnapshot"], 1)
        self.assertEqual(second["stats"]["retainedObservationsByFamily"], {"day": 2, "yoon": 1})
        self.assertEqual(
            {item["normalized"] for item in second["keywords"]},
            {"old", "shared", "new"},
        )

        third = accumulate_union(
            [
                {"title": "Shared", "link": "https://yoon/shared", "pubDate": "3", "sourceFamily": "yoon"},
                {"title": "New", "link": "https://day/new", "pubDate": "3", "sourceFamily": "day"},
            ],
            families,
            second,
        )
        self.assertEqual(third["stats"]["union"], 3)
        self.assertEqual(third["stats"]["retainedObservationsByFamily"], {"day": 2, "yoon": 1})
        self.assertEqual(third["delta"]["newNormalizedKeywords"], 0)
        self.assertEqual(third["delta"]["newObservations"], 0)

    def test_empty_normalized_rows_do_not_create_permanent_false_delta(self):
        report = accumulate_union(
            [
                {"title": "fraud", "link": "https://day/empty", "pubDate": "1", "sourceFamily": "day"},
                {"title": "Real fraud", "link": "https://day/real", "pubDate": "1", "sourceFamily": "day"},
            ],
            ("day",),
        )
        rerun = accumulate_union(
            [
                {"title": "fraud", "link": "https://day/empty", "pubDate": "2", "sourceFamily": "day"},
                {"title": "Real fraud", "link": "https://day/real", "pubDate": "2", "sourceFamily": "day"},
            ],
            ("day",),
            report,
        )

        self.assertEqual(report["stats"]["union"], 1)
        self.assertEqual(rerun["delta"]["newNormalizedKeywords"], 0)
        self.assertEqual(rerun["delta"]["newObservations"], 0)


if __name__ == "__main__":
    unittest.main()
