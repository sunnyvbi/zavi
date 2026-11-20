import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { isCustomAgentSlug } from "@/services/billing/tiers";

export const HANDOFF_JOIN_WAIT_SECONDS = 30 * 60;
export const HANDOFF_JOIN_POLL_SECONDS = 30;
export const HANDOFF_FINDINGS_MAX = 6000;

export const HANDOFF_JOIN_EVENT = "custom-agent/handoff.join.requested";
export const HANDOFF_DELIVER_ATTEMPTS = 10;
export const HANDOFF_LEASE_SECONDS = 5 * 60;

const NON_TERMINAL = new Set(["queued", "running", "blocked"]);

export type ParkSeams = {
  park: (tenant_id: string, run_id: string, output: string) => Promise<boolean>;
  sendJoinEvent: (tenant_id: string, run_id: string) => Promise<void>;
  cancel: (tenant_id: string, run_id: string) => Promise<boolean>;
  warn: (s: string) => void;
};

const defaultParkSeams: ParkSeams = {
  park: async (tenant_id, run_id, output) => {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "custom_agent_handoff_park", {
      p_parent_run_id: run_id,
      p_output: output,
      p_wait_seconds: HANDOFF_JOIN_WAIT_SECONDS,
    });
    if (error) throw new Error(error.message);
    return data === true;
  },
  sendJoinEvent: async (tenant_id, run_id) => {
    const { inngest } = await import("../../../workers/client");
    await inngest.send({ id: `custom-handoff-join:${run_id}`, name: HANDOFF_JOIN_EVENT, data: { tenant_id, parent_run_id: run_id } });
  },
  cancel: async (tenant_id, run_id) => {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "custom_agent_handoff_cancel", {
      p_parent_run_id: run_id,
    });
    if (error) throw new Error(error.message);
    return data === true;
  },
  warn: (s) => console.warn(s),
};

export async function parkCustomHandoff(
  p: { tenant_id: string; run_id: string; output: string },
  seams: ParkSeams = defaultParkSeams,
): Promise<boolean> {
  let parked = false;
  try {
    parked = await seams.park(p.tenant_id, p.run_id, p.output);
  } catch (e) {
    seams.warn(`[custom-agent-handoff] park failed run=${p.run_id}: ${(e as Error).message}`);
    return false;
  }
  if (!parked) return false;
  for (let i = 0; i < 2; i++) {
    try {
      await seams.sendJoinEvent(p.tenant_id, p.run_id);
      return true;
    } catch (e) {
      seams.warn(`[custom-agent-handoff] join event failed run=${p.run_id}: ${(e as Error).message}`);
    }
  }
  try {
    return !(await seams.cancel(p.tenant_id, p.run_id));
  } catch (c) {
    seams.warn(`[custom-agent-handoff] cancel failed run=${p.run_id}, staying parked: ${(c as Error).message}`);
    return true;
  }
}

export type HelperRun = {
  id: string;
  agent_slug: string;
  status: string;
  output_text: string | null;
};

export function helperIsDone(r: HelperRun): boolean {
  return !NON_TERMINAL.has(r.status);
}

export function builtInHelperName(slug: string): string {
  const s = slug.replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "The helper";
}

export function composeJoinedOutput(
  parentOutput: string,
  childIds: string[],
  helpers: HelperRun[],
  names: Record<string, string>,
): string {
  const parts = [parentOutput.trim()].filter((x) => x.length > 0);
  for (const id of childIds) {
    const h = helpers.find((x) => x.id === id);
    const name = h ? (names[h.agent_slug] ?? builtInHelperName(h.agent_slug)) : "A helper";
    if (!h || !helperIsDone(h)) {
      parts.push(`${name} did not finish in time. Its result will be in its run history.`);
      continue;
    }
    const out = (h.output_text ?? "").trim();
    if (h.status !== "success" || !out) {
      parts.push(`${name} could not finish this time.`);
      continue;
    }
    const cut = out.length > HANDOFF_FINDINGS_MAX ? `${out.slice(0, HANDOFF_FINDINGS_MAX - 1)}…` : out;
    parts.push(`What ${name} found:\n${cut}`);
  }
  return parts.join("\n\n");
}

export type JoinRow = { status: string; deadline_at: string | null; child_run_ids: string[]; lease_until?: string | null };

export type JoinSeams = {
  readJoin: (tenant_id: string, parent_run_id: string) => Promise<JoinRow | null>;
  readHelpers: (tenant_id: string, ids: string[]) => Promise<HelperRun[]>;
  claim: (
    tenant_id: string,
    parent_run_id: string,
  ) => Promise<{ parent_output: string; child_run_ids: string[]; attempts: number } | null>;
  settle: (tenant_id: string, parent_run_id: string, status: "delivered" | "waiting" | "cancelled") => Promise<void>;
  alreadyDelivered: (tenant_id: string, parent_run_id: string) => Promise<boolean>;
  helperNames: (tenant_id: string, slugs: string[]) => Promise<Record<string, string>>;
  deliver: (tenant_id: string, parent_run_id: string, combined: string) => Promise<string>;
};

export function settleFor(outcome: string, attempts: number): "delivered" | "waiting" | "cancelled" {
  switch (outcome) {
    case "delivered":
    case "pending_whatsapp":
    case "deferred":
    case "no_destination":
    case "waiting_handoff":
    case "failed_delivery":
      return "delivered";
    case "transient_delivery":
    case "threw":
      return attempts < HANDOFF_DELIVER_ATTEMPTS ? "waiting" : "delivered";
    default:
      return "cancelled";
  }
}

export async function checkHandoffJoin(
  tenant_id: string,
  parent_run_id: string,
  now: Date,
  seams: JoinSeams,
): Promise<{ state: "wait" | "done" | "skip"; outcome?: string }> {
  const row = await seams.readJoin(tenant_id, parent_run_id);
  if (!row) return { state: "skip" };
  const leaseLapsed =
    row.status === "delivering" && (!row.lease_until || new Date(row.lease_until).getTime() < now.getTime());
  if (row.status !== "waiting" && !leaseLapsed) {
    return row.status === "delivering" ? { state: "wait" } : { state: "skip" };
  }
  const helpers = await seams.readHelpers(tenant_id, row.child_run_ids);
  const allDone = row.child_run_ids.every((id) => {
    const h = helpers.find((x) => x.id === id);
    return !!h && helperIsDone(h);
  });
  const expired = !row.deadline_at || new Date(row.deadline_at).getTime() <= now.getTime();
  if (!allDone && !expired && !leaseLapsed) return { state: "wait" };
  const claimed = await seams.claim(tenant_id, parent_run_id);
  if (!claimed) return { state: "skip" };
  if (leaseLapsed || claimed.attempts > 1) {
    let sent: boolean;
    try {
      sent = await seams.alreadyDelivered(tenant_id, parent_run_id);
    } catch {
      await seams.settle(tenant_id, parent_run_id, "waiting");
      return { state: "wait" };
    }
    if (sent) {
      await seams.settle(tenant_id, parent_run_id, "delivered");
      return { state: "done", outcome: "already_delivered" };
    }
  }
  let outcome: string;
  try {
    const final = await seams.readHelpers(tenant_id, claimed.child_run_ids);
    const customSlugs = final.map((h) => h.agent_slug).filter((s) => isCustomAgentSlug(s));
    const names = customSlugs.length > 0 ? await seams.helperNames(tenant_id, customSlugs) : {};
    const combined = composeJoinedOutput(claimed.parent_output, claimed.child_run_ids, final, names);
    outcome = await seams.deliver(tenant_id, parent_run_id, combined);
  } catch {
    outcome = "threw";
  }
  const next = settleFor(outcome, claimed.attempts);
  await seams.settle(tenant_id, parent_run_id, next);
  return next === "waiting" ? { state: "wait", outcome } : { state: "done", outcome };
}

export const defaultJoinSeams: JoinSeams = {
  readJoin: async (tenant_id, parent_run_id) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agent_handoff_joins")
      .select("status, deadline_at, child_run_ids, lease_until")
      .eq("parent_run_id", parent_run_id)
      .maybeSingle<JoinRow>();
    if (error) throw new Error(`join read failed: ${error.message}`);
    return data ?? null;
  },
  readHelpers: async (tenant_id, ids) => {
    if (ids.length === 0) return [];
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("id, agent_slug, status, output_text")
      .in("id", ids);
    if (error) throw new Error(`helper read failed: ${error.message}`);
    return (data ?? []) as HelperRun[];
  },
  claim: async (tenant_id, parent_run_id) => {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "custom_agent_handoff_claim", {
      p_parent_run_id: parent_run_id,
    });
    if (error) throw new Error(`join claim failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    const r = row as { parent_output: string | null; child_run_ids: string[] | null; attempts: number | null };
    return { parent_output: r.parent_output ?? "", child_run_ids: r.child_run_ids ?? [], attempts: r.attempts ?? 1 };
  },
  alreadyDelivered: async (tenant_id, parent_run_id) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agents")
      .select("id")
      .eq("last_outcome_key", `run:${parent_run_id}`)
      .limit(1);
    if (error) throw new Error(`outcome read failed: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  },
  settle: async (tenant_id, parent_run_id, status) => {
    const { error } = await tenantRpc(asTenantId(tenant_id), "custom_agent_handoff_settle", {
      p_parent_run_id: parent_run_id,
      p_status: status,
    });
    if (error) console.warn(`[custom-agent-handoff] settle failed run=${parent_run_id}: ${error.message}`);
  },
  helperNames: async (tenant_id, slugs) => {
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agents")
      .select("slug, name")
      .in("slug", slugs);
    const out: Record<string, string> = {};
    for (const r of (data ?? []) as Array<{ slug: string; name: string }>) out[r.slug] = r.name;
    return out;
  },
  deliver: async (tenant_id, parent_run_id, combined) => {
    const { data: run, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("id, agent_slug, payload, custom_agent_id, custom_trigger_id")
      .eq("id", parent_run_id)
      .maybeSingle<{
        id: string;
        agent_slug: string;
        payload: unknown;
        custom_agent_id: string | null;
        custom_trigger_id: string | null;
      }>();
    if (error || !run) return "skipped_missing";
    const { finishCustomAgentRunProd } = await import("./custom-agent-runs");
    const { scrubAgentEgress } = await import("./scrub-agent-egress");
    return finishCustomAgentRunProd(
      {
        tenant_id,
        run_id: run.id,
        agent_slug: run.agent_slug,
        custom_agent_id: run.custom_agent_id,
        custom_trigger_id: run.custom_trigger_id,
        payload: run.payload,
        status: "success",
        output_text: combined,
        will_retry: false,
        handoff_joined: true,
      },
      (text: string) => scrubAgentEgress(text, { surface: "persist", agentSlug: run.agent_slug }).text,
      run.agent_slug,
    );
  },
};
