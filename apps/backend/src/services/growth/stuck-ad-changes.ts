import { asTenantId, fleetSweepClient, tenantClient, tenantRpc } from "@/services/tenant-client";
import { nudgeOpsAlertDrain } from "@/services/logging/ops-alert-outbox";

export const STUCK_AFTER_MS = 30 * 60_000;
const SWEEP_LIMIT = 200;
const AD_MONEY_CLASS = /^(meta_ads|google_ads)\.[a-z_]+$/;

export type InflightChange = {
  id: string;
  tenant_id: string;
  exec_class: string | null;
  exec_status: "queued" | "dispatching";
  exec_claim_id: string | null;
  exec_claimed_at: string | null;
  exec_payload?: unknown;
  title?: string | null;
  site_pr_waiting?: string | null;
};

export type StuckChange = InflightChange & { since: string };

export type StuckDeps = {
  inflight: () => Promise<InflightChange[]>;
  approvedAt: (tenant_id: string, action_id: string) => Promise<string | null>;
  alert: (c: StuckChange) => Promise<void>;
  tellFounder: (tenant_id: string, stuck: StuckChange[]) => Promise<void>;
};

async function readInflight(): Promise<InflightChange[]> {
  const { data, error } = await fleetSweepClient("stuck ad changes: approved changes still queued or dispatching")
    .from("channel_actions")
    .select("id, tenant_id, title, exec_class, exec_payload, exec_status, exec_claim_id, exec_claimed_at, site_pr_waiting:exec_result->>site_pr_waiting")
    .in("exec_status", ["queued", "dispatching"])
    .limit(SWEEP_LIMIT);
  if (error) throw new Error(`stuck ad changes: read failed: ${error.message}`);
  return (data ?? []) as InflightChange[];
}

async function readApprovedAt(tenant_id: string, action_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_action_events")
    .select("at")
    .eq("action_id", action_id)
    .eq("event", "approved")
    .order("at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`stuck ad changes: approval read failed: ${error.message}`);
  return ((data ?? []) as Array<{ at: string }>)[0]?.at ?? null;
}

async function alertZavi(c: StuckChange): Promise<void> {
  const { error } = await tenantRpc(asTenantId(c.tenant_id), "enqueue_ops_alert", {
    p_dedupe_key: `stuck_ad_change:${c.id}:${c.exec_claim_id ?? c.since}`,
    p_source: "cgo.stuck",
    p_code: "ad_change_stuck",
    p_tenant_id: c.tenant_id,
    p_msg: `action=${c.id} ${c.exec_class ?? "?"} ${c.exec_status} since ${c.since}`,
  });
  if (error) throw new Error(error.message);
  nudgeOpsAlertDrain();
}

async function tellFounderDefault(tenant_id: string, stuck: StuckChange[]): Promise<void> {
  const { alertFounderSafely, stuckBlocker } = await import("./cgo-blockers");
  await alertFounderSafely(tenant_id, "stuck ad change", stuck.map((c) => stuckBlocker({ id: c.id, title: c.title ?? null, exec_class: c.exec_class, exec_payload: c.exec_payload, since: c.since })));
}

const defaultDeps: StuckDeps = { inflight: readInflight, approvedAt: readApprovedAt, alert: alertZavi, tellFounder: tellFounderDefault };

export async function findStuckAdChanges(now: Date, deps: Partial<StuckDeps> = {}): Promise<StuckChange[]> {
  const d = { ...defaultDeps, ...deps };
  const cutoff = now.getTime() - STUCK_AFTER_MS;
  const out: StuckChange[] = [];
  for (const c of await d.inflight()) {
    if (!c.exec_class) continue;
    if (c.site_pr_waiting === "approvals") continue;
    const since = c.exec_status === "dispatching" ? c.exec_claimed_at : await d.approvedAt(c.tenant_id, c.id);
    const at = since ? Date.parse(since) : NaN;
    if (Number.isFinite(at) && at <= cutoff) out.push({ ...c, since: since! });
  }
  return out;
}

export async function sweepStuckAdChanges(now: Date = new Date(), deps: Partial<StuckDeps> = {}): Promise<{ stuck: number; alerted: number; failed: number }> {
  const d = { ...defaultDeps, ...deps };
  const stuck = await findStuckAdChanges(now, d);
  let alerted = 0;
  let failed = 0;
  const byTenant = new Map<string, StuckChange[]>();
  for (const c of stuck) {
    if (c.exec_class && AD_MONEY_CLASS.test(c.exec_class)) byTenant.set(c.tenant_id, [...(byTenant.get(c.tenant_id) ?? []), c]);
    try {
      await d.alert(c);
      alerted++;
    } catch (e) {
      failed++;
      console.warn(`[stuck-ad-changes] ${c.id} (tenant ${c.tenant_id}): ${(e as Error).message}`);
    }
  }
  for (const [tenant_id, list] of byTenant) {
    await d.tellFounder(tenant_id, list).catch((e) => console.warn(`[stuck-ad-changes] founder alert for ${tenant_id}: ${(e as Error).message}`));
  }
  return { stuck: stuck.length, alerted, failed };
}

export type SpendBlindDeps = {
  lastRead: (tenant_id: string) => Promise<{ budget_id: string; actual_read_at: string | null } | null>;
  enqueue: (tenant_id: string, alert: { key: string; msg: string }) => Promise<void>;
};

const defaultSpendBlindDeps: SpendBlindDeps = {
  lastRead: async (tenant_id) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("ad_budgets")
      .select("id, actual_read_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle<{ id: string; actual_read_at: string | null }>();
    if (error) throw new Error(error.message);
    return data ? { budget_id: data.id, actual_read_at: data.actual_read_at } : null;
  },
  enqueue: async (tenant_id, alert) => {
    const { error } = await tenantRpc(asTenantId(tenant_id), "enqueue_ops_alert", {
      p_dedupe_key: alert.key,
      p_source: "cgo.spend_blind",
      p_code: "spend_data_stale",
      p_tenant_id: tenant_id,
      p_msg: alert.msg,
    });
    if (error) throw new Error(error.message);
    nudgeOpsAlertDrain();
  },
};

export async function alertSpendBlind(tenant_id: string, deps: Partial<SpendBlindDeps> = {}): Promise<{ alerted: boolean }> {
  const d = { ...defaultSpendBlindDeps, ...deps };
  const read = await d.lastRead(tenant_id);
  if (!read) return { alerted: false };
  await d.enqueue(tenant_id, {
    key: `spend_blind:${read.budget_id}:${read.actual_read_at ?? "never"}`,
    msg: `budget=${read.budget_id} live ad spend not readable; last whole spend read ${read.actual_read_at ?? "never"}`,
  });
  return { alerted: true };
}
