#!/usr/bin/env python3
import json
import multiprocessing
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

from source_health import read_source_health, record_source_health


def _record_successes(path: str, count: int) -> None:
    for _ in range(count):
        record_source_health(path, "parallel", success=True, new_items=1, latency_ms=1)


class SourceHealthTest(unittest.TestCase):
    def test_missing_file_is_empty_and_first_success_is_recorded_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "health.json"
            self.assertEqual(read_source_health(path), {})
            metrics = record_source_health(
                path,
                "sitemap-a",
                success=True,
                new_items=4,
                latency_ms=125,
                recorded_at="2026-08-10T00:00:00+00:00",
            )

            self.assertEqual(metrics["successes"], 1)
            self.assertEqual(metrics["failures"], 0)
            self.assertEqual(metrics["new_items"], 4)
            self.assertEqual(metrics["latency_ms"], 125)
            self.assertEqual(metrics["last_success"], "2026-08-10T00:00:00+00:00")
            with path.open(encoding="utf-8") as handle:
                self.assertEqual(json.load(handle), {"sitemap-a": metrics})
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_failure_increments_failure_count_and_preserves_last_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "health.json"
            first = record_source_health(
                path,
                "sitemap-a",
                success=True,
                new_items=2,
                latency_ms=10,
                now="2026-08-10T01:00:00+00:00",
            )
            failed = record_source_health(
                path,
                "sitemap-a",
                success=False,
                new_items=0,
                latency_ms=900,
                now="2026-08-10T01:01:00+00:00",
            )

            self.assertEqual(failed["successes"], 1)
            self.assertEqual(failed["failures"], 1)
            self.assertEqual(failed["new_items"], 0)
            self.assertEqual(failed["latency_ms"], 900)
            self.assertEqual(failed["last_success"], first["last_success"])

            record_source_health(path, "sitemap-a", success=True, new_items=3, latency_ms=20, now="2026-08-10T01:02:00+00:00")
            health = read_source_health(path)
            self.assertEqual(health["sitemap-a"]["successes"], 2)
            self.assertEqual(health["sitemap-a"]["failures"], 1)
            self.assertEqual(health["sitemap-a"]["last_success"], "2026-08-10T01:02:00+00:00")

    def test_updates_preserve_other_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "health.json"
            record_source_health(path, "first", success=True, now="2026-08-10T00:00:00Z")
            record_source_health(path, "second", success=False, now="2026-08-10T00:01:00Z")
            health = read_source_health(path)
            self.assertEqual(set(health), {"first", "second"})
            self.assertEqual(health["first"]["successes"], 1)
            self.assertEqual(health["second"]["failures"], 1)
            self.assertIsNone(health["second"]["last_success"])

    def test_concurrent_updates_do_not_lose_counter_increments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "health.json")
            context = multiprocessing.get_context("fork")
            processes = [context.Process(target=_record_successes, args=(path, 4)) for _ in range(4)]
            for process in processes:
                process.start()
            for process in processes:
                process.join(10)
                self.assertEqual(process.exitcode, 0)
            self.assertEqual(read_source_health(path)["parallel"]["successes"], 16)

    def test_invalid_metrics_are_rejected_before_creating_a_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "health.json"
            with self.assertRaises(ValueError):
                record_source_health(path, "sitemap-a", success=True, new_items=-1)
            with self.assertRaises(ValueError):
                record_source_health(path, "sitemap-a", success=True, latency_ms=float("nan"))
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
