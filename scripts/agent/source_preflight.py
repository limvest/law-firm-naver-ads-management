#!/usr/bin/env python3
"""Deterministic, no-network preflight for the harvest source registry.

The collector reads two file-backed inputs before it makes any source
requests: ``data/harvest-sources.json`` and ``data/harvest-health.json``.
This module checks the configuration and health document without importing or
running the collector.  A missing health document or a source with no recent
health record is a warning only; malformed configuration or malformed health
data is fatal.

The command prints exactly one JSON summary.  Exit codes are deliberately
small and stable so a caller can map them into its own pipeline contract:

* ``0``: configuration is valid; health may be missing, first-run, or stale.
* ``2``: configuration or health data is corrupt/unreadable.

No function in this module performs network I/O.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from datetime import datetime, timezone
from numbers import Real
from pathlib import Path
from typing import Mapping, Sequence
from urllib.parse import urlsplit


EXIT_OK = 0
EXIT_FATAL = 2

SUPPORTED_SOURCE_TYPES = frozenset(
    {"google_news_rss", "naver_cafe", "webpage", "naver_blog", "rss", "sitemap"}
)

_CADENCE_FIELDS = ("recrawlDays",)
_POSITIVE_LIMIT_FIELDS = (
    "perPage",
    "maxSitemaps",
    "maxItemsPerRun",
    "maxPagesPerRun",
    "seenLimit",
    "unionMaxSitemaps",
)
_NAVER_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_HEALTH_COUNTER_ALIASES = {
    "successes": ("successes", "success_count"),
    "failures": ("failures", "failure_count"),
    "last_success": ("last_success", "last_success_at"),
}

_MODULE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REGISTRY_PATH = _MODULE_ROOT / "data" / "harvest-sources.json"
DEFAULT_HEALTH_PATH = _MODULE_ROOT / "data" / "harvest-health.json"


def _issue(code: str, message: str, **context: object) -> dict[str, object]:
    """Build a JSON-safe issue with stable key insertion order."""

    result: dict[str, object] = {"code": code, "message": message}
    for key in ("source_id", "source_index", "field", "health_id"):
        if key in context:
            result[key] = context.pop(key)
    result.update(context)
    return result


def _nonempty_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and value == value.strip()


def _positive_number(value: object) -> bool:
    return (
        isinstance(value, Real)
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and value > 0
    )


def _positive_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _nonnegative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _nonnegative_number(value: object) -> bool:
    return (
        isinstance(value, Real)
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and value >= 0
    )


def _valid_naver_identifier(value: object) -> bool:
    return isinstance(value, str) and bool(_NAVER_IDENTIFIER.fullmatch(value.strip())) and value == value.strip()


def _valid_https_url(value: object) -> bool:
    if not isinstance(value, str) or not value or value != value.strip() or any(ch.isspace() for ch in value):
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme.lower() == "https" and bool(parsed.netloc) and bool(parsed.hostname)
    except ValueError:
        return False


def _validate_optional_source_fields(
    source: Mapping[str, object],
    *,
    source_id: str | None,
    source_index: int,
) -> list[dict[str, object]]:
    """Validate shared optional fields without imposing collector policy."""

    errors: list[dict[str, object]] = []
    context: dict[str, object] = {"source_index": source_index}
    if source_id is not None:
        context["source_id"] = source_id

    if "recrawlMinutes" in source:
        errors.append(
            _issue(
                "unsupported_minute_cadence",
                "minute-based collection was removed; use the daily recrawlDays cadence",
                field="recrawlMinutes",
                **context,
            )
        )

    for field in _CADENCE_FIELDS:
        if field in source and not _positive_number(source[field]):
            errors.append(
                _issue(
                    "invalid_positive_cadence",
                    f"{field} must be a finite number greater than zero",
                    field=field,
                    **context,
                )
            )

    for field in _POSITIVE_LIMIT_FIELDS:
        if field in source and not _positive_integer(source[field]):
            errors.append(
                _issue(
                    "invalid_positive_limit",
                    f"{field} must be a positive integer",
                    field=field,
                    **context,
                )
            )

    for field in ("sourceFamily",):
        if field in source and not _nonempty_text(source[field]):
            errors.append(
                _issue(
                    "invalid_text_field",
                    f"{field} must be a non-empty string",
                    field=field,
                    **context,
                )
            )

    for field in ("includePath",):
        if field in source and not isinstance(source[field], str):
            errors.append(
                _issue(
                    "invalid_text_field",
                    f"{field} must be a string when provided",
                    field=field,
                    **context,
                )
            )

    sitemap_title_strategy = source.get("sitemapTitleStrategy", "last-segment")
    if sitemap_title_strategy not in {"last-segment", "first-slug-token", "query-param"}:
        errors.append(
            _issue(
                "invalid_sitemap_title_strategy",
                "sitemapTitleStrategy must be last-segment, first-slug-token, or query-param",
                field="sitemapTitleStrategy",
                **context,
            )
        )
    elif sitemap_title_strategy == "query-param" and not _nonempty_text(source.get("sitemapTitleQueryParam")):
        errors.append(
            _issue(
                "missing_sitemap_title_query_param",
                "sitemapTitleQueryParam is required for query-param strategy",
                field="sitemapTitleQueryParam",
                **context,
            )
        )

    for field in ("fast", "search", "competitorKeywordSource", "fetchPageMetadata", "fetchPageBodyFacts", "keywordOnly"):
        if field in source and not isinstance(source[field], bool):
            errors.append(
                _issue(
                    "invalid_boolean_field",
                    f"{field} must be a boolean when provided",
                    field=field,
                    **context,
                )
            )

    if source.get("keywordOnly") and (source.get("fetchPageMetadata") or source.get("fetchPageBodyFacts")):
        errors.append(
            _issue(
                "keyword_only_detail_conflict",
                "keywordOnly sources cannot fetch page metadata or body facts",
                field="keywordOnly",
                **context,
            )
        )

    if "enabled" in source and not isinstance(source["enabled"], bool):
        errors.append(
            _issue(
                "invalid_boolean_field",
                "enabled must be a boolean when provided",
                field="enabled",
                **context,
            )
        )

    if "url" in source and not _valid_https_url(source["url"]):
        errors.append(
            _issue(
                "invalid_https_url",
                "url must be an absolute HTTPS URL",
                field="url",
                **context,
            )
        )

    return errors


def _validate_menus(
    value: object,
    *,
    source_id: str | None,
    source_index: int,
) -> list[dict[str, object]]:
    context: dict[str, object] = {"source_index": source_index, "field": "menus"}
    if source_id is not None:
        context["source_id"] = source_id
    if not isinstance(value, list) or not value:
        return [
            _issue(
                "invalid_menus",
                "menus must be a non-empty array",
                **context,
            )
        ]

    errors: list[dict[str, object]] = []
    for menu_index, menu in enumerate(value):
        menu_context = {key: item for key, item in context.items() if key != "field"}
        menu_context["menu_index"] = menu_index
        if not isinstance(menu, dict):
            errors.append(
                _issue("invalid_menu", "each menu must be an object", **menu_context)
            )
            continue
        if not _positive_integer(menu.get("menuId")):
            errors.append(
                _issue(
                    "invalid_menu_id",
                    "menuId must be a positive integer",
                    field="menuId",
                    **menu_context,
                )
            )
        if not _nonempty_text(menu.get("menuName")):
            errors.append(
                _issue(
                    "invalid_menu_name",
                    "menuName must be a non-empty string",
                    field="menuName",
                    **menu_context,
                )
            )
    return errors


def _validate_source(source: object, source_index: int) -> tuple[str | None, list[dict[str, object]]]:
    if not isinstance(source, dict):
        return None, [
            _issue(
                "invalid_source_entry",
                "each registry source must be an object",
                source_index=source_index,
            )
        ]

    source_id = source.get("id") if isinstance(source.get("id"), str) else None
    errors: list[dict[str, object]] = []
    context: dict[str, object] = {"source_index": source_index}
    if source_id is not None:
        context["source_id"] = source_id

    if not _nonempty_text(source.get("id")):
        errors.append(
            _issue(
                "invalid_source_id",
                "id must be a non-empty string without surrounding whitespace",
                field="id",
                **context,
            )
        )
        source_id = None

    source_type = source.get("type")
    if not isinstance(source_type, str) or source_type not in SUPPORTED_SOURCE_TYPES:
        errors.append(
            _issue(
                "unsupported_source_type",
                f"type must be one of {sorted(SUPPORTED_SOURCE_TYPES)}",
                field="type",
                **context,
            )
        )

    for field in ("name", "sourceType"):
        if not _nonempty_text(source.get(field)):
            errors.append(
                _issue(
                    "missing_required_field" if field not in source else "invalid_required_field",
                    f"{field} must be a non-empty string",
                    field=field,
                    **context,
                )
            )

    errors.extend(
        _validate_optional_source_fields(
            source, source_id=source_id, source_index=source_index
        )
    )

    if source_type == "naver_cafe":
        if not _positive_integer(source.get("cafeId")):
            errors.append(
                _issue(
                    "invalid_naver_identifier",
                    "cafeId must be a positive integer",
                    field="cafeId",
                    **context,
                )
            )
        if not _valid_naver_identifier(source.get("cafeUrl")):
            errors.append(
                _issue(
                    "invalid_naver_identifier",
                    "cafeUrl must be a Naver cafe identifier",
                    field="cafeUrl",
                    **context,
                )
            )
        errors.extend(
            _validate_menus(
                source.get("menus"), source_id=source_id, source_index=source_index
            )
        )
    elif source_type == "naver_blog":
        if not _valid_naver_identifier(source.get("blogId")):
            errors.append(
                _issue(
                    "invalid_naver_identifier",
                    "blogId must be a Naver blog identifier",
                    field="blogId",
                    **context,
                )
            )
    elif source_type in {"webpage", "rss", "sitemap", "google_news_rss"}:
        if "url" not in source:
            errors.append(
                _issue(
                    "missing_required_field",
                    f"{source_type} sources require url",
                    field="url",
                    **context,
                )
            )
        if source_type == "google_news_rss":
            queries = source.get("queries")
            if not isinstance(queries, list) or not queries or not all(_nonempty_text(query) for query in queries):
                errors.append(
                    _issue(
                        "invalid_queries",
                        "google_news_rss sources require a non-empty string array in queries",
                        field="queries",
                        **context,
                    )
                )

    return source_id, errors


def validate_registry(document: object) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Return ``(sources, fatal_errors)`` for a parsed registry document."""

    if not isinstance(document, dict):
        return [], [
            _issue("invalid_registry_shape", "registry must be a JSON object")
        ]
    sources_value = document.get("sources")
    if not isinstance(sources_value, list):
        return [], [
            _issue("invalid_registry_shape", "registry.sources must be an array", field="sources")
        ]
    if not sources_value:
        return [], [
            _issue("empty_registry", "registry.sources must contain at least one source", field="sources")
        ]

    sources: list[dict[str, object]] = []
    errors: list[dict[str, object]] = []
    seen: dict[str, int] = {}
    for source_index, source in enumerate(sources_value):
        source_id, source_errors = _validate_source(source, source_index)
        errors.extend(source_errors)
        if isinstance(source, dict):
            sources.append(source)
        if source_id is not None:
            if source_id in seen:
                errors.append(
                    _issue(
                        "duplicate_source_id",
                        f"source id {source_id!r} is duplicated",
                        source_id=source_id,
                        source_index=source_index,
                        duplicate_of=seen[source_id],
                    )
                )
            else:
                seen[source_id] = source_index
    return sources, errors


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _coerce_now(value: datetime | str | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    parsed = _parse_timestamp(value)
    if parsed is None:
        raise ValueError("now must be a valid ISO timestamp")
    return parsed


def _health_alias_value(
    metrics: Mapping[str, object],
    aliases: Sequence[str],
    *,
    health_id: str,
    field: str,
    errors: list[dict[str, object]],
) -> object:
    present = [name for name in aliases if name in metrics]
    if not present:
        errors.append(
            _issue(
                "missing_health_field",
                f"health record requires {aliases[0]}",
                health_id=health_id,
                field=field,
            )
        )
        return None
    value = metrics[present[0]]
    if len(present) > 1 and any(metrics[name] != value for name in present[1:]):
        errors.append(
            _issue(
                "conflicting_health_fields",
                f"health record contains conflicting aliases for {field}",
                health_id=health_id,
                field=field,
            )
        )
    return value


def _validate_health_record(
    health_id: str,
    metrics: object,
) -> tuple[dict[str, object] | None, list[dict[str, object]]]:
    if not isinstance(metrics, dict):
        return None, [
            _issue(
                "invalid_health_record",
                "each health record must be an object",
                health_id=health_id,
            )
        ]

    errors: list[dict[str, object]] = []
    successes = _health_alias_value(
        metrics,
        _HEALTH_COUNTER_ALIASES["successes"],
        health_id=health_id,
        field="successes",
        errors=errors,
    )
    failures = _health_alias_value(
        metrics,
        _HEALTH_COUNTER_ALIASES["failures"],
        health_id=health_id,
        field="failures",
        errors=errors,
    )
    if successes is not None and not _nonnegative_integer(successes):
        errors.append(
            _issue(
                "invalid_health_metric",
                "successes must be a non-negative integer",
                health_id=health_id,
                field="successes",
            )
        )
    if failures is not None and not _nonnegative_integer(failures):
        errors.append(
            _issue(
                "invalid_health_metric",
                "failures must be a non-negative integer",
                health_id=health_id,
                field="failures",
            )
        )

    new_items = metrics.get("new_items")
    if "new_items" not in metrics:
        errors.append(
            _issue(
                "missing_health_field",
                "health record requires new_items",
                health_id=health_id,
                field="new_items",
            )
        )
    elif not _nonnegative_integer(new_items):
        errors.append(
            _issue(
                "invalid_health_metric",
                "new_items must be a non-negative integer",
                health_id=health_id,
                field="new_items",
            )
        )

    latency_ms = metrics.get("latency_ms")
    if "latency_ms" not in metrics:
        errors.append(
            _issue(
                "missing_health_field",
                "health record requires latency_ms",
                health_id=health_id,
                field="latency_ms",
            )
        )
    elif not _nonnegative_number(latency_ms):
        errors.append(
            _issue(
                "invalid_health_metric",
                "latency_ms must be a finite non-negative number",
                health_id=health_id,
                field="latency_ms",
            )
        )

    last_success = _health_alias_value(
        metrics,
        _HEALTH_COUNTER_ALIASES["last_success"],
        health_id=health_id,
        field="last_success",
        errors=errors,
    )
    parsed_last_success: datetime | None = None
    if last_success is not None:
        parsed_last_success = _parse_timestamp(last_success)
        if parsed_last_success is None:
            errors.append(
                _issue(
                    "invalid_health_timestamp",
                    "last_success must be null or a valid ISO timestamp",
                    health_id=health_id,
                    field="last_success",
                )
            )
    elif "last_success" in metrics or "last_success_at" in metrics:
        # ``None`` is how source_health represents a first failed run.  A
        # missing field was handled by _health_alias_value above.
        parsed_last_success = None

    if errors:
        return None, errors
    assert successes is not None and failures is not None
    return {
        "successes": successes,
        "failures": failures,
        "new_items": new_items,
        "latency_ms": latency_ms,
        "last_success": last_success,
        "_last_success_dt": parsed_last_success,
    }, []


def validate_health(document: object) -> tuple[dict[str, dict[str, object]], list[dict[str, object]]]:
    """Return normalized health records and fatal schema errors."""

    if not isinstance(document, dict):
        return {}, [
            _issue("invalid_health_shape", "health document must be a JSON object")
        ]

    records: dict[str, dict[str, object]] = {}
    errors: list[dict[str, object]] = []
    for health_id in sorted(document, key=lambda value: str(value)):
        if not _nonempty_text(health_id):
            errors.append(
                _issue("invalid_health_id", "health record ids must be non-empty strings", health_id=health_id)
            )
            continue
        record, record_errors = _validate_health_record(health_id, document[health_id])
        errors.extend(record_errors)
        if record is not None:
            records[health_id] = record
    return records, errors


def _cadence_seconds(source: Mapping[str, object]) -> float | None:
    if "recrawlDays" in source and _positive_number(source["recrawlDays"]):
        return float(source["recrawlDays"]) * 86_400.0
    return None


def _read_json_file(path: Path, *, label: str) -> tuple[object | None, str, list[dict[str, object]]]:
    if not path.exists():
        return None, "missing", []
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle), "readable", []
    except json.JSONDecodeError as exc:
        return None, "invalid", [
            _issue(
                f"invalid_{label}_json",
                f"{label} file is not valid JSON: {exc.msg}",
                path=str(path),
            )
        ]
    except (OSError, UnicodeError) as exc:
        return None, "unreadable", [
            _issue(
                f"unreadable_{label}",
                f"{label} file could not be read: {exc}",
                path=str(path),
            )
        ]


def _health_source_status(
    source: Mapping[str, object],
    record: Mapping[str, object] | None,
    *,
    health_state: str,
    now: datetime,
) -> dict[str, object]:
    source_id = str(source.get("id", ""))
    if health_state == "missing":
        status = "missing"
    elif record is None:
        status = "first_run"
    else:
        last_success = record.get("_last_success_dt")
        if last_success is None:
            status = "first_run"
        else:
            cadence_seconds = _cadence_seconds(source)
            age_seconds = max(0.0, (now - last_success).total_seconds())
            status = "stale" if cadence_seconds is not None and age_seconds >= cadence_seconds else "healthy"

    result: dict[str, object] = {"id": source_id, "status": status}
    if record is not None:
        result.update(
            {
                "successes": record["successes"],
                "failures": record["failures"],
                "last_success": record["last_success"],
            }
        )
        cadence_seconds = _cadence_seconds(source)
        if cadence_seconds is not None:
            result["cadence_seconds"] = cadence_seconds
    return result


def _path_value(path: str | os.PathLike[str] | None, default: Path) -> Path:
    return Path(path if path is not None else default).expanduser().absolute()


def run_preflight(
    registry_path: str | os.PathLike[str] | None = None,
    health_path: str | os.PathLike[str] | None = None,
    *,
    now: datetime | str | None = None,
) -> dict[str, object]:
    """Run the file-only preflight and return its JSON-serializable summary."""

    registry = _path_value(registry_path, DEFAULT_REGISTRY_PATH)
    health = _path_value(health_path, DEFAULT_HEALTH_PATH)
    summary: dict[str, object] = {
        "status": "fatal",
        "exit_code": EXIT_FATAL,
        "registry": {"path": str(registry), "state": "unknown", "source_count": 0},
        "health": {"path": str(health), "state": "unknown", "sources": [], "unmatched_records": []},
        "errors": [],
        "warnings": [],
    }
    errors: list[dict[str, object]] = []

    try:
        as_of = _coerce_now(now)
    except ValueError as exc:
        errors.append(_issue("invalid_now", str(exc)))
        as_of = datetime.now(timezone.utc)

    registry_document, registry_state, registry_read_errors = _read_json_file(registry, label="registry")
    errors.extend(registry_read_errors)
    sources: list[dict[str, object]] = []
    if registry_state == "missing":
        errors.append(_issue("missing_registry", "registry file does not exist", path=str(registry)))
    elif not registry_read_errors:
        sources, registry_errors = validate_registry(registry_document)
        errors.extend(registry_errors)
    summary["registry"] = {
        "path": str(registry),
        "state": registry_state,
        "source_count": len(sources),
    }

    health_document, health_state, health_read_errors = _read_json_file(health, label="health")
    errors.extend(health_read_errors)
    health_records: dict[str, dict[str, object]] = {}
    if health_state == "missing":
        health_summary_state = "missing"
    elif health_read_errors:
        health_summary_state = health_state
    else:
        health_records, health_errors = validate_health(health_document)
        errors.extend(health_errors)
        health_summary_state = "readable" if not health_errors else "invalid"

    source_statuses: list[dict[str, object]] = []
    warnings: list[dict[str, object]] = []
    known_ids: set[str] = set()
    for source in sources:
        source_id = source.get("id")
        if not isinstance(source_id, str) or not source_id:
            continue
        known_ids.add(source_id)
        status_record = health_records.get(source_id)
        if health_summary_state in {"invalid", "unreadable", "invalid"} and source_id not in health_records:
            status = {"id": source_id, "status": "invalid"}
        else:
            status = _health_source_status(
                source,
                status_record,
                health_state=health_summary_state,
                now=as_of,
            )
        source_statuses.append(status)
        if status["status"] in {"missing", "first_run", "stale"}:
            warnings.append(
                _issue(
                    f"health_{status['status']}",
                    f"source health is {status['status']}",
                    source_id=source_id,
                )
            )

    unmatched_records = sorted(set(health_records) - known_ids)
    summary["health"] = {
        "path": str(health),
        "state": health_summary_state,
        "record_count": len(health_records),
        "sources": source_statuses,
        "unmatched_records": unmatched_records,
    }
    summary["warnings"] = warnings
    summary["errors"] = errors
    if errors:
        summary["status"] = "fatal"
        summary["exit_code"] = EXIT_FATAL
    elif warnings:
        summary["status"] = "warning"
        summary["exit_code"] = EXIT_OK
    else:
        summary["status"] = "ok"
        summary["exit_code"] = EXIT_OK
    return summary


# A short alias makes the integration call self-documenting while retaining
# the more explicit function name for callers and tests.
preflight = run_preflight


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--registry",
        "--registry-path",
        dest="registry_path",
        default=os.environ.get("HARVEST_REGISTRY_PATH", str(DEFAULT_REGISTRY_PATH)),
        help="path to harvest-sources.json",
    )
    parser.add_argument(
        "--health",
        "--health-path",
        dest="health_path",
        default=os.environ.get("HARVEST_HEALTH_PATH", str(DEFAULT_HEALTH_PATH)),
        help="path to harvest-health.json",
    )
    parser.add_argument(
        "--now",
        help="ISO timestamp used for stale classification (primarily for deterministic tests)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    summary = run_preflight(args.registry_path, args.health_path, now=args.now)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return int(summary["exit_code"])


if __name__ == "__main__":
    sys.exit(main())
