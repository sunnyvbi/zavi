
import { deliverOpsAlert } from "./alert";
import { logEvent } from "./logEvent";
import { opsRpc } from "@/services/tenant-client";

export const OPS_ALERT_ENQUEUED_EVENT = "ops/alert.enqueued";
export const OPS_ALERT_MAX_ATTEMPTS = 10;
const CLAIM_BATCH = 50;

export type OutboxRow = {
  id: number;
  dedupe_key: string;
  source: string;
  code: string;
  tenant_id: string | null;
  msg: string;
  attempts: number;
};

type RpcResult<T> = { data: T | null; error: { message: string } | null };

export type DrainDeps = {
  claim: (limit: number) => PromiseLike<RpcResult<OutboxRow[]>>;
  finish: (id: number, attempt: number, ok: boolean, error: string | null) => PromiseLike<RpcResult<boolean>>;
  deliver: typeof deliverOpsAlert;
  log: typeof logEvent;
};

const DEFAULT_DEPS: DrainDeps = {
  claim: (limit) => opsRpc("claim_ops_alerts", { p_limit: limit }),
  finish: (id, attempt, ok, error) => opsRpc("finish_ops_alert", { p_id: id, p_attempt: attempt, p_ok: ok, p_error: error }),
  deliver: (input, opts) => deliverOpsAlert(input, opts),
  log: logEvent,
};

export type DrainResult = { claimed: number; sent: number; failed: number; gave_up: number; fenced: number };

export async function drainOpsAlerts(deps: Partial<DrainDeps> = {}): Promise<DrainResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const { data, error } = await d.claim(CLAIM_BATCH);
  if (error) throw new Error(`claim_ops_alerts failed: ${error.message}`);
  const rows = data ?? [];
  const out: DrainResult = { claimed: rows.length, sent: 0, failed: 0, gave_up: 0, fenced: 0 };
  const finishErrors: string[] = [];
  for (const r of rows) {
    let delivered: { ok: boolean; error?: string };
    try {
      delivered = await d.deliver({ source: r.source, code: r.code, tenant_id: r.tenant_id, msg: r.msg }, { log: r.attempts === 1 });
    } catch (e) {
      delivered = { ok: false, error: (e as Error).message };
    }
    const errText = delivered.ok ? delivered.error ?? null : (delivered.error ?? "unknown").slice(0, 500);
    const fin = await d.finish(r.id, r.attempts, delivered.ok, errText);
    if (fin.error) {
      finishErrors.push(`${r.id}: ${fin.error.message}`);
      continue;
    }
    if (fin.data !== true) {
      out.fenced++;
      continue;
    }
    if (delivered.ok) {
      out.sent++;
      continue;
    }
    out.failed++;
    if (r.attempts >= OPS_ALERT_MAX_ATTEMPTS) {
      out.gave_up++;
      void d.log({
        level: "error",
        source: "ops_alert_outbox",
        code: "ops_alert_gave_up",
        message: `alert ${r.id} (${r.code}) not delivered after ${r.attempts} attempts: ${errText ?? "unknown"}`.slice(0, 500),
        tenant_id: r.tenant_id,
      });
    }
  }
  if (finishErrors.length) throw new Error(`finish_ops_alert failed for ${finishErrors.length} row(s): ${finishErrors[0]}`);
  return out;
}

export function nudgeOpsAlertDrain(): void {
  void import("@/../workers/client")
    .then(({ inngest }) => inngest.send({ name: OPS_ALERT_ENQUEUED_EVENT, data: {} }))
    .catch(() => {});
}
