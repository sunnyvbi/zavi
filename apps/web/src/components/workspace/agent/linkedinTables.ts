
import { DEFAULT_RANGES } from "./google-ads/types";
import { ChartLine } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraRow, ExtraTableData } from "../actions/ExtraTable";
import type { ChannelChrome } from "./legacyChannelActions";
import { num } from "./dashboard-ui";
import { topRows, topTail } from "../actions/checklist";

type LinkedInPost = {
  id: string;
  url: string | null;
  text: string;
  posted_at: string | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
};
export type LinkedInPayload = {
  page_url?: string | null;
  account?: { name: string | null; followers: number | null } | null;
  metrics?: ChannelMetric[];
  top_posts?: LinkedInPost[];
  refresh?: { used: number; cap: number; remaining: number };
  problem?: string | null;
};

const asPayload = (payload: unknown): LinkedInPayload | null =>
  payload && typeof payload === "object" ? (payload as LinkedInPayload) : null;

export function linkedinKpis(payload: unknown): ChannelMetric[] {
  const d = asPayload(payload);
  return Array.isArray(d?.metrics) ? d.metrics : [];
}

export function linkedinTables(payload: unknown): ExtraTableData[] {
  const d = asPayload(payload);
  if (!d || !Array.isArray(d.top_posts)) return [];
  return [
    {
      id: "linkedin_top_posts",
      title: "Top posts",
      icon: ChartLine,
      columns: [
        { label: "Post", align: "left" },
        { label: "Reactions" },
        { label: "Comments" },
        { label: "Reposts" },
        { label: "Posted" },
      ],
      tailToggle: topTail(d.top_posts.length),
      rows: topRows(d.top_posts.map<ExtraRow>((p) => {
        const text = p.text.replace(/\s+/g, " ").trim() || "(no text)";
        const characters = Array.from(text);
        const shortened = characters.length > 180;
        const start = characters.slice(0, 180).join("");
        const preview = shortened ? `${start.replace(/\s+\S*$/, "").trimEnd()}…` : text;
        return {
          id: p.id,
          cells: [
            { text: preview },
            p.reactions === null ? { text: "-", tone: "dim" } : { text: num(p.reactions), strong: true },
            p.comments === null ? { text: "-", tone: "dim" } : { text: num(p.comments) },
            p.reposts === null ? { text: "-", tone: "dim" } : { text: num(p.reposts) },
            {
              text: p.posted_at
                ? new Date(p.posted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
                : "-",
            },
          ],
          actions: p.url ? [{ label: "Open on LinkedIn", href: p.url }] : undefined,
          detail: shortened ? {
            title: "Full post",
            text: p.text,
            openLabel: "Read full post",
            closeLabel: "Show less",
          } : undefined,
        };
      })),
      empty: d.page_url
        ? "No public posts have been collected from this reference page. This does not mean no posts were published. Check the read status above; your drafts are in Overview."
        : "Save your LinkedIn page in Settings to see its posts here.",
      caption: "Public counts from your LinkedIn page. LinkedIn shows views to the author only.",
      keepWhenEmpty: true,
    },
  ];
}

export function linkedinChrome(payload: unknown): ChannelChrome | null {
  const d = asPayload(payload);
  if (!d || !("page_url" in d)) return null;
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
    account: d.account?.name
      ? { name: d.account.name, sub: [followers, allowance].filter(Boolean).join(" · ") }
      : null,
    problem: d.problem
      ? { text: d.problem, reconnect: false }
      : d.page_url
        ? null
        : { text: "Save your LinkedIn page in Settings and Zavi reads its public numbers.", reconnect: false },
    plan: null,
  };
}
