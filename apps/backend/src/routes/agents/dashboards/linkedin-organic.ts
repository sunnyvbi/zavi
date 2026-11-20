
import { readLinkedInRefreshStatus } from "@/services/linkedin-social/refresh-status";
import { defaultChannelContext } from "@/services/channels/context";
import {
  LINKEDIN_CHANNEL,
  LINKEDIN_METER_KEY,
  LINKEDIN_READS_PER_DAY,
  refreshLinkedIn,
  savedPageUrl,
} from "@/services/linkedin-social/snapshots";
import { utcDay } from "@/services/x-social/read-cap";
import { snapshotWindow, type SnapshotWindow } from "@/services/agents/dashboards/snapshot-window";
import type { DashboardBuilder, DashboardContext } from "./_contract";
import { LINKEDIN_CHANNELS, stagedDrafts } from "@/services/channels/staged-drafts";
import { readConnectorList } from "@/services/connectors/metadata";
import { isLinkedInSocialUsable } from "@/services/connectors/social-publish-account";

const WINDOW_DAYS = 30;

type AccountRow = { captured_on: string; name: string | null; followers_count: number | null };
type PostRow = {
  external_post_id: string;
  captured_on: string;
  posted_at: string | null;
  text: string | null;
  url: string | null;
  metrics: { reactions?: number | null; comments?: number | null; reposts?: number | null } | null;
};
export type LinkedInTopPost = {
  id: string;
  url: string | null;
  text: string;
  posted_at: string | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
};

export function shapeLinkedIn(accounts: AccountRow[], posts: PostRow[], now: Date = new Date()) {
  const latest = accounts[accounts.length - 1] ?? null;
  const first = accounts.length > 1 ? accounts[accounts.length - 2] : null;
  const newest = new Map<string, PostRow>();
  for (const p of posts) {
    const seen = newest.get(p.external_post_id);
    if (!seen || p.captured_on > seen.captured_on) newest.set(p.external_post_id, p);
  }
  const top_posts: LinkedInTopPost[] = [...newest.values()]
    .map((p) => ({
      id: p.external_post_id,
      url: p.url,
      text: p.text ?? "",
      posted_at: p.posted_at,
      reactions: p.metrics?.reactions == null ? null : Number(p.metrics.reactions),
      comments: p.metrics?.comments == null ? null : Number(p.metrics.comments),
      reposts: p.metrics?.reposts == null ? null : Number(p.metrics.reposts),
    }))
    .sort((a, b) => (b.reactions ?? 0) + (b.comments ?? 0) - ((a.reactions ?? 0) + (a.comments ?? 0)));
  const shown = top_posts.slice(0, 5).sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? ""));

  const day = latest?.captured_on ?? "";
  const row = (key: string, value: number | null, unit: string | null = null, prev: number | null = null) =>
    value === null
      ? []
      : [{ key, value, unit, window_kind: null, day, grounded: true, prev_value: prev, prev_day: prev === null ? null : (first?.captured_on ?? null) }];

  const followers = latest?.followers_count ?? null;

  const engagements = top_posts.reduce((n, p) => n + (p.reactions ?? 0) + (p.comments ?? 0) + (p.reposts ?? 0), 0);
  const rate =
    followers && followers > 0 && top_posts.length > 0
      ? Math.round((engagements / (followers * top_posts.length)) * 10000) / 100
      : null;

  const newestPost = top_posts
    .map((p) => p.posted_at)
    .filter((d): d is string => !!d)
    .sort()
    .pop();
  const days = newestPost
    ? Math.max(0, Math.floor((now.getTime() - new Date(newestPost).getTime()) / 86_400_000))
    : null;

  const knownTotal = (pick: (p: LinkedInTopPost) => number | null): number | null => {
    if (!top_posts.length || top_posts.some((p) => pick(p) === null)) return null;
    return top_posts.reduce((n, p) => n + (pick(p) ?? 0), 0);
  };
  const metrics = [
    ...row("followers", followers, null, first?.followers_count ?? null),
    ...row("total_posts", latest ? top_posts.length : null),
    ...row("engagement_rate", rate, "pct"),
    ...row("reactions", knownTotal((p) => p.reactions)),
    ...row("comments", knownTotal((p) => p.comments)),
    ...row("reposts", knownTotal((p) => p.reposts)),
    ...row("days_since_last_post", days),
  ];
  return { account: latest ? { name: latest.name, followers: latest.followers_count } : null, metrics, top_posts: shown, last_day: latest?.captured_on ?? null };
}

async function readRows(c: DashboardContext, window?: SnapshotWindow) {
  const since = window?.since ?? new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const until = window?.until ?? null;
  const accounts = c.sb
    .from("social_account_snapshots")
    .select("captured_on, name, followers_count")
    .eq("tenant_id", c.tenantId)
    .eq("channel", LINKEDIN_CHANNEL)
    .gte("captured_on", since);
  const posts = c.sb
    .from("social_post_metric_snapshots")
    .select("external_post_id, captured_on, posted_at, text, url, metrics")
    .eq("tenant_id", c.tenantId)
    .eq("channel", LINKEDIN_CHANNEL)
    .gte("captured_on", since);
  const [a, p] = await Promise.all([
    (until ? accounts.lte("captured_on", until) : accounts).order("captured_on", { ascending: true }),
    until ? posts.lte("captured_on", until) : posts,
  ]);
  if (a.error || p.error) throw new Error((a.error ?? p.error)?.message ?? "stored read failed");
  return { accounts: ((a.data ?? []) as AccountRow[]).sort((x, y) => x.captured_on.localeCompare(y.captured_on)), posts: (p.data ?? []) as PostRow[] };
}

export const build: DashboardBuilder = async (c) => {
  let page_url: string | null = null;
  try {
    page_url = savedPageUrl(await defaultChannelContext(c.tenantId, "linkedin_organic"));
  } catch {
  }

  const STORED_READ_FAILED = "Zavi could not load your stored LinkedIn numbers just now. Try again in a minute.";
  let rows: { accounts: AccountRow[]; posts: PostRow[] } = { accounts: [], posts: [] };
  let problem: string | null = null;
  let storedOk = true;
  try {
    rows = await readRows(c);
  } catch {
    storedOk = false;
    problem = STORED_READ_FAILED;
  }
  const readAllowance = async () => {
    try {
      const { data, error } = await c.sb.from("tenant_metered_read_counters").select("reads")
        .eq("tenant_id", c.tenantId).eq("day", utcDay()).eq("key", LINKEDIN_METER_KEY).maybeSingle();
      if (error) return null;
      const n = Number(data?.reads ?? 0);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch { return null; }
  };
  let used = await readAllowance();
  const readToday = rows.accounts.some((r) => r.captured_on === utcDay());
  if (page_url && storedOk && (c.meteredRefresh || (!readToday && used === 0))) {
    const r = await refreshLinkedIn(c.tenantId, { automatic: !c.meteredRefresh });
    if (r.ok) {
      try { rows = await readRows(c); }
      catch { problem = STORED_READ_FAILED; }
    } else problem = r.message;
    used = await readAllowance();
  }
  const window = snapshotWindow(c, WINDOW_DAYS);
  const lastAttempt = await readLinkedInRefreshStatus(c.tenantId, page_url);
  const lastDay = rows.accounts.at(-1)?.captured_on ?? null;
  const stale = !!page_url && lastDay !== utcDay();
  if (!problem && page_url && storedOk && window.isDefault) {
    if (lastAttempt && lastAttempt.at.slice(0, 10) === utcDay() && !lastAttempt.ok) problem = lastAttempt.message;
    else if (stale && used === null) problem = "Zavi could not check the refresh allowance. Showing the last saved numbers.";
    else if (stale && used !== null && used >= LINKEDIN_READS_PER_DAY) problem = `All ${LINKEDIN_READS_PER_DAY} of today's LinkedIn refreshes are used. No newer numbers were saved. Refreshes reset at midnight UTC.`;
    else if (stale && used !== null && used > 0) problem = "A refresh was already attempted today. No newer numbers are available. Use Refresh to try again.";
  }

  let shown = rows;
  if (!window.isDefault && storedOk) {
    try {
      shown = await readRows(c, window);
    } catch {
      shown = { accounts: [], posts: [] };
      problem = STORED_READ_FAILED;
    }
  }

  const staged = await stagedDrafts(c, LINKEDIN_CHANNELS);
  let publishing_account: { name: string } | null = null;
  let publishing_connected: boolean | null = null;
  try {
    publishing_connected = await isLinkedInSocialUsable(c.tenantId);
    const connector = (await readConnectorList(c.tenantId)).find(row => row.slug === "linkedin_social");
    const name = connector?.team_name?.trim();
    if (name && publishing_connected) publishing_account = { name };
  } catch {  }
  return {
    page_url,
    publishing_account,
    publishing_connected,
    freshness: { last_success_day: lastDay, stale },
    drafts: staged ?? [],
    drafts_ok: staged !== null,
    ...shapeLinkedIn(shown.accounts, shown.posts, window.until ? new Date(`${window.until}T23:59:59Z`) : new Date()),
    period: window.period,
    refresh: { available: used !== null, used: used ?? LINKEDIN_READS_PER_DAY, cap: LINKEDIN_READS_PER_DAY, remaining: Math.max(0, LINKEDIN_READS_PER_DAY - (used ?? LINKEDIN_READS_PER_DAY)), last_attempt: lastAttempt },
    problem,
  };
};
