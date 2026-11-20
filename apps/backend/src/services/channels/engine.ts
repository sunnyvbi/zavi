
import { randomUUID } from "node:crypto";
import { getChannel, RETIRED_CHANNEL_MESSAGE, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { reserveEstimateFor } from "@/services/agents/credits";
import { loadChannelRecipe, recipeExists } from "./recipe";
import { CAP_REACHED_MESSAGE } from "./budget";
import { trackChannelRunStarted } from "@/services/analytics/action-events";
import {
  claimChannelRun,
  releaseChannelRunClaim,
  settleChannelRunClaim,
} from "./claim";
import { comingSoonMessage, isChannelLocked } from "./lock";
import { readChannelStopped } from "@/services/growth/channel-stopped";
import { topActionDef, type TopActionPayload } from "./top-actions";

export type ChannelRunRefusal =
  | { ok: false; reason: "unknown_channel"; message: string }
  | { ok: false; reason: "coming_soon"; message: string }
  | { ok: false; reason: "retired"; message: string }
  | { ok: false; reason: "founder_stopped"; message: string }
  | { ok: false; reason: "no_recipe"; message: string }
  | { ok: false; reason: "cap_reached"; message: string; spent_30d: number }
  | { ok: false; reason: "budget_unavailable"; message: string };

export type ChannelRunAccepted = {
  ok: true;
  run_id: string | null;
  channel_slug: string;
  executor: string;
  stamped: boolean;
  stamp_error?: string | null;
  duplicate?: boolean;
};

export type ChannelRunResult = ChannelRunAccepted | ChannelRunRefusal;

export type EngineDeps = {
  enqueue: (input: {
    slug: string;
    tenant_id: string;
    trigger: string;
    payload: Record<string, unknown>;
  }) => Promise<{ run_id: string }>;
  channelContext?: (tenant_id: string, channel_slug: string) => Promise<Record<string, unknown> | null>;
};

export type ChannelRedo = {
  action_key: string;
  action_title: string;
  note: string;
  kind?: "answer" | "do";
  redo_of_decision_id?: string | null;
  redo_of_action_id?: string | null;
  origin_run_id?: string | null;
  origin_position?: number | null;
  origin_of?: number | null;
};

export async function runChannelRecipe(
  tenant_id: string,
  channel_slug: string,
  deps: EngineDeps,
  redo?: ChannelRedo,
  extra?: Record<string, unknown>,
  request_id?: string | null,
  emailPlan?: Record<string, unknown> | null,
  topAction?: TopActionPayload | null,
  joinLane?: string | null,
): Promise<ChannelRunResult> {
  const channel = getChannel(channel_slug);
  if (!channel) {
    return {
      ok: false,
      reason: "unknown_channel",
      message: `Unknown channel: ${channel_slug}`,
    };
  }

  if (RETIRED_CHANNEL_SLUGS.has(channel_slug)) {
    return { ok: false, reason: "retired", message: RETIRED_CHANNEL_MESSAGE };
  }

  if (await isChannelLocked(channel_slug)) {
    return { ok: false, reason: "coming_soon", message: comingSoonMessage(channel.name) };
  }

  const stopped = await readChannelStopped(tenant_id, channel_slug);
  if (stopped !== false) {
    return {
      ok: false,
      reason: "founder_stopped",
      message: stopped
        ? `You stopped ${channel.name}. Turn it back on in your growth plan to run it.`
        : `Zavi could not check whether you stopped ${channel.name}, so it did not run. Try again.`,
    };
  }

  if (!recipeExists(channel_slug)) {
    return {
      ok: false,
      reason: "no_recipe",
      message: `${channel.name} has no recipe yet.`,
    };
  }

  const recipe = loadChannelRecipe(channel_slug);
  const topDef = topAction ? topActionDef(channel_slug, topAction.key) : null;
  if (topAction && !topDef) throw new Error(`unknown top action ${channel_slug}/${topAction.key}`);
  const estimate = topDef ? Math.max(1, topDef.reserve_credits) : reserveEstimateFor(recipe.meta.executor);

  const claim = await claimChannelRun(
    tenant_id,
    channel_slug,
    request_id?.trim() || randomUUID(),
    estimate,
    joinLane && !redo && !topAction && !emailPlan ? joinLane : null,
  );
  if (claim.kind === "cap_reached") {
    return {
      ok: false,
      reason: "cap_reached",
      message: CAP_REACHED_MESSAGE,
      spent_30d: claim.spent_30d,
    };
  }
  if (claim.kind === "unavailable") {
    return {
      ok: false,
      reason: "budget_unavailable",
      message: "Couldn't check this channel's budget. Try again shortly.",
    };
  }
  if (claim.kind === "duplicate") {
    return {
      ok: true,
      run_id: claim.run_id,
      channel_slug,
      executor: recipe.meta.executor,
      stamped: true,
      stamp_error: null,
      duplicate: true,
    };
  }

  const pending_proposals = await readPendingProposals(tenant_id, recipe.meta.executor);
  let channelContext: Record<string, unknown> | null = null;
  if (deps.channelContext) {
    try {
      channelContext = await deps.channelContext(tenant_id, channel_slug);
    } catch (err) {
      console.warn(
        `[channel-engine] context load failed for ${channel_slug}; running without it`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const { email_plan: _droppedPlan, top_action: _droppedTop, ...callerExtra } = extra ?? {};
  const recipeKeys: Record<string, unknown> = topAction
    ? { top_action: topAction }
    : {
        recipe_body: recipe.body,
        artifact: recipe.meta.artifact,
        inputs: recipe.meta.inputs,
        min_evidence: recipe.meta.min_evidence,
      };
  const payload: Record<string, unknown> = {
    ...callerExtra,
    ...(emailPlan ? { email_plan: emailPlan } : {}),
    ...(channelContext ?? {}),
    channel_slug,
    channel_claim_id: claim.claim_id,
    ...(pending_proposals.length > 0 ? { pending_proposals } : {}),
    ...recipeKeys,
    router: topAction ? [] : recipe.meta.router,
    ...(redo ? { redo } : {}),
    ...(redo?.redo_of_action_id ? { redo_of_action_id: redo.redo_of_action_id } : {}),
  };

  let run_id: string;
  try {
    ({ run_id } = await deps.enqueue({
      slug: recipe.meta.executor,
      tenant_id,
      trigger: "channel_recipe",
      payload,
    }));
  } catch (err) {
    await releaseChannelRunClaim(tenant_id, claim.claim_id);
    throw err;
  }

  if (!run_id) {
    await releaseChannelRunClaim(tenant_id, claim.claim_id);
    return {
      ok: false,
      reason: "budget_unavailable",
      message: "Couldn't start this channel run. Try again shortly.",
    };
  }

  let stamped = false;
  let stamp_error: string | null = null;
  for (let attempt = 1; attempt <= 2 && !stamped; attempt++) {
    try {
      const res = await tenantRpc(asTenantId(tenant_id), "stamp_channel_run", {
        p_run_id: run_id,
        p_channel_slug: channel_slug,
      });
      stamped = res.data === true;
      stamp_error = stamped ? null : ((res.error?.message as string | undefined) ?? "rpc returned false");
    } catch (err) {
      stamp_error = err instanceof Error ? err.message : String(err);
    }
  }
  if (stamped) trackChannelRunStarted({ tenant_id, channel_slug, path: "recipe" });

  if (stamped) {
    try {
      await tenantRpc(asTenantId(tenant_id), "record_channel_run", { p_run_id: run_id });
    } catch {
    }
  }

  await settleChannelRunClaim(tenant_id, claim.claim_id, run_id, stamped);

  return {
    ok: true,
    run_id,
    channel_slug,
    executor: recipe.meta.executor,
    stamped,
    stamp_error,
    duplicate: false,
  };
}

const EMAIL_SEND_CLASSES = new Set(["bulk_outbound.send", "email_campaign.create_and_send"]);

export type PendingProposal = {
  id: string;
  decision_class: string;
  state: "pending" | "approved" | "applied";
  applied_at: string | null;
  name: string | null;
  campaign_id: string | null;
  ad_group_id: string | null;
  level: string | null;
  emitted_at: string;
};

const PENDING_PROPOSALS_CAP = 20;
const RECENT_APPLIED_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_RUNS_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const RECENT_RUNS_CAP = 60;

export async function readPendingProposals(
  tenant_id: string,
  executor: string,
): Promise<PendingProposal[]> {
  try {
    const client = tenantClient(asTenantId(tenant_id));
    const statusFilter = `status.eq.proposed,and(status.eq.acted,emitted_at.gte.${new Date(Date.now() - RECENT_APPLIED_MS).toISOString()})`;
    const cols = "id, decision_class, status, body, emitted_at, dispatched_at, approved_by";
    const since = new Date(Date.now() - RECENT_RUNS_LOOKBACK_MS).toISOString();
    const { data: runs } = await client
      .from("agent_runs")
      .select("id")
      .eq("agent_slug", executor)
      .gte("enqueued_at", since)
      .order("enqueued_at", { ascending: false })
      .limit(RECENT_RUNS_CAP);
    const runIds = Array.isArray(runs) ? (runs as Array<{ id: string }>).map((r) => r.id) : [];
    const appliedSince = new Date(Date.now() - RECENT_APPLIED_MS).toISOString();
    const execState = `status.in.(pending,snoozed),exec_status.in.(queued,dispatching),and(exec_status.eq.executed,executed_at.gte.${appliedSince})`;
    const execCols = "id, exec_class, status, exec_status, exec_payload, proposed_at, executed_at";
    const [byRun, byClass, actionsByRun, actionsByClass] = await Promise.all([
      runIds.length > 0
        ? client
            .from("decisions")
            .select(cols)
            .in("agent_run_id", runIds)
            .not("decision_class", "like", "channel.%")
            .or(statusFilter)
            .order("emitted_at", { ascending: false })
            .limit(PENDING_PROPOSALS_CAP)
        : Promise.resolve({ data: [], error: null }),
      client
        .from("decisions")
        .select(cols)
        .like("decision_class", `${executor}.%`)
        .or(statusFilter)
        .order("emitted_at", { ascending: false })
        .limit(PENDING_PROPOSALS_CAP),
      runIds.length > 0
        ? client
            .from("channel_actions")
            .select(execCols)
            .in("run_id", runIds)
            .not("exec_class", "is", null)
            .or(execState)
            .order("proposed_at", { ascending: false })
            .limit(PENDING_PROPOSALS_CAP)
        : Promise.resolve({ data: [], error: null }),
      client
        .from("channel_actions")
        .select(execCols)
        .like("exec_class", `${executor}.%`)
        .or(execState)
        .order("proposed_at", { ascending: false })
        .limit(PENDING_PROPOSALS_CAP),
    ]);
    type Row = {
      id: string;
      decision_class: string;
      status: string;
      body: unknown;
      emitted_at: string;
      dispatched_at: string | null;
      approved_by?: string | null;
    };
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const res of [byRun, byClass]) {
      if (res.error || !Array.isArray(res.data)) continue;
      for (const r of res.data as Row[]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        rows.push(r);
      }
    }
    const appliedAfter = Date.now() - RECENT_APPLIED_MS;
    for (const res of [actionsByRun, actionsByClass]) {
      if (res.error || !Array.isArray(res.data)) continue;
      for (const a of res.data as Array<{
        id: string;
        exec_class: string | null;
        status: string;
        exec_status: string | null;
        exec_payload: unknown;
        proposed_at: string;
        executed_at: string | null;
      }>) {
        if (!a.exec_class || seen.has(a.id)) continue;
        const inFlight =
          a.status === "pending" ||
          a.status === "snoozed" ||
          a.exec_status === "queued" ||
          a.exec_status === "dispatching";
        const applied =
          a.exec_status === "executed" &&
          !!a.executed_at &&
          Date.parse(a.executed_at) >= appliedAfter;
        if (!inFlight && !applied) continue;
        seen.add(a.id);
        rows.push({
          id: a.id,
          decision_class: a.exec_class,
          status: applied ? "acted" : "proposed",
          body: a.exec_payload,
          emitted_at: a.proposed_at,
          dispatched_at: a.executed_at,
          approved_by: a.exec_status === "queued" || a.exec_status === "dispatching" ? "approved" : null,
        });
      }
    }
    rows.sort((a, b) => (a.emitted_at < b.emitted_at ? 1 : -1));
    rows.splice(PENDING_PROPOSALS_CAP);
    return rows.map((row) => {
      const body = (row.body && typeof row.body === "object" ? row.body : {}) as Record<string, unknown>;
      const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
      const state: PendingProposal["state"] =
        row.status === "acted" ? "applied" : row.approved_by && EMAIL_SEND_CLASSES.has(row.decision_class) ? "approved" : "pending";
      return {
        id: row.id,
        decision_class: row.decision_class,
        state,
        applied_at: state === "applied" ? row.dispatched_at : null,
        name: str("name") ?? str("list_name"),
        campaign_id: str("campaign_id"),
        ad_group_id: str("ad_group_id"),
        level: str("level"),
        emitted_at: row.emitted_at,
      };
    });
  } catch {
    return [];
  }
}
