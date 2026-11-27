#!/usr/bin/env python3
"""Deterministically deduplicate and prioritize the daily NDJSON inbox.

The LLM extraction step only needs the original inbox row.  This module keeps
that row untouched while using a private score and explanation to decide its
order.  It deliberately does not add ``score`` or ``reasons`` fields to the
NDJSON output.

Library example::

    rows = prioritize_rows(raw_rows, now="2026-08-10T00:00:00+00:00")

CLI examples::

    python3 scripts/agent/prioritize_inbox.py < inbox.ndjson
    python3 scripts/agent/prioritize_inbox.py -i inbox.ndjson -o extract.ndjson --limit 100

Without ``--limit`` every non-search, canonical-link-unique row is emitted.
"""

from __future__ import annotations

import argparse
import datetime as _datetime
import email.utils
import json
import os
import re
import sys
import urllib.parse
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import TextIO


UTC = _datetime.timezone.utc

# Tracking parameters are not part of an article's identity.  Keep unknown
# parameters: a query parameter can be a real article/version discriminator.
_TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "dclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "yclid",
    "igshid",
    "ref_src",
    "ref_url",
    "referrer",
}

_UNRESERVED = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
_PERCENT_ESCAPE = re.compile(r"%([0-9A-Fa-f]{2})")

_SOURCE_TYPE_BASE = {
    # Community/news are independent discovery signals and should normally
    # outrank a marketing report, even when the report is newer.
    "community": 24,
    "news": 22,
    "report": 8,
}
_SOURCE_TYPE_TIE_RANK = {"community": 3, "news": 2, "report": 1}

_QUOTE_PATTERNS = (
    re.compile(r'"([^"\r\n]{2,80})"'),
    re.compile(r"“([^”\r\n]{2,80})”"),
    re.compile(r"‘([^’\r\n]{2,80})’"),
    re.compile(r"「([^」\r\n]{2,80})」"),
    re.compile(r"『([^』\r\n]{2,80})』"),
    re.compile(r"《([^》\r\n]{2,80})》"),
)

# This intentionally finds only Latin/alphanumeric tokens.  Ordinary Korean
# words cannot trigger it; an English token with digits or a visible brand
# casing transition is a useful, explainable signal for a company/app name.
_LATIN_TOKEN = re.compile(r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9-]{2,39}(?![A-Za-z0-9])")


@dataclass(frozen=True)
class RankedRow:
    """A row plus private ranking metadata.

    ``prioritize_rows`` strips this metadata before writing output.  Keeping a
    public ranked form makes the score/reasons inspectable in tests and small
    operators without changing the wire schema.
    """

    row: dict[str, object]
    score: int
    reasons: tuple[str, ...]
    canonical_link: str


@dataclass(frozen=True)
class _ScoreContext:
    source_types: frozenset[str]
    report_source_counts: Mapping[str, int]


def _text(value: object) -> str:
    return "" if value is None else str(value).strip()


def _decode_unreserved(value: str) -> str:
    """Decode only URL percent escapes that are safe to compare literally."""

    def replace(match: re.Match[str]) -> str:
        char = chr(int(match.group(1), 16))
        return char if char in _UNRESERVED else "%" + match.group(1).upper()

    return _PERCENT_ESCAPE.sub(replace, value)


def _canonical_netloc(parts: urllib.parse.SplitResult) -> str:
    """Normalize host and default port without allowing malformed URLs to fail."""

    try:
        hostname = parts.hostname
    except ValueError:
        return parts.netloc.casefold()
    if not hostname:
        return ""

    try:
        hostname = hostname.encode("idna").decode("ascii").casefold()
    except UnicodeError:
        hostname = hostname.casefold()
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"

    try:
        port = parts.port
    except ValueError:
        # Keep a malformed port deterministic instead of making a whole inbox
        # unusable.  It will still be a distinct canonical link.
        return parts.netloc.casefold()
    if port is not None and not (
        (parts.scheme.casefold() == "http" and port == 80)
        or (parts.scheme.casefold() == "https" and port == 443)
    ):
        hostname = f"{hostname}:{port}"
    return hostname


def canonicalize_link(link: object) -> str:
    """Return a stable URL identity used for deduplication.

    Host and scheme casing, default ports, fragments, trailing root slashes,
    tracking parameters, parameter order, and unreserved percent escapes are
    normalized.  Meaningful query parameters remain part of the identity.
    Empty links return ``""``; callers must not treat all empty links as one
    article because that would lose recall.
    """

    raw = _text(link)
    if not raw:
        return ""

    try:
        parts = urllib.parse.urlsplit(raw)
    except ValueError:
        # Keep malformed links usable as stable, exact identities.  The row
        # remains in the inbox instead of being discarded during prioritizing.
        return raw
    scheme = parts.scheme.casefold()
    netloc = _canonical_netloc(parts)
    host = ""
    try:
        host = (parts.hostname or "").casefold()
    except ValueError:
        host = ""

    path = _decode_unreserved(parts.path)
    if netloc and not path:
        path = "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    query_pairs: list[tuple[str, str]] = []
    if parts.query:
        try:
            query_pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        except ValueError:
            # A malformed query is still useful as an identity.  Preserve it
            # below rather than dropping a row.
            query_pairs = []

    filtered_query: list[tuple[str, str]] = []
    for key, value in query_pairs:
        lowered = key.casefold()
        if lowered.startswith("utm_") or lowered in _TRACKING_QUERY_KEYS:
            continue
        # Google News appends ``oc=5`` to RSS links.  It is a delivery hint,
        # not an article identity; do not remove similarly named parameters on
        # unrelated hosts.
        if host in {"news.google.com", "www.news.google.com"} and lowered == "oc":
            continue
        filtered_query.append((key, value))

    if query_pairs:
        query = urllib.parse.urlencode(sorted(filtered_query), doseq=True)
    else:
        query = parts.query if parts.query else ""

    return urllib.parse.urlunsplit((scheme, netloc, path, query, ""))


# Short aliases are convenient at call sites and make the identity operation
# easy to discover without duplicating implementation.
canonical_link = canonicalize_link
normalize_link = canonicalize_link
canonicalize_url = canonicalize_link


def is_search_row(row: Mapping[str, object]) -> bool:
    """Whether a row is a targeted ``검색/*`` result.

    The English spelling is accepted as a harmless compatibility aid for
    manually prepared fixtures; production harvest rows use ``검색/``.
    """

    query = _text(row.get("query"))
    return query.startswith("검색/") or query.casefold().startswith("search/")


def parse_pub_date(value: object) -> _datetime.datetime | None:
    """Parse inbox timestamps into timezone-aware UTC datetimes.

    Supported forms cover the harvester's millisecond epoch, second epoch,
    ISO-8601 (including ``Z``), and RSS/RFC-822 dates.  Invalid or missing
    values return ``None`` so one malformed row never removes another row.
    """

    if isinstance(value, _datetime.datetime):
        parsed = value
    elif isinstance(value, _datetime.date):
        parsed = _datetime.datetime.combine(value, _datetime.time())
    else:
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, (int, float)):
            numeric_text = str(value)
        else:
            numeric_text = _text(value)
        if not numeric_text:
            return None

        numeric: float | None = None
        try:
            numeric = float(numeric_text)
        except (TypeError, ValueError):
            pass
        if numeric is not None and numeric.is_integer():
            absolute = abs(numeric)
            if 100_000_000 <= absolute < 100_000_000_000_000:
                seconds = numeric / 1000 if absolute >= 100_000_000_000 else numeric
                try:
                    return _datetime.datetime.fromtimestamp(seconds, tz=UTC)
                except (OverflowError, OSError, ValueError):
                    return None

        iso_value = numeric_text[:-1] + "+00:00" if numeric_text.endswith(("Z", "z")) else numeric_text
        try:
            parsed = _datetime.datetime.fromisoformat(iso_value)
        except ValueError:
            try:
                parsed = email.utils.parsedate_to_datetime(numeric_text)
            except (TypeError, ValueError, OverflowError, IndexError):
                parsed = None
        if parsed is None:
            for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y.%m.%d"):
                try:
                    parsed = _datetime.datetime.strptime(numeric_text, fmt)
                    break
                except ValueError:
                    continue
        if parsed is None:
            return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    else:
        parsed = parsed.astimezone(UTC)
    return parsed


def _coerce_now(value: object | None) -> _datetime.datetime:
    if value is None:
        return _datetime.datetime.now(UTC)
    parsed = parse_pub_date(value)
    if parsed is None:
        raise ValueError(f"now must be a parseable timestamp, got {value!r}")
    return parsed


def _epoch(value: _datetime.datetime | None) -> float:
    return value.timestamp() if value is not None else float("-inf")


def _source_type(row: Mapping[str, object]) -> str:
    return _text(row.get("sourceType")).casefold() or "unknown"


def _source_group(row: Mapping[str, object]) -> str:
    """Return the likely independent publisher group for report rows."""

    explicit = _text(row.get("sourceFamily"))
    if explicit:
        return "family:" + re.sub(r"\W+", "", explicit.casefold())

    source = _text(row.get("source"))
    if source:
        # Names in the registry often differ only by the words "법무법인",
        # "법률사무소", or "블로그".  Removing those labels groups one firm's
        # articles while retaining a different firm's name.
        simplified = source.casefold()
        simplified = re.sub(r"법무법인|법률사무소|law\s*firm|블로그", "", simplified)
        simplified = re.sub(r"\W+", "", simplified)
        if simplified:
            return "source:" + simplified

    link = canonicalize_link(row.get("link"))
    host = urllib.parse.urlsplit(link).netloc.casefold()
    return "host:" + host if host else "row:" + _stable_json(row)


def _quoted_signal(text: str) -> bool:
    return any(pattern.search(text) for pattern in _QUOTE_PATTERNS)


def _brand_signal(text: str) -> str | None:
    for match in _LATIN_TOKEN.finditer(text):
        token = match.group(0)
        has_letter = bool(re.search(r"[A-Za-z]", token))
        has_digit = bool(re.search(r"\d", token))
        has_camel_case = bool(re.search(r"[a-z][A-Z]", token))
        title_case = token[0].isupper() and any(char.islower() for char in token[1:])
        if has_letter and (has_digit or has_camel_case or title_case):
            return token
    return None


def _company_signal_count(row: Mapping[str, object]) -> int:
    title = _text(row.get("title"))
    return int(_quoted_signal(title)) + int(_brand_signal(title) is not None)


def _candidate_quality(row: Mapping[str, object]) -> tuple[int, int, float, str]:
    """Choose a representative when canonical duplicates carry different data."""

    return (
        -_SOURCE_TYPE_TIE_RANK.get(_source_type(row), 0),
        -_company_signal_count(row),
        -_epoch(parse_pub_date(row.get("pubDate"))),
        _stable_json(row),
    )


def _deduplicate(rows: Iterable[dict[str, object]]) -> list[dict[str, object]]:
    groups: dict[str, list[dict[str, object]]] = {}
    for index, row in enumerate(rows):
        canonical = canonicalize_link(row.get("link"))
        # Empty links have no identity.  Give each one a private key so a
        # missing link cannot collapse otherwise useful observations.
        key = canonical or f"\x00empty-link-{index}"
        groups.setdefault(key, []).append(row)

    deduplicated: list[dict[str, object]] = []
    for group in groups.values():
        deduplicated.append(min(group, key=_candidate_quality))
    return deduplicated


def _build_context(rows: Iterable[Mapping[str, object]]) -> _ScoreContext:
    source_types: set[str] = set()
    report_sources: Counter[str] = Counter()
    for row in rows:
        source_type = _source_type(row)
        source_types.add(source_type)
        if source_type == "report":
            report_sources[_source_group(row)] += 1
    return _ScoreContext(frozenset(source_types), dict(report_sources))


def _recency_points(
    published: _datetime.datetime | None,
    now: _datetime.datetime,
) -> tuple[int, str] | None:
    if published is None:
        return None
    age_days = max(0.0, (now - published).total_seconds() / 86_400)
    if age_days <= 1:
        return 24, "recency: <=1d (+24)"
    if age_days <= 7:
        return 18, "recency: <=7d (+18)"
    if age_days <= 30:
        return 12, "recency: <=30d (+12)"
    if age_days <= 90:
        return 7, "recency: <=90d (+7)"
    if age_days <= 365:
        return 3, "recency: <=365d (+3)"
    return 0, "recency: older than 365d (+0)"


def _score_details(
    row: Mapping[str, object],
    *,
    now: _datetime.datetime,
    context: _ScoreContext,
) -> tuple[int, tuple[str, ...]]:
    score = 0
    reasons: list[str] = []

    recency = _recency_points(parse_pub_date(row.get("pubDate")), now)
    if recency is None:
        reasons.append("recency: missing or unparseable pubDate (+0)")
    else:
        points, reason = recency
        score += points
        reasons.append(reason)

    source_type = _source_type(row)
    source_points = _SOURCE_TYPE_BASE.get(source_type, 0)
    score += source_points
    if source_type in {"community", "news"}:
        reasons.append(f"sourceType {source_type}: independent-source preference (+{source_points})")
        if {"community", "news"}.issubset(context.source_types):
            score += 4
            reasons.append("sourceType diversity: community+news (+4)")
    elif source_type == "report":
        reasons.append(f"sourceType report: law-firm report baseline (+{source_points})")
        family = _source_group(row)
        source_count = context.report_source_counts.get(family, 1)
        if source_count > 1:
            penalty = min(20, (source_count - 1) * 4)
            score -= penalty
            reasons.append(f"report concentration: same publisher {source_count}x (-{penalty})")
    else:
        reasons.append(f"sourceType {source_type}: neutral (+0)")

    title = _text(row.get("title"))
    if _quoted_signal(title):
        score += 12
        reasons.append("company signal: quoted name (+12)")
    if _brand_signal(title) is not None:
        score += 10
        reasons.append("company signal: English/alphanumeric brand (+10)")

    return score, tuple(reasons)


def rank_rows(
    rows: Iterable[Mapping[str, object]],
    *,
    now: object | None = None,
    limit: int | None = None,
    include_search: bool = False,
) -> list[RankedRow]:
    """Return deduplicated rows with private score/reasons metadata.

    The input mappings are copied and never mutated.  Search rows are omitted
    by default.  ``limit`` is intentionally ``None`` by default: the caller
    must opt into truncation explicitly.
    """

    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 0):
        raise ValueError("limit must be a non-negative integer or None")

    now_dt = _coerce_now(now)
    eligible: list[dict[str, object]] = []
    for row in rows:
        if not isinstance(row, Mapping):
            raise TypeError("every inbox row must be a JSON object/mapping")
        copied = dict(row)
        if not include_search and is_search_row(copied):
            continue
        eligible.append(copied)

    deduplicated = _deduplicate(eligible)
    context = _build_context(deduplicated)
    ranked: list[RankedRow] = []
    for row in deduplicated:
        canonical = canonicalize_link(row.get("link"))
        score, reasons = _score_details(row, now=now_dt, context=context)
        ranked.append(RankedRow(row, score, reasons, canonical))

    def sort_key(item: RankedRow) -> tuple[object, ...]:
        # Score first, then publication time.  The normalized link and stable
        # JSON tie-breakers make equal-score output independent of hash order.
        return (
            -item.score,
            -_epoch(parse_pub_date(item.row.get("pubDate"))),
            item.canonical_link,
            _stable_json(item.row),
        )

    ranked.sort(key=sort_key)
    return ranked if limit is None else ranked[:limit]


def prioritize_rows(
    rows: Iterable[Mapping[str, object]],
    *,
    now: object | None = None,
    limit: int | None = None,
    include_search: bool = False,
) -> list[dict[str, object]]:
    """Return output-schema rows in deterministic priority order."""

    return [ranked.row for ranked in rank_rows(rows, now=now, limit=limit, include_search=include_search)]


prioritize_inbox = prioritize_rows


def explain_row(
    row: Mapping[str, object],
    *,
    now: object | None = None,
    corpus: Iterable[Mapping[str, object]] | None = None,
) -> dict[str, object]:
    """Expose internal explanation data without changing an output row."""

    copied = dict(row)
    corpus_rows = [dict(item) for item in corpus] if corpus is not None else [copied]
    context = _build_context(corpus_rows)
    now_dt = _coerce_now(now)
    score, reasons = _score_details(copied, now=now_dt, context=context)
    return {
        "score": score,
        "reasons": list(reasons),
        "canonical_link": canonicalize_link(copied.get("link")),
    }


def score_row(
    row: Mapping[str, object],
    *,
    now: object | None = None,
    corpus: Iterable[Mapping[str, object]] | None = None,
) -> int:
    """Return only the deterministic private score for one row."""

    return int(explain_row(row, now=now, corpus=corpus)["score"])


def read_ndjson(handle: TextIO) -> list[dict[str, object]]:
    """Read NDJSON objects, rejecting malformed/non-object lines explicitly."""

    rows: list[dict[str, object]] = []
    for line_number, line in enumerate(handle, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {line_number}: invalid JSON ({exc.msg})") from exc
        if not isinstance(value, dict):
            raise ValueError(f"line {line_number}: expected a JSON object")
        rows.append(value)
    return rows


def write_ndjson(rows: Iterable[Mapping[str, object]], handle: TextIO) -> None:
    """Write rows without adding ranking metadata or changing their fields."""

    for row in rows:
        if not isinstance(row, Mapping):
            raise TypeError("every output row must be a mapping")
        handle.write(json.dumps(dict(row), ensure_ascii=False, separators=(",", ":")))
        handle.write("\n")


def _read_path(path: str) -> list[dict[str, object]]:
    if path == "-":
        return read_ndjson(sys.stdin)
    with open(path, encoding="utf-8") as handle:
        return read_ndjson(handle)


def _write_path(path: str, rows: Iterable[Mapping[str, object]]) -> None:
    if path == "-":
        write_ndjson(rows, sys.stdout)
        return
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        write_ndjson(rows, handle)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_path", nargs="?", help="input NDJSON path, or - for stdin (default: stdin)")
    parser.add_argument("-i", "--input", "--input-file", dest="input_option", help="input NDJSON path, or - for stdin")
    parser.add_argument("-o", "--output", "--output-file", default="-", help="output NDJSON path, or - for stdout (default: stdout)")
    parser.add_argument("--limit", type=int, default=None, help="explicit maximum number of output rows")
    parser.add_argument("--include-search", "--keep-search", action="store_true", help="retain 검색/* rows")
    parser.add_argument("--now", help="fixed ISO/RFC timestamp used for deterministic recency scoring")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.input_path is not None and args.input_option is not None:
        parser.error("use a positional input path or --input, not both")
    input_path = args.input_option or args.input_path or "-"

    try:
        raw_rows = _read_path(input_path)
        output_rows = prioritize_rows(
            raw_rows,
            now=args.now,
            limit=args.limit,
            include_search=args.include_search,
        )
        _write_path(args.output, output_rows)
    except BrokenPipeError:
        return 0
    except (OSError, TypeError, ValueError) as exc:
        print(f"prioritize_inbox: {exc}", file=sys.stderr)
        return 2
    return 0


def _stable_json(row: Mapping[str, object]) -> str:
    return json.dumps(dict(row), ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=repr)


if __name__ == "__main__":
    raise SystemExit(main())
