
import { serviceClient, serverClientFromBearer } from "@/services/supabase";
import type { AgentTrigger } from "@/services/agents/types";
import { isFleetHalted, FleetHaltedError } from "@/services/agents/fleet-halt";
import { loadAgentDefinition } from "@/services/agents/registry";
import { isMoneyPathSlug } from "@/services/agents/infra-retry";
import { getBoolSetting } from "@/services/settings";
import { inngest } from "@/../workers/client";
import { logEvent } from "@/services/logging/logEvent";

export type WorkItemLane = "e2b" | "local";

export type WorkItemSource =
  | "cron"
  | "webhook_slack"
  | "webhook_teams"
  | "webhook_telegram"
  | "webhook_discord"
  | "webhook_whatsapp"
  | "webhook_imessage"
  | "webhook_github"
  | "a2a"
  | "heartbeat"
  | "wakeup"
  | "nightly"
  | "chat"
  | "chat_pr_followup"
  | "manual";

export type WorkItem = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  source: WorkItemSource;
  priority: number;
  status: string;
  attempts: number;
  risk_tier: string | null;
  payload: unknown;
  dedupe_key: string | null;
  agent_run_id: string | null;
  next_run_at: string;
  lane: WorkItemLane;
  work_type: string | null;
};

export type EnqueueWorkItemInput = {
  tenant_id: string;
  agent_slug: string;
  source: WorkItemSource;
  payload?: unknown;
  dedupe_key?: string | null;
  priority?: number;
  next_run_at?: string;
  risk_tier?: string | null;
  user_access_token?: string;
};

const SOURCE_TO_TRIGGER: Record<WorkItemSource, AgentTrigger> = {
  cron: "cron",
  webhook_slack: "slack",
  webhook_teams: "teams",
  webhook_telegram: "telegram",
  webhook_discord: "discord",
  webhook_whatsapp: "whatsapp",
  webhook_imessage: "imessage",
  webhook_github: "webhook",
  a2a: "a2a",
  heartbeat: "cron",
  wakeup: "cron",
  nightly: "cron",
  chat: "chat",
  chat_pr_followup: "chat",
  manual: "manual",
};

export function sourceToTrigger(source: WorkItemSource): AgentTrigger {
  return SOURCE_TO_TRIGGER[source];
}

export function isBackgroundSource(source: WorkItemSource): boolean {
  return source !== "chat" && source !== "manual";
}

const LOCAL_LANE_E2B_ONLY_SOURCES: ReadonlySet<WorkItemSource> = new Set([
  "webhook_slack",
  "webhook_teams",
  "webhook_telegram",
  "webhook_discord",
  "webhook_whatsapp",
  "webhook_imessage",
]);

export function isE2bOnlySource(source: WorkItemSource): boolean {
  return LOCAL_LANE_E2B_ONLY_SOURCES.has(source);
}

async function resolveLaneAndWorkType(
  input: EnqueueWorkItemInput,
): Promise<{ lane: WorkItemLane; work_type: string | null }> {
  let work_type: string | null = null;
  let costClass = "standard";
  try {
    const agent = await loadAgentDefinition(input.agent_slug, input.tenant_id);
    if (agent) {
      costClass = agent.metadata_praxis.cost_class;
      work_type = costClass;
    }
  } catch (e) {
    console.warn(
      `[work-queue] resolveLane: agent def load failed for ${input.agent_slug}: ${(e as Error).message}; defaulting e2b`,
    );
    return { lane: "e2b", work_type: null };
  }

  let lane: WorkItemLane = costClass === "expensive" ? "local" : "e2b";

  if (input.source === "chat_pr_followup") return { lane: "e2b", work_type: null };

  if (isE2bOnlySource(input.source)) {
    return { lane: "e2b", work_type: null };
  }

  if (isMoneyPathSlug(input.agent_slug)) {
    lane = "e2b";
  }

  if (lane === "local") {
    if (!(await fleetLocalLaneMasterOn()) || !(await localLaneEnabled(input.tenant_id))) {
      lane = "e2b";
    }
  }

  return { lane, work_type };
}

async function fleetLocalLaneMasterOn(): Promise<boolean> {
  return getBoolSetting("fleet_local_lane_enabled");
}

async function localLaneEnabled(tenant_id: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("tenant_local_lane")
    .select("enabled")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) return false;
  return !!(data as { enabled?: boolean } | null)?.enabled;
}

const CONVERSATIONAL_TRIGGERS: ReadonlySet<AgentTrigger> = new Set([
  "chat",
  "slack",
]);

export async function shouldDelegateConversationalEngineerToLocal(
  tenant_id: string,
  agent_slug: string,
  trigger: AgentTrigger,
  run_id: string,
): Promise<boolean> {
  if (agent_slug !== "engineer") return false;
  if (!CONVERSATIONAL_TRIGGERS.has(trigger)) return false;
  const delegatedSource = TRIGGER_TO_WORK_ITEM_SOURCE[trigger];
  if (!delegatedSource || isE2bOnlySource(delegatedSource)) return false;
  if (isMoneyPathSlug(agent_slug)) return false;
  if (!(await getBoolSetting("engineer_runs_local", tenant_id))) return false;
  if (!(await fleetLocalLaneMasterOn())) return false;
  if (!(await localLaneEnabled(tenant_id))) return false;
  const { data: linked } = await serviceClient()
    .from("agent_work_items")
    .select("id")
    .eq("agent_run_id", run_id)
    .limit(1)
    .maybeSingle();
  if (linked) return false;
  return true;
}

const TRIGGER_TO_WORK_ITEM_SOURCE: Partial<Record<AgentTrigger, WorkItemSource>> =
  {
    chat: "chat",
    slack: "webhook_slack",
    a2a: "a2a",
    manual: "manual",
    webhook: "webhook_github",
    cron: "cron",
  };

export async function delegateConversationalRunToLocal(input: {
  run_id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: AgentTrigger;
  payload: unknown;
}): Promise<void> {
  const source = TRIGGER_TO_WORK_ITEM_SOURCE[input.trigger] ?? "manual";
  if (isE2bOnlySource(source)) {
    throw new Error(`delegate-to-local refused: source '${source}' is e2b-only`);
  }
  const sb = serviceClient();
  const { error: stampErr } = await sb
    .from("agent_runs")
    .update({ agent_definition_hash: "local" })
    .eq("id", input.run_id)
    .eq("status", "running");
  if (stampErr) {
    throw new Error(`delegate-to-local stamp failed: ${stampErr.message}`);
  }
  const { error } = await sb.from("agent_work_items").insert({
    tenant_id: input.tenant_id,
    agent_slug: input.agent_slug,
    source,
    lane: "local",
    status: "pending",
    agent_run_id: input.run_id,
    payload: (input.payload ?? null) as object | null,
    work_type: "expensive",
    next_run_at: new Date().toISOString(),
  });
  if (error) {
    throw new Error(`delegate-to-local insert failed: ${error.message}`);
  }
}

export const LOCAL_LANE_RELANE_AFTER_MS = 30 * 60 * 1000;

export async function relaneStaleLocalItems(
  thresholdMs: number = LOCAL_LANE_RELANE_AFTER_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const { data, error } = await serviceClient()
    .from("agent_work_items")
    .update({ lane: "e2b", updated_at: new Date().toISOString() })
    .eq("lane", "local")
    .eq("status", "pending")
    .is("agent_run_id", null)
    .lt("next_run_at", cutoff)
    .select("id");
  if (error) return 0;
  return (data ?? []).length;
}

export async function enqueueWorkItem(
  input: EnqueueWorkItemInput,
): Promise<{ work_item_id: string }> {
  if (await isFleetHalted()) {
    throw new FleetHaltedError();
  }

  const isUserDirect =
    (input.source === "chat" || input.source === "manual") &&
    !!input.user_access_token;
  const rpcClient = isUserDirect
    ? serverClientFromBearer(input.user_access_token!)
    : serviceClient();

  const { lane, work_type } = isUserDirect
    ? { lane: "e2b" as WorkItemLane, work_type: null }
    : await resolveLaneAndWorkType(input);

  const { data, error } = await rpcClient.rpc("enqueue_work_item", {
    p_tenant_id: input.tenant_id,
    p_agent_slug: input.agent_slug,
    p_source: input.source,
    p_payload: (input.payload ?? null) as object | null,
    p_dedupe_key: input.dedupe_key ?? null,
    p_priority: input.priority ?? 0,
    p_next_run_at: input.next_run_at ?? new Date().toISOString(),
    p_risk_tier: input.risk_tier ?? null,
    p_work_type: work_type,
    p_lane: lane,
  });
  if (error) {
    throw new Error(`enqueue_work_item failed: ${error.message}`);
  }
  return { work_item_id: (data as string | null) ?? "" };
}

export type IngestAndEnqueueInput = {
  tenant_id: string;
  provider: string;
  external_event_id: string;
  event_type: string;
  ingest_payload: Record<string, unknown>;
  agent_slug: string;
  source: WorkItemSource;
  payload: Record<string, unknown>;
  dedupe_key?: string | null;
};

export type IngestAndEnqueueResult =
  | { duplicate: true }
  | { duplicate: false; ingested_event_id: string; work_item_id: string };

export async function ingestAndEnqueueWorkItem(
  input: IngestAndEnqueueInput,
): Promise<IngestAndEnqueueResult> {
  if (await isFleetHalted()) {
    throw new FleetHaltedError();
  }
  const { lane, work_type } = await resolveLaneAndWorkType({
    tenant_id: input.tenant_id,
    agent_slug: input.agent_slug,
    source: input.source,
    payload: input.payload,
  });
  const { data, error } = await serviceClient().rpc("ingest_and_enqueue_work", {
    p_tenant_id: input.tenant_id,
    p_provider: input.provider,
    p_external_event_id: input.external_event_id,
    p_event_type: input.event_type,
    p_ingest_payload: input.ingest_payload as object,
    p_agent_slug: input.agent_slug,
    p_source: input.source,
    p_work_payload: input.payload as object,
    p_dedupe_key: input.dedupe_key ?? null,
    p_work_type: work_type,
    p_lane: lane,
  });
  if (error) {
    throw new Error(`ingest_and_enqueue_work failed: ${error.message}`);
  }
  const row = (data ?? {}) as {
    duplicate?: boolean;
    ingested_event_id?: string;
    work_item_id?: string;
  };
  if (row.duplicate) return { duplicate: true };
  const work_item_id = String(row.work_item_id ?? "");

  void inngest
    .send({
      name: "agent.work_item.enqueued",
      data: { work_item_id, tenant_id: input.tenant_id, source: input.source },
    })
    .catch((e) => {
      void logEvent({
        level: "warn",
        source: "work-queue",
        code: "work_item.wake_send_failed",
        message: `drainer wake-up send failed for work item ${work_item_id}; falling back to the cron tick: ${(e as Error).message}`,
        tenant_id: input.tenant_id,
      }).catch(() => {});
    });

  return {
    duplicate: false,
    ingested_event_id: String(row.ingested_event_id ?? ""),
    work_item_id,
  };
}

export async function claimWorkItems(
  owner: string,
  limit = 10,
  leaseSeconds = 300,
  lane: WorkItemLane = "e2b",
  tenantId: string | null = null,
): Promise<WorkItem[]> {
  const { data, error } = await serviceClient().rpc("claim_agent_work_items", {
    p_owner: owner,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
    p_lane: lane,
    p_tenant_id: tenantId,
  });
  if (error) {
    throw new Error(`claim_agent_work_items failed: ${error.message}`);
  }
  return (data ?? []) as WorkItem[];
}

export async function completeLocalWorkItem(args: {
  id: string;
  tenant_id: string;
  owner: string;
  status: "done" | "failed" | "dropped";
  agent_run_id?: string | null;
  last_error?: string | null;
}): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("complete_local_work_item", {
    p_id: args.id,
    p_tenant_id: args.tenant_id,
    p_owner: args.owner,
    p_status: args.status,
    p_agent_run_id: args.agent_run_id ?? null,
    p_last_error: args.last_error ?? null,
  });
  if (error) {
    throw new Error(`complete_local_work_item failed: ${error.message}`);
  }
  return data === true;
}

export async function renewLocalLease(args: {
  id: string;
  tenant_id: string;
  owner: string;
  lease_seconds?: number;
}): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("renew_local_lease", {
    p_id: args.id,
    p_tenant_id: args.tenant_id,
    p_owner: args.owner,
    p_lease_seconds: args.lease_seconds ?? 3600,
  });
  if (error) {
    throw new Error(`renew_local_lease failed: ${error.message}`);
  }
  return data === true;
}

export async function touchLocalLaneDrained(tenant_id: string): Promise<void> {
  const { error } = await serviceClient().rpc("touch_tenant_local_lane_drained", {
    p_tenant_id: tenant_id,
  });
  if (error) {
    throw new Error(`touch_tenant_local_lane_drained failed: ${error.message}`);
  }
}

export async function completeWorkItem(
  id: string,
  status: "done" | "failed" | "dropped",
  agent_run_id: string | null = null,
  last_error: string | null = null,
): Promise<void> {
  const { error } = await serviceClient().rpc("complete_work_item", {
    p_id: id,
    p_status: status,
    p_agent_run_id: agent_run_id,
    p_last_error: last_error,
  });
  if (error) {
    throw new Error(`complete_work_item failed: ${error.message}`);
  }
}

export async function releaseWorkItemToPending(
  id: string,
  delaySeconds = 30,
): Promise<void> {
  const next = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const { error } = await serviceClient()
    .from("agent_work_items")
    .update({
      status: "pending",
      lease_owner: null,
      lease_expires_at: null,
      next_run_at: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "leased");
  if (error) {
    throw new Error(`releaseWorkItemToPending failed: ${error.message}`);
  }
}
