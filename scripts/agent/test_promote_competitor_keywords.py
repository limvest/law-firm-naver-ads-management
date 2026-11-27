#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from promote_competitor_keywords import promote  # noqa: E402


def record(name, families):
    return {
        "normalized": name.lower().replace(" ", ""),
        "display": name,
        "variants": [name],
        "sourceFamilies": families,
        "observations": [
            {"sourceFamily": family, "title": name, "url": f"https://{family}/{name}", "lastmod": "2026-08-10"}
            for family in families
        ],
    }


class PromoteCompetitorKeywordsTest(unittest.TestCase):
    def test_demo_all_publishes_quality_candidate_and_rejects_noise(self):
        union = {
            "generatedAt": "2026-08-10T00:00:00+00:00",
            "families": ["a", "b", "c"],
            "currentNormalizedKeywords": ["전화"],
            "keywords": [
                {
                    "normalized": "전화",
                    "display": "전화",
                    "sourceFamilies": ["a"],
                    "variants": ["전화"],
                    "observations": [],
                },
                {
                    "normalized": "historicalcase",
                    "display": "Historical Case",
                    "sourceFamilies": ["b"],
                    "variants": ["Historical Case"],
                    "observations": [],
                },
            ],
        }

        store, report = promote(union, {"keywords": []}, demo_all=True)

        self.assertEqual(len(store["keywords"]), 1)
        by_name = {row["name"]: row for row in store["keywords"]}
        self.assertEqual(by_name["Historical Case"]["status"], "published")
        self.assertTrue(all(row["demoCorpus"] for row in store["keywords"]))
        self.assertEqual(len(report["demoKeywordMappings"]), 1)
        self.assertEqual(len(report["demoSlugs"]), 1)
        self.assertEqual(report["counts"]["rejected"], 1)

    def test_quality_candidates_publish_even_from_a_single_source(self):
        union = {"generatedAt": "2026-08-10T00:00:00+00:00", "keywords": [
            record("AlphaX", ["a", "b", "c"]),
            record("BetaX", ["a", "b"]),
            record("GammaX", ["a"]),
        ]}
        store, report = promote(union, {"keywords": []})
        by_name = {item["name"]: item for item in store["keywords"]}
        self.assertEqual(by_name["AlphaX"]["status"], "published")
        self.assertTrue(by_name["AlphaX"]["autoPublish"])
        self.assertTrue(by_name["AlphaX"]["competitorManaged"])
        self.assertEqual(by_name["BetaX"]["status"], "published")
        self.assertEqual(by_name["BetaX"]["scamType"], "other")
        self.assertEqual(by_name["GammaX"]["status"], "published")
        self.assertEqual(report["counts"]["published"], 3)

    def test_noise_is_rejected_but_existing_keyword_gets_new_provenance(self):
        existing = {
            "name": "전화", "slug": "existing-phone", "scamType": "leading", "aliases": [],
            "status": "published", "firstSeenAt": None, "lastSeenAt": None, "observations": [],
        }
        union = {"generatedAt": "2026-08-10T00:00:00+00:00", "keywords": [
            record("전화", ["a", "b", "c"]),
            record("1000만원", ["a", "b", "c"]),
        ]}
        store, report = promote(union, {"keywords": [existing]})
        self.assertEqual(len(store["keywords"]), 1)
        self.assertEqual(len(existing["observations"]), 3)
        self.assertEqual(report["counts"]["rejected"], 1)

    def test_rerun_is_idempotent(self):
        union = {"generatedAt": "2026-08-10T00:00:00+00:00", "keywords": [record("CoinAlpha", ["a", "b", "c"])]}
        first, _ = promote(union, {"keywords": []})
        second, report = promote(union, first)
        self.assertEqual(len(second["keywords"]), 1)
        self.assertEqual(len(second["keywords"][0]["observations"]), 3)
        self.assertEqual(report["changedSlugs"], [])

    def test_independent_evidence_is_not_required_for_publication(self):
        first, _ = promote(
            {"generatedAt": "2026-08-10T00:00:00+00:00", "keywords": [record("UpgradeX", ["a", "b"])]},
            {"keywords": []},
        )
        second, report = promote(
            {"generatedAt": "2026-08-11T00:00:00+00:00", "keywords": [record("UpgradeX", ["a", "b", "c"])]},
            first,
        )
        self.assertEqual(second["keywords"][0]["status"], "published")
        self.assertTrue(second["keywords"][0]["autoPublish"])

    def test_three_families_plus_independent_evidence_can_publish(self):
        first, _ = promote(
            {"generatedAt": "2026-08-10T00:00:00+00:00", "keywords": [record("EvidenceX", ["a", "b", "c"])]},
            {"keywords": []},
        )
        first["keywords"][0]["observations"].append({
            "observedAt": "2026-08-10T00:00:00+00:00", "sourceUrl": "https://news/evidence",
            "sourceType": "news", "sourceFamily": "independent-news", "title": "EvidenceX 피해",
        })
        second, _ = promote(
            {"generatedAt": "2026-08-11T00:00:00+00:00", "keywords": [record("EvidenceX", ["a", "b", "c"])]},
            first,
        )
        self.assertEqual(second["keywords"][0]["status"], "published")
        self.assertTrue(second["keywords"][0]["autoPublish"])

    def test_basic_quality_candidate_publishes_without_independent_evidence(self):
        first, _ = promote(
            {"generatedAt": "2026-08-10T00:00:00+00:00", "families": ["a", "b", "c"], "keywords": [record("MAX", ["a", "b", "c"])]},
            {"keywords": []},
        )
        first["keywords"][0]["observations"].extend([
            {"observedAt": "2026-08-10T00:00:00+00:00", "sourceUrl": "https://a/duplicate", "sourceType": "report", "sourceFamily": "a", "title": "MAX"},
            {"observedAt": "2026-08-10T00:00:00+00:00", "sourceUrl": "https://news/max", "sourceType": "news", "sourceFamily": "news", "title": "MOCK Edge MAX 피해"},
        ])
        second, report = promote(
            {"generatedAt": "2026-08-11T00:00:00+00:00", "families": ["a", "b", "c"], "keywords": [record("MAX", ["a", "b", "c"])]},
            first,
        )
        self.assertEqual(second["keywords"][0]["status"], "published")
        self.assertNotIn("https://a/duplicate", {o["sourceUrl"] for o in second["keywords"][0]["observations"]})
        self.assertIn(second["keywords"][0]["slug"], report["cleanupCompetitorDuplicateSlugs"])

    def test_historical_only_union_key_is_not_promoted(self):
        union = {
            "generatedAt": "2026-08-10T00:00:00+00:00",
            "currentNormalizedKeywords": ["currentx"],
            "keywords": [record("OldX", ["a", "b", "c"]), record("CurrentX", ["a", "b"])],
        }
        store, report = promote(union, {"keywords": []})
        self.assertEqual([item["name"] for item in store["keywords"]], ["CurrentX"])
        self.assertEqual(report["counts"]["historicalOnly"], 1)


if __name__ == "__main__":
    unittest.main()
