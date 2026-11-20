"""
Praxis voice sidecar — AWS Secrets Manager loader.

Python port of `apps/backend/scripts/docker-load-secrets.cjs`. Pulls the
same two secrets in the same order:

    1. Common secret (praxis-env-common-prod) — shared keys for the env.
    2. Role secret (praxis-envprod-1) — set via PRAXIS_SECRETS_SECRET_ID;
       wins on conflicts.

Output: a .env file at PRAXIS_VOICE_DOTENV_PATH (default
/app/apps/voice-pipeline/.env) that the sidecar process reads at boot
via python-dotenv (loaded inside sidecar.py).

Required env at startup:
    PRAXIS_SECRETS_SECRET_ID  — name of the role secret in Secrets Manager
    AWS_REGION                — defaults us-west-1
"""

from __future__ import annotations

import json
import os
import sys
from typing import Mapping

import boto3
from botocore.exceptions import BotoCoreError, ClientError

def _shell_escape(v: str) -> str:
    """Escape a value for inclusion in a .env file. Same shape as the
    Node escapeDotenvValue() helper — wrap in double quotes when the
    value contains whitespace, $, or # so dotenv parsers don't mis-split."""
    needs_quote = any(c in v for c in (" ", "\t", "\n", "\r", "#", "$", "'", '"', "`"))
    if not needs_quote:
        return v
    escaped = v.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return f'"{escaped}"'

def _json_to_dotenv(obj: Mapping[str, object]) -> str:
    lines: list[str] = []
    for k, v in obj.items():
        if v is None:
            continue
        if isinstance(v, (dict, list)):
            val = json.dumps(v, separators=(",", ":"))
        else:
            val = str(v)
        lines.append(f"{k}={_shell_escape(val)}")
    return "\n".join(lines) + "\n"

def _fetch_secret(client, secret_id: str) -> Mapping[str, object] | str | None:
    try:
        resp = client.get_secret_value(SecretId=secret_id)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        print(
            f"load-secrets: get_secret_value({secret_id}) failed: {code}",
            file=sys.stderr,
        )
        return None
    except BotoCoreError as e:
        print(f"load-secrets: AWS client error for {secret_id}: {e}", file=sys.stderr)
        return None

    text = resp.get("SecretString")
    if text is None:
        return None
    text = text.strip()
    if text.startswith("{") and text.endswith("}"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text  # treat as plain .env text below
    return text

_COMMON_BY_ENV = {
    "production": "praxis-env-common-prod",
    "staging": "praxis-env-common-staging",
}

def main() -> int:
    out_path = os.environ.get(
        "PRAXIS_VOICE_DOTENV_PATH", "/app/apps/voice-pipeline/.env"
    )
    role_id = os.environ.get("PRAXIS_SECRETS_SECRET_ID")
    if not role_id:
        print("load-secrets: PRAXIS_SECRETS_SECRET_ID not set", file=sys.stderr)
        return 1

    env_name = os.environ.get("NODE_ENV") or os.environ.get(
        "PRAXIS_VOICE_ENV", "production"
    )
    common_id = _COMMON_BY_ENV.get(env_name, _COMMON_BY_ENV["production"])

    region = os.environ.get("AWS_REGION", "us-west-1")
    client = boto3.client("secretsmanager", region_name=region)

    merged: dict[str, object] = {}
    dotenv_text_parts: list[str] = []

    for sid in (common_id, role_id):
        val = _fetch_secret(client, sid)
        if val is None:
            if sid == role_id:
                print(f"load-secrets: required role secret {sid} unavailable", file=sys.stderr)
                return 2
            continue
        if isinstance(val, str):
            dotenv_text_parts.append(val.strip())
        else:
            merged.update(val)  # role overwrites common

    parts: list[str] = []
    if dotenv_text_parts:
        parts.append("\n".join(dotenv_text_parts))
    if merged:
        parts.append(_json_to_dotenv(merged))
    final = "\n".join(parts).rstrip() + "\n"

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(final)
    print(f"load-secrets: wrote {len(final.splitlines())} lines to {out_path}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
