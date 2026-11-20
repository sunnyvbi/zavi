from __future__ import annotations

import re
from collections.abc import Collection
from dataclasses import dataclass
from typing import Any, Literal

Cap = Literal["yes", "no", "unknown"]

WRITE_VERB_RE = re.compile(
    r"(^|[_-])(create|update|delete|remove|insert|add|set|send|post|put|patch|write|edit|upload|publish|archive|cancel|"
    r"approve|reject|merge|close|move|assign|invite|revoke|disable|enable|trigger|execute|run|start|stop|pay|charge|"
    r"refund|transfer|mutation|mutate)([_-]|$)",
    re.IGNORECASE,
)
FETCH_VERB_RE = re.compile(
    r"(^|[_-])(fetch|http|https|request|browse|browser|scrape|scraper|crawl|crawler|download|curl|url|uri|web|www|rag|"
    r"proxy|retrieve|readpage|read_url|read_page|apicall|api_call)([_-]|$)|(^|[_-])(get|read|search|lookup|query)([_-]|$)",
    re.IGNORECASE,
)

@dataclass(frozen=True)
class RemoteCapability:
    write: Cap
    egress: Cap

def is_dynamic_vendor(server_id: str) -> bool:
    return server_id.startswith("pipedream_") or server_id == "composio"

def looks_like_write(tool_name: str) -> bool:
    return WRITE_VERB_RE.search(tool_name) is not None

def looks_like_fetch(tool_name: str) -> bool:
    return FETCH_VERB_RE.search(tool_name) is not None

def _hint(annotations: dict[str, Any] | None, key: str) -> bool | None:
    value = (annotations or {}).get(key)
    return value if isinstance(value, bool) else None

def classify_remote(
    server_id: str,
    tool_name: str,
    annotations: dict[str, Any] | None = None,
    *,
    internal_servers: Collection[str] = (),
) -> RemoteCapability:
    if server_id in internal_servers:
        raise ValueError(f"{server_id} is an internal server; classify it with a ToolDef, not heuristics")
    dynamic = is_dynamic_vendor(server_id)
    read_only_hint = _hint(annotations, "readOnlyHint")
    open_world_hint = _hint(annotations, "openWorldHint")
    if looks_like_write(tool_name) or _hint(annotations, "destructiveHint") is True:
        write: Cap = "yes"
    elif dynamic:
        write = "unknown"
    elif read_only_hint is True:
        write = "no"
    elif read_only_hint is False:
        write = "yes"
    else:
        write = "unknown"
    if open_world_hint is True or dynamic:
        egress: Cap = "yes"
    elif open_world_hint is False:
        egress = "no"
    else:
        egress = "unknown"
    return RemoteCapability(write=write, egress=egress)

def is_remote_egress(server_id: str, tool_name: str, annotations: dict[str, Any] | None = None) -> bool:
    cap = classify_remote(server_id, tool_name, annotations)
    if cap.egress != "unknown":
        return cap.egress == "yes"
    return looks_like_fetch(tool_name)

def remote_tool_allowed(server_id: str, tool_name: str, annotations: dict[str, Any] | None = None) -> bool:
    if _hint(annotations, "readOnlyHint") is not True:
        return False
    return classify_remote(server_id, tool_name, annotations).write != "yes"
