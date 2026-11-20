
import { serviceClient } from "@/services/supabase";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import {
  buildCustomWatchPayload,
  recordCustomAgentFailure,
  resolveCustomDeliver,
} from "@/services/agents/custom-agent-runs";
import { CUSTOM_WATCH_MIN_INTERVAL_MINUTES } from "@/services/agents/custom-agent-trigger-row";
import {
  checkUrlWatch,
  conditionIsPageOnly,
  extractWatchUrls,
  guardedRefetch,
  type Refetch,
  type UrlBaseline,
} from "@/services/agents/url-watch";
import {
  customScheduleDedupeKey,
  type CustomAgentFireRow,
  type CustomScheduleLogger,
} from "./custom-agent-schedules";

export type CustomWatchRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  interval_minutes: number | null;
  condition: string | null;
  deliver: unknown;
  next_due_at: string | null;
  last_checked_at: string | null;
  url_baseline: unknown;
  last_fingerprint: string | null;
};

export type CustomWatchDeps = {
  loadTriggers: (nowIso: string) => Promise<CustomWatchRow[]>;
  loadActiveAgents: (agentIds: string[]) => Promise<CustomAgentFireRow[]>;
  claim: (row: CustomWatchRow, nextDueIso: string, checkedIso: string) => Promise<boolean>;
  unclaim: (row: CustomWatchRow, setIso: string) => Promise<void>;
  markFired: (row: CustomWatchRow, firedIso: string) => Promise<void>;
  refetch: Refetch;
  tierAllowed: (tenant_id: string, slug: string) => Promise<boolean>;
  enqueue: typeof enqueueWorkItem;
  recordFailure: (args: {
    tenant_id: string;
    agent_id: string;
    trigger_id: string | null;
    key: string;
  }) => Promise<unknown>;
};

export type CustomWatchResult = {
  scanned: number;
  checked: number;
  fired: number;
  noDelta: number;
  notDue: number;
  skippedPlan: number;
  invalid: number;
  lostClaim: number;
};

export function watchIntervalMinutes(row: { interval_minutes: number | null }): number {
  const n = Number(row.interval_minutes);
  return Number.isFinite(n) && n >= CUSTOM_WATCH_MIN_INTERVAL_MINUTES
    ? Math.floor(n)
    : CUSTOM_WATCH_MIN_INTERVAL_MINUTES;
}

function baselineOf(raw: unknown): UrlBaseline {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: UrlBaseline = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function runCustomAgentWatches(
  bucket: string,
  opts: { shellTenantIds: ReadonlySet<string>; logger: CustomScheduleLogger; now?: Date },
  deps: CustomWatchDeps,
): Promise<CustomWatchResult> {
  const res: CustomWatchResult = {
    scanned: 0, checked: 0, fired: 0, noDelta: 0, notDue: 0, skippedPlan: 0, invalid: 0, lostClaim: 0,
  };
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const triggers = await deps.loadTriggers(nowIso);
  if (triggers.length === 0) return res;
  const agents = await deps.loadActiveAgents([...new Set(triggers.map((t) => t.agent_id))]);
  const agentOf = new Map(agents.filter((a) => a.status === "active").map((a) => [`${a.tenant_id}:${a.id}`, a]));

  for (const row of triggers) {
    try {
      await checkOne(row);
    } catch (e) {
      opts.logger.error(`scheduled-runs: custom watch ${row.id} failed: ${(e as Error).message}`);
    }
  }
  return res;

  async function checkOne(row: CustomWatchRow): Promise<void> {
    const agent = agentOf.get(`${row.tenant_id}:${row.agent_id}`);
    if (!agent) return;
    if (opts.shellTenantIds.has(row.tenant_id)) return;
    res.scanned += 1;

    if (row.next_due_at && new Date(row.next_due_at).getTime() > now.getTime()) {
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

    const occurrence = row.next_due_at ? new Date(row.next_due_at).toISOString() : bucket;
    const nextDueIso = new Date(now.getTime() + watchIntervalMinutes(row) * 60_000).toISOString();
    if (!(await deps.claim(row, nextDueIso, nowIso))) {
      res.lostClaim += 1;
      return;
    }
    res.checked += 1;
    const failure = {
      tenant_id: row.tenant_id,
      agent_id: agent.id,
      trigger_id: row.id,
      key: `invalid:${row.id}:${occurrence}`,
    };

    const condition = typeof row.condition === "string" ? row.condition.trim() : "";
    if (condition.length === 0 || !resolveCustomDeliver(row, agent).ok) {
      res.invalid += 1;
      opts.logger.warn(`scheduled-runs: custom watch ${row.id} has no condition or a malformed destination; not run`);
      await deps.recordFailure(failure);
      return;
    }

    let baseline: UrlBaseline | null = null;
    let changed: string[] = [];
    const urls = extractWatchUrls(condition);
    if (urls.length > 0 && conditionIsPageOnly(condition)) {
      try {
        const check = await checkUrlWatch(urls, baselineOf(row.url_baseline), deps.refetch);
        if (check.kind === "no_delta") {
          res.noDelta += 1;
          return;
        }
        baseline = check.baseline;
        changed = check.kind === "delta" ? check.changed : [];
      } catch (e) {
        opts.logger.warn(`scheduled-runs: custom watch ${row.id} page check errored, running the check: ${(e as Error).message}`);
      }
    }

    try {
      await deps.enqueue({
        tenant_id: row.tenant_id,
        agent_slug: agent.slug,
        source: "cron",
        payload: buildCustomWatchPayload(row, changed, baseline),
        dedupe_key: customScheduleDedupeKey(row.id, occurrence),
      });
      res.fired += 1;
    } catch (e) {
      opts.logger.error(`scheduled-runs: custom watch enqueue failed for ${row.tenant_id}/${agent.slug}: ${(e as Error).message}`);
      try {
        await deps.unclaim(row, nextDueIso);
      } catch (ue) {
        opts.logger.error(`scheduled-runs: custom watch unclaim failed for trigger ${row.id}: ${(ue as Error).message}`);
      }
      return;
    }
    try {
      await deps.markFired(row, nowIso);
    } catch (e) {
      opts.logger.warn(`scheduled-runs: custom watch ${row.id} last_fired_at not stamped: ${(e as Error).message}`);
    }
  }
}

export function defaultCustomWatchDeps(
  tierDecide: (tenant_id: string, slug: string) => Promise<{ allowed: boolean }>,
): CustomWatchDeps {
  return {
    loadTriggers: async (nowIso) => {
      const { data, error } = await serviceClient()
        .from("custom_agent_triggers")
        .select("id, tenant_id, agent_id, interval_minutes, condition, deliver, next_due_at, last_checked_at, url_baseline, last_fingerprint")
        .eq("kind", "watch")
        .eq("enabled", true)
        .or(`next_due_at.is.null,next_due_at.lte."${nowIso}"`);
      if (error) throw new Error(`custom_agent_triggers watch scan failed: ${error.message}`);
      return (data ?? []) as CustomWatchRow[];
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
    claim: async (row, nextDueIso, checkedIso) => {
      let q = serviceClient()
        .from("custom_agent_triggers")
        .update({ next_due_at: nextDueIso, last_checked_at: checkedIso })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id)
        .eq("kind", "watch")
        .eq("enabled", true);
      q = row.next_due_at == null ? q.is("next_due_at", null) : q.eq("next_due_at", row.next_due_at);
      const { data, error } = await q.select("id");
      if (error) throw new Error(`custom watch claim failed: ${error.message}`);
      return Array.isArray(data) && data.length === 1;
    },
    unclaim: async (row, setIso) => {
      const { error } = await serviceClient()
        .from("custom_agent_triggers")
        .update({ next_due_at: row.next_due_at })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id)
        .eq("next_due_at", setIso);
      if (error) throw new Error(`custom watch unclaim failed: ${error.message}`);
    },
    markFired: async (row, firedIso) => {
      const { error } = await serviceClient()
        .from("custom_agent_triggers")
        .update({ last_fired_at: firedIso })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id);
      if (error) throw new Error(`custom watch last_fired_at write failed: ${error.message}`);
    },
    refetch: (url) => guardedRefetch(url),
    tierAllowed: async (tenant_id, slug) => (await tierDecide(tenant_id, slug)).allowed,
    enqueue: enqueueWorkItem,
    recordFailure: (args) => recordCustomAgentFailure(args),
  };
}
