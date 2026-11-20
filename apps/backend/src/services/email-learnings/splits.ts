
import { createHash } from "node:crypto";

export const SPLITS = ["subject_digit", "subject_length", "weekend", "morning", "list"] as const;
export type Split = (typeof SPLITS)[number];
export type Metric = "clicks" | "visitors";
export type Route = "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";
export type ObsWindow = "d7" | "lifetime";

export type Observation = {
  key: string;
  account_key: string;
  route: Route;
  list_id: string | null;
  list_name: string | null;
  window: ObsWindow;
  metric: Metric;
  subject: string;
  sent_at: string;
  exact_time: boolean;
  delivered: number;
  hits: number;
};

export type Topic = {
  split: Split;
  route: Route;
  list_id: string | null;
  list_name: string | null;
  metric: Metric;
  account_key: string;
  obs_window: ObsWindow;
  holds: boolean;
  side: "a" | "b" | null;
  fingerprint: string;
  text: string;
  strength: "early" | "firm" | null;
  rank: number;
  stats: { n_a: number; n_b: number; rate_a: number; rate_b: number; side: "a" | "b"; lift: number };
};

export const MIN_SIDE = 3;
export const FIRM_SIDE = 5;
export const FIRM_LIFT = 0.5;
export const MIN_LIFT = 0.2;
export const MIN_ABS = 0.001;
export const SHORT_SUBJECT = 40;
export const MORNING_END_HOUR = 12;

export function localParts(iso: string, timeZone: string): { hour: number; weekday: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(d);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
    return Number.isFinite(hour) && weekday >= 0 ? { hour, weekday } : null;
  } catch {
    return null;
  }
}

export function sideOf(split: Split, o: Observation, timeZone: string, listId: string | null = null): "a" | "b" | null {
  switch (split) {
    case "subject_digit":
      return o.subject.trim() ? (/\d/.test(o.subject) ? "a" : "b") : null;
    case "subject_length":
      return o.subject.trim() ? (o.subject.trim().length <= SHORT_SUBJECT ? "a" : "b") : null;
    case "weekend":
    case "morning": {
      if (!o.exact_time) return null;
      const p = localParts(o.sent_at, timeZone);
      if (!p) return null;
      if (split === "weekend") return p.weekday === 0 || p.weekday === 6 ? "a" : "b";
      return p.hour < MORNING_END_HOUR ? "a" : "b";
    }
    case "list":
      return o.list_id === null ? null : o.list_id === listId ? "a" : "b";
  }
}

const rateOf = (rows: Observation[]): number => {
  const d = rows.reduce((s, r) => s + r.delivered, 0);
  return d > 0 ? rows.reduce((s, r) => s + r.hits, 0) / d : 0;
};

function compare(a: Observation[], b: Observation[]): { side: "a" | "b"; lift: number; abs: number; rate_a: number; rate_b: number } | null {
  const ra = rateOf(a);
  const rb = rateOf(b);
  if (ra === rb) return null;
  const side = ra > rb ? "a" : "b";
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  return { side, lift: lo > 0 ? (hi - lo) / lo : Number.POSITIVE_INFINITY, abs: hi - lo, rate_a: ra, rate_b: rb };
}

function survivesLeaveOneOut(a: Observation[], b: Observation[], side: "a" | "b"): boolean {
  for (let i = 0; i < a.length; i++) {
    const c = compare([...a.slice(0, i), ...a.slice(i + 1)], b);
    if (!c || c.side !== side) return false;
  }
  for (let i = 0; i < b.length; i++) {
    const c = compare(a, [...b.slice(0, i), ...b.slice(i + 1)]);
    if (!c || c.side !== side) return false;
  }
  return true;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const what = (m: Metric) => (m === "visitors" ? "website visits" : "clicks");

export function phrase(split: Split, side: "a" | "b", metric: Metric, listName: string | null, r: { rate_a: number; rate_b: number; n_a: number; n_b: number }): string {
  const hi = side === "a" ? r.rate_a : r.rate_b;
  const lo = side === "a" ? r.rate_b : r.rate_a;
  const nums = `${pct(hi)} vs ${pct(lo)} ${what(metric)} per delivered email, ${r.n_a + r.n_b} emails`;
  const to = listName ? ` to "${listName}"` : "";
  switch (split) {
    case "subject_digit":
      return side === "a"
        ? `Emails${to} with a number in the subject got more ${what(metric)} (${nums}).`
        : `Emails${to} without a number in the subject got more ${what(metric)} (${nums}).`;
    case "subject_length":
      return side === "a"
        ? `Shorter subject lines (${SHORT_SUBJECT} characters or fewer) got more ${what(metric)}${to} (${nums}).`
        : `Longer subject lines (over ${SHORT_SUBJECT} characters) got more ${what(metric)}${to} (${nums}).`;
    case "weekend":
      return side === "a"
        ? `Emails${to} sent on a weekend got more ${what(metric)} than weekday sends (${nums}).`
        : `Emails${to} sent on a weekday got more ${what(metric)} than weekend sends (${nums}).`;
    case "morning":
      return side === "a"
        ? `Emails${to} sent before noon got more ${what(metric)} than later sends (${nums}).`
        : `Emails${to} sent from noon on got more ${what(metric)} than morning sends (${nums}).`;
    case "list":
      return side === "a"
        ? `Emails to "${listName ?? "this list"}" got more ${what(metric)} than to your other lists (${nums}).`
        : `Emails to "${listName ?? "this list"}" got fewer ${what(metric)} than to your other lists (${nums}).`;
  }
}

export function evidenceFingerprint(a: Observation[], b: Observation[]): string {
  const part = (rows: Observation[]) => rows.map((o) => `${o.key}:${o.delivered}:${o.hits}`).sort().join(",");
  return createHash("sha256").update(`a=${part(a)}|b=${part(b)}`).digest("hex").slice(0, 32);
}

export function evaluate(
  split: Split,
  rows: Observation[],
  timeZone: string,
  stratum: { account_key: string; route: Route; list_id: string | null; list_name: string | null; metric: Metric; window: ObsWindow },
): Topic | null {
  const a: Observation[] = [];
  const b: Observation[] = [];
  for (const o of rows) {
    const s = sideOf(split, o, timeZone, stratum.list_id);
    if (s === "a") a.push(o);
    else if (s === "b") b.push(o);
  }
  if (a.length < MIN_SIDE || b.length < MIN_SIDE) return null;
  const c = compare(a, b);
  const holds = !!c && c.lift >= MIN_LIFT && c.abs >= MIN_ABS && survivesLeaveOneOut(a, b, c.side);
  const stats = {
    n_a: a.length,
    n_b: b.length,
    rate_a: Number((c?.rate_a ?? rateOf(a)).toFixed(6)),
    rate_b: Number((c?.rate_b ?? rateOf(b)).toFixed(6)),
    side: c?.side ?? "a",
    lift: c && Number.isFinite(c.lift) ? Number(c.lift.toFixed(4)) : c ? 99 : 0,
  };
  const firm = holds && Math.min(a.length, b.length) >= FIRM_SIDE && (c?.lift ?? 0) >= FIRM_LIFT;
  return {
    split,
    route: stratum.route,
    list_id: stratum.list_id,
    list_name: stratum.list_name,
    metric: stratum.metric,
    account_key: stratum.account_key,
    obs_window: stratum.window,
    holds,
    side: c?.side ?? null,
    fingerprint: evidenceFingerprint(a, b),
    text: holds && c ? phrase(split, c.side, stratum.metric, stratum.list_name, stats) : "",
    strength: holds ? (firm ? "firm" : "early") : null,
    rank: holds ? Number((Math.min(a.length, b.length) * Math.min(stats.lift, 3)).toFixed(4)) : 0,
    stats: stats as Topic["stats"],
  };
}

export function computeTopics(rows: Observation[], timeZone: string): Topic[] {
  const out: Topic[] = [];
  const byAccount = new Map<string, Observation[]>();
  for (const o of rows) {
    const k = [o.account_key, o.route, o.metric, o.window].join("|");
    (byAccount.get(k) ?? byAccount.set(k, []).get(k)!).push(o);
  }
  for (const group of byAccount.values()) {
    const first = group[0];
    const byList = new Map<string, Observation[]>();
    for (const o of group) {
      if (o.list_id === null) continue;
      (byList.get(o.list_id) ?? byList.set(o.list_id, []).get(o.list_id)!).push(o);
    }
    for (const [listId, listRows] of byList) {
      const stratum = { account_key: first.account_key, route: first.route, list_id: listId, list_name: listRows[0].list_name, metric: first.metric, window: first.window };
      for (const split of SPLITS) {
        if (split === "list") continue;
        const t = evaluate(split, listRows, timeZone, stratum);
        if (t) out.push(t);
      }
      if (byList.size > 1) {
        const t = evaluate("list", group, timeZone, stratum);
        if (t) out.push(t);
      }
    }
  }
  return out;
}
