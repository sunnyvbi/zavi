
import { DEFAULT_RANGES } from "./google-ads/types";
import { TrendingUp } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraRow, ExtraTableData } from "../actions/ExtraTable";
import type { ChannelChrome } from "./legacyChannelActions";
import { num } from "./dashboard-ui";
import { topRows, topTail } from "../actions/checklist";

type InstagramPost = {
  id: string;
  url: string | null;
  text: string;
  posted_at: string | null;
  format: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
};
export type InstagramPayload = {
  connected?: boolean;
  account?: { username: string | null; name: string | null; followers: number | null } | null;
  metrics?: ChannelMetric[];
  top_posts?: InstagramPost[];
  refresh?: { used: number; cap: number; remaining: number };
  problem?: string | null;
};

const asPayload = (payload: unknown): InstagramPayload | null =>
  payload && typeof payload === "object" ? (payload as InstagramPayload) : null;

export function instagramKpis(payload: unknown): ChannelMetric[] {
  const d = asPayload(payload);
  return Array.isArray(d?.metrics) ? d.metrics : [];
}

export function instagramTables(payload: unknown): ExtraTableData[] {
  const d = asPayload(payload);
  if (!d || !Array.isArray(d.top_posts)) return [];
  return [
    {
      id: "instagram_top_posts",
      title: "Top posts",
      icon: TrendingUp,
      columns: [
        { label: "Post", align: "left" },
        { label: "Views" },
        { label: "Likes" },
        { label: "Comments" },
        { label: "Saves" },
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
          p.saves === null ? { text: "-", tone: "dim" } : { text: num(p.saves) },
          {
            text: p.posted_at
              ? new Date(p.posted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
              : "-",
          },
        ],
      }))),
      keepWhenEmpty: true,
      empty: d.connected ? "No posts read yet. Refresh reads your account's latest posts." : "No posts to show yet.",
      caption: "Your account's own insights from Instagram. Views replaced impressions in April 2025.",
    },
  ];
}

export function instagramChrome(payload: unknown): ChannelChrome | null {
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
  return {
    connected: true,
    ranges: DEFAULT_RANGES,
    period: null,
    account: d.account?.username
      ? { name: `@${d.account.username}`, sub: [followers, allowance].filter(Boolean).join(" · ") }
      : null,
    problem: d.problem ? { text: d.problem, reconnect: false } : null,
    plan: null,
  };
}
