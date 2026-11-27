#!/usr/bin/env python3
"""Build the complete normalized keyword union from competitor sitemaps.

The output is a union of *page-title keys*, not a count of real-world cases.
Every normalized key keeps its original title variants and source URLs so a
later entity-clustering step can merge aliases without losing provenance.

Examples:
  # Fetch the current public sitemaps registered in harvest-sources.json.
  python3 scripts/agent/competitor_union.py --live

  # Reproduce a report from one or more saved NDJSON snapshots.
  python3 scripts/agent/competitor_union.py \
    --input data/keyword-inbox/2026-08-10.ndjson \
    --output /tmp/competitor-union.json \
    --text-output /tmp/competitor-union.txt
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path
from typing import Iterable, Mapping

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from feedlib import collect_sitemap_entries, sitemap_title  # noqa: E402


DEFAULT_REGISTRY = ROOT / "data" / "harvest-sources.json"
DEFAULT_OUTPUT = ROOT / "data" / "competitor-keyword-union.json"
DEFAULT_TEXT_OUTPUT = ROOT / "data" / "competitor-keyword-union.txt"
USER_AGENT = "Mozilla/5.0 (Macintosh) lawfirm-ads-competitor-union/1.0"


def clean_display_title(value: object) -> str:
    """Return a readable title while removing known sitemap-only noise."""
    title = unicodedata.normalize("NFKC", str(value or "")).strip()
    title = urllib.parse.unquote(title)
    title = re.sub(r"^https?://", "", title, flags=re.I)
    title = re.sub(r"^www\.", "", title, flags=re.I)
    title = re.sub(r"fraud$", "", title, flags=re.I)
    return re.sub(r"\s+", " ", title).strip(" -_/")


def normalize_keyword(value: object) -> str:
    """Return the stable comparison key used for unions/intersections."""
    title = clean_display_title(value).casefold()
    return re.sub(r"[^0-9a-z가-힣]", "", title)


def _get_text(url: str, *, timeout: int = 30) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def load_registry_sources(
    registry_path: Path,
    families: set[str],
) -> list[dict[str, object]]:
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    sources = []
    for source in registry.get("sources", []):
        if source.get("type") != "sitemap":
            continue
        if source.get("sourceFamily") not in families:
            continue
        sources.append(source)
    missing = families - {str(source["sourceFamily"]) for source in sources}
    if missing:
        raise ValueError(f"missing sitemap source families in registry: {sorted(missing)}")
    return sources


def load_competitor_families(registry_path: Path) -> tuple[str, ...]:
    """Discover the configured competitor families instead of hardcoding them."""
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    families = tuple(
        dict.fromkeys(
            str(source["sourceFamily"])
            for source in registry.get("sources", [])
            if source.get("type") == "sitemap"
            and source.get("competitorKeywordSource") is True
            and source.get("sourceFamily")
        )
    )
    if not families:
        raise ValueError("registry has no competitorKeywordSource sitemap families")
    return families


def iter_live_rows(
    registry_path: Path,
    families: set[str],
) -> Iterable[dict[str, str]]:
    """Yield current metadata rows directly from registered public sitemaps."""
    for source in load_registry_sources(registry_path, families):
        family = str(source["sourceFamily"])
        include_path = str(source.get("includePath", ""))
        entries = collect_sitemap_entries(
            _get_text,
            str(source["url"]),
            max_sitemaps=int(source.get("unionMaxSitemaps", source.get("maxSitemaps", 100))),
        )
        accepted = 0
        for entry in entries:
            link = entry.get("loc", "")
            if include_path and not urllib.parse.urlsplit(link).path.startswith(include_path):
                continue
            accepted += 1
            yield {
                "title": sitemap_title(link),
                "link": link,
                "pubDate": entry.get("lastmod", ""),
                "sourceFamily": family,
            }
        if accepted == 0:
            raise RuntimeError(f"sitemap source returned no accepted rows: {family}")


def iter_ndjson_rows(paths: Iterable[Path], families: set[str]) -> Iterable[dict[str, str]]:
    for path in paths:
        with path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"invalid NDJSON at {path}:{line_number}: {exc}") from exc
                if row.get("sourceFamily") not in families:
                    continue
                yield {
                    "title": str(row.get("title", "")),
                    "link": str(row.get("link", "")),
                    "pubDate": str(row.get("pubDate", "")),
                    "sourceFamily": str(row["sourceFamily"]),
                }


def iter_report_rows(report: Mapping[str, object]) -> Iterable[dict[str, str]]:
    """Yield rows retained in an earlier union report for cumulative merging."""
    for keyword in report.get("keywords", []):
        if not isinstance(keyword, Mapping):
            continue
        observations = keyword.get("observations", [])
        if isinstance(observations, list) and observations:
            for observation in observations:
                if not isinstance(observation, Mapping):
                    continue
                yield {
                    "title": str(observation.get("title") or keyword.get("display", "")),
                    "link": str(observation.get("url", "")),
                    "pubDate": str(observation.get("lastmod", "")),
                    "sourceFamily": str(observation.get("sourceFamily", "")),
                }
            continue
        for family in keyword.get("sourceFamilies", []):
            yield {
                "title": str(keyword.get("display", "")),
                "link": "",
                "pubDate": "",
                "sourceFamily": str(family),
            }


def build_union(rows: Iterable[dict[str, str]], families: Iterable[str]) -> dict[str, object]:
    family_order = tuple(dict.fromkeys(families))
    family_sets = {family: set() for family in family_order}
    raw_rows = {family: 0 for family in family_order}
    unique_observations = {family: 0 for family in family_order}
    records: dict[str, dict[str, object]] = {}
    seen_observations: set[tuple[str, str, str]] = set()

    for row in rows:
        family = row.get("sourceFamily", "")
        if family not in family_sets:
            continue
        raw_rows[family] += 1
        display = clean_display_title(row.get("title", ""))
        normalized = normalize_keyword(display)
        if not normalized:
            continue
        family_sets[family].add(normalized)
        record = records.setdefault(
            normalized,
            {"normalized": normalized, "variants": set(), "observations": []},
        )
        record["variants"].add(display)
        identity = (family, row.get("link", ""), display)
        if identity in seen_observations:
            continue
        seen_observations.add(identity)
        unique_observations[family] += 1
        record["observations"].append(
            {
                "sourceFamily": family,
                "title": display,
                "url": row.get("link", ""),
                "lastmod": row.get("pubDate", ""),
            }
        )

    keywords = []
    for normalized in sorted(records):
        record = records[normalized]
        variants = sorted(record["variants"], key=lambda value: (len(value), value.casefold(), value))
        observations = sorted(
            record["observations"],
            key=lambda item: (item["sourceFamily"], item["url"], item["title"]),
        )
        keywords.append(
            {
                "normalized": normalized,
                "display": variants[0],
                "variants": variants,
                "sourceFamilies": sorted({item["sourceFamily"] for item in observations}),
                "observations": observations,
            }
        )

    pairwise = {}
    for left, right in combinations(family_order, 2):
        pairwise[f"{left}__{right}"] = len(family_sets[left] & family_sets[right])
    all_intersection = set.intersection(*(family_sets[family] for family in family_order))
    exclusive = {
        family: len(
            family_sets[family]
            - set().union(*(family_sets[other] for other in family_order if other != family))
        )
        for family in family_order
    }

    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "measurement": "normalized sitemap page-title keys; not deduplicated real-world cases",
        "normalization": "NFKC + casefold + strip scheme/www/trailing fraud + keep ASCII alnum/Hangul",
        "families": list(family_order),
        "stats": {
            "rawRows": raw_rows,
            "uniqueObservationsByFamily": unique_observations,
            "normalizedUniqueByFamily": {
                family: len(family_sets[family]) for family in family_order
            },
            "union": len(records),
            "pairwiseIntersections": pairwise,
            "allFamiliesIntersection": len(all_intersection),
            "exclusiveByFamily": exclusive,
        },
        "keywords": keywords,
    }


def accumulate_union(
    current_rows: Iterable[dict[str, str]],
    families: Iterable[str],
    existing_report: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Merge a complete current snapshot into the prior append-only union.

    Current sitemap removals never delete a historical key.  Existing rows are
    fed first so their original discovery metadata remains stable; only unseen
    normalized keys, variants, source families, or source URLs are appended.
    """
    family_order = tuple(dict.fromkeys(families))
    current = list(current_rows)
    current_report = build_union(current, family_order)
    previous_rows = list(iter_report_rows(existing_report or {}))
    previous_report = build_union(previous_rows, family_order)
    combined = build_union([*previous_rows, *current], family_order)

    previous_keys = {item["normalized"] for item in previous_report["keywords"]}
    current_keys = {item["normalized"] for item in current_report["keywords"]}
    previous_observations = {
        (row["sourceFamily"], row["link"], clean_display_title(row["title"]))
        for row in previous_rows
    }
    current_observations = {
        (row["sourceFamily"], row["link"], clean_display_title(row["title"]))
        for row in current
        if normalize_keyword(row["title"])
    }
    combined["currentSnapshotStats"] = current_report["stats"]
    combined["currentNormalizedKeywords"] = sorted(current_keys)
    combined["stats"]["retainedObservationsByFamily"] = combined["stats"].pop(
        "uniqueObservationsByFamily"
    )
    # ``rawRows`` is meaningful for one fetched snapshot, but not for a merge
    # where previous and current rows intentionally overlap.
    combined["stats"].pop("rawRows", None)
    combined["delta"] = {
        "newNormalizedKeywords": len(current_keys - previous_keys),
        "newObservations": len(current_observations - previous_observations),
        "historicalKeywordsAbsentFromCurrentSnapshot": len(previous_keys - current_keys),
    }
    combined["accumulation"] = (
        "append-only normalized keyword ledger; current sitemap removals are retained historically"
    )
    return combined


def atomic_write_text(path: Path, content: str) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_outputs(report: dict[str, object], output: Path, text_output: Path) -> None:
    atomic_write_text(output, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    text = "\n".join(item["display"] for item in report["keywords"])
    atomic_write_text(text_output, text + ("\n" if text else ""))


def expected_text_output(report: Mapping[str, object]) -> str:
    text = "\n".join(str(item["display"]) for item in report["keywords"])
    return text + ("\n" if text else "")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live",
        action="store_true",
        help="fetch registered public sitemaps (default when --input is omitted)",
    )
    parser.add_argument(
        "--input",
        action="append",
        type=Path,
        default=[],
        help="saved NDJSON snapshot; repeat to combine multiple files",
    )
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument(
        "--families",
        default="",
        help="comma-separated override; default discovers competitorKeywordSource entries from registry",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--text-output", type=Path, default=DEFAULT_TEXT_OUTPUT)
    parser.add_argument(
        "--replace",
        action="store_true",
        help="replace rather than merge the existing output ledger",
    )
    parser.add_argument("--dry-run", action="store_true", help="print stats without writing files")
    args = parser.parse_args(argv)
    if args.live and args.input:
        parser.error("use either --live or --input, not both")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    families = (
        tuple(value.strip() for value in args.families.split(",") if value.strip())
        if args.families
        else load_competitor_families(args.registry)
    )
    if len(families) < 2:
        raise ValueError("at least two source families are required")
    family_set = set(families)
    mode = "ndjson" if args.input else "live"
    rows = list(
        iter_ndjson_rows(args.input, family_set)
        if args.input
        else iter_live_rows(args.registry, family_set)
    )
    existing_report = None
    if not args.replace and args.output.exists():
        existing_report = json.loads(args.output.read_text(encoding="utf-8"))
    report = accumulate_union(rows, families, existing_report)
    report["mode"] = f"{mode}-cumulative"
    if args.input:
        report["inputs"] = [str(path.resolve()) for path in args.input]
    else:
        report["registry"] = str(args.registry.resolve())

    changed = True
    if existing_report is not None:
        previous_semantic = dict(existing_report)
        current_semantic = dict(report)
        previous_semantic.pop("generatedAt", None)
        current_semantic.pop("generatedAt", None)
        changed = previous_semantic != current_semantic
        # Repair a missing or stale companion TXT even when JSON is unchanged.
        if not changed:
            changed = (
                not args.text_output.exists()
                or args.text_output.read_text(encoding="utf-8") != expected_text_output(report)
            )
        if not changed:
            report["generatedAt"] = existing_report.get("generatedAt", report["generatedAt"])
    if not args.dry_run and changed:
        write_outputs(report, args.output, args.text_output)
    print(json.dumps(report["stats"], ensure_ascii=False, indent=2))
    if not args.dry_run:
        print(f"Status: {'updated' if changed else 'unchanged'}")
        print(f"JSON: {args.output.resolve()}")
        print(f"TXT:  {args.text_output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
