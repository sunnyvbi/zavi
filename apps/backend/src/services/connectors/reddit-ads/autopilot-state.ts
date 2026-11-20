
import { authoritySchema } from "./schema";
import { asTenantId, tenantClient } from "@/services/tenant-client";

type Limits = { daily_limit_usd: number; campaign_lifetime_limit_usd: number; objectives: string[]; geolocations: string[]; expires_at: string; goal_id: string };

export type RedditAutopilotState = {
  authority: { state: "granted" | "expired" | "goal_inactive" | "none" | "unreadable"; limits: Limits | null };
  active_goals: Array<{ goal_id: string; objective: string; target_metric: string }> | "unreadable";
  run_goal_id: string | null;
  open_cards: Array<{ action_id: string; exec_class: string; operation_key: string | null }> | "unreadable";
  prepared_not_launched: string[] | "unreadable";
  prepared_drifted: Array<{ operation_key: string; why: string }>;
  prepared_in_review: Array<{ operation_key: string; ad_status: string }>;
  running: Array<{ operation_key: string; campaign_id: string }> | "unreadable";
  next: { tool: "reddit_ads__propose_authorize_account" | "reddit_ads__propose_prepare_campaign" | "reddit_ads__propose_launch_campaign" | null; why: string };
};

const MAX_VERIFY = 3;
const LIFECYCLE = ["reddit_ads.authorize_account", "reddit_ads.prepare_campaign", "reddit_ads.launch_campaign"] as const;

export type AutopilotStateDeps = {
  authority: (tenantId: string, accountId: string) => Promise<unknown | null>;
  goals: (tenantId: string) => Promise<Array<{ id: string; objective: string; target_metric: string; status: string }>>;
  runGoal: (tenantId: string, runId: string) => Promise<string | null>;
  openCards: (tenantId: string, execClass: string) => Promise<Array<{ action_id: string; exec_payload: Record<string, unknown> | null }>>;
  operations: (tenantId: string) => Promise<Array<{ operation_key: string; step: string; state: string; request: Record<string, unknown> | null; result: unknown }>>;
  activeCampaigns: (tenantId: string, accountId: string, ids: string[]) => Promise<string[]>;
  verifyPrepared: (tenantId: string, accountId: string, key: string) => Promise<{ ok: true; review?: string | null } | { ok: false; why: string }>;
};

const db = (t: string) => tenantClient(asTenantId(t));

const defaultDeps: AutopilotStateDeps = {
  async authority(tenantId, accountId) {
    const { data, error } = await db(tenantId).from("reddit_ad_authority").select("limits").eq("ad_account_id", accountId).maybeSingle<{ limits: unknown }>();
    if (error) throw new Error(error.message);
    return data ? data.limits : null;
  },
  async goals(tenantId) {
    const { data, error } = await db(tenantId).from("autopilot_goals").select("id,objective,target_metric,status").eq("status", "active").order("priority", { ascending: false }).limit(20);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; objective: string; target_metric: string; status: string }>;
  },
  async runGoal(tenantId, runId) {
    const { data, error } = await db(tenantId).from("agent_runs").select("payload").eq("id", runId).maybeSingle<{ payload: { goal_id?: unknown } | null }>();
    if (error) throw new Error(error.message);
    return typeof data?.payload?.goal_id === "string" ? data.payload.goal_id : null;
  },
  async openCards(tenantId, execClass) {
    return (await import("@/services/growth/pending-test-claim")).openChannelCards(tenantId, "reddit_ads", execClass);
  },
  async operations(tenantId) {
    const { data, error } = await db(tenantId).from("reddit_ad_operations").select("operation_key,step,state,request,result").eq("state", "complete").order("updated_at", { ascending: false }).limit(1000);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ operation_key: string; step: string; state: string; request: Record<string, unknown> | null; result: unknown }>;
  },
  async activeCampaigns(tenantId, accountId, ids) {
    if (!ids.length) return [];
    const { ownedAccount, listObjects } = await import("./adapter");
    const { account } = await ownedAccount(tenantId, accountId);
    const live = await listObjects(account, accountId, "campaign");
    return live.filter((c) => ids.includes(c.id) && c.configured_status === "ACTIVE").map((c) => c.id);
  },
  async verifyPrepared(tenantId, accountId, key) {
    const { ExpectedToolError } = await import("@/services/tools/types");
    const { ownedAccount, getObject } = await import("./adapter");
    const { preparedCampaign, verifyManifest } = await import("./lifecycle");
    try {
      const { plan, manifest } = await preparedCampaign(tenantId, key, "00000000-0000-0000-0000-000000000000");
      const { account } = await ownedAccount(tenantId, accountId);
      await verifyManifest(account, plan, manifest, "PAUSED");
      let review: string | null = null;
      for (const [level, obj] of [["campaign", manifest.campaign], ["ad_group", manifest.group], ...manifest.ads.map((a) => ["ad", a] as const)] as const) {
        const live = await getObject(account, accountId, level, obj.id);
        if (!obj.modified_at || live.modified_at !== obj.modified_at) return { ok: false, why: `its ${level === "ad_group" ? "ad group" : level} ${obj.id} was changed in Reddit after preparation` };
        if (level === "ad") {
          const status = String(live.effective_status ?? "");
          if (/REJECT|DISAPPROV/i.test(status)) return { ok: false, why: `Reddit rejected its ad ${obj.id} (${status})` };
          if (!review && /PENDING|REVIEW/i.test(status)) review = status;
        }
      }
      return { ok: true, review };
    } catch (e) {
      if (e instanceof ExpectedToolError && ["reddit_ads_verification_failed", "reddit_ads_retained_object_archived", "reddit_ads_invalid_request", "reddit_ads_prepare_incomplete"].includes(e.code)) return { ok: false, why: e.message };
      throw e;
    }
  },
};

async function orUnreadable<T>(f: () => Promise<T>): Promise<T | "unreadable"> {
  try {
    return await f();
  } catch {
    return "unreadable";
  }
}

export async function readRedditAutopilotState(
  tenantId: string,
  accountId: string,
  runId: string | undefined,
  now: Date = new Date(),
  deps: AutopilotStateDeps = defaultDeps,
): Promise<RedditAutopilotState> {
  const goals = await orUnreadable(() => deps.goals(tenantId));
  const active_goals = goals === "unreadable" ? goals : goals.map((g) => ({ goal_id: g.id, objective: g.objective, target_metric: g.target_metric }));

  let authority: RedditAutopilotState["authority"];
  const raw = await orUnreadable(() => deps.authority(tenantId, accountId));
  if (raw === "unreadable") authority = { state: "unreadable", limits: null };
  else if (raw === null) authority = { state: "none", limits: null };
  else {
    const parsed = authoritySchema.safeParse(raw);
    if (!parsed.success) authority = { state: "unreadable", limits: null };
    else {
      const l = parsed.data;
      const limits: Limits = { daily_limit_usd: l.daily_limit_usd, campaign_lifetime_limit_usd: l.campaign_lifetime_limit_usd, objectives: l.objectives, geolocations: l.geolocations, expires_at: l.expires_at, goal_id: l.goal_id };
      const expired = Date.parse(l.expires_at) <= now.getTime();
      const goalActive = goals === "unreadable" ? null : goals.some((g) => g.id === l.goal_id);
      authority = { state: expired ? "expired" : goalActive === false ? "goal_inactive" : goalActive === null ? "unreadable" : "granted", limits };
    }
  }

  const run_goal_id = runId ? ((await orUnreadable(() => deps.runGoal(tenantId, runId))) as string | null | "unreadable") : null;

  const cards = await orUnreadable(async () => {
    const out: Array<{ action_id: string; exec_class: string; operation_key: string | null }> = [];
    for (const cls of LIFECYCLE) {
      for (const c of await deps.openCards(tenantId, cls)) {
        if (c.exec_payload?.ad_account_id !== accountId) continue;
        out.push({ action_id: c.action_id, exec_class: cls, operation_key: typeof c.exec_payload?.operation_key === "string" ? c.exec_payload.operation_key : null });
      }
    }
    return out;
  });

  const ops = await orUnreadable(async () => {
    const rows = await deps.operations(tenantId);
    const byKey = new Map<string, { account: string | null; campaign: string | null; manifest: boolean; enabled: boolean }>();
    for (const r of rows) {
      const k = byKey.get(r.operation_key) ?? { account: null, campaign: null, manifest: false, enabled: false };
      if (r.step === "plan" && typeof r.request?.ad_account_id === "string") k.account = r.request.ad_account_id;
      if (r.step === "manifest") {
        k.manifest = true;
        const id = (r.result as { id?: unknown } | null)?.id;
        if (typeof id === "string") k.campaign = id;
      }
      if (r.step.startsWith("enable_")) k.enabled = true;
      byKey.set(r.operation_key, k);
    }
    return [...byKey.entries()].filter(([, v]) => v.account === accountId && v.manifest);
  });
  const prepared_drifted: Array<{ operation_key: string; why: string }> = [];
  const prepared_in_review: Array<{ operation_key: string; ad_status: string }> = [];
  const prepared = ops === "unreadable"
    ? ops
    : await orUnreadable(async () => {
        const out: string[] = [];
        for (const [key] of ops.filter(([, v]) => !v.enabled).slice(0, MAX_VERIFY)) {
          const v = await deps.verifyPrepared(tenantId, accountId, key);
          if (v.ok) {
            out.push(key);
            if (v.review) prepared_in_review.push({ operation_key: key, ad_status: v.review });
          }
          else prepared_drifted.push({ operation_key: key, why: v.why });
        }
        return out;
      });
  const running = ops === "unreadable"
    ? ops
    : await orUnreadable(async () => {
        const launched = ops.filter(([, v]) => v.enabled && v.campaign).map(([key, v]) => ({ operation_key: key, campaign_id: v.campaign as string }));
        const active = new Set(await deps.activeCampaigns(tenantId, accountId, launched.map((l) => l.campaign_id)));
        return launched.filter((l) => active.has(l.campaign_id));
      });

  return {
    authority,
    active_goals,
    run_goal_id: run_goal_id === "unreadable" ? null : run_goal_id,
    open_cards: cards,
    prepared_not_launched: prepared,
    prepared_drifted,
    prepared_in_review,
    running,
    next: nextMove(authority.state, cards, prepared, running, prepared_drifted, prepared_in_review),
  };
}

export function nextMove(
  authority: RedditAutopilotState["authority"]["state"],
  cards: RedditAutopilotState["open_cards"],
  prepared: RedditAutopilotState["prepared_not_launched"],
  running: RedditAutopilotState["running"],
  drifted: RedditAutopilotState["prepared_drifted"] = [],
  inReview: RedditAutopilotState["prepared_in_review"] = [],
): RedditAutopilotState["next"] {
  if (cards === "unreadable" || prepared === "unreadable" || running === "unreadable" || authority === "unreadable") {
    return { tool: null, why: "Zavi could not read this account's launch state this run; propose no lifecycle card and say so." };
  }
  const open = cards[0];
  if (open) return { tool: null, why: `Card ${open.action_id} (${open.exec_class}) is still open; it is the next step until a person decides it or it finishes.` };
  const live = running[0];
  if (live) return { tool: null, why: `Zavi's campaign ${live.campaign_id} (${live.operation_key}) is switched on: read its results; a budget change or a pause is its own card.` };
  if (authority !== "granted") return { tool: "reddit_ads__propose_authorize_account", why: authority === "none" ? "No operating authority on this account yet: the founder grants limits once." : `The grant on this account is ${authority === "expired" ? "expired" : "tied to a goal that is no longer active"}: the founder renews it.` };
  if (prepared.length) {
    const review = inReview.find((r) => r.operation_key === prepared[0]);
    if (review) return { tool: "reddit_ads__propose_launch_campaign", why: `Campaign ${prepared[0]} is prepared and paused, but Reddit is still reviewing its ads (${review.ad_status}). Do not call it ready to launch: a launch card may be filed, and delivery starts only after Reddit approves the ads.` };
    return { tool: "reddit_ads__propose_launch_campaign", why: `Campaign ${prepared[0]} is prepared and paused: the next card turns it on.` };
  }
  if (drifted.length) return { tool: "reddit_ads__propose_prepare_campaign", why: `Campaign ${drifted[0].operation_key} no longer matches what was prepared (${drifted[0].why}): prepare again with a NEW operation_key; archive the old one in Reddit Ads Manager if it is not needed.` };
  return { tool: "reddit_ads__propose_prepare_campaign", why: "Authority is granted and nothing is prepared: the next card creates a paused campaign within the grant." };
}
