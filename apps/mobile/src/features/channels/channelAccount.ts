import { seoAccount } from "./seoKpis";

export type ChannelAccount = { name: string | null; sub: string };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" ? (v as Rec) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function allowance(budget: unknown, noun: "reads" | "refreshes"): string | null {
  const b = rec(budget);
  const remaining = num(b?.remaining);
  const cap = num(b?.cap);
  if (!b || remaining === null || cap === null || cap <= 0) return null;
  return remaining === 0 ? `No ${noun} left today` : `${remaining} of ${cap} ${noun} left today`;
}

const join = (...parts: Array<string | null>) => parts.filter(Boolean).join(" · ");

export function channelAccount(slug: string, payload: unknown): ChannelAccount | null {
  const d = rec(payload);
  if (!d) return null;
  try {
    switch (slug) {
      case "seo":
        return seoAccount(d);
      case "geo": {
        const r = rec(d.readiness);
        const site = str(r?.site);
        if (!r || r.status !== "ok" || !site) return null;
        const pages = num(r.pages_analyzed) ?? 0;
        return { name: site.replace(/^https?:\/\//, "").replace(/\/$/, ""), sub: `${plural(pages, "page")} read` };
      }
      case "x_organic": {
        const handle = str(d.handle) ?? str(d.account_name);
        return handle ? { name: handle, sub: allowance(d.read_budget, "reads") ?? "" } : null;
      }
      case "linkedin_organic": {
        const a = rec(d.account);
        const name = str(a?.name);
        const followers = num(a?.followers);
        return name ? { name, sub: join(followers === null ? null : `${fmt(followers)} followers`, allowance(d.refresh, "refreshes")) } : null;
      }
      case "instagram_organic":
      case "tiktok_organic": {
        const a = rec(d.account);
        const user = str(a?.username);
        const name = user ? `@${user}` : slug === "tiktok_organic" ? str(a?.name) : null;
        const followers = num(a?.followers);
        return name ? { name, sub: join(followers === null ? null : `${fmt(followers)} followers`, allowance(d.refresh, "refreshes")) } : null;
      }
      case "reddit_ads":
      case "linkedin_ads":
      case "x_ads": {
        const a = rec(d.account);
        if (!a || typeof d.connected !== "boolean") return null;
        const n = num(a.active_count) ?? 0;
        return { name: str(a.name), sub: `${n} active ${n === 1 ? "campaign" : "campaigns"}` };
      }
      case "tiktok_ads": {
        const a = rec(d.account);
        if (!a || typeof d.connected !== "boolean") return null;
        return { name: str(a.name), sub: plural(num(a.campaign_count) ?? 0, "campaign") };
      }
      case "meta_ads": {
        const channels = Array.isArray(d.channels) ? (d.channels as Rec[]) : [];
        if (!channels.some((c) => c.channel === "meta")) return null;
        const active = (Array.isArray(d.campaigns) ? (d.campaigns as Rec[]) : []).filter((c) => c.channel === "meta" && c.status === "ACTIVE").length;
        return { name: null, sub: `${active} active ${active === 1 ? "campaign" : "campaigns"}` };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
