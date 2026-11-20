
import { DEFAULT_RANGES } from "./google-ads/types";
import { TrendingUp } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraRow, ExtraTableData } from "../actions/ExtraTable";
import type { ChannelChrome } from "./legacyChannelActions";
import { num } from "./dashboard-ui";
import { topRows, topTail } from "../actions/checklist";

type TikTokPost = {
  id: string;
  url: string | null;
  text: string;
  posted_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};
export type TikTokPayload = {
  connected?: boolean;
  account?: { username: string | null; name: string | null; followers: number | null } | null;
  metrics?: ChannelMetric[];
  top_posts?: TikTokPost[];
  refresh?: { used: number; cap: number; remaining: number };
  problem?: string | null;
};

const asPayload = (payload: unknown): TikTokPayload | null =>
  payload && typeof payload === "object" ? (payload as TikTokPayload) : null;

export function tiktokKpis(payload: unknown): ChannelMetric[] {
  const d = asPayload(payload);
  return Array.isArray(d?.metrics) ? d.metrics : [];
}

export function tiktokTables(payload: unknown): ExtraTableData[] {
  const d = asPayload(payload);
  if (!d || !Array.isArray(d.top_posts)) return [];
  return [
    {
      id: "tiktok_top_posts",
      title: "Top posts",
      icon: TrendingUp,
      columns: [
        { label: "Post", align: "left" },
        { label: "Views" },
        { label: "Likes" },
        { label: "Comments" },
        { label: "Shares" },
        { label: "Posted" },
      ],
      tailToggle: topTail(d.top_posts.length),
      rows: topRows(d.top_posts.map<ExtraRow>((p) => ({
        id: p.id,
        cells: [
          { text: p.text || "(no caption)", href: p.url ?? undefined, title: p.text },
          p.views === null ? { text: "-", tone: "dim" } : { text: num(p.views), strong: true },
          p.likes === null ? { text: "-", tone: "dim" } : { text: num(p.likes) },
          p.comments === null ? { text: "-", tone: "dim" } : { text: num(p.comments) },
          p.shares === null ? { text: "-", tone: "dim" } : { text: num(p.shares) },
          {
            text: p.posted_at
              ? new Date(p.posted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
              : "-",
          },
        ],
      }))),
      empty: d.connected
        ? "No posts read yet. Refresh reads your account's recent posts."
        : "Connect TikTok in Settings and Zavi reads your own posts' real numbers.",
      caption: "Your account's own counts from TikTok's API, across your recent public posts.",
    },
  ];
}

export function tiktokChrome(payload: unknown): ChannelChrome | null {
  const d = asPayload(payload);
  if (!d || typeof d.connected !== "boolean") return null;
  const r = d.refresh;
  const allowance = r
    ? r.remaining === 0
      ? "No refreshes left today"
      : `${r.remaining} of ${r.cap} refreshes left today`
    : "";
  const followers =
    typeof d.account?.followers === "number" ? `${num(d.account.followers)} followers` : null;
  const accountName = d.account?.username ? `@${d.account.username}` : d.account?.name ?? null;
  return {
    connected: true,
    ranges: DEFAULT_RANGES,
    period: null,
    account: accountName
      ? { name: accountName, sub: [followers, allowance].filter(Boolean).join(" · ") }
      : null,
    problem: d.problem
      ? { text: d.problem, reconnect: false }
      : d.connected
        ? null
        : { text: "Connect TikTok in Settings and Zavi reads your account's own views, likes and shares.", reconnect: false },
    plan: null,
  };
}
