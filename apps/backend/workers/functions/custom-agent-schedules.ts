
import { serviceClient } from "@/services/supabase";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import {
  buildCustomSchedulePayload,
  recordCustomAgentFailure,
  resolveCustomDeliver,
} from "@/services/agents/custom-agent-runs";
import {
  cronDueInBucket,
  nextLocalCronFire,
} from "./cron-match";

export { triggerScheduleValid, type CustomTriggerRow } from "@/services/agents/custom-agent-trigger-row";
import type { CustomTriggerRow } from "@/services/agents/custom-agent-trigger-row";
import { triggerScheduleValid } from "@/services/agents/custom-agent-trigger-row";

export type CustomAgentFireRow = {
  id: string;
  tenant_id: string;
  slug: string;
  status: string;
  default_deliver: unknown;
};

export type CustomScheduleLogger = {
  info: (s: string) => void;
  warn: (s: string) => void;
  error: (s: string) => void;
};

export type CustomScheduleDeps = {
  loadTriggers: (nowIso: string) => Promise<CustomTriggerRow[]>;
  loadActiveAgents: (agentIds: string[]) => Promise<CustomAgentFireRow[]>;
  claim: (row: CustomTriggerRow, nextDueIso: string) => Promise<boolean>;
  unclaim: (row: CustomTriggerRow, setIso: string) => Promise<void>;
  tierAllowed: (tenant_id: string, slug: string) => Promise<boolean>;
  enqueue: typeof enqueueWorkItem;
  recordFailure: (args: {
    tenant_id: string;
    agent_id: string;
    trigger_id: string | null;
    key: string;
  }) => Promise<unknown>;
};

export type CustomScheduleResult = {
  scanned: number;
  fired: number;
  notDue: number;
  skippedPlan: number;
  invalid: number;
  lostClaim: number;
};

const FIVE_MIN_MS = 5 * 60_000;
const NEVER_FIRES_PARK_MS = 366 * 24 * 60 * 60_000;

export function customScheduleDedupeKey(trigger_id: string, occurrence: string): string {
  return `custom:${trigger_id}:${occurrence}`;
}

export async function runCustomAgentSchedules(
  bucket: string,
  opts: { shellTenantIds: ReadonlySet<string>; logger: CustomScheduleLogger; now?: Date },
  deps: CustomScheduleDeps,
): Promise<CustomScheduleResult> {
  const res: CustomScheduleResult = { scanned: 0, fired: 0, notDue: 0, skippedPlan: 0, invalid: 0, lostClaim: 0 };
  const now = opts.now ?? new Date();
  const triggers = await deps.loadTriggers(now.toISOString());
  if (triggers.length === 0) return res;
  const agents = await deps.loadActiveAgents([...new Set(triggers.map((t) => t.agent_id))]);
  const agentOf = new Map(agents.filter((a) => a.status === "active").map((a) => [`${a.tenant_id}:${a.id}`, a]));
  const afterNow = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);

  for (const row of triggers) {
    try {
      await fireOne(row);
    } catch (e) {
      opts.logger.error(`scheduled-runs: custom trigger ${row.id} failed: ${(e as Error).message}`);
    }
  }
  return res;

  async function fireOne(row: CustomTriggerRow): Promise<void> {
    const agent = agentOf.get(`${row.tenant_id}:${row.agent_id}`);
    if (!agent) return;
    if (opts.shellTenantIds.has(row.tenant_id)) return;
    res.scanned += 1;

    const occurrence = row.next_due_at ? new Date(row.next_due_at).toISOString() : bucket;
    const failure = {
      tenant_id: row.tenant_id,
      agent_id: agent.id,
      trigger_id: row.id,
      key: `invalid:${row.id}:${occurrence}`,
    };

    if (!triggerScheduleValid(row)) {
      res.invalid += 1;
      if (await deps.claim(row, new Date(now.getTime() + FIVE_MIN_MS).toISOString())) {
        opts.logger.warn(`scheduled-runs: custom trigger ${row.id} has an invalid schedule; not run`);
        await deps.recordFailure(failure);
      }
      return;
    }
    const expr = row.cron as string;
    const tz = row.tz as string;

    const due = row.next_due_at
      ? new Date(row.next_due_at).getTime() <= now.getTime()
      : cronDueInBucket(expr, bucket, tz);
    if (!due) {
      res.notDue += 1;
      return;
    }

    let allowed = false;
    try {
      allowed = await deps.tierAllowed(row.tenant_id, agent.slug);
    } catch (e) {
      opts.logger.warn(`scheduled-runs: tier unreadable for custom ${row.tenant_id}/${agent.slug}, skipping: ${(e as Error).message}`);
    }
    if (!allowed) {
      res.skippedPlan += 1;
      return;
    }

    const next = nextLocalCronFire(expr, tz, afterNow);
    const nextDueIso = (next ?? new Date(afterNow.getTime() + NEVER_FIRES_PARK_MS)).toISOString();
    if (!(await deps.claim(row, nextDueIso))) {
      res.lostClaim += 1;
      return;
    }

    if (!resolveCustomDeliver(row, agent).ok) {
      res.invalid += 1;
      await deps.recordFailure(failure);
      return;
    }

    try {
      await deps.enqueue({
        tenant_id: row.tenant_id,
        agent_slug: agent.slug,
        source: "cron",
        payload: buildCustomSchedulePayload(row),
        dedupe_key: customScheduleDedupeKey(row.id, occurrence),
      });
      res.fired += 1;
    } catch (e) {
      opts.logger.error(`scheduled-runs: custom enqueue failed for ${row.tenant_id}/${agent.slug}: ${(e as Error).message}`);
      try {
        await deps.unclaim(row, nextDueIso);
      } catch (ue) {
        opts.logger.error(`scheduled-runs: custom unclaim failed for trigger ${row.id}: ${(ue as Error).message}`);
      }
    }
  }
}

export function defaultCustomScheduleDeps(
  tierDecide: (tenant_id: string, slug: string) => Promise<{ allowed: boolean }>,
): CustomScheduleDeps {
  return {
    loadTriggers: async (nowIso) => {
      const { data, error } = await serviceClient()
        .from("custom_agent_triggers")
        .select("id, tenant_id, agent_id, cron, tz, deliver, next_due_at, last_result_summary")
        .eq("kind", "schedule")
        .eq("enabled", true)
        .or(`next_due_at.is.null,next_due_at.lte."${nowIso}"`);
      if (error) throw new Error(`custom_agent_triggers scan failed: ${error.message}`);
      return (data ?? []) as CustomTriggerRow[];
    },
    loadActiveAgents: async (ids) => {
      if (ids.length === 0) return [];
      const { data, error } = await serviceClient()
        .from("custom_agents")
        .select("id, tenant_id, slug, status, default_deliver")
        .in("id", ids)
        .eq("status", "active");
      if (error) throw new Error(`custom_agents scan failed: ${error.message}`);
      return (data ?? []) as CustomAgentFireRow[];
    },
    claim: async (row, nextDueIso) => {
      let q = serviceClient()
        .from("custom_agent_triggers")
        .update({ next_due_at: nextDueIso, last_fired_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id)
        .eq("enabled", true);
      q = row.next_due_at == null ? q.is("next_due_at", null) : q.eq("next_due_at", row.next_due_at);
      const { data, error } = await q.select("id");
      if (error) throw new Error(`custom trigger claim failed: ${error.message}`);
      return Array.isArray(data) && data.length === 1;
    },
    unclaim: async (row, setIso) => {
      const { error } = await serviceClient()
        .from("custom_agent_triggers")
        .update({ next_due_at: row.next_due_at })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id)
        .eq("next_due_at", setIso);
      if (error) throw new Error(`custom trigger unclaim failed: ${error.message}`);
    },
    tierAllowed: async (tenant_id, slug) => (await tierDecide(tenant_id, slug)).allowed,
    enqueue: enqueueWorkItem,
    recordFailure: (args) => recordCustomAgentFailure(args),
  };
}
