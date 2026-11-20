import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ChannelChrome } from "./legacyChannelActions";
import { num } from "./dashboard-ui";

type PinterestPayload = {
  connected?: boolean;
  account?: { username: string | null; followers: number | null } | null;
  metrics?: ChannelMetric[];
  refresh?: { used: number; cap: number; remaining: number };
  problem?: string | null;
};

const payloadOf = (payload: unknown): PinterestPayload | null =>
  payload && typeof payload === "object" ? payload as PinterestPayload : null;

const shortDay = (ymd: string): string | null => {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

function sinceNote(m: ChannelMetric, today: string): string {
  const since = m.prev_day ? shortDay(m.prev_day) : null;
  if (m.prev_value !== null && m.prev_value !== undefined && Number.isFinite(m.prev_value) && since) {
    const diff = m.value - m.prev_value;
    return diff === 0 ? `No change since ${since}` : `${diff > 0 ? "+" : "-"}${num(Math.abs(diff))} since ${since}`;
  }
  const day = m.day.slice(0, 10) === today ? null : shortDay(m.day);
  return `First reading ${day ? `on ${day}` : "today"}. The change shows when you open this on a later day.`;
}

export function pinterestKpis(payload: unknown, now: number = Date.now()): ChannelMetric[] {
  const data = payloadOf(payload);
  if (!Array.isArray(data?.metrics)) return [];
  const today = new Date(now).toISOString().slice(0, 10);
  return data.metrics.map((m) => ({ ...m, note: m.note ?? sinceNote(m, today) }));
}

export function pinterestChrome(payload: unknown): ChannelChrome | null {
  const data = payloadOf(payload);
  if (!data || typeof data.connected !== "boolean") return null;
  const refresh = data.refresh;
  const allowance = refresh
    ? refresh.remaining === 0
      ? "No refreshes left today"
      : `${refresh.remaining} of ${refresh.cap} refreshes left today`
    : "";
  const followers = typeof data.account?.followers === "number" ? `${num(data.account.followers)} followers` : null;
  return {
    connected: true,
    ranges: [{ id: "now", label: "Latest 30 days", days: 30 }],
    period: null,
    account: data.account?.username
      ? { name: `@${data.account.username}`, sub: [followers, allowance].filter(Boolean).join(" · ") }
      : null,
    problem: data.problem
      ? { text: data.problem, reconnect: false }
      : data.connected
        ? null
        : { text: "Connect Pinterest in Settings and Zavi reads your account's impressions, clicks and saves.", reconnect: false },
    plan: null,
  };
}
