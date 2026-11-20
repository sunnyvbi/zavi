
export class EgressBlockedError extends Error {
  constructor(msg: string) {
    super(`egress_blocked: ${msg}`);
    this.name = "EgressBlockedError";
  }
}

const DEFAULT_STREAMABLE_HOSTS = [
  "backend.composio.dev",
  "mcp.composio.dev",
  "mcp.higgsfield.ai",
  "remote.mcp.pipedream.net",
  "api.pipedream.com",
];
let _warnedLegacyHostsEnv = false;

export function allowedStreamableHosts(): Set<string> {
  const fresh = process.env.STREAMABLE_MCP_HOSTS?.trim();
  const legacy = process.env.COMPOSIO_MCP_HOSTS?.trim();
  if (!fresh && legacy && !_warnedLegacyHostsEnv) {
    _warnedLegacyHostsEnv = true;
    console.warn(
      "[mcp/streamable-guards] COMPOSIO_MCP_HOSTS is deprecated — rename to STREAMABLE_MCP_HOSTS in Secrets Manager + restart.",
    );
  }
  const raw = fresh && fresh.length > 0 ? fresh : legacy;
  const overrides = raw && raw.length > 0
    ? raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
    : [];
  return new Set([...DEFAULT_STREAMABLE_HOSTS, ...overrides]);
}

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(?:Authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b[a-z0-9_]+\.(?:access_token|refresh_token|api_key)\b/gi,
  /\b(?:client_secret|client_id)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{6,}/gi,
];

export function redactSecrets(s: string): string {
  if (!s) return s;
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

export function assertStreamableUrlAllowed(
  url: string,
  allowed: Set<string> = allowedStreamableHosts(),
): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressBlockedError(`unparseable url`);
  }
  if (parsed.protocol !== "https:") {
    throw new EgressBlockedError(`non-https url (${parsed.protocol})`);
  }
  if (!allowed.has(parsed.host.toLowerCase())) {
    throw new EgressBlockedError(`host not allowlisted: ${parsed.host}`);
  }
  return parsed;
}

const SAFE_NAME = /^[A-Za-z0-9_]+$/;
export const MAX_ENCODED_TOOL_NAME = 54;

export function encodeRemoteToolName(raw: string): string {
  if (SAFE_NAME.test(raw)) return raw;
  let out = "";
  for (const ch of raw) {
    if (/[A-Za-z0-9_]/.test(ch)) {
      out += ch;
    } else if (ch === "-") {
      out += "--";
    } else {
      const code = ch.charCodeAt(0);
      out += "-" + code.toString(16).padStart(2, "0");
    }
  }
  return out;
}

export function decodeRemoteToolName(encoded: string): string {
  let out = "";
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== "-") {
      out += encoded[i];
      continue;
    }
    if (encoded[i + 1] === "-") {
      out += "-";
      i += 1;
    } else {
      const hex = encoded.slice(i + 1, i + 3);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    }
  }
  return out;
}
