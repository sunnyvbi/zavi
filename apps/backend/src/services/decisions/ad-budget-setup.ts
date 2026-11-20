
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { metaSetStatus } from "@/services/tools/meta-ads/write/set_status";
import { gadsGetCampaignBudget } from "@/services/tools/google-ads/_client";
import { googleSetCampaignStatus } from "@/services/tools/google-ads/write/set_status";
import { ExpectedToolError } from "@/services/tools/types";
import { readAdBudgetMonthView, type AdBudgetMonthView, type AdPlatform } from "./ad-budget";
import {
  AD_CHANGE_COLUMNS,
  describeChange,
  freedPerDay,
  inverseOf,
  recordAdObjectChanges,
  type AdChangeRow,
} from "./ad-changes";

export const MAX_MONTHLY_USD = 10_000_000;
export const MIN_BUDGET_USD = 1;
export const BUDGET_MESSAGES = {
  monthlyMissing: "Enter a monthly amount in dollars.",
  monthlyMin: "The monthly budget must be at least $1.",
  monthlyMax: "The monthly budget must be less than $10,000,000.",
  dailyMin: "The daily limit must be at least $1, or left empty.",
  dailyOverMonthly: "The daily limit can't be more than the monthly amount.",
} as const;
const DAY_MS = 86_400_000;

export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isYmd(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export type BudgetInput = { monthly_usd: number; daily_limit_usd: number | null };
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseBudgetInput(body: unknown): Parsed<BudgetInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const monthly = b.monthly_usd;
  if (typeof monthly !== "number" || !Number.isFinite(monthly)) return { ok: false, message: BUDGET_MESSAGES.monthlyMissing };
  if (cents(monthly) < MIN_BUDGET_USD) return { ok: false, message: BUDGET_MESSAGES.monthlyMin };
  if (cents(monthly) >= MAX_MONTHLY_USD) return { ok: false, message: BUDGET_MESSAGES.monthlyMax };
  let daily: number | null = null;
  if (b.daily_limit_usd !== undefined && b.daily_limit_usd !== null) {
    const d = b.daily_limit_usd;
    if (typeof d !== "number" || !Number.isFinite(d) || cents(d) < MIN_BUDGET_USD) {
      return { ok: false, message: BUDGET_MESSAGES.dailyMin };
    }
    if (cents(d) > cents(monthly)) return { ok: false, message: BUDGET_MESSAGES.dailyOverMonthly };
    daily = cents(d);
  }
  return { ok: true, value: { monthly_usd: cents(monthly), daily_limit_usd: daily } };
}

export type HumanActionInput = { occurred_at: string; note: string; amount_usd: number | null };

export function parseHumanAction(body: unknown, today: string = utcToday()): Parsed<HumanActionInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isYmd(b.occurred_at)) return { ok: false, message: "Pick the date it happened." };
  if (b.occurred_at > addDays(today, 1)) return { ok: false, message: "The date can't be in the future." };
  if (b.occurred_at < addDays(today, -365)) return { ok: false, message: "The date must be within the last year." };
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length < 1 || note.length > 500) return { ok: false, message: "Describe what you changed, in 500 characters or fewer." };
  let amount: number | null = null;
  if (b.amount_usd !== undefined && b.amount_usd !== null) {
    const a = b.amount_usd;
    if (typeof a !== "number" || !Number.isFinite(a) || a < 0 || a >= 1_000_000) {
      return { ok: false, message: "The amount must be $0 or more, or left empty." };
    }
    amount = cents(a);
  }
  return { ok: true, value: { occurred_at: b.occurred_at, note, amount_usd: amount } };
}

export type AdBudgetView = Omit<AdBudgetMonthView, "created_at"> & {
  still_running: Array<{ platform: AdPlatform; object_id: string; label?: string }>;
};

const num = (v: number | string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

export async function readAdBudgetView(tenant_id: string): Promise<AdBudgetView | null> {
  const b = await readAdBudgetMonthView(tenant_id);
  if (!b) return null;
  const still_running: AdBudgetView["still_running"] = [];
  if (b.status === "stopped") {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("ad_budget_reservations")
      .select("platform, object_id")
      .eq("budget_id", b.id)
      .in("status", ["reserved", "committed"])
      .not("object_id", "is", null);
    if (error) throw new Error(`ad_budget_reservations read failed: ${error.message}`);
    const seen = new Set<string>();
    for (const r of (data ?? []) as Array<{ platform: AdPlatform; object_id: string }>) {
      const k = `${r.platform}:${r.object_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      still_running.push({ platform: r.platform, object_id: r.object_id });
    }
  }
  for (const o of still_running) o.label = (await heldObjectFacts(tenant_id, o)).label;
  const { created_at: _created, ...view } = b;
  return { ...view, still_running };
}

export type LedgerSource = "cgo" | "person" | "automation" | "channel" | "outside";

export type LedgerRow = {
  at: string;
  kind: "event" | "hold" | "hand" | "change" | "outside";
  date: string | null;
  action: string;
  amount_usd: number | null;
  amount_label: string | null;
  result: string;
  source: LedgerSource;
  by: string;
  undo?: { change_id: string; change: string } | null;
};

type ReservationRow = {
  idem_key: string;
  platform: AdPlatform;
  object_id: string | null;
  op: "raise" | "resume" | "create" | "rebase";
  daily_delta_usd: number | string;
  amount_usd: number | string;
  status: "reserved" | "committed" | "released" | "refused";
  reason: string | null;
  created_at: string;
};

type ApproverRow = { id: string; approved_by: string | null; approved_by_source: string | null; name?: string | null };

const AD_CLASS_FILTER = (col: string) => `${col}.like.meta_ads.*,${col}.like.google_ads.*,${col}.like.chatgpt_ads.*,${col}.like.reddit_ads.*,${col}.like.x_ads.*,${col}.like.tiktok_ads.*`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEDGER_LIMIT = 200;

const PLATFORM_NAME: Record<AdPlatform, string> = { meta: "Meta", google: "Google", chatgpt: "ChatGPT", reddit: "Reddit", x: "X Ads", tiktok: "TikTok", linkedin: "LinkedIn" };
const OBJECT_NAME: Record<AdPlatform, string> = { meta: "ad set", google: "campaign", chatgpt: "campaign", reddit: "ad group", x: "campaign", tiktok: "ad group", linkedin: "campaign" };
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function adObjectLabel(platform: AdPlatform, object_id: string | null, name?: string | null, level?: "campaign"): string {
  const kind = `${PLATFORM_NAME[platform] ?? platform} ${level ?? OBJECT_NAME[platform] ?? "object"}`;
  const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (n) return `${kind} "${n}"`;
  if (!object_id) return kind;
  return object_id.length > 4 ? `${kind} …${object_id.slice(-4)}` : `${kind} ${object_id}`;
}

export function reservationAction(
  r: Pick<ReservationRow, "platform" | "object_id" | "op" | "daily_delta_usd">,
  name?: string | null,
): string {
  const obj = adObjectLabel(r.platform, r.object_id, name);
  const delta = usd(num(r.daily_delta_usd));
  if (r.platform === "chatgpt") return `${r.op === "raise" ? "Added coverage for" : "Reserved coverage for"} ${obj}: ${delta}/day set aside (2× campaign rate)`;
  if (r.op === "create") return `Created ${obj} at ${delta} a day`;
  if (r.op === "resume") return `Turned on ${obj} (${delta} a day)`;
  if (r.op === "rebase") return `Lowered ${obj} to ${delta} a day`;
  return `Raised ${obj} by ${delta} a day`;
}

export function reservationResult(r: Pick<ReservationRow, "status" | "reason">): string {
  switch (r.status) {
    case "reserved":
      return "Sending";
    case "committed":
      return "Held";
    case "released":
      if (r.reason === "budget_stopped") return "Paused when the budget was stopped";
      if (r.reason === "month_rollover") return "Paused at the start of the month: over the monthly budget";
      if (r.reason === "paused") return "Paused";
      if (r.reason === "rejected") return "Not sent: the platform refused it";
      if (r.reason === "rebased") return "Replaced after a lower budget";
      return "Given back";
    case "refused":
      if (r.reason === "over_daily_limit") return "Refused: over the daily limit";
      return "Refused: over this month's budget";
  }
  return r.status;
}

export function holdAmountLabel(r: Pick<ReservationRow, "status">, amount: number): string {
  if (r.status === "released") return `${usd(amount)} set aside, then given back`;
  if (r.status === "refused") return `${usd(amount)} asked for, not set aside`;
  return `${usd(amount)} set aside`;
}

export function handRowAt(occurred_at: string, created_at: string): string {
  const createdMs = Date.parse(created_at);
  if (Number.isFinite(createdMs) && new Date(createdMs).toISOString().slice(0, 10) <= occurred_at) {
    return new Date(createdMs).toISOString();
  }
  return `${occurred_at}T23:59:59.999Z`;
}

function sourceOf(a: ApproverRow | undefined): LedgerSource {
  if (!a || !a.approved_by) return "automation";
  if (a.approved_by_source === "cgo") return "cgo";
  return "person";
}

export function byLabel(source: LedgerSource, actor: string | null | undefined, viewer: string | null | undefined): string {
  if (source === "cgo") return "Autopilot";
  if (source === "automation") return "Automatic";
  if (source === "outside") return "Outside Zavi";
  if (source === "channel") return "A channel";
  return actor && viewer && actor === viewer ? "You" : "A teammate";
}

type EventRow = {
  budget_id: string;
  occurred_at: string;
  kind: "setup" | "edit" | "stop";
  monthly_usd: number | string;
  daily_limit_usd: number | string | null;
  backfilled: boolean | null;
  actor?: string | null;
};

const optNum = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const dailyText = (d: number | null) => (d === null ? "none" : usd(d));

export function eventRow(e: EventRow, prev: EventRow | undefined, viewer?: string | null): LedgerRow {
  const monthly = num(e.monthly_usd);
  const daily = optNum(e.daily_limit_usd);
  const base = {
    at: e.occurred_at,
    kind: "event" as const,
    date: null,
    amount_usd: null,
    amount_label: null,
    source: "person" as const,
    by: byLabel("person", e.actor, viewer),
  };
  if (e.kind === "setup") {
    const limit = daily === null ? "" : `, up to ${usd(daily)} a day`;
    const late = e.backfilled ? " (recorded after the fact: the amount on file when this history began)" : "";
    return { ...base, action: `Budget set up: ${usd(monthly)} a month${limit}${late}`, result: "Set up" };
  }
  if (e.kind === "stop") return { ...base, action: `Budget stopped (${usd(monthly)} a month)`, result: "Stopped" };
  if (!prev) {
    return { ...base, action: `Budget changed to ${usd(monthly)} a month, daily limit ${dailyText(daily)}`, result: "Changed" };
  }
  const pm = num(prev.monthly_usd);
  const pd = optNum(prev.daily_limit_usd);
  const parts: string[] = [];
  if (pm !== monthly) parts.push(`${usd(pm)} → ${usd(monthly)} a month`);
  if (pd !== daily) parts.push(`daily limit ${dailyText(pd)} → ${dailyText(daily)}`);
  if (parts.length === 0) parts.push(`${usd(monthly)} a month`);
  return { ...base, action: `Budget changed: ${parts.join("; ")}`, result: "Changed" };
}

export type ExecutedAdChange = {
  id: string;
  cls: string;
  at: string;
  approved_by: string | null;
  approved_by_source: string | null;
  channel_slug: string | null;
  name: string | null;
  object_id: string | null;
  ad_set_id: string | null;
  campaign_id: string | null;
  status: string | null;
  level: string | null;
  daily_budget_usd: string | null;
  expected_current_daily_budget_usd: string | null;
  origin?: string | null;
};

const DISPLAY_KEYS = ["name", "object_id", "ad_set_id", "campaign_id", "status", "level", "daily_budget_usd", "expected_current_daily_budget_usd"] as const;
const displayCols = (col: "body" | "exec_payload") => DISPLAY_KEYS.map((k) => `${k}:${col}->>${k}`).join(", ");

async function readExecutedAdChanges(tenant_id: string): Promise<ExecutedAdChange[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const [act, dec] = await Promise.all([
    db
      .from("channel_actions")
      .select(`id, exec_class, executed_at, approved_by, approved_by_source, channel_slug, cgo_order_origin:body->>cgo_order_origin, ${displayCols("exec_payload")}`)
      .eq("tenant_id", tenant_id)
      .eq("exec_status", "executed")
      .or(AD_CLASS_FILTER("exec_class"))
      .order("executed_at", { ascending: false })
      .limit(LEDGER_LIMIT),
    db
      .from("decisions")
      .select(`id, decision_class, dispatched_at, approved_by, approved_by_source, ${displayCols("body")}`)
      .eq("tenant_id", tenant_id)
      .eq("status", "acted")
      .or(AD_CLASS_FILTER("decision_class"))
      .order("dispatched_at", { ascending: false })
      .limit(LEDGER_LIMIT),
  ]);
  if (act.error) throw new Error(`channel_actions read failed: ${act.error.message}`);
  if (dec.error) throw new Error(`decisions read failed: ${dec.error.message}`);
  type Raw = Record<string, string | null> & { id: string };
  const pick = (r: Raw, cls: string | null, at: string | null, channel: string | null): ExecutedAdChange | null =>
    cls && at
      ? {
          id: r.id,
          cls,
          at,
          approved_by: r.approved_by ?? null,
          approved_by_source: r.approved_by_source ?? null,
          channel_slug: channel,
          name: r.name ?? null,
          object_id: r.object_id ?? null,
          ad_set_id: r.ad_set_id ?? null,
          campaign_id: r.campaign_id ?? null,
          status: r.status ?? null,
          level: r.level ?? null,
          daily_budget_usd: r.daily_budget_usd ?? null,
          expected_current_daily_budget_usd: r.expected_current_daily_budget_usd ?? null,
          origin: r.cgo_order_origin ?? null,
        }
      : null;
  const out: ExecutedAdChange[] = [];
  for (const r of (act.data ?? []) as Raw[]) {
    const x = pick(r, r.exec_class, r.executed_at, r.channel_slug ?? null);
    if (x) out.push(x);
  }
  for (const r of (dec.data ?? []) as Raw[]) {
    const x = pick(r, r.decision_class, r.dispatched_at, null);
    if (x) out.push(x);
  }
  return out;
}

const CHANNEL_NAME: Record<string, string> = { meta_ads: "Meta Ads", google_ads: "Google Ads", youtube_ads: "YouTube Ads", chatgpt_ads: "ChatGPT Ads", reddit_ads: "Reddit Ads", tiktok_ads: "TikTok Ads" };

export function executedAction(x: ExecutedAdChange): string {
  const platform: AdPlatform = x.cls.startsWith("chatgpt_ads.") ? "chatgpt" : x.cls.startsWith("google_ads.") ? "google" : x.cls.startsWith("reddit_ads.") ? "reddit" : x.cls.startsWith("x_ads.") ? "x" : x.cls.startsWith("tiktok_ads.") ? "tiktok" : "meta";
  const verb = x.cls.replace(/^(meta_ads|google_ads|chatgpt_ads|reddit_ads|x_ads|tiktok_ads)\./, "").replace(/_review$/, "");
  const id = x.object_id ?? x.ad_set_id ?? x.campaign_id;
  const campaignLevel = x.level === "campaign" || (platform === "meta" && !x.object_id && !x.ad_set_id && !!x.campaign_id && verb !== "create_ad_set");
  const obj = adObjectLabel(platform, id, x.name, campaignLevel ? "campaign" : undefined);
  const d = x.daily_budget_usd === null ? null : Number(x.daily_budget_usd);
  const was = x.expected_current_daily_budget_usd === null ? null : Number(x.expected_current_daily_budget_usd);
  switch (verb) {
    case "set_object_status":
    case "set_status":
      return `${/PAUSED/i.test(x.status ?? "") ? "Paused" : "Turned on"} ${obj}`;
    case "update_budget":
    case "update_ad_set_budget":
    case "update_campaign_budget":
      return d !== null && was !== null && Number.isFinite(d) && Number.isFinite(was)
        ? `Changed the daily budget of ${obj}: ${usd(was)} → ${usd(d)}`
        : `Changed the daily budget of ${obj}`;
    case "create_and_launch":
      return `Created and launched ${obj}`;
    case "prepare_campaign":
    case "create_ad_set":
    case "create_campaign":
      return d !== null && Number.isFinite(d) ? `Created ${obj} at ${usd(d)} a day` : `Created ${obj}`;
    case "create_ad_group":
      return `Added an ad group to ${obj}`;
    case "create_ad":
      return `Added an ad to ${obj}`;
    case "add_keywords":
      return `Added keywords to ${obj}`;
    case "remove_resource":
      return `Removed something from ${obj}`;
    default:
      return `Changed the settings of ${obj}`;
  }
}

function holdsLabel(holds: ReservationRow[]): { amount: number | null; label: string | null; result: string | null } {
  const live = holds.filter((h) => h.status !== "refused");
  if (live.length === 0) return { amount: null, label: null, result: null };
  const rebase = live.find((h) => h.op === "rebase");
  const adds = live.filter((h) => h.op !== "rebase");
  const main = adds[0] ?? rebase!;
  if (adds.length === 0 && rebase) {
    const d = num(rebase.daily_delta_usd);
    return { amount: d, label: `now held at ${usd(d)}/day`, result: reservationResult(rebase) };
  }
  const cents = adds.reduce((s, h) => s + Math.round(num(h.daily_delta_usd) * 100), 0);
  const d = cents / 100;
  const back = adds.every((h) => h.status === "released") ? ", then given back" : "";
  return { amount: d, label: `+${usd(d)}/day set aside${back}`, result: reservationResult(main) };
}

function changeBy(x: ExecutedAdChange, viewer: string | null | undefined): { source: LedgerSource; by: string } {
  if (x.approved_by_source === "cgo") return { source: "cgo", by: x.origin === "ad_spend_controller" ? "Autopilot spend controller" : "Autopilot" };
  if (!x.approved_by) {
    const slug = x.channel_slug ?? (x.cls.startsWith("chatgpt_ads.") ? "chatgpt_ads" : x.cls.startsWith("google_ads.") ? "google_ads" : "meta_ads");
    return { source: "channel", by: `${CHANNEL_NAME[slug] ?? "A"} channel` };
  }
  return { source: "person", by: byLabel("person", x.approved_by, viewer) };
}

const objectKey = (c: Pick<AdChangeRow, "platform" | "object_id">) => `${c.platform}:${c.object_id}`;

export function changeRows(
  executed: ReadonlyArray<ExecutedAdChange>,
  holdsOf: ReadonlyMap<string, ReservationRow[]>,
  changes: ReadonlyArray<AdChangeRow>,
  viewer?: string | null,
): LedgerRow[] {
  const newest = new Map<string, string>();
  for (const c of changes) if (!newest.has(objectKey(c))) newest.set(objectKey(c), c.id);
  const priorOf = new Map<string, AdChangeRow>();
  for (const c of changes) if (c.source === "zavi" && c.action_id && !priorOf.has(c.action_id)) priorOf.set(c.action_id, c);

  return executed.map((x) => {
    const prior = priorOf.get(x.id) ?? null;
    const who = changeBy(x, viewer);
    const holds = holdsLabel(holdsOf.get(x.id) ?? []);
    let amount_usd = holds.amount;
    let amount_label = holds.label;
    const isPause = /set_status/.test(x.cls) && /PAUSED/i.test(x.status ?? "");
    if (amount_label === null && isPause) {
      const freed = prior ? freedPerDay({ ...prior, before_daily_usd: prior.before_daily_usd === null ? null : Number(prior.before_daily_usd) }) : null;
      amount_usd = freed;
      amount_label = freed !== null ? `about ${usd(freed)}/day freed` : "amount unknown";
    }
    const inv = prior && newest.get(objectKey(prior)) === prior.id ? inverseOf(prior) : null;
    return {
      at: x.at,
      kind: "change" as const,
      date: null,
      action: prior ? describeChange(prior) : executedAction(x),
      amount_usd,
      amount_label,
      result: holds.result ?? "Done",
      source: who.source,
      by: who.by,
      undo: inv && prior ? { change_id: prior.id, change: inv.change } : null,
    };
  });
}

export function outsideRow(o: AdChangeRow): LedgerRow {
  const pause = o.change_kind === "status" && describeChange(o).startsWith("Paused");
  const freed = pause ? freedPerDay({ ...o, before_daily_usd: o.before_daily_usd === null ? null : Number(o.before_daily_usd) }) : null;
  return {
    at: o.occurred_at,
    kind: "outside",
    date: null,
    action: `${describeChange(o)}, outside Zavi`,
    amount_usd: freed,
    amount_label: pause ? (freed !== null ? `about ${usd(freed)}/day freed` : "amount unknown") : null,
    result: "Seen in the ad account",
    source: "outside",
    by: "Outside Zavi",
    undo: null,
  };
}

export async function readAdBudgetLedger(tenant_id: string, viewer?: string | null): Promise<LedgerRow[]> {
  const db = tenantClient(asTenantId(tenant_id));

  const { data: evData, error: evErr } = await db
    .from("ad_budget_events")
    .select("budget_id, occurred_at, kind, monthly_usd, daily_limit_usd, backfilled, actor")
    .order("occurred_at", { ascending: false })
    .limit(LEDGER_LIMIT);
  if (evErr) throw new Error(`ad_budget_events read failed: ${evErr.message}`);
  const events = (evData ?? []) as EventRow[];

  const { data: resData, error: resErr } = await db
    .from("ad_budget_reservations")
    .select("idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(LEDGER_LIMIT);
  if (resErr) throw new Error(`ad_budget_reservations read failed: ${resErr.message}`);
  const reservations = (resData ?? []) as ReservationRow[];

  const ids = [...new Set(reservations.map((r) => r.idem_key.split(":")[0]).filter((id) => UUID_RE.test(id)))];
  const approvers = new Map<string, ApproverRow>();
  if (ids.length > 0) {
    const [dec, act] = await Promise.all([
      db.from("decisions").select("id, approved_by, approved_by_source, name:body->>name").in("id", ids).or(AD_CLASS_FILTER("decision_class")),
      db
        .from("channel_actions")
        .select("id, approved_by, approved_by_source, name:exec_payload->>name")
        .in("id", ids)
        .or(AD_CLASS_FILTER("exec_class")),
    ]);
    if (dec.error) throw new Error(`decisions read failed: ${dec.error.message}`);
    if (act.error) throw new Error(`channel_actions read failed: ${act.error.message}`);
    for (const row of [...((dec.data ?? []) as ApproverRow[]), ...((act.data ?? []) as ApproverRow[])]) {
      approvers.set(row.id, {
        id: row.id,
        approved_by: row.approved_by,
        approved_by_source: row.approved_by_source,
        name: typeof row.name === "string" ? row.name : null,
      });
    }
  }

  const executed = await readExecutedAdChanges(tenant_id);
  const { data: chData, error: chErr } = await db
    .from("ad_object_changes")
    .select(AD_CHANGE_COLUMNS)
    .eq("tenant_id", tenant_id)
    .order("occurred_at", { ascending: false })
    .limit(LEDGER_LIMIT * 2);
  if (chErr) throw new Error(`ad_object_changes read failed: ${chErr.message}`);
  const changes = (chData ?? []) as AdChangeRow[];

  const { data: humData, error: humErr } = await db
    .from("ad_budget_human_actions")
    .select("occurred_at, note, amount_usd, created_at, created_by")
    .order("occurred_at", { ascending: false })
    .limit(LEDGER_LIMIT);
  if (humErr) throw new Error(`ad_budget_human_actions read failed: ${humErr.message}`);

  const execIds = new Set(executed.map((x) => x.id));
  const holdsOf = new Map<string, ReservationRow[]>();
  for (const r of reservations) {
    const id = r.idem_key.split(":")[0];
    if (!execIds.has(id)) continue;
    holdsOf.set(id, [...(holdsOf.get(id) ?? []), r]);
  }
  const rows: LedgerRow[] = changeRows(executed, holdsOf, changes, viewer);
  for (const o of changes) if (o.source === "outside") rows.push(outsideRow(o));

  for (const r of reservations) {
    if (execIds.has(r.idem_key.split(":")[0])) continue;
    const amount = num(r.amount_usd);
    const approver = approvers.get(r.idem_key.split(":")[0]);
    const source = sourceOf(approver);
    rows.push({
      at: r.created_at,
      kind: "hold",
      date: null,
      action: reservationAction(r, approver?.name),
      amount_usd: amount,
      amount_label: holdAmountLabel(r, amount),
      result: reservationResult(r),
      source,
      by: byLabel(source, approver?.approved_by, viewer),
    });
  }
  for (const h of (humData ?? []) as Array<{
    occurred_at: string;
    note: string;
    amount_usd: number | string | null;
    created_at: string;
    created_by?: string | null;
  }>) {
    const amount = h.amount_usd === null ? null : num(h.amount_usd);
    rows.push({
      at: handRowAt(h.occurred_at, h.created_at),
      kind: "hand",
      date: h.occurred_at,
      action: `Logged by hand: ${h.note}`,
      amount_usd: amount,
      amount_label: amount === null ? null : `${usd(amount)} (logged by hand)`,
      result: "Logged",
      source: "person",
      by: byLabel("person", h.created_by, viewer),
    });
  }
  const chron = [...events].sort((x, y) => (x.occurred_at < y.occurred_at ? -1 : x.occurred_at > y.occurred_at ? 1 : 0));
  const lastOf = new Map<string, EventRow>();
  for (const e of chron) {
    rows.push(eventRow(e, lastOf.get(e.budget_id), viewer));
    lastOf.set(e.budget_id, e);
  }
  const t = (r: LedgerRow) => Date.parse(r.at) || 0;
  return rows.sort((x, y) => t(y) - t(x));
}

export type StopOutcome =
  | { status: "not_found" }
  | {
      status: "stopped" | "already_stopped";
      paused: Array<{ platform: AdPlatform; object_id: string; released_usd: number | null }>;
      failed: Array<{ platform: AdPlatform; object_id: string; error: string; label: string; reason: string }>;
    };

async function pauseObject(tenant_id: string, platform: AdPlatform, object_id: string): Promise<void> {
  if (platform === "linkedin") { await (await import("@/services/ads-wallet/adapters/linkedin")).requestLinkedinPause(tenant_id, object_id); return; }
  if (platform === "x") { await (await import("@/services/connectors/x-ads/budget-ledger")).pauseXBudgetObject(tenant_id, object_id); return; }
  if (platform === "tiktok") { await (await import("@/services/connectors/tiktok-ads/execute")).pauseTiktokBudgetObject(tenant_id, object_id); return; }
  if (platform === "reddit") {
    const { pauseRedditBudgetObject } = await import("@/services/connectors/reddit-ads/spend-controls");
    await pauseRedditBudgetObject(tenant_id, object_id);
    return;
  }
  if (platform === "chatgpt") {
    const { readCampaign, updateCampaign } = await import("@/services/connectors/chatgpt-ads/workspace");
    const {withChatgptBudgetCampaign}=await import("@/services/ads-wallet/chatgpt-budget-identity");
    await withChatgptBudgetCampaign(tenant_id,object_id,async providerId=>{
    const c = await readCampaign(tenant_id, providerId);
    if (c.status === "archived" || (typeof c.end_time === "number" && c.end_time * 1000 + 48 * 3600000 <= Date.now())) return;
    const { withApprovedChatgptDispatch } = await import("@/services/connectors/chatgpt-ads/growth-workspace-budget");
    await withApprovedChatgptDispatch(tenant_id, () => updateCampaign(tenant_id, providerId, { status: "paused", expected_updated_at: c.updated_at }));
    });
    return;
  }
  if (platform === "meta") {
    await metaSetStatus(tenant_id, { object_id, level: "adset", status: "PAUSED" });
    return;
  }
  const live = await gadsGetCampaignBudget(tenant_id, object_id);
  if (live.channel_type === "VIDEO") throw new Error(VIDEO_PAUSE_REFUSED);
  await googleSetCampaignStatus(tenant_id, { campaign_resource: live.campaign_resource, status: "PAUSED" });
}

export const VIDEO_PAUSE_REFUSED =
  "Google does not let Zavi pause YouTube Video campaigns. Pause this campaign in Google Ads yourself; it keeps spending until you do.";

export type HeldObject = { platform: AdPlatform; object_id: string; in_flight?: boolean };
export type PauseResult = {
  paused: Array<{ platform: AdPlatform; object_id: string; released_usd: number | null }>;
  failed: Array<{ platform: AdPlatform; object_id: string; error: string; reason?: string }>;
};

export async function pauseHeldObjects(
  tenant_id: string,
  budget_id: string,
  objects: HeldObject[],
  opts: { logTag: string; inFlightMessage: string },
): Promise<PauseResult> {
  const tid = asTenantId(tenant_id);
  const paused: PauseResult["paused"] = [];
  const failed: PauseResult["failed"] = [];
  for (const o of objects) {
    if ((o.platform !== "meta" && o.platform !== "google" && o.platform !== "chatgpt" && o.platform !== "reddit" && o.platform !== "x" && o.platform !== "tiktok" && o.platform !== "linkedin") || typeof o.object_id !== "string") continue;
    try {
      await pauseObject(tenant_id, o.platform, o.object_id);
    } catch (e) {
      const msg = (e as Error).message ?? "unknown error";
      console.error(`[${opts.logTag}] pause failed for ${o.platform} ${o.object_id} (tenant ${tenant_id}); the hold stays: ${msg}`);
      const shown = msg === VIDEO_PAUSE_REFUSED || (o.platform === "linkedin" && e instanceof ExpectedToolError);
      failed.push({ platform: o.platform, object_id: o.object_id, error: msg.slice(0, 300), ...(shown ? { reason: msg.slice(0, 400) } : {}) });
      continue;
    }
    console.log(`[${opts.logTag}] paused ${o.platform} ${o.object_id} (tenant ${tenant_id}, budget ${budget_id})`);
    await recordAdObjectChanges(tenant_id, [
      {
        platform: o.platform,
        object_id: o.object_id,
        level: o.platform === "google" ? "campaign" : null,
        campaign_id: null,
        object_name: null,
        source: "zavi",
        action_table: "budget_stop",
        action_id: null,
        change_kind: "status",
        before_status: null,
        after_status: "PAUSED",
        before_daily_usd: null,
        after_daily_usd: null,
      },
    ]).catch((e: Error) => console.warn(`[${opts.logTag}] stop record for ${o.object_id} not written: ${e.message}`));
    if (o.in_flight === true) {
      failed.push({ platform: o.platform, object_id: o.object_id, error: opts.inFlightMessage, reason: opts.inFlightMessage });
      continue;
    }
    let released: number | null = null;
    try {
      const rel = await tenantRpc(tid, "release_ad_spend_for_object", {
        p_platform: o.platform,
        p_object_id: o.object_id,
        p_budget_id: budget_id,
      });
      if (rel.error) throw new Error(rel.error.message);
      released = num((rel.data as { released_usd?: number | string } | null)?.released_usd);
    } catch (e) {
      console.error(`[${opts.logTag}] release failed for ${o.platform} ${o.object_id}; the hold stays: ${(e as Error).message}`);
    }
    paused.push({ platform: o.platform, object_id: o.object_id, released_usd: released });
  }
  return { paused, failed };
}

export async function stopAdBudget(tenant_id: string, actor: string, budget_id: string): Promise<StopOutcome> {
  const tid = asTenantId(tenant_id);
  const r = await tenantRpc(tid, "stop_ad_budget", { p_actor: actor, p_budget_id: budget_id });
  if (r.error) throw new Error(`stop_ad_budget failed: ${r.error.message}`);
  const ans = (r.data ?? {}) as { status?: string; objects?: HeldObject[] };
  if (ans.status === "not_found") return { status: "not_found" };
  if (ans.status !== "stopped" && ans.status !== "already_stopped") {
    throw new Error(`stop_ad_budget returned an unknown answer: ${String(ans.status)}`);
  }
  const { paused, failed } = await pauseHeldObjects(tenant_id, budget_id, ans.objects ?? [], {
    logTag: "ad-budget-stop",
    inFlightMessage:
      "A change to this ad was still being sent when you stopped. Press Stop again in a minute to make sure it is paused.",
  });
  const described: Array<{ platform: AdPlatform; object_id: string; error: string; label: string; reason: string }> = [];
  for (const f of failed) {
    const facts = await heldObjectFacts(tenant_id, f);
    described.push({ platform: f.platform, object_id: f.object_id, error: f.error, label: facts.label, reason: f.reason ?? facts.fallback });
  }
  return { status: ans.status, paused, failed: described };
}

export async function heldObjectFacts(tenant_id: string, o: { platform: AdPlatform; object_id: string }): Promise<{ label: string; fallback: string }> {
  const platformName = PLATFORM_NAME[o.platform];
  if (o.platform !== "linkedin") {
    return { label: adObjectLabel(o.platform, o.object_id), fallback: `Pause it in ${platformName.endsWith("Ads") ? platformName : `${platformName} Ads`}, or press Stop again.` };
  }
  let name: string | null = null;
  let wallet = false;
  try {
    const { getCampaignBinding } = await import("@/services/ads-wallet/bindings");
    const binding = await getCampaignBinding(tenant_id, o.object_id);
    wallet = binding.funding_source === "wallet";
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("channel_actions")
      .select("name:exec_payload->campaign->>name")
      .eq("tenant_id", tenant_id)
      .eq("exec_class", "linkedin_ads.create_campaign_bundle")
      .eq("exec_progress->>campaign_id", binding.provider_campaign_id)
      .limit(1);
    const n = (data as Array<{ name: unknown }> | null)?.[0]?.name;
    name = typeof n === "string" ? n : null;
  } catch {
    name = null;
  }
  return {
    label: adObjectLabel("linkedin", null, name),
    fallback: wallet
      ? "It runs on Zavi's shared ads account, so Zavi pauses it for you. Press Stop again in a minute."
      : "Pause it in LinkedIn Campaign Manager, or press Stop again.",
  };
}
