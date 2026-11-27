"""Public feed helpers used by the discovery harvester.

Only feed metadata (URL, title/slug, published/modified time) is handled here.
Article bodies are deliberately outside this module so a competitor sitemap can
be used as a discovery signal without copying its content.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET
from collections.abc import Iterable, Mapping
from html.parser import HTMLParser


def _sitemap_entry_parts(entry: Mapping[str, object] | str, lastmod: object = "") -> tuple[str, str]:
    """Return normalized ``(loc, lastmod)`` values without changing *entry*."""
    if isinstance(entry, Mapping):
        loc = entry.get("loc", entry.get("url", ""))
        lastmod = entry.get("lastmod", "")
    else:
        loc = entry
    return str(loc or "").strip(), str(lastmod or "").strip()


def parse_naver_loose_json(value: str) -> dict[str, object]:
    """Decode Naver's JSON-like responses with apostrophe escapes/control chars/trailing data."""
    text = (value or "").lstrip("\ufeff\r\n\t ").replace("\\'", "'")
    # A small subset of CDN responses has exposed an HTTP chunk-size line in
    # the JSON string itself (for example ``\r\n1FF8\r\n``), splitting titles.
    # The API payload is normally one line, so removing only complete hex-size
    # framing lines is both narrow and deterministic.
    text = re.sub(r"\r?\n[0-9A-Fa-f]{1,8}\r?\n", "", text)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed, _ = json.JSONDecoder(strict=False).raw_decode(text)
    if not isinstance(parsed, dict):
        raise ValueError("Naver response root must be an object")
    return parsed


def sitemap_entry_fingerprint(
    entry: Mapping[str, object] | str | None = None,
    lastmod: object = "",
    *,
    url: Mapping[str, object] | str | None = None,
) -> str:
    """Return a stable SHA-256 fingerprint for one sitemap URL and ``lastmod``.

    The function is deliberately pure: it only reads its input and does not
    perform I/O or mutate the supplied mapping.  A URL string may be supplied
    together with ``lastmod`` as a convenience for callers storing compact
    state.
    """
    if url is not None:
        if entry is not None:
            raise TypeError("provide either entry or url, not both")
        entry = url
    if entry is None:
        raise ValueError("sitemap entry is missing loc")
    loc, modified = _sitemap_entry_parts(entry, lastmod)
    if not loc:
        raise ValueError("sitemap entry is missing loc")
    payload = json.dumps(
        {"lastmod": modified, "loc": loc},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


# Short aliases make the state-oriented API readable at call sites while the
# longer name remains the documented public spelling.
entry_fingerprint = sitemap_entry_fingerprint
fingerprint_sitemap_entry = sitemap_entry_fingerprint


def sitemap_entry_fingerprints(entries: Iterable[Mapping[str, object]]) -> dict[str, str]:
    """Build a URL → fingerprint snapshot for *entries*.

    Empty sitemap rows are ignored, and duplicate URLs use the final row just
    as a dictionary-backed state snapshot would.  The input iterable is never
    consumed more than once and its entries are not modified.
    """
    snapshot: dict[str, str] = {}
    for entry in entries:
        loc, _ = _sitemap_entry_parts(entry)
        if loc:
            snapshot[loc] = sitemap_entry_fingerprint(entry)
    return snapshot


def sitemap_fingerprint(entries: Iterable[Mapping[str, object]]) -> str:
    """Return an order-independent fingerprint for a complete sitemap.

    Only URL and ``lastmod`` participate.  Sorting the per-entry fingerprints
    prevents a publisher's harmless row reordering from looking like a full
    sitemap change while still detecting additions, removals, and modified
    timestamps.
    """
    fingerprints = sorted(
        sitemap_entry_fingerprint(entry)
        for entry in entries
        if _sitemap_entry_parts(entry)[0]
    )
    return hashlib.sha256("\n".join(fingerprints).encode("ascii")).hexdigest()


fingerprint_sitemap = sitemap_fingerprint


def _previous_sitemap_fingerprints(previous) -> dict[str, str | None]:
    """Normalize a fingerprint mapping or an older URL-only seen collection."""
    if previous is None:
        return {}

    normalized: dict[str, str | None] = {}
    if isinstance(previous, Mapping):
        for raw_loc, value in previous.items():
            loc = str(raw_loc or "").strip()
            if not loc:
                continue
            if isinstance(value, Mapping):
                fingerprint = value.get("fingerprint") or value.get("sitemapFingerprint")
                if fingerprint is None and "lastmod" in value:
                    fingerprint = sitemap_entry_fingerprint({"loc": loc, "lastmod": value.get("lastmod", "")})
                normalized[loc] = str(fingerprint) if fingerprint else None
            elif value is None:
                # A URL-only state entry is still useful for backwards
                # compatibility, but it cannot prove a lastmod value.
                normalized[loc] = None
            elif isinstance(value, str):
                value = value.strip()
                if not value:
                    normalized[loc] = None
                elif re.fullmatch(r"[0-9a-fA-F]{64}", value):
                    normalized[loc] = value.lower()
                else:
                    # Also accept a compact URL → lastmod snapshot.  A real
                    # SHA-256 fingerprint is unambiguously 64 hex chars.
                    normalized[loc] = sitemap_entry_fingerprint({"loc": loc, "lastmod": value})
            else:
                normalized[loc] = str(value)
        return normalized

    for item in previous:
        if isinstance(item, str):
            loc = item.strip()
            if loc:
                normalized[loc] = None
            continue
        if isinstance(item, Mapping):
            loc, _ = _sitemap_entry_parts(item)
            if loc:
                normalized[loc] = sitemap_entry_fingerprint(item)
    return normalized


def detect_sitemap_changes(
    entries: Iterable[Mapping[str, object]],
    previous,
    *,
    include_path: str = "",
    limit: int | None = None,
) -> list[dict[str, object]]:
    """Return new or ``lastmod``-changed sitemap rows in input order.

    ``previous`` can be a URL → fingerprint mapping produced by
    :func:`sitemap_entry_fingerprints`, a prior iterable of sitemap rows, or a
    legacy URL-only set/list.  URL-only state suppresses known URLs (it has no
    timestamp with which to compare); callers should persist fingerprints for
    timestamp change detection on subsequent runs.
    """
    if limit is not None and limit < 0:
        raise ValueError("limit must be non-negative")
    if limit == 0:
        return []
    old = _previous_sitemap_fingerprints(previous)
    changed: list[dict[str, object]] = []
    for entry in entries:
        loc, _ = _sitemap_entry_parts(entry)
        if not loc:
            continue
        if include_path and not urllib.parse.urlsplit(loc).path.startswith(include_path):
            continue
        if loc in old:
            if old[loc] is None:
                continue
            if old[loc] == sitemap_entry_fingerprint(entry):
                continue
        changed.append(dict(entry))
        if limit is not None and len(changed) >= limit:
            break
    return changed


changed_sitemap_entries = detect_sitemap_changes


def has_sitemap_changed(entries: Iterable[Mapping[str, object]], previous_fingerprint: str | None) -> bool:
    """Return whether the complete sitemap differs from a prior fingerprint."""
    return sitemap_fingerprint(entries) != previous_fingerprint


sitemap_changed = has_sitemap_changed


def parse_sitemap(xml_text: str) -> tuple[str, list[dict[str, str]]]:
    """Return (kind, entries) for a sitemap index or urlset.

    A doctype is rejected because sitemaps do not need one and this keeps XML
    entity expansion out of a network-facing parser.
    """
    if "<!DOCTYPE" in xml_text.upper():
        raise ValueError("sitemap doctype is not allowed")
    # A few nginx/PHP endpoints expose HTTP chunk-size markers inside the
    # decoded response body. Remove only standalone hexadecimal marker lines.
    xml_text = re.sub(r"\r?\n[0-9a-fA-F]{3,8}\r?\n", "", xml_text)
    # Some CDN-backed generators append a diagnostic fragment after the
    # closing root element.  Ignore only bytes after a complete allowed root;
    # malformed XML inside the sitemap still fails closed.
    for closing in ("</urlset>", "</sitemapindex>"):
        end = xml_text.find(closing)
        if end >= 0:
            xml_text = xml_text[:end + len(closing)]
            break
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        lowered = xml_text[:4096].lower()
        if "<urlset" in lowered:
            kind, item_tag = "urlset", "url"
        elif "<sitemapindex" in lowered:
            kind, item_tag = "sitemapindex", "sitemap"
        else:
            raise
        entries: list[dict[str, str]] = []
        for block in re.findall(rf"<{item_tag}\b[^>]*>(.*?)</{item_tag}>", xml_text, re.I | re.S):
            loc_match = re.search(r"<loc\b[^>]*>(.*?)</loc>", block, re.I | re.S)
            if not loc_match:
                continue
            loc = html.unescape(re.sub(r"<[^>]+>", "", loc_match.group(1))).strip()
            parsed = urllib.parse.urlsplit(loc)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                continue
            lastmod_match = re.search(r"<lastmod\b[^>]*>(.*?)</lastmod>", block, re.I | re.S)
            lastmod = html.unescape(re.sub(r"<[^>]+>", "", lastmod_match.group(1))).strip() if lastmod_match else ""
            entries.append({"loc": loc, "lastmod": lastmod})
        if not entries:
            raise
        return kind, entries
    kind = root.tag.rsplit("}", 1)[-1]
    if kind not in {"sitemapindex", "urlset"}:
        raise ValueError(f"unsupported sitemap root: {kind}")

    entries: list[dict[str, str]] = []
    item_tag = "sitemap" if kind == "sitemapindex" else "url"
    for item in root:
        if item.tag.rsplit("}", 1)[-1] != item_tag:
            continue
        values = {child.tag.rsplit("}", 1)[-1]: (child.text or "").strip() for child in item}
        if values.get("loc"):
            entries.append({"loc": values["loc"], "lastmod": values.get("lastmod", "")})
    return kind, entries


def collect_sitemap_entries(get_text, root_url: str, *, max_sitemaps: int = 10) -> list[dict[str, str]]:
    """Recursively fetch a same-host sitemap tree, failing instead of truncating."""
    root_host = urllib.parse.urlsplit(root_url).netloc.lower()
    collected: list[dict[str, str]] = []
    pending = [root_url]
    visited: set[str] = set()
    while pending:
        sitemap_url = pending.pop(0)
        if sitemap_url in visited:
            continue
        if len(visited) >= max_sitemaps:
            raise ValueError(f"sitemap tree exceeds max_sitemaps={max_sitemaps}")
        visited.add(sitemap_url)
        kind, entries = parse_sitemap(get_text(sitemap_url))
        if kind == "urlset":
            collected.extend(entries)
            continue
        for child in entries:
            child_url = child["loc"]
            if urllib.parse.urlsplit(child_url).netloc.lower() == root_host:
                pending.append(child_url)
    return collected


def sitemap_title(url: str, strategy: str = "last-segment", query_param: str = "name") -> str:
    """Derive a readable discovery label from the final URL path segment.

    ``first-slug-token`` supports URLs shaped like
    ``/fraud/{case-name}-{SEO-description}-{hash}`` without turning the SEO
    description into the candidate keyword.
    """
    parsed = urllib.parse.urlsplit(url)
    if strategy == "query-param":
        values = urllib.parse.parse_qs(parsed.query).get(query_param, [])
        return re.sub(r"\s+", " ", urllib.parse.unquote(values[0])).strip() if values else ""
    path = urllib.parse.unquote(parsed.path).rstrip("/")
    if not path:
        return ""
    segment = path.rsplit("/", 1)[-1]
    segment = re.sub(r"\.(?:html?|php|aspx?)$", "", segment, flags=re.I)
    if strategy == "first-slug-token":
        segment = re.split(r"[-_]", segment, maxsplit=1)[0]
    elif strategy != "last-segment":
        raise ValueError(f"unsupported sitemap title strategy: {strategy}")
    segment = re.sub(r"[-_]+", " ", segment)
    return re.sub(r"\s+", " ", segment).strip()


class _MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.title_parts: list[str] = []
        self.description = ""
        self.og_title = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "title":
            self.in_title = True
            return
        if tag.lower() != "meta":
            return
        values = {str(key).lower(): str(value or "") for key, value in attrs}
        key = (values.get("name") or values.get("property") or "").lower()
        content = values.get("content", "").strip()
        if key == "description" and content and not self.description:
            self.description = content
        elif key == "og:description" and content and not self.description:
            self.description = content
        elif key == "og:title" and content and not self.og_title:
            self.og_title = content

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)


def extract_html_metadata(html_text: str) -> dict[str, str]:
    """Return bounded public title/description metadata without retaining HTML."""
    parser = _MetadataParser()
    parser.feed(html_text)
    title = parser.og_title or " ".join(parser.title_parts)
    def clean(value: str, limit: int) -> str:
        value = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[이메일]", html.unescape(value))
        value = re.sub(r"(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)", "[전화번호]", value)
        return re.sub(r"\s+", " ", value).strip()[:limit]
    return {"title": clean(title, 500), "description": clean(parser.description, 500)}


class _HeadingParser(HTMLParser):
    """Collect visible H1–H3 text for pages with a site-wide `<title>`."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.level = 0
        self.parts: list[str] = []
        self.headings: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"h1", "h2", "h3"}:
            self.level = int(tag[-1])
            self.parts = []

    def handle_endtag(self, tag: str) -> None:
        if self.level and tag.lower() == f"h{self.level}":
            value = re.sub(r"\s+", " ", " ".join(self.parts)).strip()
            if value:
                self.headings.append(value)
            self.level = 0
            self.parts = []

    def handle_data(self, data: str) -> None:
        if self.level and data.strip():
            self.parts.append(data.strip())


def extract_html_headings(html_text: str, limit: int = 30) -> list[str]:
    """Return bounded H1–H3 labels for title fallback and transient parsing."""
    parser = _HeadingParser()
    parser.feed(html_text)
    result: list[str] = []
    for raw in parser.headings:
        value = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[이메일]", html.unescape(raw))
        value = re.sub(r"(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)", "[전화번호]", value)
        value = re.sub(r"\s+", " ", value).strip()
        if value:
            result.append(value[:500])
        if len(result) >= limit:
            break
    return result


class _ArticleTextParser(HTMLParser):
    """Extract visible text from the first article without retaining HTML."""

    _IGNORED = {"script", "style", "noscript", "svg", "form", "button"}
    _VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.article_depth = 0
        self.ignore_depth = 0
        self.parts: list[str] = []
        self.finished = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.finished:
            return
        if self.article_depth and tag not in self._VOID:
            self.article_depth += 1
        elif tag == "article":
            self.article_depth = 1
        if tag in self._IGNORED:
            self.ignore_depth += 1

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self._IGNORED and self.ignore_depth:
            self.ignore_depth -= 1
        if tag in self._VOID:
            return
        if self.article_depth:
            self.article_depth -= 1
            if self.article_depth == 0:
                self.finished = True

    def handle_data(self, data: str) -> None:
        if self.article_depth and not self.ignore_depth and data.strip():
            self.parts.append(data.strip())


def extract_article_text(html_text: str, limit: int = 50_000) -> str:
    """Return bounded article text for in-memory fact extraction only."""
    parser = _ArticleTextParser()
    parser.feed(html_text)
    value = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
    # Defense in depth: downstream facts never need contact identifiers.
    value = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[이메일]", value)
    value = re.sub(r"(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)", "[전화번호]", value)
    return value[:limit]


class _NaverBlogTextParser(HTMLParser):
    """Extract only the editor body from a public Naver Blog detail page."""

    _TARGET_CLASSES = {"se-main-container", "post-view", "postViewArea"}
    _TARGET_IDS = {"postViewArea"}
    _IGNORED = {"script", "style", "noscript", "svg", "form", "button"}
    _VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.body_depth = 0
        self.ignore_depth = 0
        self.parts: list[str] = []
        self.finished = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.finished:
            return
        values = {str(key): str(value or "") for key, value in attrs}
        classes = set(values.get("class", "").split())
        is_target = bool(classes & self._TARGET_CLASSES) or values.get("id") in self._TARGET_IDS
        if self.body_depth and tag not in self._VOID:
            self.body_depth += 1
        elif is_target:
            self.body_depth = 1
        if self.body_depth and tag in self._IGNORED:
            self.ignore_depth += 1

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.body_depth and tag in self._IGNORED and self.ignore_depth:
            self.ignore_depth -= 1
        if tag in self._VOID:
            return
        if self.body_depth:
            self.body_depth -= 1
            if self.body_depth == 0:
                self.finished = True

    def handle_data(self, data: str) -> None:
        if self.body_depth and not self.ignore_depth and data.strip():
            self.parts.append(data.strip())


def extract_naver_blog_text(html_text: str, limit: int = 50_000) -> str:
    """Return a bounded Naver Blog body for transient fact extraction.

    Both the SmartEditor ``se-main-container`` and legacy post containers are
    supported. Contact identifiers are redacted before the text leaves this
    helper; callers retain only structured facts, never this body text.
    """
    parser = _NaverBlogTextParser()
    parser.feed(html_text)
    value = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
    value = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[이메일]", value)
    value = re.sub(r"(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)", "[전화번호]", value)
    return value[:limit]


class _SelectedContainerTextParser(HTMLParser):
    _IGNORED = {"script", "style", "noscript", "svg", "form", "button"}
    _VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, selector: str) -> None:
        super().__init__(convert_charrefs=True)
        self.selector = selector
        self.depth = 0
        self.ignore_depth = 0
        self.parts: list[str] = []
        self.finished = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.finished:
            return
        values = {str(key): str(value or "") for key, value in attrs}
        classes = set(values.get("class", "").split())
        target = tag == self.selector or self.selector in classes or values.get("id") == self.selector
        if self.depth and tag not in self._VOID:
            self.depth += 1
        elif target:
            self.depth = 1
        if self.depth and tag in self._IGNORED:
            self.ignore_depth += 1

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        # HTMLParser dispatches ``<img />`` and other self-closing void
        # elements through handle_startendtag, which calls handle_endtag after
        # handle_starttag.  Void tags never increased ``depth`` above, so they
        # must not decrease it here either.
        if tag in self._VOID:
            return
        if self.depth and tag in self._IGNORED and self.ignore_depth:
            self.ignore_depth -= 1
        if self.depth:
            self.depth -= 1
            if self.depth == 0:
                self.finished = True

    def handle_data(self, data: str) -> None:
        if self.depth and not self.ignore_depth and data.strip():
            self.parts.append(data.strip())


def extract_detail_text(html_text: str, selector: str | None, limit: int = 50_000) -> str:
    """Extract a validated detail-body selector chosen by source analyzer agent 2."""
    if not selector:
        return ""
    parser = _SelectedContainerTextParser(selector)
    parser.feed(html_text)
    value = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
    value = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[이메일]", value)
    value = re.sub(r"(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)", "[전화번호]", value)
    return value[:limit]


class _PublicLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.current_href = ""
        self.current_parts: list[str] = []
        self.links: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a" or self.current_href:
            return
        values = {str(key).lower(): str(value or "") for key, value in attrs}
        self.current_href = values.get("href", "").strip()
        self.current_parts = []

    def handle_data(self, data: str) -> None:
        if self.current_href and data.strip():
            self.current_parts.append(data.strip())

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self.current_href:
            self.links.append((self.current_href, " ".join(self.current_parts)))
            self.current_href = ""
            self.current_parts = []


def extract_same_origin_links(html_text: str, base_url: str, include_path: str = "") -> list[dict[str, str]]:
    """Return unique same-origin detail links from a validated list page."""
    parser = _PublicLinkParser()
    parser.feed(html_text)
    origin = urllib.parse.urlsplit(base_url)
    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for href, title in parser.links:
        try:
            url = urllib.parse.urljoin(base_url, html.unescape(href))
            parsed = urllib.parse.urlsplit(url)
        except ValueError:
            continue
        if parsed.scheme not in {"http", "https"} or parsed.netloc.lower() != origin.netloc.lower():
            continue
        clean = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
        scope = "/" + include_path.strip("/") if include_path else ""
        in_scope = not scope or parsed.path == scope or parsed.path.startswith(scope + "/")
        if clean == base_url or not in_scope or clean in seen:
            continue
        seen.add(clean)
        result.append({"url": clean, "title": re.sub(r"\s+", " ", title).strip()})
    return result


_CASE_SIGNAL = re.compile(r"(?:투자\s*)?주의|사칭|사기|피해|먹튀", re.I)
_GENERIC_CASE_NAME = re.compile(
    r"^(?:게임계정|고수익알바|불법hts|투자사이트|가상프로젝트C|정부지원금부정수급|피부관리샵|"
    r"보이스피싱|리딩방|금융|투자|주식|코인|거래소|해외선물|가상화폐|(?:가상화폐)?(?:도지)?코인|알바|티켓|출금|은행계좌)$",
    re.I,
)
_GENERIC_CASE_LABEL = re.compile(
    r"(?:법무법인|법률사무소|변호사(?:사무실)?|법률상담|피해자?\s*센터|"
    r"투자사기\s*(?:대응|전문|전담)|금융사기\s*(?:대응|전문|전담))",
    re.I,
)
_COMPACT_TLDS = ("com", "net", "org", "xyz", "vip", "top", "shop", "site", "kr", "io")


def case_name_from_page_title(page_title: str) -> str:
    """Extract a conservative incident name from a public detail-page title."""
    value = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", html.unescape(page_title or ""))).strip()
    if not value:
        return ""
    value = re.split(r"\s*(?:\||—|–)\s*", value, maxsplit=1)[0].strip()
    signal = _CASE_SIGNAL.search(value)
    if not signal or signal.start() < 2:
        return ""
    candidate = value[:signal.start()].strip(" \t\r\n-_,:;()·")
    candidate = re.sub(r"\s+", " ", candidate)
    candidate = re.sub(r"(?:\s+텔레그램)?\s+리딩방$", "", candidate, flags=re.I).strip()
    candidate = re.sub(r"계좌$", "", candidate).strip()
    normalized = re.sub(r"[^0-9a-z가-힣]", "", candidate.lower())
    if (len(normalized) < 3 or len(normalized) > 60 or _GENERIC_CASE_NAME.fullmatch(normalized)
            or _GENERIC_CASE_LABEL.search(candidate)):
        return ""
    if not re.search(r"[a-z가-힣]", normalized) or len(candidate.split()) > 6:
        return ""
    if re.fullmatch(r"[a-z0-9-]{7,}", candidate, re.I) and "." not in candidate:
        lowered = candidate.lower()
        for tld in _COMPACT_TLDS:
            if lowered.endswith(tld) and len(candidate) - len(tld) >= 4:
                candidate = f"{candidate[:-len(tld)]}.{candidate[-len(tld):]}"
                break
    return candidate


def case_name_from_keyword_slug(value: str) -> str:
    """Normalize keyword-only sitemap slugs without inventing body facts."""
    candidate = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", html.unescape(value or ""))).strip()
    candidate = re.sub(r"\s*(?:사칭(?:\s*사기)?|사기)$", "", candidate, flags=re.I).strip()
    lowered = candidate.lower()
    if re.fullmatch(r"[a-z0-9-]{7,}", candidate, re.I) and "." not in candidate:
        for tld in _COMPACT_TLDS:
            if lowered.endswith(tld) and len(candidate) - len(tld) >= 4:
                candidate = f"{candidate[:-len(tld)]}.{candidate[-len(tld):]}"
                break
    normalized = re.sub(r"[^0-9a-z가-힣]", "", candidate.lower())
    if len(normalized) < 3 or _GENERIC_CASE_NAME.fullmatch(normalized):
        return ""
    return candidate


def select_new_entries(
    entries: list[dict[str, str]],
    seen_urls: set[str],
    *,
    include_path: str = "",
    limit: int = 500,
) -> list[dict[str, str]]:
    """Filter, newest-first sort, and cap unseen sitemap entries."""
    filtered = []
    for entry in entries:
        loc = entry.get("loc", "")
        if not loc or loc in seen_urls:
            continue
        if include_path and not urllib.parse.urlsplit(loc).path.startswith(include_path):
            continue
        filtered.append(entry)
    # ISO-8601 lastmod values sort correctly as strings. Python's stable sort
    # preserves sitemap order when a publisher stamps a whole batch equally.
    filtered.sort(key=lambda item: item.get("lastmod", ""), reverse=True)
    return filtered[:limit]
