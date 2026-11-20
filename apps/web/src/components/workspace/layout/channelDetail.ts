
import type { DeliveryMode } from "./ActionDrawer";
import type { Channel } from "@zavi/shared";

export type ProbeVerdict = {
  verdict: "changed" | "unchanged" | "unavailable";
  signals: Array<{
    key: string;
    prev: number | null;
    now: number | null;
    delta: number | null;
    prev_at?: string;
    now_at?: string;
    compare?: "pct_change" | "abs_change";
    tripped: boolean;
    reason?: string;
  }>;
  reason?: string;
};

export type ChannelDetail = {
  channel: Channel;
  mode: DeliveryMode;
  connected: boolean;
  connectors: string[];
  linkedConnectors?: string[];
  workState: "idle" | "running" | "needs_review" | "delivered";
  lastRunAt: string | null;
  lastProbeAt: string | null;
  lastProbeDelta: ProbeVerdict | null;
  runnable: boolean;
  planIntent?: string | null;
  planRationale?: string | null;
  fit?: { value: "high" | "medium" | "low"; line: string } | null;
  hasStrategy?: boolean;
};

const SIGNAL_LABEL: Record<string, string> = {
  ads_spend_7d: "Spend",
  ads_cpa_7d: "CPA",
  google_ads_spend_7d: "Spend",
  google_ads_cpa_7d: "CPA",
  weekly_signups: "Signups",
  weekly_bookings: "Bookings",
  stripe_mrr: "MRR",
  x_impressions_30d: "Impressions",
  x_link_clicks_30d: "Link clicks",
  x_posts_7d: "Posts",
};

export function probeSummary(d: ChannelDetail): string | null {
  const p = d.lastProbeDelta;
  if (!p) return null;
  if (p.verdict === "unavailable") {
    if (p.reason === "no_signals_declared") return null;
    return "Couldn't check";
  }
  if (p.verdict === "unchanged") return "No change";
  const moved = p.signals.filter((s) => s.tripped && s.delta !== null);
  if (moved.length === 0) return "Changed";
  return moved
    .map((s) => {
      const label = SIGNAL_LABEL[s.key] ?? s.key;
      const sign = s.delta! > 0 ? "+" : "";
      const unit = s.compare === "abs_change" ? "" : "%";
      return `${label} ${sign}${Math.round(s.delta!)}${unit}`;
    })
    .join(", ");
}

export function probeWindow(d: ChannelDetail): string | null {
  const moved =
    d.lastProbeDelta?.signals.filter((s) => s.prev_at && s.now_at) ?? [];
  const first = moved[0];
  if (!first?.prev_at || !first?.now_at) return null;
  const fmt = (iso: string) => {
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime())
      ? null
      : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const a = fmt(first.prev_at);
  const b = fmt(first.now_at);
  return a && b ? `${a} → ${b}` : null;
}

export const MODE_COPY: Record<DeliveryMode, string> = {
  execute:
    "Zavi can act here. It proposes the change and carries it out once you approve.",
  produce:
    "Zavi makes the thing here, and you do the last step. It cannot post on your behalf yet.",
  advise: "Zavi can read and recommend here, but not act.",
};

export const relative = (iso: string | null) => {
  if (!iso) return "Never";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
};
