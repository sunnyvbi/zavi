
import { verifyLogBatch } from "./signing";
import type { SiteFunctionsStore } from "./store";

export const MAX_ENTRIES = 500;
const SCRIPT_RE = /^zf[nt]-[0-9a-f]{32}(-[0-9]{1,12})?$/;

export interface LogEntryIn {
  script: string;
  ts: number;
  level: string;
  message: string;
  outcome?: string | null;
  path?: string | null;
  status?: number | null;
}

export type IngestResult = { status: number; body: Record<string, unknown> };

function isEntry(v: unknown): v is LogEntryIn {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.script === "string" && SCRIPT_RE.test(e.script) && typeof e.ts === "number" && Number.isFinite(e.ts) && typeof e.message === "string";
}

export function redactValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    if (v.length > 0 && out.includes(v)) out = out.split(v).join("[redacted]");
  }
  return out;
}

export async function ingestLogBatch(
  deps: { store: SiteFunctionsStore; secret: string | undefined; now?: () => number },
  header: (n: string) => string | undefined,
  raw: Buffer,
): Promise<IngestResult> {
  if (!deps.secret) return { status: 503, body: { error: "logs_unconfigured" } };
  if (!verifyLogBatch(deps.secret, header, raw, (deps.now ?? Date.now)())) return { status: 401, body: { error: "unauthorized" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return { status: 400, body: { error: "invalid_batch" } };
  const ok = entries.slice(0, MAX_ENTRIES).filter(isEntry);
  if (!ok.length) return { status: 200, body: { stored: 0 } };
  const scripts = [...new Set(ok.map((e) => e.script))].slice(0, 200);
  const values = new Map<string, string[]>();
  for (const r of await deps.store.secretsForScripts(scripts)) {
    const l = values.get(r.script) ?? [];
    l.push(r.value);
    values.set(r.script, l);
  }
  const clean = ok
    .filter((e) => scripts.includes(e.script))
    .map((e) => ({
      script: e.script,
      ts: e.ts,
      level: e.level,
      message: redactValues(e.message, values.get(e.script) ?? []).slice(0, 2000),
      outcome: typeof e.outcome === "string" ? e.outcome.slice(0, 32) : null,
      path: typeof e.path === "string" ? redactValues(e.path, values.get(e.script) ?? []).slice(0, 200) : null,
      status: typeof e.status === "number" ? e.status : null,
    }));
  const stored = await deps.store.logsInsert(clean);
  return { status: 200, body: { stored } };
}
