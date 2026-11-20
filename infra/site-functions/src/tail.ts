
import { redactSecrets, signLogBatch } from "./shared";

export interface TailEnv {
  FN_LOG_INGEST_URL?: string;
  FN_LOG_SECRET?: string;
}

export interface TraceItemLike {
  scriptName?: string | null;
  outcome?: string;
  eventTimestamp?: number | null;
  event?: { request?: { url?: string; method?: string }; response?: { status?: number } } | null;
  logs?: Array<{ level?: string; message?: unknown; timestamp?: number }>;
  exceptions?: Array<{ name?: string; message?: string; timestamp?: number }>;
}

export interface LogEntry {
  script: string;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  outcome: string;
  path: string | null;
  status: number | null;
}

export const MAX_LOGS = 50;
export const MAX_LINE = 2000;
export const MAX_BATCH = 500;
const SCRIPT_RE = /^zf[nt]-[0-9a-f]{32}(-[0-9]{1,12})?$/;

function stringify(m: unknown): string {
  if (typeof m === "string") return m;
  try {
    return JSON.stringify(m);
  } catch {
    return String(m);
  }
}

function level(l: string | undefined): LogEntry["level"] {
  return l === "error" ? "error" : l === "warn" ? "warn" : l === "debug" ? "debug" : "info";
}

export function toEntries(events: readonly TraceItemLike[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const ev of events) {
    const script = ev.scriptName ?? "";
    if (!SCRIPT_RE.test(script)) continue;
    let path: string | null = null;
    try {
      path = ev.event?.request?.url ? new URL(ev.event.request.url).pathname.slice(0, 200) : null;
    } catch {
      path = null;
    }
    const base = { script, outcome: String(ev.outcome ?? "unknown").slice(0, 32), path, status: ev.event?.response?.status ?? null };
    const line = (s: string) => redactSecrets(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")).slice(0, MAX_LINE);
    for (const l of (ev.logs ?? []).slice(0, MAX_LOGS)) {
      const msg = Array.isArray(l.message) ? l.message.map(stringify).join(" ") : stringify(l.message);
      out.push({ ...base, ts: l.timestamp ?? ev.eventTimestamp ?? Date.now(), level: level(l.level), message: line(msg) });
    }
    for (const x of (ev.exceptions ?? []).slice(0, 10)) {
      out.push({ ...base, ts: x.timestamp ?? ev.eventTimestamp ?? Date.now(), level: "error", message: line(`${x.name ?? "Error"}: ${x.message ?? ""}`) });
    }
    if (!ev.logs?.length && !ev.exceptions?.length && base.outcome !== "ok") {
      out.push({ ...base, ts: ev.eventTimestamp ?? Date.now(), level: "error", message: `invocation ended: ${base.outcome}` });
    }
    if (out.length >= MAX_BATCH) break;
  }
  return out.slice(0, MAX_BATCH);
}

export async function handleTail(events: readonly TraceItemLike[], env: TailEnv, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<void> {
  if (!env.FN_LOG_INGEST_URL || !env.FN_LOG_SECRET) return;
  const entries = toEntries(events);
  if (!entries.length) return;
  const body = new TextEncoder().encode(JSON.stringify({ v: 1, entries }));
  try {
    await fetchFn(env.FN_LOG_INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await signLogBatch(env.FN_LOG_SECRET, body, now())) },
      body,
    });
  } catch {
  }
}

export default {
  async tail(events: TraceItemLike[], env: TailEnv): Promise<void> {
    await handleTail(events, env);
  },
};
