
import { scrubSecretsFromText } from "@/services/mcp/egress-secret-scrub";

const REDACTED = "[redacted]";

const DOC_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
];

const CRED_SEGMENT = /(?:^|[_. -])(?:api[_ -]?key|secret|token|password|passwd|pwd|client[_ -]?secret|private[_ -]?key|access[_ -]?key|[a-z0-9]+[_ -]key)$/i;
const CRED_CAMEL = /[a-z0-9](?:Key|Secret|Token|Password|Pwd)$/;
const AUTH_HEADER_NAME = /^(?:proxy-)?authorization$/i;
export function isCredentialKey(k: string): boolean {
  const key = k.trim();
  return (
    key.toLowerCase() !== "key" &&
    (CRED_SEGMENT.test(key) || CRED_CAMEL.test(key) || AUTH_HEADER_NAME.test(key) || /^(?:password|passwd|pwd|secret|token)$/i.test(key))
  );
}

const AUTH_PARAM =
  /(["']?)\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?!\[redacted\])((?:digest|oauth|aws4-hmac-sha256|hmac|negotiate|ntlm)\s[^\n]*)/gi;
const AUTH_HEADER =
  /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?!\[redacted\])(?:(basic|bearer|token)\s+([\w.~+/=-]+)|((?:[A-Za-z][\w-]*\s+)?[^\s"'<>,;]{16,}))/gi;

function credentialShaped(scheme: string, token: string): boolean {
  if (scheme.toLowerCase() !== "basic") return /^[\w.~+/=-]{16,}$/.test(token);
  return /^[A-Za-z0-9+/=]{8,}$/.test(token) && (/[0-9+/=]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1))));
}

function splitParamValue(value: string, quote: string): [string, string] {
  if (!quote) return [value, ""];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === quote && value[i - 1] !== "\\") return [value.slice(0, i), value.slice(i)];
  }
  return [value, ""];
}

const CREDENTIAL_LINE =
  /^(\s*(?:export\s+)?((?:[A-Za-z0-9]+[_.-])*[A-Za-z0-9]+)\s*[:=]\s*)(\S[^\n]*?)(\s*)$/gm;

function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

const isEmpty = (v: unknown) =>
  v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && Object.keys(v).length === 0);

function scrubJson(text: string): { text: string; count: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (isCredentialKey(k) && !isEmpty(val) && val !== REDACTED) {
          out[k] = REDACTED;
          count += 1;
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  };
  return { text: JSON.stringify(walk(parsed), null, 2), count };
}

export function parseCsv(text: string, delimiter = ","): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (quoted) return null;
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csvCell = (c: string) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

function scrubCsv(text: string): { text: string; count: number } | null {
  const rows = parseCsv(text);
  if (!rows || rows.length < 2 || rows[0].length < 2) return null;
  const cols = rows[0].map((h, i) => (isCredentialKey(h) ? i : -1)).filter((i) => i >= 0);
  if (cols.length === 0) return { text, count: 0 };
  let count = 0;
  const out = rows.map((r, ri) =>
    ri === 0 ? r : r.map((c, ci) => (cols.includes(ci) && c.trim() && c !== REDACTED ? ((count += 1), REDACTED) : c)),
  );
  return { text: out.map((r) => r.map(csvCell).join(",")).join("\n"), count };
}

export function scrubDocumentText(input: string, kind: "text" | "json" | "csv" = "text"): { text: string; count: number } {
  let count = 0;
  let text = input.replace(/^\uFEFF/, "");
  const structured = kind === "json" ? scrubJson(text) : kind === "csv" ? scrubCsv(text) : null;
  if (structured) {
    text = structured.text;
    count += structured.count;
  }
  text = decodePercent(text);
  for (const re of DOC_PATTERNS) {
    text = text.replace(re, () => {
      count += 1;
      return REDACTED;
    });
  }
  text = text.replace(AUTH_PARAM, (_m: string, lead: string, head: string, value: string) => {
    const quote = lead || (/["']$/.test(head) ? head.slice(-1) : "");
    const [, rest] = splitParamValue(value, quote);
    count += 1;
    return `${lead}${head}${REDACTED}${rest}`;
  });
  text = text.replace(AUTH_HEADER, (m: string, head: string, scheme?: string, token?: string) => {
    if (scheme && token && !credentialShaped(scheme, token)) return m;
    count += 1;
    return `${head}${REDACTED}`;
  });
  const egress = scrubSecretsFromText(text);
  text = egress.scrubbed;
  count += egress.redactions.length;
  text = text.replace(CREDENTIAL_LINE, (m: string, head: string, name: string, value: string, tail: string) => {
    if (!isCredentialKey(name) || AUTH_HEADER_NAME.test(name) || value === REDACTED || value === `"${REDACTED}"`) return m;
    count += 1;
    return `${head}${REDACTED}${tail}`;
  });
  text = text.replace(/("([A-Za-z0-9_.-]{1,64})"\s*:\s*")((?:[^"\\]|\\.){1,500})(")/g, (m, head: string, key: string, value: string, tail: string) => {
    if (!isCredentialKey(key) || value === REDACTED) return m;
    count += 1;
    return `${head}${REDACTED}${tail}`;
  });
  return { text, count };
}
