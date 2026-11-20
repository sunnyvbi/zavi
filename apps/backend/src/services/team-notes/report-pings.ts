
import { logEvent } from "@/services/logging/logEvent";
import { opsRpc } from "@/services/tenant-client";

export const TEAM_REPORT_PING_MAX_ATTEMPTS = 6;
export const TEAM_REPORTS_ADMIN_URL = "https://admin.zaviagent.com/team-notes";
export const PING_CLAIM_BATCH = 50;
export const PING_LEASE_MS = 15 * 60_000;
export const PING_POST_WINDOW_MS = 10 * 60_000;
export const TEAM_REPORT_PING_DUE_EVENT = "team_report_ping.due" as const;
export type TeamReportPingDueEvent = { name: typeof TEAM_REPORT_PING_DUE_EVENT; id: string; data: { ping_id: number } };
export const PING_MAX_BATCHES = 10;
const WEBHOOK_TIMEOUT_MS = 10_000;

export type PingRow = {
  id: number;
  tenant_id: string;
  tenant_slug: string;
  agent_slug: string;
  signal: string;
  send_count: number;
  attempts: number;
  window_start: string;
};

type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Outcome = "sent" | "skipped" | "retry" | "release";

export type PingDeps = {
  webhook: () => string | undefined;
  claim: (limit: number) => PromiseLike<RpcResult<PingRow[]>>;
  finish: (id: number, attempt: number, outcome: Outcome, error: string | null) => PromiseLike<RpcResult<boolean>>;
  post: (url: string, body: { text: string }) => Promise<{ ok: boolean; status: number }>;
  log: typeof logEvent;
  now: () => number;
};

const DEFAULT_DEPS: PingDeps = {
  webhook: () => process.env.ZAVI_TEAM_REPORTS_SLACK_WEBHOOK?.trim() || undefined,
  claim: (limit) => opsRpc("claim_team_report_pings", { p_limit: limit }),
  finish: (id, attempt, outcome, error) =>
    opsRpc("finish_team_report_ping", { p_id: id, p_attempt: attempt, p_outcome: outcome, p_error: error }),
  post: async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  },
  log: logEvent,
  now: () => Date.now(),
};

const clean = (s: string) => String(s ?? "").replace(/[<>&*_`~|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64) || "?";

export function teamReportPingText(r: Pick<PingRow, "tenant_slug" | "agent_slug" | "signal" | "send_count">): string {
  const n = Math.max(1, Math.floor(Number(r.send_count) || 1));
  const what = n === 1 ? "1 report" : `${n} reports`;
  return `Founder sent ${what} to the Zavi team in 10 min. Tenant ${clean(r.tenant_slug)}, agent ${clean(r.agent_slug)}, signal ${clean(r.signal)}. <${TEAM_REPORTS_ADMIN_URL}|Open team notes>`;
}

export async function pingDueAt(id: number): Promise<string | null> {
  const { data, error } = await opsRpc("team_report_ping_due_at", { p_id: id });
  if (error) throw new Error(`team_report_ping_due_at failed: ${error.message}`);
  return typeof data === "string" && data ? data : null;
}

export function emitTeamReportPingDue(pingId: unknown, send: (e: TeamReportPingDueEvent) => Promise<unknown>): void {
  const id = typeof pingId === "number" ? pingId : Number(pingId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  void Promise.resolve()
    .then(() => send({ name: TEAM_REPORT_PING_DUE_EVENT, id: `team-report-ping-${id}`, data: { ping_id: id } }))
    .catch(() => {
    void logEvent({ level: "warn", source: "team-report-pings", code: "team_report_ping.event_send_failed" });
  });
}

export type PingResult = {
  claimed: number; sent: number; skipped: number; retried: number; gave_up: number; fenced: number; batches: number;
  released: number;
};

export type DrainOptions = {
  batchSize?: number;
  maxBatches?: number;
  deadlineMs?: number;
};

const httpStatusOf = (e: string | null) => (e && /^http_\d{3}$/.test(e) ? Number(e.slice(5)) : undefined);

export async function drainTeamReportPings(deps: Partial<PingDeps> = {}, opts: DrainOptions = {}): Promise<PingResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? PING_CLAIM_BATCH, PING_CLAIM_BATCH));
  const maxBatches = Math.max(1, Math.min(opts.maxBatches ?? PING_MAX_BATCHES, PING_MAX_BATCHES));
  const started = d.now();
  const callDeadline = opts.deadlineMs !== undefined ? started + Math.max(0, opts.deadlineMs) : Number.POSITIVE_INFINITY;
  const out: PingResult = { claimed: 0, sent: 0, skipped: 0, retried: 0, gave_up: 0, fenced: 0, batches: 0, released: 0 };
  let url: string | undefined;
  let urlRead = false;
  for (let b = 0; b < maxBatches; b++) {
    if (d.now() >= callDeadline) break;
    const claimedAt = d.now();
    const { data, error } = await d.claim(batchSize);
    if (error) {
      if (b === 0) throw new Error(`claim_team_report_pings failed: ${error.message}`);
      break;
    }
    const rows = data ?? [];
    out.batches += 1;
    out.claimed += rows.length;
    if (rows.length === 0) break;
    if (!urlRead) {
      url = d.webhook();
      urlRead = true;
    }
    const stopAt = Math.min(callDeadline, claimedAt + PING_POST_WINDOW_MS);
    const stopped = await deliverBatch(d, rows, url, out, stopAt);
    if (stopped || rows.length < batchSize) break;
  }
  if (out.skipped > 0) {
    void d.log({ level: "info", source: "team-report-pings", code: "team_report_ping.no_webhook",
      meta: { count: out.skipped } });
  }
  if (out.retried > 0 || out.fenced > 0) {
    void d.log({ level: "warn", source: "team-report-pings", code: "team_report_ping.retry",
      meta: { count: out.retried, batch_errors: out.fenced } });
  }
  return out;
}

async function deliverBatch(
  d: PingDeps, rows: PingRow[], url: string | undefined, out: PingResult, stopAt: number,
): Promise<boolean> {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (url && d.now() >= stopAt) {
      for (const rest of rows.slice(i)) {
        const fin = await d.finish(rest.id, rest.attempts, "release", null);
        if (fin.error || fin.data !== true) out.fenced += 1;
        else out.released += 1;
      }
      return true;
    }
    let outcome: Outcome;
    let errText: string | null = null;
    if (!url) {
      outcome = "skipped";
    } else {
      try {
        const res = await d.post(url, { text: teamReportPingText(r) });
        outcome = res.ok ? "sent" : "retry";
        if (!res.ok) errText = `http_${res.status}`;
      } catch (e) {
        outcome = "retry";
        errText = ((e as Error).name || "error").slice(0, 100);
      }
    }
    const fin = await d.finish(r.id, r.attempts, outcome, errText);
    if (fin.error || fin.data !== true) {
      out.fenced += 1;
      continue;
    }
    if (outcome === "sent") out.sent += 1;
    else if (outcome === "skipped") out.skipped += 1;
    else if (r.attempts >= TEAM_REPORT_PING_MAX_ATTEMPTS) {
      out.gave_up += 1;
      const http = httpStatusOf(errText);
      void d.log({ level: "warn", source: "team-report-pings", code: "team_report_ping.gave_up",
        tenant_id: r.tenant_id,
        meta: { retry_count: r.attempts, ...(errText ? { error_class: errText } : {}), ...(http ? { http_status: http } : {}) } });
    } else out.retried += 1;
  }
  return false;
}
