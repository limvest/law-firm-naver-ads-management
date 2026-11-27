#!/usr/bin/env python3
import ast
import json
import os
import sys
import tempfile
import unittest
import zlib
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

from feedlib import detect_sitemap_changes, sitemap_entry_fingerprints


HARVEST = Path(__file__).with_name("harvest.py")


def load_helpers(*names):
    tree = ast.parse(HARVEST.read_text(encoding="utf-8"), filename=str(HARVEST))
    wanted = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    }
    missing = set(names) - set(wanted)
    if missing:
        raise AssertionError(f"missing harvest helpers: {sorted(missing)}")
    namespace = {
        "json": json,
        "os": os,
        "tempfile": tempfile,
        "sitemap_entry_fingerprints": sitemap_entry_fingerprints,
        "zlib": zlib,
        "date": date,
        "datetime": datetime,
        "timedelta": timedelta,
    }
    module = ast.Module(body=[wanted[name] for name in names], type_ignores=[])
    exec(compile(module, str(HARVEST), "exec"), namespace)
    return tuple(namespace[name] for name in names)


(
    atomic_json_dump,
    sitemap_checkpoint,
    search_checkpoint,
    observation_identity,
    select_appendable_rows,
    sitemap_commit_entries,
    _search_interval,
    search_due,
) = load_helpers(
    "atomic_json_dump",
    "sitemap_checkpoint",
    "search_checkpoint",
    "observation_identity",
    "select_appendable_rows",
    "sitemap_commit_entries",
    "search_interval",
    "search_due",
)


class HarvestHelpersTest(unittest.TestCase):
    def test_atomic_json_dump_replaces_document_and_cleans_temp_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text('{"old": true}\n', encoding="utf-8")

            atomic_json_dump({"new": [1, 2]}, path)

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"new": [1, 2]})
            self.assertEqual(list(path.parent.glob(".state.json.*.tmp")), [])

    def test_atomic_json_dump_keeps_old_document_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text('{"old": true}\n', encoding="utf-8")

            with mock.patch.object(os, "replace", side_effect=OSError("replace failed")):
                with self.assertRaises(OSError):
                    atomic_json_dump({"new": True}, path)

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"old": True})
            self.assertEqual(list(path.parent.glob(".state.json.*.tmp")), [])

    def test_search_checkpoint_preserves_state_after_failed_target(self):
        state = {"search:cafe:alpha": 10, "search:cafe:alpha:last": "2026-08-09", "other": 1}

        failed = search_checkpoint(
            state,
            "search:cafe:alpha",
            42,
            "2026-08-10",
            success=False,
        )
        self.assertEqual(failed, state)
        self.assertEqual(state["search:cafe:alpha"], 10)
        self.assertEqual(state["search:cafe:alpha:last"], "2026-08-09")

        succeeded = search_checkpoint(
            state,
            "search:cafe:alpha",
            42,
            "2026-08-10",
            success=True,
        )
        self.assertEqual(succeeded["search:cafe:alpha"], 42)
        self.assertEqual(succeeded["search:cafe:alpha:last"], "2026-08-10")

    def test_search_due_does_not_seed_state_before_attempt_succeeds(self):
        state = {"search:cafe:alpha": 10}
        before = dict(state)

        search_due(
            {"slug": "alpha", "observations": []},
            "cafe",
            state,
            "2026-08-10",
        )

        self.assertEqual(state, before)

    def test_legacy_checkpoint_does_not_mark_unselected_rows_current(self):
        old_url = "https://example.test/cases/old"
        new_url = "https://example.test/cases/new"
        pending_url = "https://example.test/cases/pending"
        current = [
            {"loc": old_url, "lastmod": "2026-08-10"},
            {"loc": new_url, "lastmod": "2026-08-11"},
            {"loc": pending_url, "lastmod": "2026-08-09"},
        ]

        checkpoint = sitemap_checkpoint([old_url], current, [current[1]])

        self.assertNotIn(old_url, checkpoint)
        self.assertEqual(
            checkpoint[new_url],
            sitemap_entry_fingerprints([current[1]])[new_url],
        )
        self.assertNotIn(pending_url, checkpoint)

        # Both unconfirmed legacy URLs remain eligible for a later bounded
        # migration pass; only the selected URL is fingerprinted.
        self.assertEqual(
            [entry["loc"] for entry in detect_sitemap_changes(current, checkpoint)],
            [old_url, pending_url],
        )

    def test_legacy_row_checkpoint_preserves_changed_pending_after_limit(self):
        previous = [
            {"loc": "https://example.test/cases/a", "lastmod": "2026-08-01"},
            {"loc": "https://example.test/cases/b", "lastmod": "2026-08-01"},
        ]
        current = [
            {"loc": "https://example.test/cases/a", "lastmod": "2026-08-02"},
            {"loc": "https://example.test/cases/b", "lastmod": "2026-08-02"},
        ]
        selected = detect_sitemap_changes(current, previous, limit=1)
        checkpoint = sitemap_checkpoint(previous, current, selected)

        self.assertEqual(
            [entry["loc"] for entry in detect_sitemap_changes(current, checkpoint)],
            ["https://example.test/cases/b"],
        )

    def test_sitemap_lastmod_revision_has_distinct_append_identity(self):
        old = {
            "link": "https://example.test/cases/a",
            "pubDate": "2026-08-10",
            "discoveryTier": "metadata",
        }
        revised = {**old, "pubDate": "2026-08-11"}

        self.assertNotEqual(observation_identity(old), observation_identity(revised))
        appendable, occupied = select_appendable_rows([revised], {observation_identity(old)})
        self.assertEqual(appendable, [revised])
        self.assertIn(observation_identity(revised), occupied)

    def test_sitemap_commit_entries_includes_existing_or_appendable_identity_only(self):
        existing = {
            "link": "https://example.test/cases/existing",
            "pubDate": "2026-08-10",
            "discoveryTier": "metadata",
        }
        new = {
            "link": "https://example.test/cases/new",
            "pubDate": "2026-08-11",
            "discoveryTier": "metadata",
        }
        selected_rows = [
            ({"loc": existing["link"], "lastmod": existing["pubDate"]}, existing),
            ({"loc": new["link"], "lastmod": new["pubDate"]}, new),
        ]
        _, occupied = select_appendable_rows([new], {observation_identity(existing)})

        self.assertEqual(
            sitemap_commit_entries(selected_rows, occupied),
            [selected_rows[0][0], selected_rows[1][0]],
        )


if __name__ == "__main__":
    unittest.main()
