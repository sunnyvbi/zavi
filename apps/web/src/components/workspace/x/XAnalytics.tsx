"use client";

import { useState, type ReactNode } from "react";
import { Eye, Heart, LineChart, MessageSquareText, Repeat2, SquareArrowOutUpRight, User, UserPlus, type LucideIcon } from "lucide-react";
import { DeltaTile as Tile } from "../metrics/DeltaTile";
import { cn } from "@/lib/cn";
import { useAgentDashboard } from "../agent/dashboard-ui";
import { DEFAULT_RANGES } from "../agent/google-ads/types";
import { ChannelDashboardControls } from "../actions/ChannelDashboardControls";
import { payloadPeriod } from "../actions/dateRange";
import { useRangePick } from "../actions/useRangePick";
import { cardButton } from "../actions/card/styles";
import type { XMetric, XPayload, XPostRow } from "../agent/XAgentDashboard";
import { xChrome } from "../agent/xTables";
import { XProfileChecklist } from "./XProfileChecklist";

const FORMAT_WORD: Record<string, string> = { text: "Text", thread: "Thread", link: "Link", poll: "Poll", video: "Video", image: "Image" };

const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, "")}%`;

export function xDelta(m: XMetric | undefined): { pct: number; up: boolean } | null {
  if (!m || m.value === null || m.delta === null) return null;
  const rel = m.delta_unit === "pp" ? (m.value - m.delta > 0 ? (m.delta / (m.value - m.delta)) * 100 : null) : m.delta;
  return rel === null ? null : { pct: Math.abs(Math.round(rel)), up: rel >= 0 };
}

export function xTopPosts(rows: XPostRow[] | undefined): XPostRow[] {
  return (rows ?? [])
    .filter((p) => !["reply", "repost"].includes(p.kind ?? p.format) && p.eng_rate !== null)
    .sort((a, b) => (b.eng_rate ?? 0) - (a.eng_rate ?? 0) || b.views - a.views)
    .slice(0, 5);
}

const TH = "border-b border-ca-border px-4 py-3 text-left text-ca-facts font-semibold text-ca-xdark";
const TD = "border-b border-ca-border px-4 py-3 text-ca-facts text-ca-secondary";

function Thumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <span aria-hidden className="block size-10 shrink-0 overflow-hidden rounded-lg bg-ca-subtle">
      <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />
    </span>
  );
}

function TopPosts({ posts, label }: { posts: XPostRow[]; label: string }) {
  return (
    <section aria-labelledby="x-top-posts">
      <h2 id="x-top-posts" className="text-ca-title font-semibold text-ca-xdark">Top posts</h2>
      {posts.length === 0 ? (
        <p data-testid="x-top-posts-empty" className="mt-3 rounded-2xl border border-ca-border bg-ca-bg p-5 text-ca-action text-ca-secondary">No post numbers in the {label} yet. Posts you publish show up here with their results.</p>
      ) : (
      <div className="mt-3 overflow-x-auto rounded-2xl border border-ca-border">
        <table className="w-full border-collapse">
          <thead className="bg-ca-subtle">
            <tr>
              <th scope="col" className={TH}>Post</th>
              <th scope="col" className={TH}>Format</th>
              <th scope="col" className={cn(TH, "text-right")}>Views</th>
              <th scope="col" className={cn(TH, "text-right")}>Engagement</th>
            </tr>
          </thead>
          <tbody className="[&>tr:last-child>*]:border-b-0">
            {posts.map((p, i) => (
              <tr key={p.id} data-testid="x-top-post">
                <th scope="row" className="border-b border-ca-border px-4 py-3 text-left text-ca-facts font-normal text-ca-xdark">
                  <span className="flex min-w-[14rem] items-center gap-3">
                    {p.thumb_url && <Thumb src={p.thumb_url} />}
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 min-w-0 break-words hover:underline focus-visible:underline focus-visible:outline-none">{p.text || "(no text)"}</a>
                    ) : (
                      <span className="line-clamp-2 min-w-0 break-words">{p.text || "(no text)"}</span>
                    )}
                    {i === 0 && <span className="whitespace-nowrap rounded-full bg-ca-success-bg px-2 py-0.5 text-[13px] font-medium text-ca-success">Best</span>}
                  </span>
                </th>
                <td className={TD}>{(p.kind && FORMAT_WORD[p.kind]) || "–"}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{p.views.toLocaleString("en-US")}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{pct(p.eng_rate ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
}

const SINCE = "vs the period before";
const TILES: ReadonlyArray<{ key: XMetric["key"]; label: string; icon: LucideIcon; show: (n: number) => string }> = [
  { key: "impressions", label: "Impressions", icon: Eye, show: compact },
  { key: "profile_visits", label: "Profile visits", icon: User, show: compact },
  { key: "link_clicks", label: "Link clicks", icon: SquareArrowOutUpRight, show: compact },
  { key: "new_follows", label: "New follows", icon: UserPlus, show: compact },
  { key: "replies", label: "Replies", icon: MessageSquareText, show: compact },
  { key: "likes", label: "Likes", icon: Heart, show: compact },
  { key: "reposts", label: "Reposts", icon: Repeat2, show: compact },
  { key: "engagement_rate", label: "Engagement rate", icon: LineChart, show: pct },
];

function Body({ data, phrase }: { data: XPayload; phrase: string }) {
  const metric = (key: XMetric["key"]) => data.metrics?.find((m) => m.key === key);
  const top = xTopPosts(data.top_posts);
  const problem = xChrome(data)?.problem;
  const note = data.connected === false
    ? "Connect X in Settings and Zavi reads your account's views, clicks and new followers."
    : problem ? problem.text : null;
  return (
    <div className="mt-3 flex flex-col gap-8 pb-6">
      {note && <p role="status" className="text-ca-action text-ca-secondary">{note}</p>}
      <section aria-label={phrase}>
        <ul className="grid grid-cols-1 gap-3 [@container(min-width:32rem)]:grid-cols-2 [@container(min-width:56rem)]:grid-cols-4">
          {TILES.map((tile) => {
            const m = metric(tile.key);
            return <Tile key={tile.key} icon={tile.icon} label={tile.label} value={m && m.value !== null ? tile.show(m.value) : "–"} delta={xDelta(m)} since={SINCE} signed />;
          })}
        </ul>
      </section>
      {data.checklist && <XProfileChecklist checklist={data.checklist} />}
      {data.connected !== false && <TopPosts posts={top} label={phrase} />}
    </div>
  );
}

function Loaded({ foot }: { foot?: ReactNode }) {
  const { range, custom, params, phrase, onPick } = useRangePick();
  const dashboard = useAgentDashboard<XPayload>("x_organic", { params });
  return (
    <>
      <ChannelDashboardControls
        ranges={DEFAULT_RANGES}
        range={range}
        pickedId={range.id}
        onPick={onPick}
        allowCustom
        custom={custom}
        period={payloadPeriod(dashboard.data)}
        onRefresh={dashboard.refresh}
        refreshing={dashboard.refreshing}
        scan={false}
      />
      <div data-testid="x-analytics" className="mx-auto flex w-full max-w-ca-content flex-col">
        <section aria-labelledby="x-analytics-title" className="mt-3 [container-type:inline-size]">
          <h2 id="x-analytics-title" className="text-ca-heading font-semibold tracking-tight text-ca-xdark">How the account is doing</h2>
          {dashboard.data ? (
            <Body data={dashboard.data} phrase={phrase} />
          ) : dashboard.error ? (
            <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-ca-action text-ca-danger">
              Zavi could not load your X numbers just now.
              <button type="button" onClick={dashboard.refreshSilent ?? dashboard.refresh} className={cn(cardButton.base, cardButton.secondary)}>Try again</button>
            </p>
          ) : (
            <div aria-busy className="mt-3 h-[360px] animate-pulse rounded-2xl bg-ca-subtle motion-reduce:animate-none" />
          )}
        </section>
        {foot}
      </div>
    </>
  );
}

export function XAnalytics({ active, foot }: { active: boolean; foot?: ReactNode }) {
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);
  return opened ? <Loaded foot={foot} /> : null;
}
