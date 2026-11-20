from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import BaseModel

REDACTED = "[redacted]"

SECRET_VALUE_PATTERNS = (
    ("stripe_secret_key", re.compile(r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b")),
    ("aws_access_key_id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}|ghs_[0-9]+_eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]{20,}")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
)

PII_VALUE_PATTERNS = (
    (
        "email",
        re.compile(
            r"\b[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}\b"
        ),
    ),
    ("phone", re.compile(r"(?:\+\d(?:[\s.-]?\d){6,14}\b)|(?:(?:\(\d{3}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b)")),
)

CREDENTIAL_PARAM_NAME = re.compile(
    r"^(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|auth|token|secret|client[_-]?secret|password|passwd|pwd|bearer|session[_-]?token|sig|signature)$",
    re.IGNORECASE,
)

URLISH_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)

def _apply(patterns: tuple[tuple[str, re.Pattern[str]], ...], text: str) -> tuple[str, list[str]]:
    redactions: list[str] = []
    for name, pattern in patterns:
        text, n = pattern.subn(REDACTED, text)
        redactions.extend([name] * n)
    return text, redactions

def scrub_text(text: str) -> tuple[str, list[str]]:
    return _apply(SECRET_VALUE_PATTERNS, text)

def scrub_url(raw: str) -> tuple[str, list[str]]:
    parts = urlsplit(raw)
    if not parts.scheme or not parts.netloc:
        return scrub_text(raw)
    redactions: list[str] = []
    query_changed = False
    rebuilt: list[tuple[str, str]] = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if CREDENTIAL_PARAM_NAME.match(key):
            rebuilt.append((key, REDACTED))
            redactions.append(f"param:{key}")
            query_changed = True
            continue
        value, secret_hits = scrub_text(value)
        value, pii_hits = _apply(PII_VALUE_PATTERNS, value)
        hits = secret_hits + pii_hits
        if hits:
            redactions.extend(f"param:{key}:{h}" for h in hits)
            query_changed = True
        rebuilt.append((key, value))
    query = urlencode(rebuilt) if query_changed else parts.query
    path, path_hits = scrub_text(parts.path)
    redactions.extend(f"path:{h}" for h in path_hits)
    fragment, fragment_hits = scrub_text(parts.fragment)
    redactions.extend(f"fragment:{h}" for h in fragment_hits)
    if not redactions:
        return raw, []
    return urlunsplit((parts.scheme, parts.netloc, path, query, fragment)), redactions

def scrub_args(value: Any, max_depth: int = 8) -> tuple[Any, list[str]]:
    redactions: list[str] = []

    def walk(v: Any, depth: int) -> Any:
        if depth > max_depth:
            return v
        if isinstance(v, str):
            out, hits = scrub_url(v) if URLISH_RE.match(v) else scrub_text(v)
            redactions.extend(hits)
            return out
        if isinstance(v, BaseModel):
            updates: dict[str, Any] = {}
            for name in type(v).model_fields:
                before = len(redactions)
                out = walk(getattr(v, name), depth + 1)
                if len(redactions) > before:
                    updates[name] = out
            return v.model_copy(update=updates) if updates else v
        if isinstance(v, list):
            return [walk(item, depth + 1) for item in v]
        if isinstance(v, dict):
            return {k: walk(item, depth + 1) for k, item in v.items()}
        return v

    return walk(value, 0), redactions
