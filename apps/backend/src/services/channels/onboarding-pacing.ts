
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { PREVIEW_RUN_KEY_PREFIX } from "@/services/billing/tiers";
import { logEvent } from "@/services/logging/logEvent";

const OTHER_CHANNELS = "*";

export const PACING_CHANNEL_ORDER: readonly string[] = [
  "linkedin_organic",
  "reddit_organic",
  "geo",
  "seo",
  OTHER_CHANNELS,
  "x_organic",
  "instagram_organic",
];

export const PACING_HOLD_DAYS = 10;
const DAY_MS = 86_400_000;
const FIRST_RUN_KEY_PREFIX = "first-run:";
const PREVIEW_DONE_KEY_PREFIX = "first-run-preview-done:";

export type PacingCard = {
  id: string;
  channel_slug: string;
  status: string;
  held_reason: string | null;
  touched: boolean;
};

export type PacingPlan = { focus: string | null; hold: string[]; release: string[] };

function channelRank(order: readonly string[], slug: string): [number, string] {
  const i = order.indexOf(slug);
  return [i >= 0 ? i : order.indexOf(OTHER_CHANNELS), slug];
}

export function planPacing(
  cards: readonly PacingCard[],
  order: readonly string[] = PACING_CHANNEL_ORDER,
  opts: { frozen?: boolean } = {},
): PacingPlan {
  const held = (c: PacingCard) => c.status === "snoozed" && c.held_reason === "pacing";
  const open = cards.filter((c) => c.status === "pending" || held(c));
  const channels = [...new Set(open.map((c) => c.channel_slug))].sort((a, b) => {
    const [ia, sa] = channelRank(order, a);
    const [ib, sb] = channelRank(order, b);
    return ia - ib || (sa < sb ? -1 : sa > sb ? 1 : 0);
  });
  const focus = channels[0] ?? null;
  if (opts.frozen || cards.some((c) => c.touched) || focus === null) return { focus, hold: [], release: [] };
  return {
    focus,
    hold: open
      .filter((c) => c.channel_slug !== focus && c.status === "pending" && c.held_reason == null)
      .map((c) => c.id),
    release: open.filter((c) => c.channel_slug === focus && held(c)).map((c) => c.id),
  };
}

type RunRow = { id: string; agent_slug: string | null; trigger: string | null; enqueued_by: string | null; cron_dedupe_key: string | null };

export function signupRunIds(tenantId: string, runs: readonly RunRow[]): Set<string> {
  const mine = runs.filter((r) => r.trigger === "channel_recipe" && r.enqueued_by == null && r.cron_dedupe_key);
  const done = new Set(
    mine
      .filter((r) => r.agent_slug && r.cron_dedupe_key === `${PREVIEW_DONE_KEY_PREFIX}${tenantId}:${r.agent_slug}`)
      .map((r) => r.agent_slug as string),
  );
  const out = new Set<string>();
  for (const r of mine) {
    const key = r.cron_dedupe_key as string;
    const slug = r.agent_slug ?? "";
    if (key === `${FIRST_RUN_KEY_PREFIX}${tenantId}`) out.add(r.id);
    else if (slug && key === `${PREVIEW_DONE_KEY_PREFIX}${tenantId}:${slug}`) out.add(r.id);
    else if (slug && key === `${PREVIEW_RUN_KEY_PREFIX}${tenantId}:${slug}` && !done.has(slug)) out.add(r.id);
  }
  return out;
}

export type PacingDeps = {
  rpc?: typeof tenantRpc;
  db?: (tenantId: string) => ReturnType<typeof tenantClient>;
  nowMs?: number;
};

export async function paceSignupCards(tenantId: string, runId: string, deps: PacingDeps = {}): Promise<PacingPlan | null> {
  const tid = asTenantId(tenantId);
  const db = (deps.db ?? ((t: string) => tenantClient(asTenantId(t))))(tenantId);
  const rpc = deps.rpc ?? tenantRpc;
  try {
    const self = await db.from("agent_runs").select("cron_dedupe_key").eq("id", runId).maybeSingle();
    if (self.error) throw new Error(`run read failed: ${self.error.message}`);
    const key = (self.data as { cron_dedupe_key?: string | null } | null)?.cron_dedupe_key ?? "";
    if (!key.startsWith("first-run")) return null;

    const runs = await db
      .from("agent_runs")
      .select("id, agent_slug, trigger, enqueued_by, cron_dedupe_key")
      .like("cron_dedupe_key", "first-run%")
      .limit(100);
    if (runs.error) throw new Error(`signup runs read failed: ${runs.error.message}`);
    const ids = signupRunIds(tenantId, (runs.data ?? []) as RunRow[]);
    if (!ids.has(runId)) return null;

    const [cards, events, touchedAny, tenant] = await Promise.all([
      db
        .from("channel_actions")
        .select("id, channel_slug, status, held_reason, founder_touched_at")
        .in("run_id", [...ids])
        .in("status", ["pending", "snoozed"])
        .limit(500),
      db.from("channel_action_events").select("action_id").eq("actor_kind", "founder").limit(500),
      db.from("channel_actions").select("id").not("founder_touched_at", "is", null).limit(1),
      db.from("tenants").select("created_at").eq("id", tenantId).maybeSingle(),
    ]);
    for (const [what, r] of [["cards", cards], ["founder events", events], ["touched cards", touchedAny], ["tenant", tenant]] as const) {
      if (r.error) throw new Error(`${what} read failed: ${r.error.message}`);
    }
    const answered = new Set(((events.data ?? []) as Array<{ action_id: string }>).map((e) => e.action_id));
    const rows = ((cards.data ?? []) as Array<{ id: string; channel_slug: string; status: string; held_reason: string | null; founder_touched_at: string | null }>).map(
      (c): PacingCard => ({
        id: c.id,
        channel_slug: c.channel_slug,
        status: c.status,
        held_reason: c.held_reason ?? null,
        touched: c.founder_touched_at != null || answered.has(c.id),
      }),
    );
    const frozen = answered.size > 0 || (touchedAny.data ?? []).length > 0;
    const plan = planPacing(rows, PACING_CHANNEL_ORDER, { frozen });

    if (plan.release.length > 0) {
      const { error } = await rpc(tid, "release_paced_channel_actions", { p_channels: null, p_ids: plan.release });
      if (error) throw new Error(`release failed: ${error.message}`);
    }
    if (plan.hold.length > 0) {
      const created = Date.parse(String((tenant.data as { created_at?: unknown } | null)?.created_at ?? ""));
      const now = deps.nowMs ?? Date.now();
      const until = new Date((Number.isFinite(created) ? created : now) + PACING_HOLD_DAYS * DAY_MS);
      if (until.getTime() > now) {
        const { error } = await rpc(tid, "hold_paced_channel_actions", { p_ids: plan.hold, p_until: until.toISOString() });
        if (error) throw new Error(`hold failed: ${error.message}`);
      }
    }
    return plan;
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "channel_actions.pacing",
      code: "channel.pacing_failed",
      error: e,
      tenant_id: tenantId,
      run_id: runId,
    });
    return null;
  }
}

export async function releasePacedChannels(
  tenantId: string,
  channels: readonly string[],
  deps: { rpc?: typeof tenantRpc } = {},
): Promise<number> {
  if (channels.length === 0) return 0;
  const { data, error } = await (deps.rpc ?? tenantRpc)(asTenantId(tenantId), "release_paced_channel_actions", {
    p_channels: [...channels],
    p_ids: null,
  });
  if (error) throw new Error(`release held cards failed: ${error.message}`);
  return Number(data ?? 0);
}
