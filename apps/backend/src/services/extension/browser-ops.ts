
import { logEvent } from "@/services/logging/logEvent";
import {
  asTenantId,
  tenantClient,
  tenantRpc,
} from "@/services/tenant-client";

export const EXTENSION_PANEL_SESSIONS_TABLE = "extension_panel_sessions";
export const EXTENSION_BROWSER_OPS_TABLE = "extension_browser_ops";

export const SESSION_LIVE_MS = 30_000;
const TOUCH_EVERY_MS = 5_000;

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const iso = (ms: number) => new Date(ms).toISOString();

type SessionRow = {
  id: string;
  tab_id: number;
  last_seen_at: string;
  ended_at: string | null;
};

function isLive(row: SessionRow | null, nowMs: number): boolean {
  if (!row || row.ended_at !== null) return false;
  const seen = Date.parse(row.last_seen_at);
  return Number.isFinite(seen) && nowMs - seen < SESSION_LIVE_MS;
}

async function readOwnedSession(
  session_id: string,
  tenant_id: string,
  user_id: string,
): Promise<SessionRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_PANEL_SESSIONS_TABLE)
    .select("id, tab_id, last_seen_at, ended_at")
    .eq("id", session_id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SessionRow | null) ?? null;
}

export async function createPanelSession(
  tenant_id: string,
  user_id: string,
  tab_id: number,
): Promise<string> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_PANEL_SESSIONS_TABLE)
    .insert({ user_id, tab_id })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "session insert returned no row");
  return (data as { id: string }).id;
}

export async function touchPanelSession(
  session_id: string,
  tenant_id: string,
  user_id: string,
  clock: Clock = realClock,
): Promise<boolean> {
  const now = clock.now();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_PANEL_SESSIONS_TABLE)
    .update({ last_seen_at: iso(now) })
    .eq("id", session_id)
    .eq("user_id", user_id)
    .is("ended_at", null)
    .gt("last_seen_at", iso(now - SESSION_LIVE_MS))
    .select("id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

export async function endPanelSession(
  session_id: string,
  tenant_id: string,
  user_id: string,
  clock: Clock = realClock,
): Promise<boolean> {
  const row = await readOwnedSession(session_id, tenant_id, user_id);
  if (!row) return false;
  if (row.ended_at !== null) return true;
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_PANEL_SESSIONS_TABLE)
    .update({ ended_at: iso(clock.now()) })
    .eq("id", session_id)
    .eq("user_id", user_id)
    .is("ended_at", null);
  if (error) throw new Error(error.message);
  return true;
}

export async function isSessionLive(
  session_id: string,
  tenant_id: string,
  user_id: string,
  clock: Clock = realClock,
): Promise<boolean> {
  return isLive(await readOwnedSession(session_id, tenant_id, user_id), clock.now());
}

export async function panelSessionState(
  session_id: string,
  tenant_id: string,
  user_id: string,
  clock: Clock = realClock,
): Promise<"live" | "ended" | "stale" | "missing"> {
  const row = await readOwnedSession(session_id, tenant_id, user_id);
  if (!row) return "missing";
  if (row.ended_at !== null) return "ended";
  return isLive(row, clock.now()) ? "live" : "stale";
}

export async function liveSessionTab(
  session_id: string,
  tenant_id: string,
  user_id: string,
  clock: Clock = realClock,
): Promise<number | null> {
  const row = await readOwnedSession(session_id, tenant_id, user_id);
  return isLive(row, clock.now()) ? row!.tab_id : null;
}

export const TAB_TASK_KEY_PREFIX = "tab_task:";

export async function countTabTasksToday(tenant_id: string, clock: Clock = realClock): Promise<number> {
  const since = new Date(clock.now());
  since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .select("id", { count: "exact", head: true })
    .like("idempotency_key", `${TAB_TASK_KEY_PREFIX}%`)
    .gte("created_at", since.toISOString());
  if (error) throw new Error(error.message);
  if (typeof count !== "number") throw new Error("tab task count unavailable");
  return count;
}

export async function recordTabTaskStart(
  input: {
    tenant_id: string;
    user_id: string;
    run_id: string;
    session_id: string;
    tab_id: number;
    seq: number;
    task_key: string;
  },
  clock: Clock = realClock,
): Promise<void> {
  const { error } = await tenantClient(asTenantId(input.tenant_id))
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .insert({
      user_id: input.user_id,
      run_id: input.run_id,
      panel_session_id: input.session_id,
      tab_id: input.tab_id,
      seq: input.seq,
      op: { op: "tab_task" },
      is_write: false,
      status: "done",
      idempotency_key: `${TAB_TASK_KEY_PREFIX}${input.task_key}`.slice(0, 200),
      expires_at: iso(clock.now()),
    });
  if (error) throw new Error(error.message);
}

export type EnqueueOpInput = {
  tenant_id: string;
  user_id: string;
  run_id: string;
  session_id: string;
  tab_id: number;
  seq: number;
  op: Record<string, unknown>;
  is_write: boolean;
  expires_in_ms?: number;
  status?: "queued" | "awaiting_confirm";
};

export type EnqueueResult =
  | { ok: true; op_id: string }
  | { ok: false; reason: "no_panel" | "tab_mismatch" };

export async function enqueueOp(
  input: EnqueueOpInput,
  clock: Clock = realClock,
): Promise<EnqueueResult> {
  const session = await readOwnedSession(input.session_id, input.tenant_id, input.user_id);
  const now = clock.now();
  if (!isLive(session, now)) return { ok: false, reason: "no_panel" };
  if (session!.tab_id !== input.tab_id) return { ok: false, reason: "tab_mismatch" };

  const { data, error } = await tenantClient(asTenantId(input.tenant_id))
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .insert({
      user_id: input.user_id,
      run_id: input.run_id,
      panel_session_id: input.session_id,
      tab_id: input.tab_id,
      seq: input.seq,
      op: input.op,
      is_write: input.is_write,
      status: input.status ?? "queued",
      expires_at: iso(now + (input.expires_in_ms ?? 30_000)),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "op insert returned no row");
  return { ok: true, op_id: (data as { id: string }).id };
}

export type OpOutcome =
  | { status: "done" | "failed"; result: unknown }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "not_found" };

type OpStateRow = { status: string; is_write: boolean; result: unknown; op?: unknown };

async function readOpState(tenant_id: string, op_id: string): Promise<OpStateRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .select("status, is_write, result, op")
    .eq("id", op_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OpStateRow | null) ?? null;
}

function terminal(row: OpStateRow): OpOutcome | null {
  switch (row.status) {
    case "done":
    case "failed":
      return { status: row.status, result: row.result ?? null };
    case "unknown":
      return { status: "unknown" };
    case "expired":
      return { status: "expired" };
    default:
      return null;
  }
}

export function minimalOpResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.top_url === "string") out.top_url = r.top_url;
  if (typeof r.error_code === "string") out.error_code = r.error_code;
  return out;
}

function minimalOp(op: unknown): Record<string, unknown> | null {
  if (!op || typeof op !== "object") return null;
  const o = op as Record<string, unknown>;
  if (o.op === "type_ref") return { op: "type_ref", ref: o.ref ?? null, text: "[redacted]" };
  if (o.op === "select_option") return { op: "select_option", ref: o.ref ?? null, label: "[redacted]" };
  if (typeof o.dialog_text === "string") return { ...o, dialog_text: "[redacted]" };
  return null;
}

async function scrubOpResult(tenant_id: string, op_id: string): Promise<void> {
  const row = await readOpState(tenant_id, op_id);
  if (!row || !["done", "failed", "unknown", "expired"].includes(row.status)) return;
  const update: Record<string, unknown> = {};
  if (row.result != null) update.result = minimalOpResult(row.result);
  const op = minimalOp(row.op);
  if (op) update.op = op;
  if (Object.keys(update).length === 0) return;
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .update(update)
    .eq("id", op_id);
  if (error) throw new Error(error.message);
}

async function scrubWithRetry(tenant_id: string, op_id: string): Promise<void> {
  try {
    await scrubOpResult(tenant_id, op_id);
  } catch {
    await scrubOpResult(tenant_id, op_id).catch((e) => {
      void logEvent({
        level: "error",
        source: "extension.browser_ops",
        code: "step_scrub_failed",
        tenant_id,
        error: e,
      });
    });
  }
}

async function takeTerminal(tenant_id: string, op_id: string, row: OpStateRow): Promise<OpOutcome | null> {
  const done = terminal(row);
  if (done) await scrubWithRetry(tenant_id, op_id);
  return done;
}

async function moveStatus(
  tenant_id: string,
  op_id: string,
  from: string[],
  to: string,
): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .update({ status: to })
    .eq("id", op_id)
    .in("status", from);
  if (error) throw new Error(error.message);
}

export async function readOpStatus(tenant_id: string, op_id: string): Promise<string | null> {
  return (await readOpState(tenant_id, op_id))?.status ?? null;
}

export async function releaseHeldOp(
  args: { tenant_id: string; user_id: string; op_id: string; expires_in_ms?: number },
  clock: Clock = realClock,
): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .update({ status: "queued", expires_at: iso(clock.now() + (args.expires_in_ms ?? 30_000)) })
    .eq("id", args.op_id)
    .eq("user_id", args.user_id)
    .eq("status", "awaiting_confirm")
    .select("id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

export async function expireHeldOp(tenant_id: string, op_id: string): Promise<void> {
  await moveStatus(tenant_id, op_id, ["awaiting_confirm"], "expired");
  await scrubWithRetry(tenant_id, op_id);
}

export async function awaitOpResult(
  args: { tenant_id: string; op_id: string },
  opts: { timeoutMs?: number; pollMs?: number } = {},
  clock: Clock = realClock,
): Promise<OpOutcome> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = clock.now() + timeoutMs;

  for (;;) {
    const row = await readOpState(args.tenant_id, args.op_id);
    if (!row) return { status: "not_found" };
    const done = await takeTerminal(args.tenant_id, args.op_id, row);
    if (done) return done;
    if (clock.now() >= deadline) break;
    await clock.sleep(pollMs);
  }

  const row = await readOpState(args.tenant_id, args.op_id);
  if (!row) return { status: "not_found" };
  const done = await takeTerminal(args.tenant_id, args.op_id, row);
  if (done) return done;

  if (row.status === "delivered") {
    await moveStatus(args.tenant_id, args.op_id, ["delivered"], row.is_write ? "unknown" : "expired");
  } else {
    await moveStatus(
      args.tenant_id,
      args.op_id,
      ["queued", "lease_expired", "awaiting_confirm"],
      "expired",
    );
  }

  const settled = await readOpState(args.tenant_id, args.op_id);
  if (!settled) return { status: "not_found" };
  return (await takeTerminal(args.tenant_id, args.op_id, settled)) ?? (settled.is_write ? { status: "unknown" } : { status: "expired" });
}

export type ClaimedOp = {
  id: string;
  run_id: string;
  seq: number;
  tab_id: number;
  op: unknown;
  is_write: boolean;
  execution_token: string;
  lease_until: string;
};

export type ClaimResult =
  | { kind: "op"; op: ClaimedOp }
  | { kind: "timeout" }
  | { kind: "dead" }
  | { kind: "aborted" };

async function claimOnce(
  tenant_id: string,
  user_id: string,
  session_id: string,
): Promise<ClaimedOp | null> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "claim_extension_op", {
    p_user_id: user_id,
    p_session_id: session_id,
  });
  if (error) throw new Error(error.message);
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as Record<string, unknown>[];
  const r = rows[0];
  if (!r || typeof r.id !== "string") return null;
  return {
    id: r.id,
    run_id: r.run_id as string,
    seq: r.seq as number,
    tab_id: r.tab_id as number,
    op: r.op,
    is_write: r.is_write as boolean,
    execution_token: r.execution_token as string,
    lease_until: r.lease_until as string,
  };
}

export async function claimNextOp(
  tenant_id: string,
  user_id: string,
  session_id: string,
  opts: { waitMs?: number; pollMs?: number; signal?: AbortSignal } = {},
  clock: Clock = realClock,
): Promise<ClaimResult> {
  const waitMs = opts.waitMs ?? 25_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = clock.now() + waitMs;
  let lastTouch = -Infinity;

  for (;;) {
    if (opts.signal?.aborted) return { kind: "aborted" };
    if (clock.now() - lastTouch >= TOUCH_EVERY_MS) {
      if (!(await touchPanelSession(session_id, tenant_id, user_id, clock))) {
        return { kind: "dead" };
      }
      lastTouch = clock.now();
    }
    const op = await claimOnce(tenant_id, user_id, session_id);
    if (op) return { kind: "op", op };
    if (clock.now() >= deadline) return { kind: "timeout" };
    await clock.sleep(pollMs);
  }
}

export async function completeOp(args: {
  tenant_id: string;
  user_id: string;
  op_id: string;
  session_id: string;
  run_id: string;
  execution_token: string;
  status: "done" | "failed";
  result: unknown;
}): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(args.tenant_id), "complete_extension_op", {
    p_op_id: args.op_id,
    p_user_id: args.user_id,
    p_session_id: args.session_id,
    p_run_id: args.run_id,
    p_token: args.execution_token,
    p_status: args.status,
    p_result: args.result ?? null,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function stopUserBrowserControl(
  tenant_id: string,
  user_id: string,
  clock: Clock = realClock,
): Promise<void> {
  const scoped = tenantClient(asTenantId(tenant_id));

  let firstError: Error | null = null;
  const note = (err: { message: string } | null) => {
    if (err && !firstError) firstError = new Error(err.message);
  };

  const ended = await scoped
    .from(EXTENSION_PANEL_SESSIONS_TABLE)
    .update({ ended_at: iso(clock.now()) })
    .eq("user_id", user_id)
    .is("ended_at", null);
  note(ended.error);

  const lostWrites = await scoped
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .update({ status: "unknown" })
    .eq("user_id", user_id)
    .eq("status", "delivered")
    .eq("is_write", true);
  note(lostWrites.error);

  const pendingFrom = lostWrites.error
    ? ["queued", "lease_expired", "awaiting_confirm"]
    : ["queued", "lease_expired", "awaiting_confirm", "delivered"];
  const pending = await scoped
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .update({ status: "expired" })
    .eq("user_id", user_id)
    .in("status", pendingFrom);
  note(pending.error);

  const erased = await scoped
    .from(EXTENSION_BROWSER_OPS_TABLE)
    .update({ result: null, op: { op: "redacted" } })
    .eq("user_id", user_id);
  note(erased.error);

  if (firstError) throw firstError;
}
