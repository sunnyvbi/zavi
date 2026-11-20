"""
Praxis voice sidecar — PII redactor (Python port of Node services/redactor).

Per plan §"P1 — PII redactor (release blocker)" + §"Python sidecar logging
discipline":

    The sidecar's stdout/stderr + Docker json log driver WILL capture raw
    STT transcripts + LLM outputs unless explicitly suppressed — that's
    a new PII surface OUTSIDE the Node redactor.

This module is the Python side of the parity pair. Patterns mirror
`apps/backend/src/services/tools/operator-db/discovery/redact.ts` +
`apps/backend/src/services/redactor/index.ts`. The marker convention
(`‹redacted:<class>›`) is identical so logs from either side look the same.

Use cases:
    1. Before every log emit — pass `msg` through redact_log_string().
    2. Before any callback body to Node — pass voice transcript text
       through redact_voice_transcript_full(). (Node ALSO redacts at
       insert time — belt-and-suspenders.)

Parity test fixture: `tests/redactor-fixtures.json` (Slice 4 follow-up;
shared with the Node side. Both sides MUST produce byte-identical output
on every fixture row.)
"""

from __future__ import annotations

import re
from typing import Final

EMAIL: Final = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SSN: Final = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
CARD: Final = re.compile(r"\b(?:\d[ -]?){13,16}\b")
JWT: Final = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
APIKEY: Final = re.compile(r"\bsk-[A-Za-z0-9-]{10,}\b")
PHONE: Final = re.compile(r"(?:\+?\d[\d ().-]{8,}\d)")

DOB_NUMERIC: Final = re.compile(
    r"\b(?:(?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])[/\-](?:19|20)\d{2}"
    r"|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b"
)
DOB_VERBAL: Final = re.compile(
    r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December|"
    r"Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+"
    r"(?:(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?)\s*,?\s+(?:19|20)\d{2}\b",
    re.IGNORECASE,
)
STREET_ADDRESS: Final = re.compile(
    r"\b\d{1,6}\s+(?:[A-Z][a-z]+\.?\s+){1,4}"
    r"(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|"
    r"Lane|Ln\.?|Way|Court|Ct\.?|Place|Pl\.?|Terrace|Ter\.?|Plaza|Sq|Square|"
    r"Circle|Cir\.?|Highway|Hwy\.?|Parkway|Pkwy\.?|Loop|Trail|Tr\.?)\b"
)

def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)

def _phone_repl(m: re.Match[str]) -> str:
    return "‹redacted:phone›" if len(_digits(m.group())) >= 10 else m.group()

def redact_standard(text: str) -> str:
    """Apply email/SSN/card/JWT/api-key/phone redaction. Mirrors Node
    `redactValue("voice_transcript", text)` for a string value."""
    if not text:
        return text
    out = EMAIL.sub("‹redacted:email›", text)
    out = SSN.sub("‹redacted:ssn›", out)
    out = CARD.sub("‹redacted:card›", out)
    out = JWT.sub("‹redacted:secret›", out)
    out = APIKEY.sub("‹redacted:secret›", out)
    out = PHONE.sub(_phone_repl, out)
    return out

def redact_voice_only(text: str) -> str:
    """Apply DOB + street-address patterns only. Mirrors Node
    `redactVoiceTranscript()`."""
    if not text:
        return text
    out = DOB_NUMERIC.sub("‹redacted:dob›", text)
    out = DOB_VERBAL.sub("‹redacted:dob›", out)
    out = STREET_ADDRESS.sub("‹redacted:address›", out)
    return out

def redact_voice_transcript_full(text: str) -> str:
    """Full chain for a voice transcript — standard PII THEN voice-specific.
    Mirrors Node `redactVoiceTranscriptFull()`. Result is persistence-safe."""
    if not text:
        return text
    return redact_voice_only(redact_standard(text))

import hashlib  # noqa: E402  (import deferred — only needed by log path)

def redact_log_string(value: object) -> object:
    """Redact a single log-field value. Strings get standard PII + voice
    redaction inline. Non-string values pass through.

    Special-case for transcript-shaped fields: callers pass a string
    prefixed with `__TRANSCRIPT__` to replace the entire content with
    a length+sha marker (debugging needs the count + identity-without-content,
    not the words)."""
    if not isinstance(value, str):
        return value
    if value.startswith("__TRANSCRIPT__"):
        body = value[len("__TRANSCRIPT__") :]
        sha = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
        return f"‹transcript-redacted len={len(body)} hash={sha}›"
    return redact_voice_transcript_full(value)
