"""Small, file-backed source health recorder for the collection agents.

The file is a JSON object keyed by source id.  A source record has cumulative
``successes`` and ``failures`` counters, plus the latest run's ``new_items``
and ``latency_ms`` and the timestamp of its most recent successful run::

    {
      "example-sitemap": {
        "successes": 3,
        "failures": 1,
        "new_items": 7,
        "latency_ms": 842.5,
        "last_success": "2026-08-10T00:00:00+00:00"
      }
    }

Updates use a same-directory temporary file followed by ``os.replace`` so a
reader sees either the old complete document or the new complete document.
An advisory lock also protects the read/modify/replace sequence when two
collector processes update different sources at the same time.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from numbers import Real

try:
    import fcntl
except ImportError:  # pragma: no cover - the supported collector hosts are Unix.
    fcntl = None


def _target_path(path) -> str:
    return os.path.abspath(os.fspath(path))


def _read_json(path: str) -> dict[str, object]:
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)
    if not isinstance(document, dict):
        raise ValueError("source health document must be a JSON object")
    return document


def read_source_health(path) -> dict[str, object]:
    """Read a health document, returning an empty object when it is absent."""
    return _read_json(_target_path(path))


load_source_health = read_source_health


@contextmanager
def _exclusive_update_lock(path: str) -> Iterator[None]:
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    lock_path = f"{path}.lock"
    with open(lock_path, "a+", encoding="utf-8") as lock:
        if fcntl is not None:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _atomic_write(path: str, document: Mapping[str, object]) -> None:
    directory = os.path.dirname(path)
    basename = os.path.basename(path) or "source-health.json"
    fd, temporary = tempfile.mkstemp(prefix=f".{basename}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _counter(metrics: Mapping[str, object], *names: str) -> int:
    for name in names:
        if name in metrics:
            value = metrics[name]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"health metric {name!r} must be a non-negative integer")
            return value
    return 0


def _timestamp(value: datetime | str | None) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise ValueError("recorded_at must be a non-empty ISO timestamp or datetime")


def _validate_inputs(source_id: str, success: bool, new_items: int, latency_ms: Real) -> None:
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("source_id must be a non-empty string")
    if not isinstance(success, bool):
        raise TypeError("success must be a bool")
    if isinstance(new_items, bool) or not isinstance(new_items, int) or new_items < 0:
        raise ValueError("new_items must be a non-negative integer")
    if isinstance(latency_ms, bool) or not isinstance(latency_ms, Real):
        raise ValueError("latency_ms must be a non-negative number")
    if not math.isfinite(float(latency_ms)) or latency_ms < 0:
        raise ValueError("latency_ms must be a non-negative number")


def record_source_health(
    path,
    source_id: str,
    *,
    success: bool,
    new_items: int = 0,
    latency_ms: Real = 0,
    recorded_at: datetime | str | None = None,
    now: datetime | str | None = None,
) -> dict[str, object]:
    """Atomically record one source run and return its updated metrics.

    ``successes`` and ``failures`` are cumulative counters.  ``new_items`` and
    ``latency_ms`` describe the latest run.  A failed run never overwrites
    ``last_success``.  ``now`` is accepted as a convenience alias for
    ``recorded_at`` in deterministic tests and small integrations.
    """
    if recorded_at is not None and now is not None:
        raise ValueError("use either recorded_at or now, not both")
    _validate_inputs(source_id, success, new_items, latency_ms)
    timestamp = _timestamp(recorded_at if recorded_at is not None else now)
    target = _target_path(path)

    with _exclusive_update_lock(target):
        document = _read_json(target)
        existing = document.get(source_id, {})
        if not isinstance(existing, dict):
            raise ValueError(f"health record for {source_id!r} must be a JSON object")

        metrics = dict(existing)
        metrics["successes"] = _counter(existing, "successes", "success_count") + (1 if success else 0)
        metrics["failures"] = _counter(existing, "failures", "failure_count") + (0 if success else 1)
        metrics["new_items"] = new_items
        metrics["latency_ms"] = float(latency_ms)
        if success:
            metrics["last_success"] = timestamp
        else:
            metrics["last_success"] = existing.get("last_success", existing.get("last_success_at"))
        document[source_id] = metrics
        _atomic_write(target, document)
        return dict(metrics)


record_health = record_source_health
update_source_health = record_source_health
