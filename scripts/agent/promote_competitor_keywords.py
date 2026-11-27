#!/usr/bin/env python3
"""Classify collected competitor keywords into the local keyword DB mirror.

Valid company/case names are written directly as published.  Invalid noise is
rejected instead of being parked in a discovered queue, so there is no later
discovered-to-published promotion gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_UNION = ROOT / "data" / "competitor-keyword-union.json"
DEFAULT_KEYWORDS = ROOT / "data" / "keywords.json"
DEFAULT_REPORT = ROOT / "data" / "competitor-keyword-promotions.json"

GENERIC_EXACT = {
    "전화", "돈의", "금융", "투자", "주식", "코인", "거래소", "프로젝트", "가상프로젝트A",
    "수익플랜", "투자전략", "재테크", "전문가", "리딩방", "고객센터", "해외선물", "선물거래",
}
NOISE_RE = re.compile(
    r"^(?:\d{1,2}월\s*\d{1,2}일|\d+(?:억|만|천)?원(?:대)?|\d+기|\d+차시|\d{2,4}년)$"
)
SCAM_TYPES = (
    ("romance", ("로맨스", "데이트", "소개팅", "연애", "romance")),
    ("used", ("중고", "마켓", "market", "쇼핑몰", "스토어", "store", "shop", "티켓")),
    ("coin", ("코인", "coin", "crypto", "거래소", "exchange", "wallet", "btc", "usdt", "bit")),
    ("stock", ("주식", "stock", "증권", "asset", "invest", "trading", "trade", "펀드", "fund")),
)


def normalize(value: object) -> str:
    title = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    title = re.sub(r"^https?://(?:www\.)?", "", title)
    title = re.sub(r"fraud$", "", title)
    return re.sub(r"[^0-9a-z가-힣]", "", title)


def quality_rejection(name: str) -> str | None:
    key = normalize(name)
    if len(key) < 3:
        return "too_short"
    if len(key) > 60:
        return "too_long"
    if not re.search(r"[a-z가-힣]", key):
        return "no_letters"
    if key in {normalize(value) for value in GENERIC_EXACT}:
        return "generic_term"
    if NOISE_RE.fullmatch(re.sub(r"\s+", "", name)):
        return "date_or_amount"
    if len(name.split()) > 10:
        return "sentence_like"
    return None


def infer_scam_type(name: str) -> str:
    lowered = name.casefold()
    for scam_type, tokens in SCAM_TYPES:
        if any(token in lowered for token in tokens):
            return scam_type
    return "other"


def stable_slug(name: str, normalized: str, used: set[str]) -> str:
    ascii_slug = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:10]
    base = ascii_slug[:45].strip("-") if len(ascii_slug.replace("-", "")) >= 2 else "case"
    candidate = f"{base}-{digest}"
    counter = 2
    while candidate in used:
        candidate = f"{base[:42]}-{digest}-{counter}"
        counter += 1
    return candidate


def observation_time(value: object, fallback: str) -> str:
    text = str(value or "").strip()
    if text:
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()
        except ValueError:
            pass
    return fallback


def atomic_json_dump(value: object, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=1)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def promote(
    union: Mapping[str, object],
    store: dict[str, object],
    *,
    demo_all: bool = False,
) -> tuple[dict[str, object], dict[str, object]]:
    keywords = store.setdefault("keywords", [])
    assert isinstance(keywords, list)
    by_normalized: dict[str, dict[str, object]] = {}
    by_primary_name: dict[str, dict[str, object]] = {}
    used_slugs: set[str] = set()
    for keyword in keywords:
        if not isinstance(keyword, dict):
            continue
        used_slugs.add(str(keyword.get("slug", "")))
        primary = normalize(keyword.get("name", ""))
        if primary:
            by_primary_name.setdefault(primary, keyword)
        for value in [keyword.get("name", ""), *keyword.get("aliases", [])]:
            if normalize(value):
                by_normalized.setdefault(normalize(value), keyword)

    fallback_time = str(union.get("generatedAt") or datetime.now(timezone.utc).isoformat())
    changed_slugs: set[str] = set()
    counts = {"published": 0, "blocked": 0, "existingUpdated": 0, "historicalOnly": 0, "rejected": 0}
    rejection_reasons: dict[str, int] = {}
    downgraded_slugs: set[str] = set()
    metadata_slugs: set[str] = set()
    cleanup_duplicate_slugs: set[str] = set()
    demo_mappings: list[dict[str, str]] = []
    current_keys = set(str(value) for value in union.get("currentNormalizedKeywords", []))
    competitor_families = set(str(value) for value in union.get("families", []))
    enforce_current = "currentNormalizedKeywords" in union

    for item in union.get("keywords", []):
        if not isinstance(item, Mapping):
            continue
        normalized = str(item.get("normalized", ""))
        name = str(item.get("display", "")).strip()
        families = sorted(set(str(value) for value in item.get("sourceFamilies", [])))
        # Demo corpus promises one routable page for every normalized union key.
        # Alias collapsing remains useful for the curated publication path, but
        # would silently omit collected titles from full-corpus demo coverage.
        existing = (by_primary_name if demo_all else by_normalized).get(normalized)
        is_current = not enforce_current or normalized in current_keys
        if not is_current:
            counts["historicalOnly"] += 1
            if not demo_all:
                continue
        rejection = quality_rejection(name)
        if existing is None and rejection:
            counts["rejected"] += 1
            rejection_reasons[rejection] = rejection_reasons.get(rejection, 0) + 1
            continue

        if existing is None:
            status = "published"
            slug = stable_slug(name, normalized, used_slugs)
            used_slugs.add(slug)
            existing = {
                "name": name,
                "slug": slug,
                "scamType": infer_scam_type(name),
                "aliases": sorted(set(item.get("variants", [])) - {name}),
                "status": status,
                "autoPublish": True,
                "competitorManaged": True,
                "firstSeenAt": None,
                "lastSeenAt": None,
                "observations": [],
            }
            keywords.append(existing)
            by_normalized[normalized] = existing
            by_primary_name[normalized] = existing
            counts[status] += 1
            changed_slugs.add(slug)
        else:
            slug = str(existing["slug"])
            if existing.get("competitorManaged") is True and rejection:
                if existing.get("status") != "blocked":
                    existing["status"] = "blocked"
                    existing["autoPublish"] = False
                    counts["blocked"] += 1
                    changed_slugs.add(slug)
                    downgraded_slugs.add(slug)
                continue
            if existing.get("competitorManaged") is True:
                inferred_type = infer_scam_type(name)
                if existing.get("scamType") != inferred_type:
                    existing["scamType"] = inferred_type
                    metadata_slugs.add(slug)
                    changed_slugs.add(slug)

        if demo_all:
            if existing.get("demoCorpus") is not True:
                existing["demoCorpus"] = True
                changed_slugs.add(slug)
            demo_mappings.append({"normalized": normalized, "slug": slug})

        observations = existing.setdefault("observations", [])
        if existing.get("competitorManaged") is True and competitor_families:
            canonical_observations = [
                obs for obs in observations
                if not (
                    isinstance(obs, Mapping)
                    and obs.get("sourceFamily") in competitor_families
                    and obs.get("sourceType") != "competitor-sitemap"
                )
            ]
            if len(canonical_observations) != len(observations):
                existing["observations"] = observations = canonical_observations
                cleanup_duplicate_slugs.add(slug)
                changed_slugs.add(slug)
        known_urls = {str(obs.get("sourceUrl", "")) for obs in observations if isinstance(obs, Mapping)}
        before = len(observations)
        for source in item.get("observations", []):
            if not isinstance(source, Mapping):
                continue
            url = str(source.get("url", ""))
            if not url or url in known_urls:
                continue
            observed_at = observation_time(source.get("lastmod"), fallback_time)
            observations.append({
                "observedAt": observed_at,
                "sourceUrl": url,
                "sourceType": "competitor-sitemap",
                "title": str(source.get("title", name))[:200],
                "origin": str(source.get("sourceFamily", "")),
                "sourceFamily": str(source.get("sourceFamily", "")),
            })
            known_urls.add(url)
        if len(observations) != before:
            times = sorted(str(obs["observedAt"]) for obs in observations if obs.get("observedAt"))
            existing["firstSeenAt"] = times[0] if times else existing.get("firstSeenAt")
            existing["lastSeenAt"] = times[-1] if times else existing.get("lastSeenAt")
            if slug not in changed_slugs:
                counts["existingUpdated"] += 1
            changed_slugs.add(slug)

        if (
            existing.get("competitorManaged") is True
            and rejection is None
            and existing.get("status") == "discovered"
        ):
            existing["status"] = "published"
            existing["autoPublish"] = True
            counts["published"] += 1
            changed_slugs.add(slug)

    previous_pending: set[str] = set()
    if isinstance(store.get("_previousPromotionPending"), list):
        previous_pending.update(str(value) for value in store.pop("_previousPromotionPending"))
    report = {
        "schemaVersion": 1,
        "generatedAt": fallback_time,
        "policy": "quality-valid collected candidate=published immediately; invalid noise=rejected or blocked; no discovered promotion gate",
        "counts": counts,
        "rejectionReasons": dict(sorted(rejection_reasons.items())),
        "changedSlugs": sorted(changed_slugs),
        "pendingSlugs": sorted(previous_pending | changed_slugs),
        "downgradedSlugs": sorted(downgraded_slugs),
        "metadataSlugs": sorted(metadata_slugs),
        "cleanupCompetitorDuplicateSlugs": sorted(cleanup_duplicate_slugs),
        "competitorFamilies": sorted(competitor_families),
        "demoAll": demo_all,
        "demoKeywordMappings": demo_mappings,
        "demoSlugs": sorted({item["slug"] for item in demo_mappings}),
    }
    return store, report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--union", type=Path, default=DEFAULT_UNION)
    parser.add_argument("--keywords", type=Path, default=DEFAULT_KEYWORDS)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--demo-all",
        action="store_true",
        help="classify the full cumulative union and emit mappings for accepted deployable keywords",
    )
    parser.add_argument("--ack-sync", action="store_true", help="clear pendingSlugs after a successful DB sync")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.ack_sync:
        report = json.loads(args.report.read_text(encoding="utf-8"))
        report["pendingSlugs"] = []
        report["downgradedSlugs"] = []
        report["metadataSlugs"] = []
        report["cleanupCompetitorDuplicateSlugs"] = []
        report["syncedAt"] = datetime.now(timezone.utc).isoformat()
        atomic_json_dump(report, args.report)
        print("competitor promotions: DB sync acknowledged")
        return 0
    union = json.loads(args.union.read_text(encoding="utf-8"))
    store = json.loads(args.keywords.read_text(encoding="utf-8")) if args.keywords.exists() else {"keywords": []}
    if args.report.exists():
        previous_report = json.loads(args.report.read_text(encoding="utf-8"))
        store["_previousPromotionPending"] = previous_report.get("pendingSlugs", [])
    promoted, report = promote(union, store, demo_all=args.demo_all)
    if not args.dry_run:
        atomic_json_dump(promoted, args.keywords)
        atomic_json_dump(report, args.report)
    print(json.dumps({
        "counts": report["counts"],
        "rejectionReasons": report["rejectionReasons"],
        "changedSlugs": len(report["changedSlugs"]),
        "pendingSlugs": len(report["pendingSlugs"]),
        "metadataSlugs": len(report["metadataSlugs"]),
        "cleanupCompetitorDuplicateSlugs": len(report["cleanupCompetitorDuplicateSlugs"]),
        "demoUnionRecords": len(report["demoKeywordMappings"]),
        "demoUniqueSlugs": len(report["demoSlugs"]),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
