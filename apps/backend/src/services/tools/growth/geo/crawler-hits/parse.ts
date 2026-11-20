
import { gunzipSync } from "node:zlib";
import { classifyUserAgent } from "../bots";

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDS = 250_000;
export const MAX_KEYS = 4_000;
export const MAX_PATH_CHARS = 512;
export const OTHER_PATH = "(other)";

export type LogRecord = {
  ts: number | null;
  userAgent: string | null;
  path: string | null;
  status: number | null;
};

export type ParsedBatch = {
  records: LogRecord[];
  unparsed: number;
  truncated: boolean;
};

export class LogPayloadError extends Error {
  constructor(public code: "too_large" | "bad_gzip" | "empty") {
    super(code);
  }
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (Array.isArray(v)) return str(v[0]);
  return null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

export function parseTimestamp(v: unknown): number | null {
  const n = num(v);
  if (n !== null && typeof v !== "string") {
    if (n > 1e17) return Math.floor(n / 1e6);
    if (n > 1e14) return Math.floor(n / 1e3);
    if (n > 1e11) return Math.floor(n);
    if (n > 1e8) return Math.floor(n * 1000);
    return null;
  }
  const s = str(v);
  if (!s) return null;
  const clf = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2})$/.exec(s);
  if (clf && MONTHS[clf[2]]) {
    const t = Date.parse(`${clf[3]}-${MONTHS[clf[2]]}-${clf[1]}T${clf[4]}:${clf[5]}:${clf[6]}${clf[7]}:${clf[8]}`);
    return Number.isNaN(t) ? null : t;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseTimestamp(Number(s));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function recordFromObject(o: Record<string, unknown>): LogRecord {
  const proxy = obj(o.proxy);
  const request = obj(o.request);
  const http = obj(o.http);
  const response = obj(o.response);
  const headers = obj(request?.headers);
  return {
    userAgent:
      str(o.ClientRequestUserAgent) ??
      str(proxy?.userAgent) ??
      str(o.user_agent) ??
      str(o.userAgent) ??
      str(o.ua) ??
      str(o.http_user_agent) ??
      str(http?.user_agent) ??
      str(headers?.["user-agent"]),
    path:
      str(o.ClientRequestPath) ??
      str(o.ClientRequestURI) ??
      str(proxy?.path) ??
      str(o.path) ??
      str(o.request_uri) ??
      str(o.uri) ??
      str(o.url) ??
      str(request?.path) ??
      str(request?.url),
    status:
      num(o.EdgeResponseStatus) ??
      num(proxy?.statusCode) ??
      num(o.status) ??
      num(o.status_code) ??
      num(o.statusCode) ??
      num(response?.status),
    ts: parseTimestamp(
      o.EdgeStartTimestamp ?? o.timestamp ?? o["@timestamp"] ?? o.time ?? o.ts ?? o.date ?? proxy?.timestamp,
    ),
  };
}

const COMBINED =
  /^\S+ \S+ \S+ \[([^\]]+)\] "(?:[A-Z]+) (\S+)(?: [^"]*)?" (\d{3}) \S+(?: "(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)")?/;

function recordFromLine(line: string): LogRecord | null {
  const t = line.trim();
  if (t === "") return null;
  if (t.startsWith("{")) {
    try {
      const o = obj(JSON.parse(t));
      return o ? recordFromObject(o) : null;
    } catch {
      return null;
    }
  }
  const m = COMBINED.exec(t);
  if (!m) return null;
  return { ts: parseTimestamp(m[1]), path: m[2], status: Number(m[3]), userAgent: m[4] ?? null };
}

export function parseLogBody(body: Buffer): ParsedBatch {
  if (body.length === 0) throw new LogPayloadError("empty");
  if (body.length > MAX_BODY_BYTES) throw new LogPayloadError("too_large");
  let raw = body;
  if (body[0] === 0x1f && body[1] === 0x8b) {
    try {
      raw = gunzipSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (e) {
      const code = (e as { code?: string }).code;
      throw new LogPayloadError(code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "bad_gzip");
    }
  }
  const text = raw.toString("utf8");
  const trimmed = text.trimStart();

  const records: LogRecord[] = [];
  let unparsed = 0;
  let truncated = false;
  const push = (r: LogRecord | null): boolean => {
    if (records.length >= MAX_RECORDS) {
      truncated = true;
      return false;
    }
    if (r) records.push(r);
    else unparsed++;
    return true;
  };

  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const o = obj(item);
          if (!push(o ? recordFromObject(o) : null)) break;
        }
        return { records, unparsed, truncated };
      }
    } catch {
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!push(recordFromLine(line))) break;
  }
  return { records, unparsed, truncated };
}

export type HitRow = {
  day: string;
  bot: string;
  path: string;
  status: number;
  hits: number;
  first_seen_at: string;
  last_seen_at: string;
};

export function normalizePath(raw: string | null): string {
  if (!raw) return "/";
  let p = raw.trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return "/";
    }
  }
  p = p.split(/[?#]/)[0] || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  return p.slice(0, MAX_PATH_CHARS);
}

export function aggregateHits(
  records: readonly LogRecord[],
  now: number,
): { rows: HitRow[]; matched: number; ignored: number; undated: number } {
  const map = new Map<string, HitRow>();
  let matched = 0;
  let ignored = 0;
  let undated = 0;
  for (const r of records) {
    const bot = classifyUserAgent(r.userAgent);
    if (!bot) {
      ignored++;
      continue;
    }
    matched++;
    const ts = r.ts ?? now;
    if (r.ts === null) undated++;
    const at = new Date(ts).toISOString();
    const day = at.slice(0, 10);
    const status = r.status !== null && r.status >= 0 && r.status <= 599 ? Math.trunc(r.status) : 0;
    let path = normalizePath(r.path);
    let key = `${day}|${bot.name}|${path}|${status}`;
    if (!map.has(key) && map.size >= MAX_KEYS) {
      path = OTHER_PATH;
      key = `${day}|${bot.name}|${path}|${status}`;
    }
    const row = map.get(key);
    if (row) {
      row.hits += 1;
      if (at < row.first_seen_at) row.first_seen_at = at;
      if (at > row.last_seen_at) row.last_seen_at = at;
    } else {
      map.set(key, { day, bot: bot.name, path, status, hits: 1, first_seen_at: at, last_seen_at: at });
    }
  }
  return { rows: [...map.values()], matched, ignored, undated };
}
