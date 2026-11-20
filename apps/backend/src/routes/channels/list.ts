
import type { Request, Response } from "express";
import { CHANNELS, linkedWithAliases } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { readSiteReadState } from "@/services/tools/growth/seo/snapshot";
import { serverClientFromBearer } from "@/services/supabase";
import { recipeExists } from "@/services/channels/recipe";
import { pinLiveBetsHigh, readStrategyFit } from "@/services/growth/channel-fit";
import { readChannelStates, type ChannelState, type ChannelStatesRead } from "@/services/channels/state";
import { seedTenantChannels } from "@/services/tenants/seed-channels";
import { readLockedChannelSlugs } from "@/services/channels/lock";
import { isRecordOnlyRun } from "@/services/channels/record-only-run";
import { firstRoundOpenChannels } from "@/services/channels/preview-run-starts";
import { annotateLockedTier, tenantPlanForDisplay } from "@/services/agents/entitlement";
import { staleRunReapHours } from "@/services/agents/stale-run-reaper";
import { costToCredits, reserveEstimateFor } from "@/services/agents/credits";
import { starterVideoCredits, starterVideoEstimateUsd } from "@/services/launch-video/video-estimate";
import type { WatchVerdict } from "@/services/channels/watch";
import type { Tier } from "@/services/billing/tiers";

export type TenantChannelRow = {
  channel_slug: string;
  delivery_mode: "advise" | "produce" | "execute";
  work_state: "idle" | "running" | "needs_review" | "delivered";
  priority: number;
  last_run_at: string | null;
  last_probe_at: string | null;
  last_probe_delta: WatchVerdict | null;
  plan_intent: string | null;
  plan_rationale: string | null;
  fit: { value: "high" | "medium" | "low"; line: string } | null;
};

export type TenantChannelView = TenantChannelRow & {
  connected: boolean;
  connectors: string[];
  linked_connectors: string[];
  runnable: boolean;
  locked: boolean;
  locked_tier?: Tier | null;
  last_run_id: string | null;
  run_reserve_credits: number;
  video_credits_each: number | null;
};

export function deliveryModeFor(
  slug: string,
  connectors: readonly string[],
  linked: ReadonlySet<string>,
  readiness: string,
): TenantChannelRow["delivery_mode"] {
  if (readiness === "live" && connectors.length > 0 && connectors.some((c) => linked.has(c))) {
    return "execute";
  }
  return recipeExists(slug) ? "produce" : "advise";
}

export function workStateFor(
  latest: { status: string; started_at: string | null } | undefined,
  now: number,
  staleMs: number,
): TenantChannelRow["work_state"] {
  if (!latest) return "idle";

  if (latest.status === "queued" || latest.status === "running") {
    const started = latest.started_at ? Date.parse(latest.started_at) : NaN;
    if (!Number.isFinite(started)) return "running";
    return now - started < staleMs ? "running" : "needs_review";
  }

  if (latest.status === "success") return "delivered";
  return "needs_review";
}

export type LatestRun = {
  id: string | null;
  status: string;
  started_at: string | null;
  at: string | null;
};

export type LatestRunRow = {
  id: string | null;
  channel_slug: string;
  status: string;
  enqueued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  agent_definition_hash?: string | null;
};

export function foldLatestRuns(rows: LatestRunRow[]): Map<string, LatestRun> {
  const latestRun = new Map<string, LatestRun>();
  for (const r of rows) {
    if (isRecordOnlyRun(r.agent_definition_hash)) continue;
    if (!latestRun.has(r.channel_slug)) {
      latestRun.set(r.channel_slug, {
        id: r.id ?? null,
        status: r.status,
        started_at: r.started_at,
        at: r.finished_at ?? r.started_at ?? r.enqueued_at,
      });
    }
  }
  return latestRun;
}

export function assembleChannels(input: {
  states: readonly ChannelState[];
  linked: ReadonlySet<string>;
  latestRun: ReadonlyMap<string, LatestRun>;
  runsAvailable: boolean;
  now: number;
  staleMs: number;
  locked?: ReadonlySet<string>;
  planBets?: ReadonlyMap<string, { intent: string | null; rationale: string | null }>;
  fits?: ReadonlyMap<string, { value: "high" | "medium" | "low"; line: string }>;
  videoCreditsEach?: number;
}): TenantChannelView[] {
  const { states, linked, latestRun, runsAvailable, now, staleMs } = input;
  const locked = input.locked ?? new Set<string>();
  const planBets = input.planBets ?? new Map<string, { intent: string | null; rationale: string | null }>();

  return states
    .map(({ channel: ch, ...state }) => {
      const latest = latestRun.get(ch.slug);
      const connectors = [...ch.connectors];
      return {
        channel_slug: ch.slug,
        delivery_mode: deliveryModeFor(ch.slug, ch.connectors, linked, ch.readiness),
        work_state: runsAvailable ? workStateFor(latest, now, staleMs) : state.work_state,
        last_run_at: (runsAvailable ? (latest?.at ?? null) : null) ?? state.last_run_at,
        priority: state.priority,
        last_probe_at: state.last_probe_at,
        last_probe_delta: state.last_probe_delta,
        plan_intent: planBets.get(ch.slug)?.intent ?? null,
        plan_rationale: planBets.get(ch.slug)?.rationale ?? null,
        fit: input.fits?.get(ch.slug) ?? null,
        connected: connectors.some((c) => linked.has(c)),
        connectors,
        linked_connectors: connectors.filter((c) => linked.has(c)),
        runnable: recipeExists(ch.slug),
        locked: locked.has(ch.slug),
        last_run_id: runsAvailable ? (latest?.id ?? null) : null,
        run_reserve_credits: reserveEstimateFor(ch.executor),
        video_credits_each: ch.slug === "generated_video" ? input.videoCreditsEach ?? costToCredits(starterVideoEstimateUsd()) : null,
      };
    })
    .sort(
      (a, b) => a.priority - b.priority || a.channel_slug.localeCompare(b.channel_slug),
    );
}

function planText(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : null;
}

export { pinLiveBetsHigh, readStrategyFit } from "@/services/growth/channel-fit";

async function readLivePlanBets(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
): Promise<ReadonlyMap<string, { intent: string | null; rationale: string | null; status?: string | null }>> {
  const empty = new Map<string, { intent: string | null; rationale: string | null; status?: string | null }>();
  try {
    const { data: planRows, error: planErr } = await sb
      .from("growth_plan")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("status", "live")
      .limit(1);
    if (planErr || !planRows || planRows.length === 0) return empty;
    const planId = (planRows[0] as { id?: unknown }).id;
    if (typeof planId !== "string") return empty;

    const { data, error } = await sb
      .from("growth_plan_bets")
      .select("channel_slug, intent, rationale, status")
      .eq("tenant_id", tenant_id)
      .eq("plan_id", planId)
      .limit(50);
    if (error || !data) return empty;

    const out = new Map<string, { intent: string | null; rationale: string | null; status?: string | null }>();
    for (const row of data as Array<Record<string, unknown>>) {
      const slug = typeof row.channel_slug === "string" ? row.channel_slug : null;
      if (!slug) continue;
      out.set(slug, {
        intent: planText(row.intent),
        rationale: planText(row.rationale),
        status: typeof row.status === "string" ? row.status : null,
      });
    }
    return out;
  } catch {
    return empty;
  }
}

export async function readChannelStatesSeeded(
  read: () => Promise<ChannelStatesRead>,
  seed: () => Promise<{ channels_inserted: number; error: string | null }>,
): Promise<ChannelStatesRead> {
  const first = await read();
  if (first.rowCount > 0 || first.error) return first;
  const seeded = await seed().catch((e: Error) => ({ channels_inserted: 0, error: e.message }));
  if (seeded.error) {
    console.warn(`[channels/list] seeding an unseeded tenant failed: ${seeded.error}`);
    return first;
  }
  return read();
}

export async function channelsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { states, rowCount, error } = await readChannelStatesSeeded(
    () => readChannelStates(supabase, auth.tenant_id),
    () => seedTenantChannels(auth.tenant_id),
  );
  let channel_locks_known = true;
  const tiers = await annotateLockedTier(
    CHANNELS.map((c) => ({ slug: c.slug })),
    auth.tenant_id,
    () => {
      channel_locks_known = false;
    },
  );
  const channel_locks: Record<string, Tier | null> = Object.fromEntries(
    tiers.map((t) => [t.slug, t.locked_tier]),
  );

  if (error) {
    res.status(500).json({ error: { code: "list_failed", message: error } });
    return;
  }

  if (rowCount === 0) {
    res.json({ channels: [], channel_locks, channel_locks_known });
    return;
  }

  const { data: conn } = await supabase
    .from("connector_metadata")
    .select("slug")
    .eq("tenant_id", auth.tenant_id);
  const linked = linkedWithAliases(((conn ?? []) as Array<{ slug: string }>).map((c) => c.slug));

  const { data: runRows } = await supabase
    .from("agent_runs")
    .select("id, channel_slug, status, enqueued_at, started_at, finished_at, agent_definition_hash")
    .eq("tenant_id", auth.tenant_id)
    .not("channel_slug", "is", null)
    .order("enqueued_at", { ascending: false, nullsFirst: false })
    .limit(200);
  const latestRun = foldLatestRuns((runRows ?? []) as LatestRunRow[]);
  const now = Date.now();
  const staleMs = staleRunReapHours() * 60 * 60 * 1000;
  const locked = await readLockedChannelSlugs();

  const planBets = await readLivePlanBets(supabase, auth.tenant_id);
  const strategyFit = await readStrategyFit(auth.tenant_id);
  const fits = pinLiveBetsHigh(strategyFit.fits, planBets);

  const channels = assembleChannels({
    states,
    linked,
    latestRun,
    runsAvailable: Boolean(runRows),
    now,
    staleMs,
    locked,
    planBets,
    fits,
    videoCreditsEach: await starterVideoCredits(),
  });

  const tenant_tier = await tenantPlanForDisplay(auth.tenant_id);

  const firstRoundOpen = await firstRoundOpenChannels(
    auth.tenant_id,
    Object.keys(channel_locks).filter((slug) => channel_locks[slug] !== null),
  );

  const site_read = await readSiteReadState(auth.tenant_id);

  res.json({
    channels: channels.map((c) => {
      const locked_tier = channel_locks[c.channel_slug] ?? null;
      return { ...c, locked_tier, first_round_open: locked_tier !== null && firstRoundOpen.has(c.channel_slug) };
    }),
    channel_locks,
    channel_locks_known,
    tenant_tier,
    has_strategy: strategyFit.has_strategy,
    site_read,
  });
}
