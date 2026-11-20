
import { isChannelOnlyAgent } from "@/services/agents/registry";
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { listAgents } from "@/services/agents/registry";
import { getTenantDisabledSlugs } from "@/services/agents/visibility";
import { annotateLockedTier } from "@/services/agents/entitlement";
import { listCustomAgentsForTree } from "@/services/agents/custom-agents";
import { isCustomAgentSlug } from "@/services/billing/tiers";
import { countThreadsBySlug } from "@/services/agents/thread-counts";
import { scrubForeignThreadBindings } from "@/services/workspace/scrubThreadBindings";
import { scrubForeignBuildSessions } from "@/services/workspace/scrubBuildSessionBindings";
import { logEvent } from "@/services/logging/logEvent";
import { tenantDayStartIso } from "@/services/tenants/local-day";
import { isSupplyDemandEligible, isSupplyDemandReachable } from "@/services/marketplace-intel/eligibility";
import { getLatestConfirmedMapping } from "@/services/tools/operator-db/mapping";
import {
  countOpenChannelActions,
  totalWaitingOnYou,
} from "@/services/channels/open-actions-count";

export async function workspaceBootstrap(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);

  const costFloorIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  const [
    disabledSlugs,
    runtimeRes,
    sessionRes,
    costRes,
    activeRes,
    approvalsRes,
    openChannelActions,
    prefsRes,
    tenantRes,
    hasSupplyDemandMapping,
  ] = await Promise.all([
    getTenantDisabledSlugs(auth.tenant_id),
    supabase.rpc("list_agents_for_tenant"),
    supabase.rpc("get_tabs_session"),
    supabase
      .from("agent_runs")
      .select("cost_usd, started_at")
      .eq("tenant_id", auth.tenant_id)
      .neq("agent_definition_hash", "seed-synthetic")
      .gte("started_at", costFloorIso),
    supabase
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id)
      .neq("agent_definition_hash", "seed-synthetic")
      .in("status", ["queued", "running"]),
    supabase
      .from("customer_visible_pending_decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id),
    countOpenChannelActions(supabase, auth.tenant_id),
    Promise.resolve(supabase.rpc("get_user_prefs")).catch((e: unknown) => ({
      data: null,
      error: { message: e instanceof Error ? e.message : String(e) },
    })),
    (async () => {
      try {
        return await supabase
          .from("tenants")
          .select("timezone, company_shape, company_shape_source")
          .eq("id", auth.tenant_id)
          .maybeSingle();
      } catch {
        return { data: null, error: null };
      }
    })(),
    (async () => {
      try {
        return (await getLatestConfirmedMapping(auth.tenant_id)) !== null;
      } catch {
        return false;
      }
    })(),
  ]);

  const visibleAgents = listAgents().filter((a) => !disabledSlugs.has(a.slug));
  const registryAgents = await annotateLockedTier(visibleAgents, auth.tenant_id);
  const customAgents = await listCustomAgentsForTree(auth.tenant_id);
  const entitledSlugs = new Set([...registryAgents.map((a) => a.slug), ...customAgents.map((c) => c.slug)]);

  if (sessionRes.error) {
    res.status(500).json({
      error: {
        code: "tabs_session_query_failed",
        message: sessionRes.error.message,
      },
    });
    return;
  }

  type RuntimeRow = {
    slug: string;
    latest_run_started_at: string | null;
    latest_run_status: string | null;
    latest_event_preview: string;
    pending_decisions_count: number;
    has_unseen_pending: boolean;
    unseen_thread_count: number;
  };
  const runtimeBySlug = new Map<string, RuntimeRow>();
  if (!runtimeRes.error && runtimeRes.data) {
    for (const r of runtimeRes.data as RuntimeRow[]) {
      runtimeBySlug.set(r.slug, r);
    }
  }
  const threadCountBySlug = await countThreadsBySlug(
    supabase,
    auth.tenant_id,
    auth.user_id,
  );
  const treeAgents = [
    ...registryAgents,
    ...customAgents.map((c) => ({ ...c, metadata_praxis: undefined as { department?: string } | undefined })),
  ].map((a) => {
    const rt = runtimeBySlug.get(a.slug);
    return {
      slug: a.slug,
      thread_count: threadCountBySlug.get(a.slug) ?? 0,
      department: a.metadata_praxis?.department ?? "others",
      locked_tier: a.locked_tier,
      latest_run_started_at: rt?.latest_run_started_at ?? null,
      latest_run_status: rt?.latest_run_status ?? null,
      latest_event_preview: rt?.latest_event_preview ?? "",
      pending_decisions_count: rt?.pending_decisions_count ?? 0,
      has_unseen_pending: rt?.has_unseen_pending ?? true,
      unseen_thread_count: rt?.unseen_thread_count ?? 0,
      ...(isCustomAgentSlug(a.slug)
        ? { name: a.name, custom: true, ...("id" in a && typeof a.id === "string" ? { custom_agent_id: a.id } : {}) }
        : {}),
    };
  });

  const sessionRow = Array.isArray(sessionRes.data)
    ? sessionRes.data[0]
    : sessionRes.data;

  const rawSession = (sessionRow ?? { tabs: [], active_tab_id: null }) as {
    tabs: Array<{
      id?: string;
      payload?: { kind?: string; slug?: string; threadId?: string | null };
    }>;
    active_tab_id: string | null;
  };
  const visibleTabs = (rawSession.tabs ?? []).filter((t) => {
    const p = t.payload;
    if (!p || p.kind !== "agent" || !p.slug) return true;
    return !disabledSlugs.has(p.slug) && !isChannelOnlyAgent(p.slug);
  });
  const planFilteredTabs = visibleTabs.filter((t) => {
    const slug = (t as { payload?: { slug?: string } }).payload?.slug;
    return !slug || entitledSlugs.has(slug);
  });
  const threadScrubbedTabs = await scrubForeignThreadBindings(
    planFilteredTabs,
    auth.tenant_id,
    auth.user_id,
  );
  const scrubbedTabs = await scrubForeignBuildSessions(
    threadScrubbedTabs,
    auth.tenant_id,
  );
  const surviving = new Set(
    scrubbedTabs.map((t) => t.id).filter((x): x is string => typeof x === "string"),
  );
  const activeTabId =
    rawSession.active_tab_id && surviving.has(rawSession.active_tab_id)
      ? rawSession.active_tab_id
      : null;

  const tenantRow = (
    tenantRes as {
      data?: { timezone?: string | null; company_shape?: string | null; company_shape_source?: string | null } | null;
    } | null
  )?.data;
  const tenantTz = tenantRow?.timezone ?? null;
  const declaredShape = tenantRow?.company_shape_source === "inferred" ? null : tenantRow?.company_shape;
  const supply_demand_eligible = isSupplyDemandEligible(
    declaredShape,
    hasSupplyDemandMapping === true,
  );
  const supply_demand_reachable = isSupplyDemandReachable(declaredShape);
  const todayStartMs = Date.parse(tenantDayStartIso(tenantTz));
  const cost_today_usd = (costRes.data ?? []).reduce((sum, row) => {
    const r = row as { cost_usd: number | null; started_at: string | null };
    const t = r.started_at ? Date.parse(r.started_at) : NaN;
    if (!Number.isFinite(t) || t < todayStartMs) return sum;
    return sum + (r.cost_usd ?? 0);
  }, 0);

  let prefs: Record<string, unknown> = {};
  if (prefsRes.error) {
    void logEvent({
      level: "warn",
      source: "workspace_bootstrap",
      code: "workspace.prefs.read_failed",
      tenant_id: auth.tenant_id,
      message: prefsRes.error.message,
    });
  } else if (
    prefsRes.data &&
    typeof prefsRes.data === "object" &&
    !Array.isArray(prefsRes.data)
  ) {
    prefs = prefsRes.data as Record<string, unknown>;
  }

  res.json({
    tree: { agents: treeAgents },
    tabs_session: { tabs: scrubbedTabs, active_tab_id: activeTabId },
    status_counters: {
      drift_pct: 0,
      cost_today_usd,
      active_runs: activeRes.count ?? 0,
      approvals_pending: totalWaitingOnYou(approvalsRes.count, openChannelActions),
    },
    prefs,
    supply_demand_eligible,
    supply_demand_reachable,
  });
}
