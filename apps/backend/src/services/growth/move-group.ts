
import { adChangeCleanObjectLabel, adMoney, googleActionRaisesSpend } from "@zavi/shared";
import { metaActionRaisesSpend } from "@/services/tools/meta-ads/write/_decision-bodies";
import { AUTO_OF } from "./founder-order";

export const UNKNOWN_ORDER_PREFIX = "unknown-order:";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function moveGroupOf(body: unknown): string | null {
  const b = obj(body);
  if (b.founder_chat_order !== true) return null;
  return typeof b.move_group === "string" && b.move_group.length > 0 ? b.move_group : null;
}

export type LegSide = "lowers" | "adds" | "neutral";

const baseClass = (cls: string): string => AUTO_OF[cls] ?? cls;

export function legSide(exec_class: string, body: unknown): LegSide {
  const b = obj(body);
  const cls = baseClass(exec_class);
  const raises = cls.startsWith("meta_ads.") ? metaActionRaisesSpend(cls, b) : cls.startsWith("google_ads.") ? googleActionRaisesSpend(cls, b) : false;
  if (raises) return "adds";
  if (BUDGET_CLASSES.has(cls)) {
    const to = b.daily_budget_usd, from = b.expected_current_daily_budget_usd;
    return typeof to === "number" && typeof from === "number" && Number.isFinite(to) && Number.isFinite(from) && to < from ? "lowers" : "neutral";
  }
  if (STATUS_CLASSES.has(cls) || cls === "meta_ads.update_ad") return b.status === "PAUSED" ? "lowers" : "neutral";
  return "neutral";
}

const BUDGET_CLASSES: ReadonlySet<string> = new Set([
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_campaign_budget",
  "google_ads.update_campaign_budget",
]);
const STATUS_CLASSES: ReadonlySet<string> = new Set(["meta_ads.set_status", "google_ads.set_status"]);

export type LegState = "open" | "in_flight" | "applied" | "failed" | "declined";

export type MoveLeg = {
  table: "decisions" | "channel_actions";
  id: string;
  exec_class: string;
  body: unknown;
  state: LegState;
  run_id: string | null;
};

export function decisionLegState(status: string | null | undefined): LegState {
  switch (status) {
    case "proposed":
      return "open";
    case "approved":
    case "dispatching":
      return "in_flight";
    case "acted":
      return "applied";
    case "dispatch_failed":
      return "failed";
    default:
      return "declined";
  }
}

export function actionLegState(status: string | null | undefined, exec_status: string | null | undefined): LegState {
  if (exec_status === "executed") return "applied";
  if (exec_status === "queued" || exec_status === "dispatching") return "in_flight";
  if (exec_status === "failed") return "failed";
  if (status === "pending" && exec_status == null) return "open";
  return "declined";
}

export type PairWait = "cut_untapped" | "cut_applying" | "cut_failed" | "cut_declined" | "order_still_running" | "order_waits_on_card" | "order_unknown" | "unreadable";

export type PairVerdict = { kind: "go" } | { kind: "wait"; why: PairWait; legs: MoveLeg[] };

export function pairVerdict(selfId: string, legs: ReadonlyArray<MoveLeg>, sealed: boolean): PairVerdict {
  const self = legs.find((l) => l.id === selfId);
  if (self && legSide(self.exec_class, self.body) !== "adds") return { kind: "go" };
  const lowering = legs.filter((l) => l.id !== selfId && legSide(l.exec_class, l.body) !== "adds");
  if (lowering.length === 0) return sealed ? { kind: "go" } : { kind: "wait", why: "order_still_running", legs: [] };
  const pick = (st: LegState) => lowering.filter((l) => l.state === st);
  for (const [st, why] of [["declined", "cut_declined"], ["failed", "cut_failed"], ["open", "cut_untapped"], ["in_flight", "cut_applying"]] as const) {
    const ls = pick(st);
    if (ls.length) return { kind: "wait", why, legs: ls };
  }
  if (!sealed) return { kind: "wait", why: "order_still_running", legs: [] };
  return { kind: "go" };
}

export function pairWaitMessage(why: PairWait): string {
  switch (why) {
    case "cut_untapped":
      return "This raise is part of a move you asked for. Approve the matching cut first; this raise runs only after the cut is done.";
    case "cut_applying":
      return "The matching cut is still being applied. Approve this raise again in a minute, once the cut is done.";
    case "cut_failed":
      return "Zavi could not confirm the matching cut went through, so this raise has not run. Check the cut and retry it first, or reject this raise.";
    case "cut_declined":
      return "The matching cut was turned down or replaced, so this raise will not run on its own. Reject it, or ask for the raise again by itself.";
    case "order_still_running":
      return "Zavi is still filing the rest of this move. Approve this raise again in a minute.";
    case "order_waits_on_card":
      return "Another card from the same conversation is still open or still being applied. Decide it (or let it finish) first, then approve this raise.";
    case "order_unknown":
      return "Zavi could not tell which of your requests this raise belongs to, so it will not run on its own. Reject it and ask for the change again.";
    case "unreadable":
      return "Zavi could not check the matching cut for this raise, so it has not run. Try again in a minute.";
  }
}

const LEG_PAGE = 50;

export async function readMoveGroup(tenant_id: string, group: string): Promise<MoveLeg[]> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenant_id));
  const [d, a] = await Promise.all([
    db
      .from("decisions")
      .select("id, decision_class, body, status, agent_run_id")
      .eq("tenant_id", tenant_id)
      .eq("body->>move_group", group)
      .limit(LEG_PAGE),
    db
      .from("channel_actions")
      .select("id, exec_class, exec_payload, status, exec_status, run_id")
      .eq("tenant_id", tenant_id)
      .eq("exec_payload->>move_group", group)
      .limit(LEG_PAGE),
  ]);
  if (d.error) throw new Error(`move group decisions read failed: ${d.error.message}`);
  if (a.error) throw new Error(`move group channel_actions read failed: ${a.error.message}`);
  if ((d.data ?? []).length >= LEG_PAGE || (a.data ?? []).length >= LEG_PAGE) throw new Error("move group larger than one page");
  const legs: MoveLeg[] = [];
  for (const r of (d.data ?? []) as Array<{ id: string; decision_class: string; body: unknown; status: string; agent_run_id: string | null }>) {
    if (moveGroupOf(r.body) !== group) continue;
    legs.push({ table: "decisions", id: r.id, exec_class: r.decision_class, body: r.body, state: decisionLegState(r.status), run_id: r.agent_run_id ?? null });
  }
  for (const r of (a.data ?? []) as Array<{ id: string; exec_class: string | null; exec_payload: unknown; status: string; exec_status: string | null; run_id: string | null }>) {
    if (!r.exec_class || moveGroupOf(r.exec_payload) !== group) continue;
    legs.push({ table: "channel_actions", id: r.id, exec_class: r.exec_class, body: r.exec_payload, state: actionLegState(r.status, r.exec_status), run_id: r.run_id ?? null });
  }
  return legs;
}

const STILL_RUNNING = ["queued", "running", "blocked", "paused_awaiting_approval"];
const RUN_PAGE = 200;

type ActiveRun = { id: string; status: string; thread: string | null; resume_of: string | null; ref_run: string | null };

export function orderQuiescent(args: {
  root: string;
  rootThread: string | null;
  legRuns: ReadonlyArray<string | null>;
  active: ReadonlyArray<ActiveRun>;
  selfRun?: string | null;
  selfRunWaitsOnOther?: boolean;
}): boolean {
  return orderLiveness(args) === "quiet";
}

export function orderLiveness(args: Parameters<typeof orderQuiescent>[0]): "quiet" | "running" | "paused" {
  const mine = new Set<string>([args.root, ...args.legRuns.filter((x): x is string => !!x)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of args.active) {
      if (mine.has(r.id)) continue;
      const resumeInThread = !!r.resume_of && !!args.rootThread && r.thread === args.rootThread;
      if (r.ref_run === args.root || resumeInThread || (r.resume_of && mine.has(r.resume_of))) {
        mine.add(r.id);
        grew = true;
      }
    }
  }
  const live = args.active.filter(
    (r) => mine.has(r.id) && !(r.id === args.selfRun && r.status === "paused_awaiting_approval" && args.selfRunWaitsOnOther !== true),
  );
  if (live.length === 0) return "quiet";
  return live.every((r) => r.status === "paused_awaiting_approval") ? "paused" : "running";
}

export async function readOrderLiveness(tenant_id: string, root: string, legRuns: ReadonlyArray<string | null>, selfRun: string | null, selfId: string): Promise<"quiet" | "running" | "paused"> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenant_id));
  const { data: rootRow, error: rootErr } = await db
    .from("agent_runs")
    .select("id, enqueued_at, thread:payload->>thread_id")
    .eq("tenant_id", tenant_id)
    .eq("id", root)
    .maybeSingle();
  if (rootErr) throw new Error(`order root read failed: ${rootErr.message}`);
  const r = rootRow as { enqueued_at?: string | null; thread?: string | null } | null;
  let q = db
    .from("agent_runs")
    .select("id, status, thread:payload->>thread_id, resume_of:payload->>resume_of_run_id, ref_run:payload->founder_message_ref->>run_id")
    .eq("tenant_id", tenant_id)
    .in("status", STILL_RUNNING)
    .limit(RUN_PAGE);
  if (r?.enqueued_at) q = q.gte("enqueued_at", r.enqueued_at);
  const { data, error } = await q;
  if (error) throw new Error(`order runs read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; status: string; thread: string | null; resume_of: string | null; ref_run: string | null }>;
  if (rows.length >= RUN_PAGE) throw new Error("live runs larger than one page");
  const active = rows.map((x) => ({ id: x.id, status: x.status, thread: x.thread ?? null, resume_of: x.resume_of ?? null, ref_run: x.ref_run ?? null }));
  let selfRunWaitsOnOther = false;
  if (selfRun && active.some((a) => a.id === selfRun && a.status === "paused_awaiting_approval")) {
    const { data: other, error: oErr } = await db
      .from("decisions")
      .select("id, decision_class, status, approved_at, dispatched_at, rejected_at, founder:body->>founder_chat_order")
      .eq("tenant_id", tenant_id)
      .eq("agent_run_id", selfRun)
      .neq("id", selfId)
      .limit(RUN_PAGE);
    if (oErr) throw new Error(`paused run's cards read failed: ${oErr.message}`);
    const rows = (other ?? []) as Array<OtherCard>;
    if (rows.length >= RUN_PAGE) throw new Error("paused run's cards larger than one page");
    selfRunWaitsOnOther = rows.some((o) => mayResumeRun(o, new Date()));
  }
  return orderLiveness({ root, rootThread: r?.thread ?? null, legRuns, active, selfRun, selfRunWaitsOnOther });
}

export const RESUME_WINDOW_MS = 15 * 60_000;

export type OtherCard = { decision_class: string; status: string; approved_at?: string | null; dispatched_at?: string | null; rejected_at?: string | null; founder?: string | null };

export function mayResumeRun(o: OtherCard, now: Date): boolean {
  const recent = (iso: string | null | undefined) => !!iso && now.getTime() - Date.parse(iso) < RESUME_WINDOW_MS;
  if (o.status === "proposed" || o.status === "approved" || o.status === "dispatching") return true;
  if (o.status === "acted") return !(o.founder === "true" && /^(meta_ads|google_ads)\./.test(o.decision_class)) && recent(o.dispatched_at);
  if (o.status === "rejected") return recent(o.rejected_at);
  return false;
}

type LegRef = { id: string; exec_class: string; body: unknown };

async function readVerdict(tenant_id: string, group: string, leg: LegRef): Promise<{ v: PairVerdict; legs: MoveLeg[] }> {
  if (group.startsWith(UNKNOWN_ORDER_PREFIX)) return { v: { kind: "wait", why: "order_unknown", legs: [] }, legs: [] };
  const legs = await readMoveGroup(tenant_id, group);
  const first = pairVerdict(leg.id, legs, true);
  if (first.kind === "wait") return { v: first, legs };
  const selfRun = legs.find((l) => l.id === leg.id)?.run_id ?? null;
  const live = await readOrderLiveness(tenant_id, group, legs.map((l) => l.run_id), selfRun, leg.id);
  const v = pairVerdict(leg.id, legs, live === "quiet");
  if (v.kind === "wait" && v.why === "order_still_running" && live === "paused") return { v: { kind: "wait", why: "order_waits_on_card", legs: [] }, legs };
  return { v, legs };
}

export async function checkPairedLeg(tenant_id: string, leg: LegRef): Promise<PairVerdict> {
  const group = moveGroupOf(leg.body);
  if (!group || legSide(leg.exec_class, leg.body) !== "adds") return { kind: "go" };
  try {
    return (await readVerdict(tenant_id, group, leg)).v;
  } catch (e) {
    console.warn(`[move-group] leg ${leg.id} could not be checked; it waits: ${(e as Error).message}`);
    return { kind: "wait", why: "unreadable", legs: [] };
  }
}

export type LiveReader = {
  googleCampaign: (tenant_id: string, campaign_id: string) => Promise<{ daily_usd: number | null; status: string }>;
  googleAdGroupStatus: (tenant_id: string, ad_group_id: string) => Promise<string>;
  googleAdStatus: (tenant_id: string, ad_group_id: string, ad_id: string) => Promise<string>;
  metaObject: (tenant_id: string, object_id: string) => Promise<{ daily: number | null; status: string; currency?: string }>;
};

const defaultLive: LiveReader = {
  googleCampaign: async (t, id) => {
    const { gadsGetCampaignBudget } = await import("@/services/tools/google-ads/_client");
    const l = await gadsGetCampaignBudget(t, id);
    const daily = l.amount_micros / 1_000_000;
    return { daily_usd: Number.isFinite(daily) && daily > 0 ? daily : null, status: l.campaign_status };
  },
  googleAdGroupStatus: async (t, id) => (await (await import("@/services/tools/google-ads/_client")).gadsGetAdGroup(t, id)).status,
  googleAdStatus: async (t, g, a) => (await (await import("@/services/tools/google-ads/_client")).gadsGetAd(t, g, a)).status,
  metaObject: async (t, id) => {
    const { fbGet, getAdAccountCurrency } = await import("@/services/tools/meta-ads/_client");
    const { minorUnitsPerMajor } = await import("@/services/tools/meta-ads/write/_currency");
    const r = (await fbGet(t, id, { fields: "status,daily_budget" })) as { status?: string; daily_budget?: string };
    if (typeof r?.status !== "string") throw new Error("meta status unreadable");
    const minor = typeof r.daily_budget === "string" && r.daily_budget !== "" ? Number(r.daily_budget) : NaN;
    const currency = await getAdAccountCurrency(t);
    return { daily: Number.isFinite(minor) && minor >= 0 ? minor / minorUnitsPerMajor(currency) : null, status: r.status, currency };
  },
};

const cents = (n: number): number => Math.round(n * 100);
const atOrUnder = (live: number | null, target: unknown): boolean =>
  live !== null && typeof target === "number" && Number.isFinite(target) && cents(live) <= cents(target);

export async function cutStillHolds(tenant_id: string, leg: Pick<MoveLeg, "exec_class" | "body">, live: LiveReader = defaultLive): Promise<boolean> {
  const cls = baseClass(leg.exec_class);
  const b = obj(leg.body);
  try {
    if (cls === "google_ads.update_campaign_budget") {
      return atOrUnder((await live.googleCampaign(tenant_id, String(b.campaign_id))).daily_usd, b.daily_budget_usd);
    }
    if (cls === "google_ads.set_status") {
      if (b.level === "ad_group" && typeof b.ad_group_id === "string") return (await live.googleAdGroupStatus(tenant_id, b.ad_group_id)) === "PAUSED";
      if (b.level === "ad" && typeof b.ad_group_id === "string" && typeof b.ad_id === "string") return (await live.googleAdStatus(tenant_id, b.ad_group_id, b.ad_id)) === "PAUSED";
      return (await live.googleCampaign(tenant_id, String(b.campaign_id))).status === "PAUSED";
    }
    if (cls === "meta_ads.update_ad_set_budget" || cls === "meta_ads.update_campaign_budget") {
      const id = String(cls === "meta_ads.update_ad_set_budget" ? b.ad_set_id : b.campaign_id);
      return atOrUnder((await live.metaObject(tenant_id, id)).daily, b.daily_budget_usd);
    }
    if (cls === "meta_ads.set_status") return (await live.metaObject(tenant_id, String(b.object_id))).status === "PAUSED";
    if (cls === "meta_ads.update_ad") return (await live.metaObject(tenant_id, String(b.ad_id))).status === "PAUSED";
    return false;
  } catch (e) {
    console.warn(`[move-group] live state of a cut unreadable; the paired raise waits: ${(e as Error).message}`);
    return false;
  }
}

export async function pairedDispatchHold(tenant_id: string, leg: LegRef, live: LiveReader = defaultLive): Promise<string | null> {
  const group = moveGroupOf(leg.body);
  if (!group || legSide(leg.exec_class, leg.body) !== "adds") return null;
  let read: { v: PairVerdict; legs: MoveLeg[] };
  try {
    read = await readVerdict(tenant_id, group, leg);
  } catch (e) {
    console.warn(`[move-group] group of ${leg.id} unreadable; it waits: ${(e as Error).message}`);
    return pairWaitMessage("unreadable");
  }
  if (read.v.kind === "wait") return pairWaitMessage(read.v.why);
  for (const cut of read.legs.filter((l) => l.id !== leg.id && legSide(l.exec_class, l.body) === "lowers")) {
    if (!(await cutStillHolds(tenant_id, cut, live))) {
      return "The matching cut is no longer in place in the ad account (it was changed back, or Zavi could not read it), so this raise has not run. Check the cut, then approve again.";
    }
  }
  return null;
}

export async function tellPairedPartial(tenant_id: string, leg: LegRef, error: string | null | undefined): Promise<void> {
  try {
    const group = moveGroupOf(leg.body);
    if (!group || legSide(leg.exec_class, leg.body) !== "adds") return;
    const legs = await readMoveGroup(tenant_id, group);
    const applied = legs.filter((l) => l.id !== leg.id && l.state === "applied");
    if (applied.length === 0) return;
    const { adChangeHeadline } = await import("@zavi/shared");
    const name = (l: { exec_class: string; body: unknown }) => adChangeHeadline(l.exec_class, l.body) ?? "a change in your move";
    const done = applied.map(name).join("; ");
    const what =
      `Your move may be half done: ${done} went through, but Zavi could not confirm ${name(leg)}` +
      (error ? ` (${error.slice(0, 160)})` : "") +
      `. Check it in the ad account before asking again, so it is not made twice. To undo the part that went through, use your ad changes list.`;
    const { alertFounderSafely } = await import("./cgo-blockers");
    await alertFounderSafely(tenant_id, "paired move half done", [
      {
        id: `paired_partial:${leg.id}`,
        kind: "card",
        who: "you",
        what,
        since: new Date().toISOString(),
        usd_at_stake: null,
        at_risk_now: false,
        notify_now: true,
        meanwhile: "the parts that went through stay in place",
      },
    ]);
  } catch (e) {
    console.warn(`[move-group] half-done move for ${leg.id} not told: ${(e as Error).message}`);
  }
}

export async function tellPairedPartialForAction(tenant_id: string, action_id: string, error: string | null | undefined): Promise<void> {
  try {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error: readErr } = await tenantClient(asTenantId(tenant_id))
      .from("channel_actions")
      .select("exec_class, exec_payload")
      .eq("id", action_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const row = data as { exec_class?: string | null; exec_payload?: unknown } | null;
    if (readErr || !row?.exec_class || !moveGroupOf(row.exec_payload)) return;
    await tellPairedPartial(tenant_id, { id: action_id, exec_class: row.exec_class, body: row.exec_payload }, error);
  } catch (e) {
    console.warn(`[move-group] half-done move for action ${action_id} not told: ${(e as Error).message}`);
  }
}

export function leaveMoveGroup(body: unknown, user_id: string, at: string): Record<string, unknown> {
  const { move_group, ...rest } = obj(body);
  return { ...rest, run_alone: { move_group_left: typeof move_group === "string" ? move_group : null, by: user_id, at } };
}

export type RunAloneConfirm = {
  message: string;
  daily_add: number | null;
  currency: string | null;
  open_legs: number | null;
  why: PairWait;
};

const STATUS_ON: Readonly<Record<string, string>> = { meta_ads: "ACTIVE", google_ads: "ENABLED" };

export async function legDailyAdd(tenant_id: string, leg: LegRef, live: LiveReader = defaultLive): Promise<{ daily: number | null; currency: string | null }> {
  const cls = baseClass(leg.exec_class);
  const b = obj(leg.body);
  const cur = typeof b.currency === "string" ? b.currency : null;
  if (BUDGET_CLASSES.has(cls)) {
    const to = b.daily_budget_usd, from = b.expected_current_daily_budget_usd;
    return typeof to === "number" && typeof from === "number" && Number.isFinite(to) && Number.isFinite(from) && to > from ? { daily: to - from, currency: cur } : { daily: null, currency: cur };
  }
  try {
    if (cls === "meta_ads.set_status" && b.status === STATUS_ON.meta_ads && typeof b.object_id === "string") {
      const o = await live.metaObject(tenant_id, b.object_id);
      return { daily: o.status === "ACTIVE" ? 0 : o.daily, currency: o.currency ?? null };
    }
    if (cls === "google_ads.set_status" && b.status === STATUS_ON.google_ads && (b.level ?? "campaign") === "campaign" && typeof b.campaign_id === "string") {
      const c = await live.googleCampaign(tenant_id, b.campaign_id);
      return { daily: c.status === "ENABLED" ? 0 : c.daily_usd, currency: cur };
    }
  } catch (e) {
    console.warn(`[move-group] daily amount of ${leg.id} unreadable: ${(e as Error).message}`);
  }
  return { daily: null, currency: cur };
}

const LOWER_NOUN = (legs: ReadonlyArray<Pick<MoveLeg, "exec_class" | "body">>): [string, string] => {
  const pause = legs.every((l) => obj(l.body).status === "PAUSED");
  const cut = legs.every((l) => BUDGET_CLASSES.has(baseClass(l.exec_class)));
  return pause ? ["pause", "pauses"] : cut ? ["cut", "cuts"] : ["change", "changes"];
};

export function runAloneMessage(a: {
  exec_class: string;
  body: unknown;
  daily: number | null;
  currency: string | null;
  why: PairWait;
  legs: ReadonlyArray<Pick<MoveLeg, "exec_class" | "body">>;
}): string {
  const cls = baseClass(a.exec_class);
  const b = obj(a.body);
  const name = adChangeCleanObjectLabel(a.exec_class, a.body);
  const what =
    STATUS_CLASSES.has(cls) && name
      ? `This turns on ${name}`
      : BUDGET_CLASSES.has(cls) && name
        ? `This raises ${name}`
        : name
          ? `This change to ${name} ${a.daily === null ? "may add" : "adds"} spend`
          : `This change ${a.daily === null ? "may add" : "adds"} spend`;
  const money = a.daily !== null && a.daily > 0 ? adMoney(Math.round(a.daily * 100) / 100, a.currency ?? b.currency) : null;
  const first = money ? `${what}: +${money}/day.` : a.daily === 0 ? `${what}. It is already running, so it adds nothing per day.` : `${what}. Zavi could not read how much it adds per day.`;
  const up = (tail: string, may = false) => (a.daily === 0 ? "" : `, so your daily spend ${may || a.daily === null ? "may go" : "goes"} up${money ? ` by ${money}` : ""}${tail}`);
  const n = a.legs.length;
  const [one, many] = LOWER_NOUN(a.legs);
  const these = n === 1 ? `The ${one} in this move` : n > 1 ? `The ${n} ${many} in this move` : "The rest of this move";
  const single = n <= 1;
  const isAre = single ? "is" : "are";
  switch (a.why) {
    case "cut_untapped":
      return `${first} ${these} ${isAre} still open${up(` until you approve ${single ? "it" : "them"}`)}.`;
    case "cut_applying":
      return `${first} ${these} ${isAre} still being applied${up(` until ${single ? "it is" : "they are"} done`)}.`;
    case "cut_failed":
      return `${first} Zavi could not confirm ${single ? `the ${one}` : `the ${many}`} in this move went through${up("", true)}.`;
    case "cut_declined":
      return `${first} ${these} ${single ? "was" : "were"} turned down or replaced${up("")}.`;
    case "order_still_running":
      return `${first} Zavi is still filing the rest of this move${up(" until the rest is done")}.`;
    case "order_waits_on_card":
      return `${first} Another card from the same conversation is still open${up(" until the rest of the move is done")}.`;
    case "order_unknown":
      return `${first} Zavi could not tell which of your requests this belongs to, so it cannot say what else would change.`;
    case "unreadable":
      return `${first} Zavi could not read the rest of this move, so it cannot say what else would change.`;
  }
}

export async function runAloneConfirm(tenant_id: string, leg: LegRef, verdict: Extract<PairVerdict, { kind: "wait" }>, live: LiveReader = defaultLive): Promise<RunAloneConfirm> {
  const { daily, currency } = await legDailyAdd(tenant_id, leg, live);
  let open_legs: number | null = null;
  const group = moveGroupOf(leg.body);
  if (group && verdict.why !== "unreadable" && verdict.why !== "order_unknown") {
    try {
      const legs = await readMoveGroup(tenant_id, group);
      open_legs = legs.filter((l) => l.id !== leg.id && legSide(l.exec_class, l.body) !== "adds" && l.state !== "applied").length;
    } catch (e) {
      console.warn(`[move-group] open legs of ${leg.id} unreadable: ${(e as Error).message}`);
    }
  }
  return { message: runAloneMessage({ exec_class: leg.exec_class, body: leg.body, daily, currency, why: verdict.why, legs: verdict.legs }), daily_add: daily, currency, open_legs, why: verdict.why };
}
