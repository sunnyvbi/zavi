
import { createHash } from "node:crypto";
import { logEvent } from "@/services/logging/logEvent";
import { nudgeOpsAlertDrain } from "@/services/logging/ops-alert-outbox";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export const REMATCH_SOURCE = "channel_actions.match";
export const REMATCH_EXHAUSTED_CODE = "rematch_exhausted";

export type RematchExhausted = {
  tenantId: string;
  runId: string;
  channelSlug: string;
  scope: "exec" | "run";
  targetKey?: string | null;
  positions?: readonly number[];
};

export type RematchDeps = {
  rpc?: typeof tenantRpc;
  log?: typeof logEvent;
  nudge?: () => void;
};

export function rematchDedupeKey(a: RematchExhausted): string {
  if (a.scope === "run") return `rematch:${a.runId}`;
  const t = a.targetKey ? createHash("sha256").update(a.targetKey).digest("hex").slice(0, 16) : "none";
  return `rematch:${a.runId}:${t}`;
}

export async function alertRematchExhausted(a: RematchExhausted, deps: RematchDeps = {}): Promise<void> {
  const log = deps.log ?? logEvent;
  const msg =
    `run=${a.runId} channel=${a.channelSlug} scope=${a.scope}` +
    (a.positions && a.positions.length ? ` positions=${a.positions.join(",")}` : "") +
    ": re-matched twice; filed without the matcher";
  await log({
    level: "warn",
    source: REMATCH_SOURCE,
    code: `channel.card_${REMATCH_EXHAUSTED_CODE}`,
    message: msg,
    tenant_id: a.tenantId,
    run_id: a.runId,
  }).catch(() => undefined);
  try {
    const { data, error } = await (deps.rpc ?? tenantRpc)(asTenantId(a.tenantId), "enqueue_ops_alert", {
      p_dedupe_key: rematchDedupeKey(a),
      p_source: REMATCH_SOURCE,
      p_code: REMATCH_EXHAUSTED_CODE,
      p_tenant_id: a.tenantId,
      p_msg: msg,
    });
    if (error) throw new Error(error.message);
    if (data === true) (deps.nudge ?? nudgeOpsAlertDrain)();
  } catch (e) {
    console.warn(`[card-rematch] run ${a.runId}: alert enqueue failed: ${(e as Error).message}`);
  }
}
