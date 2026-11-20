
import {
  TIKTOK_CHANNEL,
  TIKTOK_METER_KEY,
  TIKTOK_READS_PER_DAY,
  refreshTikTok,
} from "@/services/tiktok-social/snapshots";
import { utcDay } from "@/services/x-social/read-cap";
import { snapshotWindow, type SnapshotWindow } from "@/services/agents/dashboards/snapshot-window";
import type { DashboardBuilder, DashboardContext } from "./_contract";
import { TIKTOK_CHANNELS, stagedDrafts } from "@/services/channels/staged-drafts";

const WINDOW_DAYS = 30;

type AccountRow = {
  captured_on: string;
  username: string | null;
  name: string | null;
  followers_count: number | null;
  post_count?: number | null;
};
type PostRow = {
  external_post_id: string;
  captured_on: string;
  posted_at: string | null;
  text: string | null;
  url: string | null;
  format: string | null;
  metrics: Record<string, number | null> | null;
};
export type TikTokTopPost = {
  id: string;
  url: string | null;
  text: string;
  posted_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export function shapeTikTok(accounts: AccountRow[], posts: PostRow[]) {
  const latest = accounts[accounts.length - 1] ?? null;
  const first = accounts.length > 1 ? accounts[0] : null;
  const newest = new Map<string, PostRow>();
  for (const p of posts) {
    const seen = newest.get(p.external_post_id);
    if (!seen || p.captured_on > seen.captured_on) newest.set(p.external_post_id, p);
  }
  const n = (v: number | null | undefined): number | null => (typeof v === "number" ? v : null);
  const top_posts: TikTokTopPost[] = [...newest.values()]
    .map((p) => ({
      id: p.external_post_id,
      url: p.url,
      text: p.text ?? "",
      posted_at: p.posted_at,
      views: n(p.metrics?.views),
      likes: n(p.metrics?.likes),
      comments: n(p.metrics?.comments),
      shares: n(p.metrics?.shares),
    }))
    .sort((a, b) => (b.views ?? (b.likes ?? 0) + (b.comments ?? 0)) - (a.views ?? (a.likes ?? 0) + (a.comments ?? 0)));
  const shown = top_posts.slice(0, 5).sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? ""));

  const day = latest?.captured_on ?? "";
  const row = (key: string, value: number | null, unit: string | null = null, prev: number | null = null) =>
    value === null
      ? []
      : [{ key, value, unit, window_kind: null, day, grounded: true, prev_value: prev, prev_day: prev === null ? null : (first?.captured_on ?? null) }];

  const sum = (pick: (p: TikTokTopPost) => number | null): number | null => {
    let saw = false;
    let total = 0;
    for (const p of top_posts) {
      const v = pick(p);
      if (v !== null) {
        saw = true;
        total += v;
      }
    }
    return saw ? total : null;
  };
  const views = sum((p) => p.views);
  const likes = sum((p) => p.likes);
  const comments = sum((p) => p.comments);
  const shares = sum((p) => p.shares);
  const interactions = sum((p) =>
    p.likes === null || p.comments === null ? null : p.likes + p.comments + (p.shares ?? 0),
  );
  const rate = views && views > 0 && interactions !== null ? Math.round((interactions / views) * 10000) / 100 : null;

  const metrics = [
    ...row("followers", latest?.followers_count ?? null, null, first?.followers_count ?? null),
    ...row("total_posts", typeof latest?.post_count === "number" ? latest.post_count : null),
    ...row("views", views),
    ...row("engagement_rate", rate, "pct"),
    ...row("likes", likes),
    ...row("comments", comments),
    ...row("shares", shares),
  ];
  return {
    account: latest ? { username: latest.username, name: latest.name, followers: latest.followers_count } : null,
    metrics,
    top_posts: shown,
    last_day: latest?.captured_on ?? null,
  };
}

async function readRows(c: DashboardContext, window?: SnapshotWindow) {
  const since = window?.since ?? new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const until = window?.until ?? null;
  const accounts = c.sb
    .from("social_account_snapshots")
    .select("captured_on, username, name, followers_count, post_count")
    .eq("tenant_id", c.tenantId)
    .eq("channel", TIKTOK_CHANNEL)
    .gte("captured_on", since);
  const posts = c.sb
    .from("social_post_metric_snapshots")
    .select("external_post_id, captured_on, posted_at, text, url, format, metrics")
    .eq("tenant_id", c.tenantId)
    .eq("channel", TIKTOK_CHANNEL)
    .gte("captured_on", since);
  const [a, p] = await Promise.all([
    (until ? accounts.lte("captured_on", until) : accounts).order("captured_on", { ascending: true }),
    until ? posts.lte("captured_on", until) : posts,
  ]);
  if (a.error || p.error) throw new Error((a.error ?? p.error)?.message ?? "stored read failed");
  return { accounts: (a.data ?? []) as AccountRow[], posts: (p.data ?? []) as PostRow[] };
}

export const build: DashboardBuilder = async (c) => {
  let connected = false;
  try {
    const { data } = await c.sb
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", c.tenantId)
      .eq("slug", "tiktok");
    connected = (data ?? []).length > 0;
  } catch {
  }

  const STORED_READ_FAILED = "Zavi could not load your stored TikTok numbers just now. Try again in a minute.";
  let rows: { accounts: AccountRow[]; posts: PostRow[] } = { accounts: [], posts: [] };
  let problem: string | null = null;
  let storedOk = true;
  try {
    rows = await readRows(c);
  } catch {
    storedOk = false;
    problem = STORED_READ_FAILED;
  }
  const readToday = rows.accounts.some((r) => r.captured_on === utcDay());
  if (connected && storedOk && (c.meteredRefresh || !readToday)) {
    const r = await refreshTikTok(c.tenantId);
    if (r.ok) {
      try {
        rows = await readRows(c);
      } catch {
        problem = STORED_READ_FAILED;
      }
    }
    else if (c.meteredRefresh || r.reason !== "cap_reached") problem = r.message;
  }

  const window = snapshotWindow(c, WINDOW_DAYS);
  let shown = rows;
  if (!window.isDefault && storedOk) {
    try {
      shown = await readRows(c, window);
    } catch {
      shown = { accounts: [], posts: [] };
      problem = STORED_READ_FAILED;
    }
  }

  let used = TIKTOK_READS_PER_DAY;
  try {
    const { data, error } = await c.sb
      .from("tenant_metered_read_counters")
      .select("reads")
      .eq("tenant_id", c.tenantId)
      .eq("day", utcDay())
      .eq("key", TIKTOK_METER_KEY)
      .maybeSingle();
    if (!error) used = Number((data as { reads?: number } | null)?.reads ?? 0);
  } catch {
  }

  const staged = await stagedDrafts(c, TIKTOK_CHANNELS);
  return {
    connected,
    drafts: staged ?? [],
    drafts_ok: staged !== null,
    ...shapeTikTok(shown.accounts, shown.posts),
    period: window.period,
    refresh: { used, cap: TIKTOK_READS_PER_DAY, remaining: Math.max(0, TIKTOK_READS_PER_DAY - used) },
    problem,
  };
};
