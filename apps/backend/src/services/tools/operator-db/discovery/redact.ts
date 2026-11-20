
const LONG_DENY =
  /(pass(word|wd)?|secret|token|credential|encrypt|auth.?(key|code)|social.?security|date.?of.?birth|routing|account.?number|tax.?id|api.?key|private.?key|e?mail|phone|mobile|address|street|postal|first.?name|middle.?name|last.?name|full.?name|surname|given.?name|\bname\b|contact|longitude|latitude)/i;

const SHORT_DENY = new Set([
  "ssn",
  "dob",
  "card",
  "cvv",
  "cvc",
  "bank",
  "iban",
  "fax",
  "zip",
  "lat",
  "lng",
  "geo",
  "hash",
  "hashed",
  "salt",
  "jwt",
  "otp",
  "fcm",
  "apns",
  "cookie",
  "cookies",
  "iv",
  "ip",
  "fingerprint",
  "pwd",
  "coordinates",
  "coords",
]);

const ID_DOC = new Set([
  "dl",
  "license",
  "licence",
  "drivinglicense",
  "driverslicense",
  "passport",
  "selfie",
  "mvr",
  "criminal",
]);
const ID_DOC_SAFE = new Set(["plate", "status", "verified"]);

export function columnTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function foldKey(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f\u200b-\u200d\u2060\ufeff]/g, "");
}

function denyColumn(rawName: string, value?: unknown): boolean {
  if (rawName.length > 256) return true;
  const name = foldKey(rawName);
  const tokens = columnTokens(name);
  if (typeof value === "string" && tokens.some((t) => TEXT_ONLY_TOKENS.has(t)) && !tokens.some((t) => TEXT_ONLY_SAFE.has(t))) return true;
  if (typeof value === "string" && /^line[_-]?\d$/i.test(name)) return true;
  if ((typeof value === "number" || typeof value === "boolean") && tokens.some((t) => MEASURE_KEY_TOKENS.has(t))) return false;
  if (LONG_DENY.test(name)) return true;
  if (isSessionKey(tokens)) return true;
  if (tokens.some((t) => SHORT_DENY.has(t))) return true;
  return tokens.some((t) => ID_DOC.has(t)) && !tokens.some((t) => ID_DOC_SAFE.has(t));
}

const TEXT_ONLY_TOKENS = new Set(["document", "documents", "shipping"]);
const TEXT_ONLY_SAFE = new Set(["status", "type", "method", "carrier", "id", "ids", "count"]);

const MEASURE_KEY_TOKENS = new Set([
  "count", "counts", "n", "rate", "total", "sum", "avg", "mean", "median", "pct", "percent",
  "ratio", "share", "min", "max", "type", "status", "brand", "verified",
]);

const RUN_TOGETHER_LIST = ["sessionid", "sessionkey", "sessiontoken", "authid", "authref", "resetcode", "resetid", "csrftoken", "apiid"];
const RUN_TOGETHER = new Set(RUN_TOGETHER_LIST);
const SESSION_TOKENS = new Set([
  "session", "sessions", "sid", "csrf", "xsrf", "nonce",
  ...RUN_TOGETHER_LIST,
]);
const BEARER_PREFIX = new Set([
  "auth", "reset", "api", "access", "refresh", "magic", "invite", "verification", "confirm",
  "confirmation", "login", "bearer", "otp", "push",
]);
const BEARER_SUFFIX = new Set(["id", "ref", "key", "code", "link", "url", "hash", "uuid", "secret", "token"]);

function isSessionKey(tokens: string[]): boolean {
  if (tokens.some((t) => SESSION_TOKENS.has(t)) && (tokens.length === 1 || tokens.some((t) => BEARER_SUFFIX.has(t) || RUN_TOGETHER.has(t)))) return true;
  return tokens.some((t) => BEARER_PREFIX.has(t)) && tokens.some((t) => BEARER_SUFFIX.has(t));
}

const CREDENTIAL_LONG =
  /(pass(word|wd)?|secret|token|credential|encrypt|cipher|auth.?(key|code)|api.?key|private.?key|access.?key|^body$|_body$|blob|html)/i;
const CREDENTIAL_TOKENS = new Set(["hash", "hashed", "salt", "jwt", "otp", "fcm", "apns", "cookie", "cookies", "iv", "pwd"]);

export function isSecretField(rawName: string): boolean {
  if (rawName.length > 256) return true;
  const name = foldKey(rawName);
  if (CREDENTIAL_LONG.test(name)) return true;
  const tokens = columnTokens(name);
  return isSessionKey(tokens) || tokens.some((t) => CREDENTIAL_TOKENS.has(t));
}

const PII_NUMBER_TOKENS = ["phone", "mobile", "card", "account", "ssn", "tax", "routing", "license", "licence", "passport", "dl"];

function idKeyWith(name: string, lastTokens: string[]): boolean {
  const t = columnTokens(name.length > 256 ? "" : foldKey(name));
  if (isSessionKey(t)) return false;
  return lastTokens.includes(t[t.length - 1] ?? "") && !t.some((x) => PII_NUMBER_TOKENS.includes(x));
}

const isNumberedIdKey = (name: string) => idKeyWith(name, ["id", "ids"]);

const AMOUNT_TOKENS = new Set(["amount", "total", "subtotal", "price", "gmv", "revenue", "fee", "fees", "cost", "payout", "refund", "balance", "tax"]);

function isAmountKey(name: string): boolean {
  return columnTokens(name.length > 256 ? "" : foldKey(name)).some((t) => AMOUNT_TOKENS.has(t));
}

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD = /\b(?:\d[ -]?){13,16}\b/g;
const PWHASH = /(?<![A-Za-z0-9$])\$(?:2[abxy]?|argon2(?:id|i|d)|scrypt|pbkdf2)(?=([A-Za-z0-9./+=$,:_-]*))\1/g;
const PHONE = /(?<![\d ().+-])(?=([\d ().+-]+))\1/g;
const SECRET = "‹redacted:secret›";

const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isB64Url = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_-]/.test(c);

function scanMask(s: string, needle: string, scan: (s: string, p: number) => { end: number; ok: boolean }): string {
  let out = "";
  let from = 0;
  let i = 0;
  for (let at = s.indexOf(needle, i); at >= 0; at = s.indexOf(needle, i)) {
    if (isWord(s[at - 1])) {
      i = at + 1;
      continue;
    }
    const { end, ok } = scan(s, at + needle.length);
    if (ok) {
      out += s.slice(from, at) + "‹redacted:secret›";
      from = end;
    }
    i = Math.max(end, at + 1);
  }
  return out + s.slice(from);
}

function scanJwt(s: string, p: number): { end: number; ok: boolean } {
  while (isB64Url(s[p])) p++;
  for (let seg = 0; seg < 2; seg++) {
    if (s[p] !== ".") return { end: p, ok: false };
    const start = ++p;
    while (isB64Url(s[p])) p++;
    if (p === start) return { end: p, ok: false };
  }
  return { end: p, ok: true };
}

function scanSkKey(s: string, p: number): { end: number; ok: boolean } {
  const start = p;
  while (isB64Url(s[p])) p++;
  return { end: p, ok: p - start >= 10 };
}

function scanSecrets(s: string): string {
  return scanMask(scanMask(s, "eyJ", scanJwt), "sk-", scanSkKey);
}

const isEmailLocal = (c: string | undefined) => c !== undefined && /[A-Za-z0-9._%+-]/.test(c);
const isEmailDomain = (c: string | undefined) => c !== undefined && /[A-Za-z0-9.-]/.test(c);

function scanEmails(s: string): string {
  let out = "";
  let from = 0;
  for (let at = s.indexOf("@"); at >= 0; at = s.indexOf("@", at + 1)) {
    let start = at;
    while (start > from && isEmailLocal(s[start - 1])) start--;
    if (start === at) continue;
    let end = at + 1;
    while (isEmailDomain(s[end])) end++;
    let tldEnd = -1;
    for (let i = at + 2; i < end; i++) {
      if (s[i] !== ".") continue;
      let j = i + 1;
      while (j < end && /[A-Za-z]/.test(s[j]!)) j++;
      if (j - i - 1 >= 2) tldEnd = j;
    }
    if (tldEnd < 0) continue;
    out += s.slice(from, start) + "‹redacted:email›";
    from = tldEnd;
    at = tldEnd - 1;
  }
  return out + s.slice(from);
}

function phoneMatch(m: string): string {
  const first = m.search(/\+?\d/);
  if (first < 0) return m;
  let last = m.length - 1;
  while (last > first && !/\d/.test(m[last]!)) last--;
  const core = m.slice(first, last + 1);
  if (digits(core).length < 10) return m;
  return m.slice(0, first) + "‹redacted:phone›" + m.slice(last + 1);
}

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

function fullMatch(v: string, numericOk = false): string | null {
  const t = v.trim();
  if (/^(?=([A-Za-z0-9._%+-]+))\1@(?=([A-Za-z0-9.-]+))\2$/.test(t) && /\.[A-Za-z]{2,}$/.test(t)) return "‹redacted:email›";
  if (/^\d{3}-\d{2}-\d{4}$/.test(t)) return "‹redacted:ssn›";
  if (!numericOk && /^(?:\d[ -]?){13,16}$/.test(t) && digits(t).length >= 13 && digits(t).length <= 16)
    return "‹redacted:card›";
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return "‹redacted:secret›";
  if (/^sk-[A-Za-z0-9-]{10,}$/.test(t)) return "‹redacted:secret›";
  if (!numericOk && /^\+?[\d ().-]{10,}$/.test(t) && digits(t).length >= 10 && digits(t).length <= 15)
    return "‹redacted:phone›";
  return null;
}

export function redactValue(columnName: string, value: unknown): unknown {
  if (denyColumn(columnName, value)) return "‹redacted›";
  if (typeof value !== "string") return value;

  const numericOk = isNumberedIdKey(columnName) || isAmountKey(columnName);
  const whole = fullMatch(value, numericOk);
  if (whole) return whole;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value.trim())) return value;

  let out = scanEmails(value)
    .replace(SSN, "‹redacted:ssn›")
    .replace(CARD, (m) => (numericOk ? m : "‹redacted:card›"));
  out = scanSecrets(out)
    .replace(PWHASH, (m) => (/^\$[^$]*\$.{8,}/s.test(m) ? SECRET : m))
    .replace(PHONE, (m) => (numericOk ? m : phoneMatch(m)));
  return out;
}

export function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = redactValue(k, v);
  return out;
}

export const REDACT_MAX_DEPTH = 12;
export const REDACT_MAX_NODES = 5000;
export const REDACT_MAX_BYTES = 256 * 1024;

type DeepCounters = { nodes: number; bytes: number };

const CAP_MARKER = "‹redacted:capped›";

function approxBytes(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (typeof v === "number" || typeof v === "boolean") return 8;
  return 1;
}

const SAFE_BSON = new Set(["ObjectId", "ObjectID", "Decimal128", "Long", "Int32", "Double", "Timestamp", "MinKey", "MaxKey"]);

function opaqueValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  const bsontype = (value as { _bsontype?: unknown })._bsontype;
  if (typeof bsontype === "string" && SAFE_BSON.has(bsontype)) return value;
  const sub = (value as { sub_type?: unknown }).sub_type;
  if (bsontype === "Binary" && (sub === 3 || sub === 4)) return value;
  return "‹redacted›";
}

const MAX_JSON_STRING = 64 * 1024;

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") || (t.startsWith("[") && t.endsWith("]"));
}

function redactJsonString(s: string, walk: (parsed: unknown) => unknown): string {
  if (s.length > MAX_JSON_STRING) return "‹redacted›";
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return "‹redacted›";
  }
  return JSON.stringify(walk(parsed));
}

function redactNode(
  keyName: string,
  value: unknown,
  depth: number,
  counters: DeepCounters,
): unknown {
  counters.nodes += 1;
  if (counters.nodes > REDACT_MAX_NODES || counters.bytes > REDACT_MAX_BYTES) {
    return CAP_MARKER;
  }

  if (denyColumn(keyName, value)) return typeof value === "boolean" ? value : "‹redacted›";

  if (Array.isArray(value)) {
    if (depth >= REDACT_MAX_DEPTH) return CAP_MARKER;
    const out: unknown[] = [];
    for (const el of value) {
      if (counters.nodes > REDACT_MAX_NODES || counters.bytes > REDACT_MAX_BYTES) {
        out.push(CAP_MARKER);
        break;
      }
      out.push(redactNode(keyName, el, depth + 1, counters));
    }
    return out;
  }

  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    const isPlain = proto === Object.prototype || proto === null;
    if (!isPlain) return opaqueValue(value);
    if (depth >= REDACT_MAX_DEPTH) return CAP_MARKER;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (counters.nodes > REDACT_MAX_NODES || counters.bytes > REDACT_MAX_BYTES) {
        out[k] = CAP_MARKER;
        break;
      }
      out[k] = redactNode(k, v, depth + 1, counters);
    }
    return out;
  }

  if (typeof value === "function" || typeof value === "symbol") return "‹redacted›";
  if (counters.bytes + approxBytes(value) > REDACT_MAX_BYTES) return CAP_MARKER;
  counters.bytes += approxBytes(value);
  if (typeof value === "string" && looksLikeJson(value)) {
    return redactJsonString(value, (parsed) => redactNode("", parsed, depth + 1, counters));
  }
  return redactValue(keyName, value);
}

export function redactDeep(value: unknown): unknown {
  const counters: DeepCounters = { nodes: 0, bytes: 0 };
  return redactNode("", value, 0, counters);
}

export function redactDocDeep(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const counters: DeepCounters = { nodes: 0, bytes: 0 };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (counters.nodes > REDACT_MAX_NODES || counters.bytes > REDACT_MAX_BYTES) {
      out[k] = CAP_MARKER;
      break;
    }
    out[k] = redactNode(k, v, 1, counters);
  }
  return out;
}

export function redactComputed(value: unknown): unknown {
  const counters: DeepCounters = { nodes: 0, bytes: 0 };
  return redactComputedNode("", value, 0, counters, false);
}

const MEASURE_TOKENS = new Set([
  "n", "count", "counts", "sent", "sum", "total", "amount", "revenue", "rate", "avg", "mean",
  "median", "pct", "percent", "ratio", "share", "gmv", "min", "max",
]);

const COMPUTED_ID_DIGITS = 7;

function redactComputedNode(
  keyName: string,
  value: unknown,
  depth: number,
  counters: DeepCounters,
  underDenied: boolean,
): unknown {
  counters.nodes += 1;
  if (counters.nodes > REDACT_MAX_NODES || counters.bytes > REDACT_MAX_BYTES) return CAP_MARKER;
  const denied = underDenied || denyColumn(keyName, value);

  if (Array.isArray(value)) {
    if (depth >= REDACT_MAX_DEPTH) return CAP_MARKER;
    const out: unknown[] = [];
    for (const el of value) {
      if (counters.nodes > REDACT_MAX_NODES || counters.bytes > REDACT_MAX_BYTES) {
        out.push(CAP_MARKER);
        break;
      }
      out.push(redactComputedNode(keyName, el, depth + 1, counters, denied));
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return denied ? "‹redacted›" : opaqueValue(value);
    if (depth >= REDACT_MAX_DEPTH) return CAP_MARKER;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (counters.nodes > REDACT_MAX_NODES || counters.bytes > REDACT_MAX_BYTES) {
        out[k] = CAP_MARKER;
        break;
      }
      out[k] = redactComputedNode(k, v, depth + 1, counters, denied);
    }
    return out;
  }

  if (counters.bytes + approxBytes(value) > REDACT_MAX_BYTES) return CAP_MARKER;
  counters.bytes += approxBytes(value);
  if (typeof value === "number") {
    if (!denied || !Number.isFinite(value)) return value;
    if (columnTokens(keyName).some((t) => MEASURE_TOKENS.has(t))) return value;
    return digits(String(Math.trunc(Math.abs(value)))).length >= COMPUTED_ID_DIGITS ? "‹redacted›" : value;
  }
  if (typeof value === "string" && !denied && looksLikeJson(value)) {
    return redactJsonString(value, (parsed) => redactComputedNode("", parsed, depth + 1, counters, false));
  }
  if (typeof value === "string") return denied ? "‹redacted›" : redactValue("", value);
  if (typeof value === "function" || typeof value === "symbol") return "‹redacted›";
  return value;
}

export function redactStringLeaves(value: unknown): unknown {
  const counters: DeepCounters = { nodes: 0, bytes: 0 };
  const walk = (v: unknown, depth: number): unknown => {
    counters.nodes += 1;
    if (counters.nodes > REDACT_MAX_NODES || counters.bytes > REDACT_MAX_BYTES) return CAP_MARKER;
    if (Array.isArray(v)) return depth >= REDACT_MAX_DEPTH ? CAP_MARKER : v.map((e) => walk(e, depth + 1));
    if (v !== null && typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return opaqueValue(v);
      if (depth >= REDACT_MAX_DEPTH) return CAP_MARKER;
      const out: Record<string, unknown> = {};
      for (const [k, c] of Object.entries(v as Record<string, unknown>)) out[k] = walk(c, depth + 1);
      return out;
    }
    if (typeof v === "function" || typeof v === "symbol") return "‹redacted›";
    if (counters.bytes + approxBytes(v) > REDACT_MAX_BYTES) return CAP_MARKER;
    counters.bytes += approxBytes(v);
    if (typeof v === "string" && looksLikeJson(v)) return redactJsonString(v, (parsed) => redactDeep(parsed));
    return typeof v === "string" ? redactValue("", v) : v;
  };
  return walk(value, 0);
}

export function isSensitiveName(name: string): boolean {
  return isSecretField(name) || denyColumn(name, "");
}

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

export function maskTaintedValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "string") return NUMERIC_STRING.test(value) ? value : "‹redacted›";
  if (depth >= REDACT_MAX_DEPTH) return CAP_MARKER;
  if (Array.isArray(value)) return value.map((v) => maskTaintedValue(v, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskTaintedValue(v, depth + 1);
      return out;
    }
    const bsontype = (value as { _bsontype?: unknown })._bsontype;
    if (typeof bsontype === "string" && SAFE_BSON.has(bsontype)) return value;
  }
  return "‹redacted›";
}
