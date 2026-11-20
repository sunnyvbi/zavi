import type { DecisionConsequence } from "@zavi/shared";
import { formatCurrency } from "@/components/workspace/metrics/currency";

type Body = Record<string, unknown>;

export function isXAdsClass(cls: string | null | undefined): cls is `x_ads.${string}` {
  return typeof cls === "string" && cls.startsWith("x_ads.");
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Body => (v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : {});

function money(v: unknown, currency: unknown): string | null {
  const n = num(v);
  const c = str(currency);
  if (n === null || !c) return null;
  const out = formatCurrency(n, c, !Number.isInteger(n));
  return out === "-" ? null : out;
}

function who(b: Body): string {
  const name = str(b.name);
  return name ? `“${name}”` : "this campaign";
}

function isPause(b: Body): boolean {
  return str(b.status)?.toUpperCase() === "PAUSED";
}

export function xAdsChangeList(b: Body): string[] {
  const changes = obj(b.changes);
  const before = obj(b.before);
  const out: string[] = [];
  const rename = str(changes.name);
  if (rename && rename !== str(before.name)) out.push(`rename to “${rename}”`);
  for (const [key, label] of [
    ["daily_budget", "daily budget"],
    ["total_budget", "total budget"],
  ] as const) {
    if (!(key in changes)) continue;
    const to = money(changes[key], b.currency);
    const from = money(before[key], b.currency);
    if (to && from) out.push(`${label} ${from} → ${to}`);
    else if (to) out.push(`${label} to ${to}`);
    else if (changes[key] === null && from) out.push(`remove the ${from} ${label}`);
  }
  return out;
}

export function xAdsDailyStake(cls: string, b: Body): string | null {
  const daily =
    cls === "x_ads.update_campaign"
      ? "daily_budget" in obj(b.changes)
        ? obj(b.changes).daily_budget
        : obj(b.before).daily_budget
      : b.daily_budget;
  const m = money(daily, b.currency);
  if (!m) return null;
  return cls === "x_ads.set_status" && isPause(b) ? `−${m}/day` : `${m}/day`;
}

export function xAdsAction(cls: string, b: Body): string | null {
  if (cls === "x_ads.set_status") return isPause(b) ? "Pause this X campaign" : "Resume this X campaign";
  if (cls === "x_ads.create_campaign") return "Launch a new X campaign";
  if (cls === "x_ads.update_campaign") {
    const to = num(obj(b.changes).daily_budget);
    const from = num(obj(b.before).daily_budget);
    if (to !== null && from !== null && to > from) return "Raise daily budget";
    if (to !== null && from !== null && to < from) return "Lower daily budget";
    return "Edit this X campaign";
  }
  return null;
}

export function xAdsPreview(cls: string, b: Body): string | null {
  const name = str(b.name) ?? "campaign";
  if (cls === "x_ads.set_status") return `→ X · ${name}`;
  if (cls === "x_ads.update_campaign") {
    const parts = xAdsChangeList(b);
    return `→ X · ${name}${parts.length ? ` · ${parts.join(", ")}` : ""}`;
  }
  if (cls === "x_ads.create_campaign") {
    const posts = Array.isArray(b.tweet_ids) ? b.tweet_ids.length : 0;
    const daily = money(b.daily_budget, b.currency);
    const bits = [
      daily ? `${daily}/day` : null,
      posts ? `${posts} post${posts === 1 ? "" : "s"}` : null,
      str(b.launch)?.toUpperCase() === "ACTIVE" ? "goes live" : "PAUSED",
    ].filter(Boolean);
    return `→ X · create “${name}” (${bits.join(", ")})`;
  }
  return null;
}

export function xAdsConsequence(cls: string, b: Body): DecisionConsequence | null {
  if (!isXAdsClass(cls)) return null;
  const c = who(b);
  if (cls === "x_ads.set_status") {
    const daily = money(b.daily_budget, b.currency);
    if (isPause(b)) {
      return {
        approve: `Pauses ${c} in X Ads. It stops delivering and stops spending${daily ? ` (${daily}/day)` : ""}.`,
        reject: `${c} keeps running and keeps spending.`,
      };
    }
    if (str(b.status)?.toUpperCase() === "ACTIVE") {
      return {
        approve: `Turns ${c} back on in X Ads. It starts delivering and spending again${daily ? `, up to ${daily}/day` : ""}.`,
        reject: `${c} stays paused: no delivery, no spend.`,
      };
    }
  }
  if (cls === "x_ads.update_campaign") {
    const parts = xAdsChangeList(b);
    if (parts.length) {
      return {
        approve: `Updates ${c} in X Ads: ${parts.join(", ")}. Nothing else on it changes.`,
        reject: `${c} keeps its current name and budgets.`,
      };
    }
  }
  if (cls === "x_ads.create_campaign") {
    const daily = money(b.daily_budget, b.currency);
    const posts = Array.isArray(b.tweet_ids) ? b.tweet_ids.length : 0;
    const promoting = posts ? ` promoting ${posts} of your post${posts === 1 ? "" : "s"}` : "";
    const cap = daily ? ` with a ${daily}/day budget` : "";
    const live =
      str(b.launch)?.toUpperCase() === "ACTIVE"
        ? "It goes live right away and starts spending."
        : "It is created PAUSED: no spend until you turn it on.";
    return {
      approve: `Creates ${c} in X Ads${promoting}${cap}. ${live}`,
      reject: "No campaign is created.",
    };
  }
  return { approve: "Applies the change in X Ads.", reject: "No change is made in X Ads." };
}

export function xAdsFields(b: Body): Array<{ label: string; value: string }> {
  const rows = obj(b.exact_change).rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const row = obj(r);
    const item = str(row.item);
    if (!item) return [];
    const cell = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : str(v));
    const before = cell(row.before);
    const after = cell(row.after) ?? "(empty)";
    return [{ label: item, value: before ? `${before} → ${after}` : after }];
  });
}
