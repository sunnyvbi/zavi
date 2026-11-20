import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { ConnectorOp } from "@zavi/shared/db-guard";
import { logEvent } from "@/services/logging/logEvent";
import { publishWake } from "./wakeup";
import { DbSourceChangedError } from "../types";

export type QueueDeps = {
  rpc: typeof tenantRpc;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  wake: (tenant_id: string) => Promise<void>;
  log: typeof logEvent;
};
const DEFAULT: QueueDeps = {
  rpc: (...a) => tenantRpc(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  wake: (t) => publishWake(t),
  log: (i) => logEvent(i),
};

export const REQUEST_TTL_SECONDS = 60;
export const WAIT_TIMEOUT_MS = 45_000;

export type Finished = { status: "done" | "refused" | "failed" | "expired"; result: unknown; reason: string | null };

export class ConnectorQueueError extends ExpectedToolError {}

export async function enqueue(tenant_id: string, op: ConnectorOp, generation: number, ttlSeconds = REQUEST_TTL_SECONDS, deps: Partial<QueueDeps> = {}): Promise<string | null> {
  const d = { ...DEFAULT, ...deps };
  const { data, error } = await d.rpc(asTenantId(tenant_id), "enqueue_db_connector_request", { p_op: op, p_ttl_seconds: ttlSeconds, p_generation: generation });
  if (error) {
    if ((error as { code?: string }).code === "ZD412") throw new DbSourceChangedError();
    if ((error as { code?: string }).code === "ZD429") {
      throw new ConnectorQueueError("connector_busy", "Your connector has too many reads waiting. Try again in a minute.");
    }
    throw new ConnectorQueueError("connector_queue_unavailable", "Zavi could not send this read to your connector. Try again shortly.");
  }
  if (typeof data !== "string") return null;
  await d.wake(tenant_id).catch(() => undefined);
  return data;
}

export async function takeResult(tenant_id: string, request_id: string, deps: Partial<QueueDeps> = {}): Promise<Finished | null> {
  const d = { ...DEFAULT, ...deps };
  const { data, error } = await d.rpc(asTenantId(tenant_id), "take_db_connector_result", { p_request_id: request_id });
  if (error) throw new ConnectorQueueError("connector_queue_unavailable", "Zavi could not read your connector's answer. Try again shortly.");
  const row = Array.isArray(data) ? (data[0] as { status?: string; result?: unknown; reason?: string | null } | undefined) : undefined;
  if (!row?.status) return null;
  if (row.status !== "done" && row.status !== "refused" && row.status !== "failed" && row.status !== "expired") return null;
  return { status: row.status, result: row.result ?? null, reason: row.reason ?? null };
}

export async function cancel(tenant_id: string, request_id: string, deps: Partial<QueueDeps> = {}): Promise<boolean> {
  const d = { ...DEFAULT, ...deps };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error } = await d.rpc(asTenantId(tenant_id), "cancel_db_connector_request", { p_request_id: request_id });
      if (!error) return true;
    } catch {
    }
  }
  await d.log({ level: "error", source: "data-gateway.connector", code: "connector_cancel_failed", tenant_id });
  return false;
}

export async function awaitResult(
  tenant_id: string,
  request_id: string,
  opts: { timeoutMs?: number } = {},
  deps: Partial<QueueDeps> = {},
): Promise<Finished | "timeout"> {
  const d = { ...DEFAULT, ...deps };
  const start = d.now();
  const deadline = start + (opts.timeoutMs ?? WAIT_TIMEOUT_MS);
  for (;;) {
    const r = await takeResult(tenant_id, request_id, d);
    if (r) return r;
    const now = d.now();
    if (now >= deadline) break;
    await d.sleep(Math.min(now - start < 3000 ? 250 : 500, Math.max(1, deadline - now)));
  }
  await cancel(tenant_id, request_id, d);
  return "timeout";
}

export type Delivery = { id: string; execution_token: string; op: unknown; generation: number | null };

export async function claimNext(tenant_id: string, connector_id: string, deps: Partial<QueueDeps> = {}): Promise<Delivery | null> {
  const d = { ...DEFAULT, ...deps };
  const { data, error } = await d.rpc(asTenantId(tenant_id), "claim_db_connector_request", { p_connector_id: connector_id });
  if (error) throw new Error("claim_db_connector_request failed");
  const row = Array.isArray(data) ? (data[0] as (Omit<Delivery, "generation"> & { generation?: number | string | null }) | undefined) : undefined;
  return row?.id ? { ...row, generation: row.generation == null ? null : Number(row.generation) } : null;
}

export type CompleteOutcome = "accepted" | "duplicate" | "stale" | "source_changed";

export async function complete(
  tenant_id: string,
  connector_id: string,
  request_id: string,
  execution_token: string,
  status: "done" | "refused" | "failed",
  result: unknown,
  reason: string | null,
  fence: { generation: number | null; source_instance_id: string | null },
  deps: Partial<QueueDeps> = {},
): Promise<CompleteOutcome> {
  const d = { ...DEFAULT, ...deps };
  const { data, error } = await d.rpc(asTenantId(tenant_id), "complete_db_connector_request", {
    p_connector_id: connector_id,
    p_request_id: request_id,
    p_execution_token: execution_token,
    p_status: status,
    p_result: result ?? null,
    p_reason: reason,
    p_generation: fence.generation,
    p_source_instance_id: fence.source_instance_id,
  });
  if (error) throw new Error("complete_db_connector_request failed");
  return data === "accepted" || data === "duplicate" || data === "source_changed" ? data : "stale";
}
