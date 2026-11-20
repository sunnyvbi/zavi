
import { LAUNCH_GRACE_MS, OBSERVED_DAYS, dailyBudgetCapacityUsd } from "@/services/growth/delivery-capacity";
import { RUNNING_STATUS, STOPPED_STATUS } from "./ad-budget-brake";

export const SNAPSHOT_STALE_MS = 3 * 3_600_000;

const PREPAID_PLATFORMS: ReadonlySet<string> = new Set(["chatgpt"]);

const ALSO_STOPPED: ReadonlySet<string> = new Set(["REMOVED", "ADSET_PAUSED", "AD_GROUP_PAUSED", "ENDED", "ENDED_SETTLING"]);

const HOLD_FACTOR: Readonly<Record<string, number>> = { chatgpt: 2, x: 2 };

const DAY_MS = 86_400_000;
const cents = (n: number) => Math.round(n * 100);
const usd = (c: number) => Math.round(c) / 100;

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}
function pos(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export type BookObject = {
  platform: string;
  account_id: string;
  object_id: string;
  level?: string | null;
  campaign_id?: string | null;
  name?: string | null;
  budget_kind: string;
  budget_usd: number | string | null;
  campaign_budget_usd?: number | string | null;
  status: string | null;
};
export type BookSpend = { platform: string; account_id: string; object_id: string; spend_date: string; amount_usd: number | string };
export type BookChange = { platform: string; object_id: string; campaign_id?: string | null; occurred_at: string };
export type BookHold = {
  id: string;
  idem_key?: string | null;
  platform: string;
  object_id: string | null;
  status: string;
  paused?: boolean | null;
  daily_delta_usd: number | string;
  created_at: string;
  updated_at: string;
};
export type BookBudget = {
  budget_id: string;
  month_start: string;
  month_cap_usd: number;
  spent_usd: number;
  creator_held_usd: number;
  creator_spent_usd: number;
  days_left: number;
  margin: number;
};
export type BookAccount = { platform: string; account_id: string; today: string };

export type SnapshotInput = {
  budget: BookBudget;
  objects: readonly BookObject[];
  spend: readonly BookSpend[];
  lifetime_spend?: Readonly<Record<string, number>>;
  changes: readonly BookChange[];
  holds: readonly BookHold[];
  accounts: readonly BookAccount[];
  unread_platforms: readonly string[];
  read_started_at: string;
  now: Date;
  generation?: number | null;
};

export type SnapshotObject = {
  platform: string;
  account_id: string;
  object_id: string;
  name: string | null;
  live_budget_usd: number | null;
  expected_daily_usd: number;
  ceiling_daily_usd: number;
  exposure_usd: number;
  basis: string;
};

export type SnapshotTotals = {
  month_cap_usd: number;
  spent: number;
  creator_committed: number;
  days_left: number;
  margin: number;
  expected_daily: number;
  ceiling_daily: number;
  fixed_exposure: number;
  expected_rest: number;
  ceiling_rest: number;
  open_authorizations: number;
  expected_room: number;
  ceiling_room: number;
  objects_total: number;
  objects_counted: number;
  unknown_budgets: number;
};

export type MonthSnapshot = {
  budget_id: string;
  month_start: string;
  generation: number | null;
  read_started_at: string;
  complete_platforms: string[];
  unread_platforms: string[];
  totals: SnapshotTotals;
  objects: SnapshotObject[];
  reflected_hold_ids: string[];
};

export function objectCounts(o: { platform: string; status: string | null }): { counts: boolean; known: boolean } {
  const s = o.status;
  if (s === null || s === undefined || s === "") return { counts: true, known: false };
  const u = s.toUpperCase();
  if (STOPPED_STATUS.has(u) || ALSO_STOPPED.has(u)) return { counts: false, known: true };
  const allow = RUNNING_STATUS[o.platform];
  return { counts: true, known: allow ? allow.has(s) : u === "ACTIVE" };
}

export function holdExposureUsd(holds: readonly BookHold[], days_left: number, margin: number): number {
  const days = Math.max(0, Math.floor(days_left));
  let sum = 0;
  for (const h of holds) sum += Math.max(0, num(h.daily_delta_usd)) * (h.paused ? 1 : days);
  return Math.ceil(Number((sum * (margin >= 1 ? margin : 1) * 100).toFixed(4))) / 100;
}

export function splitHolds(
  holds: readonly BookHold[],
  i: { read_started_at: string; complete_platforms: ReadonlySet<string>; ledger_keys: ReadonlySet<string> },
): { reflected: BookHold[]; open: BookHold[] } {
  const fence = Date.parse(i.read_started_at);
  const reflected: BookHold[] = [];
  const open: BookHold[] = [];
  for (const h of holds) {
    if (h.status !== "reserved" && h.status !== "committed") continue;
    const written = Date.parse(h.updated_at);
    const shown =
      h.status === "committed" &&
      !!h.object_id &&
      i.complete_platforms.has(h.platform) &&
      i.ledger_keys.has(`${h.platform}:${h.object_id}`) &&
      Number.isFinite(fence) &&
      Number.isFinite(written) &&
      written < fence;
    (shown ? reflected : open).push(h);
  }
  return { reflected, open };
}

export type BookMemory = { v: 1; accounts: Record<string, Record<string, { s: string; t?: string }>> };

function memorySignature(o: BookObject): string {
  const c = (v: unknown) => (pos(v) === null ? "" : String(cents(pos(v) as number)));
  return `${o.budget_kind}|${c(o.budget_usd)}|${c(o.campaign_budget_usd)}|${objectCounts(o).counts ? 1 : 0}`;
}

export function advanceMemory(
  prev: unknown,
  i: { objects: readonly BookObject[]; accounts: readonly BookAccount[]; unread_platforms: readonly string[]; now: Date },
): { memory: BookMemory; changes: BookChange[] } {
  const p = prev as Partial<BookMemory> | null;
  const before: BookMemory["accounts"] = p && p.v === 1 && p.accounts && typeof p.accounts === "object" ? p.accounts : {};
  const nowMs = i.now.getTime();
  const nowIso = i.now.toISOString();
  const fresh = (t: string | undefined): t is string => {
    if (typeof t !== "string") return false;
    const ms = Date.parse(t);
    return Number.isFinite(ms) && nowMs - ms <= LAUNCH_GRACE_MS && ms - nowMs <= 5 * 60_000;
  };
  const unread = new Set(i.unread_platforms);
  const covered = new Set(i.accounts.filter((a) => !unread.has(a.platform)).map((a) => `${a.platform}:${a.account_id}`));
  const accounts: BookMemory["accounts"] = {};
  const changes: BookChange[] = [];

  for (const [acct, objects] of Object.entries(before)) {
    if (covered.has(acct) || !objects || typeof objects !== "object") continue;
    accounts[acct] = {};
    const platform = acct.slice(0, acct.indexOf(":"));
    for (const [object_id, e] of Object.entries(objects)) {
      if (!e || typeof e.s !== "string") continue;
      accounts[acct][object_id] = fresh(e.t) ? { s: e.s, t: e.t } : { s: e.s };
      if (fresh(e.t)) changes.push({ platform, object_id, occurred_at: e.t });
    }
  }
  for (const acct of covered) accounts[acct] = {};
  for (const o of i.objects) {
    const acct = `${o.platform}:${o.account_id}`;
    if (!covered.has(acct) || accounts[acct][o.object_id]) continue;
    const known = before[acct];
    const was = known?.[o.object_id];
    const s = memorySignature(o);
    const t = !known ? undefined : !was || was.s !== s ? nowIso : fresh(was.t) ? was.t : undefined;
    accounts[acct][o.object_id] = t ? { s, t } : { s };
    if (t) changes.push({ platform: o.platform, object_id: o.object_id, campaign_id: o.campaign_id ?? null, occurred_at: t });
  }
  return { memory: { v: 1, accounts }, changes };
}

type Emitted = SnapshotObject & { capped: boolean; unknown_budget?: boolean };

export function monthSnapshot(i: SnapshotInput): MonthSnapshot {
  const nowMs = i.now.getTime();
  const utcToday = new Date(Date.UTC(i.now.getUTCFullYear(), i.now.getUTCMonth(), i.now.getUTCDate())).toISOString().slice(0, 10);
  const unread = new Set(i.unread_platforms);
  const todayOf = new Map<string, string>();
  for (const a of i.accounts) if (!unread.has(a.platform)) todayOf.set(`${a.platform}:${a.account_id}`, a.today);
  const completePlatforms = new Set([...todayOf.keys()].map((k) => k.slice(0, k.indexOf(":"))));

  const byAccount = new Map<string, BookObject[]>();
  const seen = new Set<string>();
  for (const o of i.objects) {
    const acct = `${o.platform}:${o.account_id}`;
    if (!unread.has(o.platform) && !todayOf.has(acct)) continue;
    const key = `${acct}:${o.object_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byAccount.has(acct)) byAccount.set(acct, []);
    byAccount.get(acct)!.push(o);
  }

  const byDay = new Map<string, number>();
  const spendObjects = new Map<string, Set<string>>();
  for (const s of i.spend) {
    const acct = `${s.platform}:${s.account_id}`;
    const k = `${acct}:${s.object_id}:${String(s.spend_date).slice(0, 10)}`;
    byDay.set(k, Math.max(byDay.get(k) ?? 0, cents(Math.max(0, num(s.amount_usd)))));
    if (!spendObjects.has(acct)) spendObjects.set(acct, new Set());
    spendObjects.get(acct)!.add(s.object_id);
  }
  const observed = (acct: string, object_id: string): number => {
    const today = todayOf.get(acct) ?? utcToday;
    let c = 0;
    for (let k = 1; k <= OBSERVED_DAYS; k++) c += byDay.get(`${acct}:${object_id}:${shiftDay(today, -k)}`) ?? 0;
    return usd(c);
  };
  const lifetimeSpent = (o: BookObject) => Math.max(0, num(i.lifetime_spend?.[`${o.platform}:${o.account_id}:${o.object_id}`]));

  const changed = new Set<string>();
  const recent = (at: string) => {
    const t = Date.parse(at);
    return Number.isFinite(t) && nowMs - t <= LAUNCH_GRACE_MS && t - nowMs <= 5 * 60_000;
  };
  for (const c of i.changes) {
    if (!recent(c.occurred_at)) continue;
    changed.add(`${c.platform}:${c.object_id}`);
    if (c.campaign_id) changed.add(`${c.platform}:${c.campaign_id}`);
  }
  for (const h of i.holds) {
    if (!h.object_id || (h.status !== "reserved" && h.status !== "committed")) continue;
    if (h.status === "reserved" || recent(h.created_at)) changed.add(`${h.platform}:${h.object_id}`);
  }

  const out: Emitted[] = [];
  const trailing = (obs: number) => usd(cents(obs / OBSERVED_DAYS));
  const dailyBasis = (grace: boolean, obs: number, expected: number, budget: number) =>
    grace ? "changed_24h_full_budget" : obs <= 0 ? "no_delivery" : expected < budget ? "trailing_delivery" : "budget_cap";

  for (const [acct, rows] of byAccount) {
    const platform = rows[0].platform;
    const account_id = rows[0].account_id;
    const emitted: Emitted[] = [];
    const push = (r: Omit<Emitted, "platform" | "account_id">) => emitted.push({ platform, account_id, ...r });
    let anyRunning = false;

    const byCampaign = new Map<string, BookObject[]>();
    for (const o of rows) {
      const k = o.campaign_id || o.object_id;
      if (!byCampaign.has(k)) byCampaign.set(k, []);
      byCampaign.get(k)!.push(o);
    }

    const single = (o: BookObject) => {
      const st = objectCounts(o);
      if (!st.counts) return;
      anyRunning = true;
      const budget = pos(o.budget_usd);
      const obs = observed(acct, o.object_id);
      const grace = changed.has(`${platform}:${o.object_id}`) || (!!o.campaign_id && changed.has(`${platform}:${o.campaign_id}`));
      const tag = st.known ? "" : "+unknown_status";
      if (o.budget_kind === "daily" && budget !== null) {
        if (PREPAID_PLATFORMS.has(platform)) {
          push({ object_id: o.object_id, name: o.name ?? null, live_budget_usd: budget, expected_daily_usd: budget, ceiling_daily_usd: budget, exposure_usd: 0, basis: `prepaid_full_budget${tag}`, capped: true });
          return;
        }
        const expected = dailyBudgetCapacityUsd(budget, { just_launched: grace, spend_observed_usd: obs });
        push({ object_id: o.object_id, name: o.name ?? null, live_budget_usd: budget, expected_daily_usd: expected, ceiling_daily_usd: budget, exposure_usd: 0, basis: `${dailyBasis(grace, obs, expected, budget)}${tag}`, capped: true });
        return;
      }
      if (o.budget_kind === "lifetime" && budget !== null) {
        const left = usd(Math.max(0, cents(budget) - cents(lifetimeSpent(o))));
        push({ object_id: o.object_id, name: o.name ?? null, live_budget_usd: budget, expected_daily_usd: 0, ceiling_daily_usd: 0, exposure_usd: left, basis: `lifetime_remaining${tag}`, capped: true });
        return;
      }
      const t = trailing(obs);
      push({ object_id: o.object_id, name: o.name ?? null, live_budget_usd: null, expected_daily_usd: t, ceiling_daily_usd: t, exposure_usd: 0, basis: `trailing_delivery_no_own_budget${tag}`, capped: false });
    };

    const family = (ckey: string, members: BookObject[], parent: BookObject | undefined) => {
      if (parent && !objectCounts(parent).counts) return;
      const running = members.filter((m) => objectCounts(m).counts);
      if (running.length === 0) return;
      anyRunning = true;
      const children = running.filter((m) => m !== parent);
      const parentBudget = parent ? pos(parent.budget_usd) : null;
      const parentDaily = parent && parent.budget_kind === "daily" ? parentBudget : null;
      const parentLifetime = parent && parent.budget_kind === "lifetime" ? parentBudget : null;
      const onChildren = children
        .filter((c) => c.budget_kind === "campaign_level")
        .reduce<number | null>((m, c) => { const b = pos(c.campaign_budget_usd); return b !== null && (m === null || b > m) ? b : m; }, null);
      const P = parentDaily ?? (parentLifetime === null ? onChildren : null);
      const ownDaily = children.filter((c) => c.budget_kind === "daily" && pos(c.budget_usd) !== null);
      const C = usd(ownDaily.reduce((s, c) => s + cents(pos(c.budget_usd) as number), 0));
      const lifetimeChildren = children.filter((c) => c.budget_kind === "lifetime" && pos(c.budget_usd) !== null);
      const openEnded =
        children.some((c) =>
          c.budget_kind === "campaign_level"
            ? P === null && parentLifetime === null
            : !ownDaily.includes(c) && !lifetimeChildren.includes(c)) ||
        (children.length === 0 && P === null && parentLifetime === null);
      const unknownBudget = children.some((c) => c.budget_kind === "campaign_level") && P === null && parentLifetime === null;
      const obs = usd(running.reduce((s, m) => s + cents(observed(acct, m.object_id)), 0));
      const grace = changed.has(`${platform}:${ckey}`) || running.some((m) => changed.has(`${platform}:${m.object_id}`));
      const cap = openEnded ? null : P !== null && C > 0 ? Math.min(P, C) : (P ?? (C > 0 ? C : null));
      const lifetimeTotal = usd(cents(parentLifetime ?? 0) + lifetimeChildren.reduce((s, c) => s + cents(pos(c.budget_usd) as number), 0));

      let expected = 0;
      let ceiling = 0;
      let basis: string;
      if (cap !== null) {
        ceiling = cap;
        expected = PREPAID_PLATFORMS.has(platform) ? cap : dailyBudgetCapacityUsd(cap, { just_launched: grace, spend_observed_usd: obs });
        basis = `campaign_budget:${PREPAID_PLATFORMS.has(platform) ? "prepaid_full_budget" : dailyBasis(grace, obs, expected, cap)}`;
      } else if (openEnded || lifetimeTotal === 0) {
        expected = ceiling = trailing(obs);
        basis = unknownBudget ? "campaign_budget:unknown_amount_trailing_delivery_only" : "campaign_budget:trailing_delivery_no_known_budget";
      } else {
        basis = "campaign_budget:lifetime_remaining";
      }
      let exposure = 0;
      if (lifetimeTotal > 0) {
        const spenders = parentLifetime !== null ? members : cap === null && !openEnded ? [...lifetimeChildren, ...(parent ? [parent] : [])] : lifetimeChildren;
        const spent = spenders.reduce((s, m) => s + cents(lifetimeSpent(m)), 0);
        exposure = usd(Math.max(0, cents(lifetimeTotal) - spent));
        if (cap !== null || openEnded) basis += "+lifetime_remaining";
      }
      if (running.some((m) => !objectCounts(m).known)) basis += "+unknown_status";
      push({
        object_id: ckey,
        name: parent?.name ?? null,
        live_budget_usd: cap ?? (lifetimeTotal > 0 ? lifetimeTotal : null),
        expected_daily_usd: expected,
        ceiling_daily_usd: ceiling,
        exposure_usd: exposure,
        basis,
        capped: cap !== null || (!openEnded && lifetimeTotal > 0),
        ...(unknownBudget ? { unknown_budget: true } : {}),
      });
    };

    for (const [ckey, members] of byCampaign) {
      const parent = members.length > 1 ? members.find((m) => m.object_id === ckey) : undefined;
      const isFamily = members.length > 1 ? parent !== undefined || members.some((m) => m.budget_kind === "campaign_level") : members[0].budget_kind === "campaign_level";
      if (isFamily) family(ckey, members, parent);
      else for (const m of members) single(m);
    }

    const ledgerIds = new Set(rows.map((r) => r.object_id));
    let loose = 0;
    for (const id of spendObjects.get(acct) ?? []) if (!ledgerIds.has(id)) loose += cents(observed(acct, id));
    const looseDaily = trailing(usd(loose));
    if (looseDaily > 0 && anyRunning) {
      const open = emitted.some((e) => !e.capped);
      const headroom = usd(emitted.reduce((s, e) => s + Math.max(0, cents(e.ceiling_daily_usd) - cents(e.expected_daily_usd)), 0));
      const expected = open ? looseDaily : Math.min(looseDaily, headroom);
      const ceiling = open ? looseDaily : 0;
      if (expected > 0 || ceiling > 0) {
        push({ object_id: "(account)", name: null, live_budget_usd: null, expected_daily_usd: expected, ceiling_daily_usd: ceiling, exposure_usd: 0, basis: "account_level_delivery", capped: false });
      }
    }
    out.push(...emitted);
  }

  for (const [acct, ids] of spendObjects) {
    if (byAccount.has(acct)) continue;
    const platform = acct.slice(0, acct.indexOf(":"));
    if (!unread.has(platform) && !todayOf.has(acct)) continue;
    let loose = 0;
    for (const id of ids) loose += cents(observed(acct, id));
    const t = trailing(usd(loose));
    if (t > 0) out.push({ platform, account_id: acct.slice(acct.indexOf(":") + 1), object_id: "(account)", name: null, live_budget_usd: null, expected_daily_usd: t, ceiling_daily_usd: t, exposure_usd: 0, basis: "account_level_delivery_no_objects", capped: false });
  }

  const ledgerKeys = new Set<string>();
  for (const [acct, rows] of byAccount) {
    if (!todayOf.has(acct)) continue;
    for (const o of rows) {
      ledgerKeys.add(`${o.platform}:${o.object_id}`);
      if (o.campaign_id) ledgerKeys.add(`${o.platform}:${o.campaign_id}`);
    }
  }
  const { reflected, open } = splitHolds(i.holds, { read_started_at: i.read_started_at, complete_platforms: completePlatforms, ledger_keys: ledgerKeys });

  const b = i.budget;
  const days = Math.max(0, Math.floor(num(b.days_left)));
  const margin = num(b.margin) >= 1 ? num(b.margin) : 1;
  const counted = out.filter((o) => o.expected_daily_usd > 0 || o.ceiling_daily_usd > 0 || o.exposure_usd > 0);
  const expectedDaily = counted.reduce((s, o) => s + cents(o.expected_daily_usd), 0);
  const ceilingDaily = counted.reduce((s, o) => s + cents(o.ceiling_daily_usd), 0);
  const fixed = counted.reduce((s, o) => s + cents(o.exposure_usd), 0);
  const expectedRest = expectedDaily * days + fixed;
  const ceilingRest = ceilingDaily * days + fixed;
  const creator = cents(num(b.creator_held_usd)) + cents(num(b.creator_spent_usd));
  const openAuth = cents(holdExposureUsd(open, days, margin));
  const base = cents(num(b.month_cap_usd)) - cents(num(b.spent_usd)) - creator - openAuth;

  return {
    budget_id: b.budget_id,
    month_start: b.month_start,
    generation: i.generation ?? null,
    read_started_at: i.read_started_at,
    complete_platforms: [...completePlatforms].sort(),
    unread_platforms: [...unread].sort(),
    totals: {
      month_cap_usd: usd(cents(num(b.month_cap_usd))),
      spent: usd(cents(num(b.spent_usd))),
      creator_committed: usd(creator),
      days_left: days,
      margin,
      expected_daily: usd(expectedDaily),
      ceiling_daily: usd(ceilingDaily),
      fixed_exposure: usd(fixed),
      expected_rest: usd(expectedRest),
      ceiling_rest: usd(ceilingRest),
      open_authorizations: usd(openAuth),
      expected_room: usd(base - expectedRest),
      ceiling_room: usd(base - ceilingRest),
      objects_total: seen.size,
      objects_counted: counted.length,
      unknown_budgets: out.filter((o) => o.unknown_budget).length,
    },
    objects: counted.map(({ capped: _capped, unknown_budget: _unknown, ...o }) => o),
    reflected_hold_ids: reflected.map((h) => h.id).sort(),
  };
}

export type ShadowContext = {
  view: {
    id: string;
    status: string;
    month_start: string;
    month_cap_usd: number;
    spent_usd: number;
    held_usd: number;
    creator_held_usd: number;
    creator_spent_usd: number;
    days_left: number;
    margin?: number;
  } | null;
  snapshot: {
    budget_id: string;
    month_start: string;
    generation: number | null;
    read_started_at: string;
    totals: Partial<SnapshotTotals> | null;
    reflected_hold_ids: readonly string[];
  } | null;
  open_holds: readonly BookHold[];
  open_holds_truncated?: boolean;
};

export type ShadowChange = {
  idem_key: string;
  platform: string;
  op: "raise" | "resume" | "create";
  object_id: string | null;
  daily_delta_usd: number;
  paused: boolean;
};

export type RealAnswer = { status: "held" | "already_held" | "refused"; reason?: string | null; amount_usd?: number | null };

export type ShadowVerdictRow = {
  budget_id: string;
  idem_key: string;
  platform: string;
  op: string;
  object_id: string | null;
  daily_delta_usd: number;
  real_verdict: RealAnswer["status"];
  real_reason: string | null;
  real_amount_usd: number | null;
  real_room_usd: number;
  shadow_verdict: "would_allow" | "would_refuse" | "no_snapshot";
  shadow_note: string | null;
  shadow_change_usd: number;
  shadow_open_auth_usd: number | null;
  shadow_expected_room_usd: number | null;
  shadow_ceiling_room_usd: number | null;
  snapshot_generation: number | null;
  snapshot_age_s: number | null;
};

export function shadowVerdict(ctx: ShadowContext, change: ShadowChange, real: RealAnswer, now: Date): ShadowVerdictRow | null {
  const v = ctx.view;
  if (!v || v.status !== "active" || typeof v.id !== "string") return null;
  const days = Math.max(0, Math.floor(num(v.days_left)));
  const margin = num(v.margin) >= 1 ? num(v.margin) : 1;
  const cap = cents(num(v.month_cap_usd));
  const spent = cents(num(v.spent_usd));
  const creator = cents(num(v.creator_held_usd)) + cents(num(v.creator_spent_usd));
  const realAmount = real.amount_usd === null || real.amount_usd === undefined || !Number.isFinite(Number(real.amount_usd)) ? null : Number(real.amount_usd);
  const realRoom = cap - spent - cents(num(v.held_usd)) - creator + (real.status === "refused" ? 0 : cents(realAmount ?? 0));

  const delta = Math.ceil(Number(Math.max(0, num(change.daily_delta_usd)).toFixed(6)) * 100) / 100;
  const changeUsd =
    Math.ceil(Number((delta * (HOLD_FACTOR[change.platform] ?? 1) * (change.paused && change.op === "create" ? 1 : days) * margin * 100).toFixed(4))) / 100;

  const row: ShadowVerdictRow = {
    budget_id: v.id,
    idem_key: change.idem_key,
    platform: change.platform,
    op: change.op,
    object_id: change.object_id,
    daily_delta_usd: delta,
    real_verdict: real.status,
    real_reason: real.status === "refused" ? (real.reason || "over_month") : null,
    real_amount_usd: realAmount,
    real_room_usd: usd(realRoom),
    shadow_verdict: "no_snapshot",
    shadow_note: null,
    shadow_change_usd: changeUsd,
    shadow_open_auth_usd: null,
    shadow_expected_room_usd: null,
    shadow_ceiling_room_usd: null,
    snapshot_generation: null,
    snapshot_age_s: null,
  };

  const s = ctx.snapshot;
  if (!s) return { ...row, shadow_note: "missing" };
  const started = Date.parse(s.read_started_at);
  const age = Number.isFinite(started) ? Math.max(0, Math.round((now.getTime() - started) / 1000)) : null;
  const base = { ...row, snapshot_generation: s.generation ?? null, snapshot_age_s: age };
  const t = s.totals;
  if (age === null || !t || !Number.isFinite(Number(t.expected_rest)) || !Number.isFinite(Number(t.ceiling_rest))) return { ...base, shadow_note: "unreadable" };
  if (s.budget_id !== v.id) return { ...base, shadow_note: "other_budget" };
  if (String(s.month_start).slice(0, 10) !== String(v.month_start).slice(0, 10)) return { ...base, shadow_note: "other_month" };
  if (age * 1000 > SNAPSHOT_STALE_MS) return { ...base, shadow_note: "stale" };
  if (ctx.open_holds_truncated) return { ...base, shadow_note: "holds_truncated" };
  if (!(Number(t.unknown_budgets ?? 0) === 0)) return { ...base, shadow_note: "unknown_campaign_budget" };

  const shown = new Set(s.reflected_hold_ids);
  const open = ctx.open_holds.filter((h) => {
    if (h.status !== "reserved" && h.status !== "committed") return false;
    if (h.idem_key === change.idem_key) return false;
    const written = Date.parse(h.updated_at);
    return !(shown.has(h.id) && Number.isFinite(written) && written < started);
  });
  const openAuth = cents(holdExposureUsd(open, days, margin));
  const expectedRoom = cap - spent - creator - openAuth - cents(Number(t.expected_rest));
  const ceilingRoom = cap - spent - creator - openAuth - cents(Number(t.ceiling_rest));
  const allow = delta === 0 || cents(changeUsd) <= expectedRoom;
  return {
    ...base,
    shadow_verdict: allow ? "would_allow" : "would_refuse",
    shadow_open_auth_usd: usd(openAuth),
    shadow_expected_room_usd: usd(expectedRoom),
    shadow_ceiling_room_usd: usd(ceilingRoom),
  };
}

export type ShadowComparison = {
  total: number;
  agree: number;
  real_refused_shadow_allows: number;
  real_held_shadow_refuses: number;
  no_snapshot: number;
  not_comparable: number;
  disagreements: Array<Pick<ShadowVerdictRow, "idem_key" | "platform" | "op" | "object_id" | "daily_delta_usd" | "real_verdict" | "real_reason" | "real_room_usd" | "shadow_verdict" | "shadow_change_usd" | "shadow_expected_room_usd" | "shadow_ceiling_room_usd"> & { created_at?: string }>;
};

export function compareShadowVerdicts(rows: ReadonlyArray<ShadowVerdictRow & { created_at?: string }>): ShadowComparison {
  const out: ShadowComparison = { total: rows.length, agree: 0, real_refused_shadow_allows: 0, real_held_shadow_refuses: 0, no_snapshot: 0, not_comparable: 0, disagreements: [] };
  for (const r of rows) {
    if (r.real_verdict === "already_held" || (r.real_verdict === "refused" && r.real_reason !== "over_month")) { out.not_comparable++; continue; }
    if (r.shadow_verdict === "no_snapshot") { out.no_snapshot++; continue; }
    const realYes = r.real_verdict === "held";
    const shadowYes = r.shadow_verdict === "would_allow";
    if (realYes === shadowYes) { out.agree++; continue; }
    if (realYes) out.real_held_shadow_refuses++;
    else out.real_refused_shadow_allows++;
    out.disagreements.push({
      idem_key: r.idem_key, platform: r.platform, op: r.op, object_id: r.object_id, daily_delta_usd: Number(r.daily_delta_usd),
      real_verdict: r.real_verdict, real_reason: r.real_reason, real_room_usd: Number(r.real_room_usd),
      shadow_verdict: r.shadow_verdict, shadow_change_usd: Number(r.shadow_change_usd),
      shadow_expected_room_usd: r.shadow_expected_room_usd === null ? null : Number(r.shadow_expected_room_usd),
      shadow_ceiling_room_usd: r.shadow_ceiling_room_usd === null ? null : Number(r.shadow_ceiling_room_usd),
      ...(r.created_at ? { created_at: r.created_at } : {}),
    });
  }
  return out;
}
