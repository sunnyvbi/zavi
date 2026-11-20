
import { spanDays } from "@/services/agents/dashboards/snapshot-window";
import type { DashboardBuilder } from "./_contract";
import { stagedDrafts } from "@/services/channels/staged-drafts";
import { channelIsSwitched, readSwitchedChannelRows } from "./_channel-action-rows";
import {
  accrualOver,
  engagementsOf,
  impressionsOf,
  latestPerPost,
  readAccountSnapshots,
  readPostSnapshots,
  refreshOwnedPostsIfStale,
  type AccountSnapshotRow,
  type SnapshotRow,
} from "@/services/x-social/owned-posts";
import { readBudget } from "@/services/x-social/read-cap";

const MAX_WINDOW_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 30;
export const X_RANGES = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
] as const;
const X_CHANNELS = new Set(["x", "x_image", "x_video"]);

export type XPostKind = "text" | "thread" | "link" | "poll" | "video" | "image" | "reply" | "repost";

export type XFormatTotal = { format: XPostKind; views: number; engagements: number };

export function kindOf(format: string, hasLink: boolean | null | undefined): XPostKind {
  if (format === "reply" || format === "repost" || format === "poll" || format === "video" || format === "thread") return format;
  if (format === "gif") return "video";
  if (format === "photo" || format === "image" || format === "media") return "image";
  return hasLink ? "link" : "text";
}

export function formatTotals(posts: Array<{ kind: XPostKind; views: number; engagements: number }>): XFormatTotal[] {
  const by = new Map<XPostKind, XFormatTotal>();
  for (const p of posts) {
    if (p.kind === "reply" || p.kind === "repost" || p.views <= 0) continue;
    const t = by.get(p.kind) ?? { format: p.kind, views: 0, engagements: 0 };
    t.views += p.views;
    t.engagements += p.engagements;
    by.set(p.kind, t);
  }
  return Array.from(by.values()).sort((a, b) => b.engagements / b.views - a.engagements / a.views);
}

export type XPostRow = {
  id: string;
  external_post_id: string | null;
  url: string | null;
  text: string;
  format: string;
  kind: XPostKind;
  posted_at: string | null;
  source: "zavi" | "account";
  status: string;
  thumb_url: string | null;
  media_type: string | null;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  bookmarks: number;
  link_clicks: number;
  profile_clicks: number;
  engagements: number;
  eng_rate: number | null;
  private_metrics_available: boolean;
  link_clicks_available?: boolean;
  profile_clicks_available?: boolean;
};

export type XMetricKey =
  | "impressions"
  | "engagement_rate"
  | "profile_visits"
  | "link_clicks"
  | "new_follows"
  | "replies"
  | "likes"
  | "reposts";

export type XMetric = {
  key: XMetricKey;
  label: string;
  value: number | null;
  unit: "count" | "pct";
  delta: number | null;
  delta_unit: "pct" | "pp";
  basis: "period" | "totals" | "partial" | "none";
};

export type XAttention = {
  key: string;
  title: string;
  detail: string;
  mode: "manual" | "approval";
  status: "open" | "done";
  effort: string;
  decision_id: string | null;
  link: string | null;
  blocking: boolean;
};

export type XDraft = {
  decision_id: string;
  source: "staged" | "step";
  label: string | null;
  needs_confirm: boolean;
  channel: string;
  text: string;
  thread: string[] | null;
  image_path: string | null;
  video_path: string | null;
  scheduled_at: string | null;
  rationale: string | null;
  emitted_at: string | null;
  snoozed_until?: string | null;
};

export type XChecklistSignal = {
  key: "avatar" | "header" | "bio" | "link" | "location" | "pinned" | "cadence" | "reply_rate" | "verified" | "handle";
  label: string;
  status: "pass" | "fix" | "unknown";
  note: string;
  link: string | null;
};

type DecisionRow = {
  id: string;
  decision_class: string;
  body: Record<string, unknown> | null;
  emitted_at: string | null;
  agent_run_id: string | null;
};

const linkClicksKnown = (np: { url_link_clicks?: number; user_profile_clicks?: number }, hasLink?: boolean) =>
  Number.isFinite(np.url_link_clicks) || (hasLink === false && Number.isFinite(np.user_profile_clicks));

const day = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (iso: string, n: number) => day(new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000));

function metricsRow(m: SnapshotRow["metrics"] | null | undefined, hasLink?: boolean) {
  const p = m?.public ?? {};
  const np = m?.non_public ?? m?.organic ?? {};
  const views = impressionsOf(m);
  const engagements = engagementsOf(m);
  return {
    views,
    likes: p.like_count ?? 0,
    replies: p.reply_count ?? 0,
    reposts: (p.retweet_count ?? 0) + (p.quote_count ?? 0),
    bookmarks: p.bookmark_count ?? 0,
    link_clicks: np.url_link_clicks ?? 0,
    profile_clicks: np.user_profile_clicks ?? 0,
    engagements,
    eng_rate: views > 0 ? Math.round((engagements / views) * 10000) / 100 : null,
    private_metrics_available: linkClicksKnown(np, hasLink) && Number.isFinite(np.user_profile_clicks),
    link_clicks_available: linkClicksKnown(np, hasLink),
    profile_clicks_available: Number.isFinite(np.user_profile_clicks),
  };
}

type Pick = (m: SnapshotRow["metrics"]) => number;
const nonPublic = (m: SnapshotRow["metrics"]) => m?.non_public ?? m?.organic ?? {};
const PICK: Record<Exclude<XMetricKey, "engagement_rate" | "new_follows">, Pick> = {
  impressions: impressionsOf,
  profile_visits: (m) => nonPublic(m).user_profile_clicks ?? 0,
  link_clicks: (m) => nonPublic(m).url_link_clicks ?? 0,
  replies: (m) => m?.public?.reply_count ?? 0,
  likes: (m) => m?.public?.like_count ?? 0,
  reposts: (m) => (m?.public?.retweet_count ?? 0) + (m?.public?.quote_count ?? 0),
};
const LABEL: Record<XMetricKey, string> = {
  impressions: "Impressions",
  engagement_rate: "Engagement rate",
  profile_visits: "Profile visits",
  link_clicks: "Link clicks",
  new_follows: "New follows",
  replies: "Replies",
  likes: "Likes",
  reposts: "Reposts",
};

const pctChange = (cur: number, prev: number | null): number | null =>
  prev === null || prev <= 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10;

export function computeMetrics(args: {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  snapshots: readonly SnapshotRow[];
  accounts: readonly AccountSnapshotRow[];
  posts: readonly XPostRow[];
}): XMetric[] {
  const { from, to, prevFrom, prevTo, snapshots, accounts, posts } = args;
  const days = new Set(snapshots.map((s) => s.captured_on));
  const inWindow = Array.from(days).filter((d) => d >= from && d <= to).sort();
  const earliest = Array.from(days).sort()[0] ?? null;
  const periodBasis = inWindow.length >= 1 && earliest !== null && earliest < inWindow[inWindow.length - 1];
  const prevCovered = periodBasis && earliest !== null && earliest < prevFrom;

  const privateCoverage = (key: "profile_visits" | "link_clicks", start: string, end: string) => {
    const field = key === "profile_visits" ? "user_profile_clicks" : "url_link_clicks";
    const within = snapshots.filter(s => s.captured_on >= start && s.captured_on <= end);
    const ids = new Set(within.map(s => s.external_post_id));
    const bases = latestPerPost(snapshots.filter(s => s.captured_on < start && ids.has(s.external_post_id)));
    return within.length > 0 && [...bases, ...within].every(s => field === "url_link_clicks"
      ? linkClicksKnown(nonPublic(s.metrics), s.has_link)
      : Number.isFinite(nonPublic(s.metrics)[field]));
  };

  const counter = (key: keyof typeof PICK): { value: number | null; delta: number | null; basis: XMetric["basis"] } => {
    const privateKey = key === "profile_visits" || key === "link_clicks" ? key : null;
    if (periodBasis) {
      if (privateKey && !privateCoverage(privateKey, from, to)) return { value: null, delta: null, basis: "none" };
      const cur = accrualOver(snapshots, PICK[key], from, to);
      const prev = prevCovered && (!privateKey || privateCoverage(privateKey, prevFrom, prevTo))
        ? accrualOver(snapshots, PICK[key], prevFrom, prevTo) : null;
      return { value: cur, delta: pctChange(cur, prev), basis: "period" };
    }
    const privateAvailable = (p: XPostRow) => privateKey === "link_clicks"
      ? (p.link_clicks_available ?? p.private_metrics_available)
      : (p.profile_clicks_available ?? p.private_metrics_available);
    if (posts.length === 0 || (privateKey && posts.some(p => !privateAvailable(p)))) {
      return { value: null, delta: null, basis: "none" };
    }
    const field: Record<keyof typeof PICK, keyof XPostRow> = {
      impressions: "views",
      profile_visits: "profile_clicks",
      link_clicks: "link_clicks",
      replies: "replies",
      likes: "likes",
      reposts: "reposts",
    };
    return { value: posts.reduce((n, p) => n + (p[field[key]] as number), 0), delta: null, basis: "totals" };
  };

  const impressions = counter("impressions");

  let rate: { value: number | null; delta: number | null; basis: XMetric["basis"] };
  if (periodBasis) {
    const curE = accrualOver(snapshots, engagementsOf, from, to);
    const curI = impressions.value ?? 0;
    const cur = curI > 0 ? Math.round((curE / curI) * 1000) / 10 : null;
    let delta: number | null = null;
    if (cur !== null && prevCovered) {
      const prevE = accrualOver(snapshots, engagementsOf, prevFrom, prevTo);
      const prevI = accrualOver(snapshots, impressionsOf, prevFrom, prevTo);
      if (prevI > 0) delta = Math.round((cur - (prevE / prevI) * 100) * 10) / 10;
    }
    rate = { value: cur, delta, basis: cur === null ? "none" : "period" };
  } else if (posts.length) {
    const e = posts.reduce((n, p) => n + p.engagements, 0);
    const i = impressions.value ?? 0;
    rate = { value: i > 0 ? Math.round((e / i) * 1000) / 10 : null, delta: null, basis: i > 0 ? "totals" : "none" };
  } else {
    rate = { value: null, delta: null, basis: "none" };
  }

  const followersAt = (rows: readonly AccountSnapshotRow[]) => {
    const withCount = rows.filter((r) => typeof r.followers_count === "number");
    return withCount.length ? (withCount[withCount.length - 1].followers_count as number) : null;
  };
  const before = (d: string) => accounts.filter((r) => r.captured_on < d);
  const upTo = (d: string) => accounts.filter((r) => r.captured_on <= d);
  const endCur = followersAt(upTo(to));
  const startCur = followersAt(before(from));
  let follows: { value: number | null; delta: number | null; basis: XMetric["basis"] };
  if (endCur !== null && startCur !== null) {
    const cur = endCur - startCur;
    const endPrev = followersAt(upTo(prevTo));
    const startPrev = followersAt(before(prevFrom));
    const prev = endPrev !== null && startPrev !== null ? endPrev - startPrev : null;
    follows = { value: cur, delta: pctChange(cur, prev), basis: "period" };
  } else {
    const within = accounts.filter((r) => r.captured_on >= from && r.captured_on <= to && typeof r.followers_count === "number");
    follows =
      within.length >= 2
        ? { value: (within[within.length - 1].followers_count as number) - (within[0].followers_count as number), delta: null, basis: "partial" }
        : { value: null, delta: null, basis: "none" };
  }

  const count = (key: keyof typeof PICK): XMetric => ({ key, label: LABEL[key], unit: "count", delta_unit: "pct", ...counter(key) });
  return [
    { key: "impressions", label: LABEL.impressions, unit: "count", delta_unit: "pct", ...impressions },
    { key: "engagement_rate", label: LABEL.engagement_rate, unit: "pct", delta_unit: "pp", ...rate },
    count("profile_visits"),
    count("link_clicks"),
    { key: "new_follows", label: LABEL.new_follows, unit: "count", delta_unit: "pct", ...follows },
    count("replies"),
    count("likes"),
    count("reposts"),
  ];
}

export function profileChecks(
  account: AccountSnapshotRow | null,
  companyName: string | null,
  topPost: XPostRow | null,
): Array<Omit<XAttention, "status" | "decision_id" | "blocking" | "mode">> {
  if (!account) return [];
  const profileUrl = account.username ? `https://x.com/${account.username}` : "https://x.com/settings/profile";
  const out: Array<Omit<XAttention, "status" | "decision_id" | "blocking" | "mode">> = [];
  const name = companyName?.trim() || account.name?.trim() || null;
  const bio = (account.description ?? "").trim();
  if (!bio) {
    out.push({
      key: "bio",
      title: name ? `Bio does not say what ${name} is` : "Bio is empty",
      detail: name ? `Write one line that says what ${name} does, and keep the link.` : "Write one line that says what the company does, and keep the link.",
      effort: "1 min",
      link: profileUrl,
    });
  } else if (name && !bioNamesCompany(bio, [companyName, account.name])) {
    out.push({
      key: "bio",
      title: `Bio does not say what ${name} is`,
      detail: `The bio never mentions ${name}. Add one line that says what it does, and keep the link.`,
      effort: "1 min",
      link: profileUrl,
    });
  }
  if (!account.profile_image_url || /default_profile/i.test(account.profile_image_url)) {
    out.push({
      key: "avatar",
      title: "Profile picture is the default placeholder",
      detail: "Upload the logo at 400×400 so posts are recognisable in the feed.",
      effort: "1 min",
      link: profileUrl,
    });
  }
  if (!account.profile_banner_url) {
    out.push({
      key: "header",
      title: "No header image",
      detail: "Add a 1500×500 header with the one-line promise.",
      effort: "2 min",
      link: profileUrl,
    });
  }
  if (!account.pinned_post_id) {
    out.push({
      key: "pinned",
      title: "No pinned post",
      detail: topPost
        ? `Pin “${topPost.text.slice(0, 60)}${topPost.text.length > 60 ? "…" : ""}”, the best performer in this window, so new visitors see it first.`
        : "Pin your best post so new visitors see it first.",
      effort: "1 min",
      link: topPost?.url ?? profileUrl,
    });
  }
  return out;
}

export const MIN_RECEIVED = 5;

export function computeChecklist(
  account: AccountSnapshotRow | null,
  companyName: string | null,
  posts: readonly XPostRow[],
  windowDays: number,
  postDatesKnown = true,
): { signals: XChecklistSignal[]; passed: number; total: number } {
  const profileUrl = account?.username ? `https://x.com/${account.username}` : "https://x.com/settings/profile";
  const name = companyName?.trim() || account?.name?.trim() || null;
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const s = (
    key: XChecklistSignal["key"],
    label: string,
    ok: boolean | null,
    note: string,
    link: string | null = profileUrl,
  ): XChecklistSignal => ({ key, label, status: ok === null ? "unknown" : ok ? "pass" : "fix", note, link });

  const roots = posts.filter((p) => p.format !== "reply" && p.format !== "repost");
  const ownReplies = posts.filter((p) => p.format === "reply").length;
  const received = roots.reduce((n, p) => n + p.replies, 0);
  const weeks = Math.max(1, windowDays / 7);
  const perWeek = Math.round((roots.length / weeks) * 10) / 10;
  const replyRate = received >= MIN_RECEIVED ? Math.round((ownReplies / received) * 100) : null;

  const a = account;
  const bio = (a?.description ?? "").trim();
  const signals: XChecklistSignal[] = [
    s("avatar", "Profile picture", a ? !!a.profile_image_url && !/default_profile/i.test(a.profile_image_url) : null, a ? (a.profile_image_url && !/default_profile/i.test(a.profile_image_url) ? "Custom image set" : "Still the default placeholder") : "No profile read yet"),
    s("header", "Header image", a ? !!a.profile_banner_url : null, a ? (a.profile_banner_url ? "Header set" : "No header image") : "No profile read yet"),
    s("bio", "Bio states what you do", a ? !!bio && bioNamesCompany(bio, [companyName, a.name]) : null, a ? (!bio ? "Bio is empty" : !bioNamesCompany(bio, [companyName, a.name]) ? `Bio never mentions ${name}` : "Bio names the company") : "No profile read yet"),
    s("link", "Link in bio", a ? !!a.url : null, a ? (a.url ? a.url : "No website on the profile") : "No profile read yet"),
    s("location", "Location set", a ? !!a.location : null, a ? (a.location ? a.location : "No location on the profile") : "No profile read yet"),
    s("pinned", "Pinned post", a ? !!a.pinned_post_id : null, a ? (a.pinned_post_id ? "A post is pinned" : "Nothing pinned") : "No profile read yet"),
    s("cadence", "Posting cadence ≥ 3 / week", postDatesKnown ? perWeek >= 3 : null, postDatesKnown ? `${perWeek} posts a week in this window` : "Some published post dates are unavailable; cadence cannot be judged for this window", null),
    s("reply_rate", "Reply rate ≥ 50%", !postDatesKnown || replyRate === null ? null : replyRate >= 50, !postDatesKnown ? "Some published post dates are unavailable; replies cannot be judged for this window" : replyRate !== null ? `${ownReplies} of your replies for ${received} received (${replyRate}%)` : received === 0 ? "No replies received in this window" : `Only ${received} received, too few to judge`, null),
    s("verified", "Verified", a ? a.verified : null, a ? (a.verified === null ? "X did not say" : a.verified ? "Verified" : "Not verified") : "No profile read yet", "https://x.com/i/premium_sign_up"),
    s("handle", "Handle matches brand", a && name ? norm(a.username ?? "").includes(norm(name).slice(0, 5)) : null, a?.username ? `@${a.username}` : "No handle read yet", "https://x.com/settings/screen_name"),
  ];
  return { signals, passed: signals.filter((x) => x.status === "pass").length, total: signals.length };
}

export function bioNamesCompany(bio: string, names: Array<string | null | undefined>): boolean {
  const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hay = squash(bio);
  const needles = names.map((n) => squash(n ?? "")).filter((n) => n.length >= 3);
  return needles.length === 0 || needles.some((n) => hay.includes(n));
}

const CONFIRM_RE = /\[CONFIRM:/i;
const normText = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

export function stepToDraft(d: { id: string; body: Record<string, unknown> | null; emitted_at: string | null }): XDraft | null {
  const step = ((d.body ?? {}).step ?? {}) as Record<string, unknown>;
  const del = (step.deliverable ?? null) as { kind?: unknown; label?: unknown; content?: unknown } | null;
  if (!del || (del.kind !== "post" && del.kind !== "thread") || typeof del.content !== "string") return null;
  const parts = del.content.split(/\n\s*---\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const body = typeof step.body === "string" ? step.body : "";
  return {
    decision_id: d.id,
    source: "step",
    label: typeof del.label === "string" ? del.label : null,
    needs_confirm: CONFIRM_RE.test(del.content),
    channel: "x",
    text: parts[0],
    thread: parts.length > 1 ? parts.slice(1) : null,
    image_path: null,
    video_path: null,
    scheduled_at: null,
    rationale: body ? firstSentence(body) : null,
    emitted_at: d.emitted_at,
  };
}

function firstSentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  const m = t.match(/^(.{20,240}?[.!?])(\s|$)/);
  return m ? m[1] : t.slice(0, 200);
}

async function latestRunSteps(c: Parameters<DashboardBuilder>[0]): Promise<DecisionRow[]> {
  if (channelIsSwitched("x_organic")) {
    return await readSwitchedChannelRows(c.tenantId, "x_organic");
  }
  try {
    const { data: runs } = await c.sb
      .from("agent_runs")
      .select("id, started_at")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "x_organic")
      .order("started_at", { ascending: false })
      .limit(12);
    const ordered = ((runs ?? []) as Array<{ id: string; started_at: string | null }>)
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
      .map((r) => r.id);
    if (ordered.length === 0) return [];
    const { data, error } = await c.sb
      .from("decisions")
      .select("id, decision_class, body, emitted_at, agent_run_id")
      .eq("tenant_id", c.tenantId)
      .eq("status", "proposed")
      .eq("decision_class", "channel.recipe_step")
      .in("agent_run_id", ordered)
      .order("emitted_at", { ascending: false })
      .limit(300);
    if (error || !Array.isArray(data)) return [];
    const rows = data as DecisionRow[];
    const live = ordered.find((id) => rows.some((r) => r.agent_run_id === id));
    return live ? rows.filter((r) => r.agent_run_id === live) : [];
  } catch {
    return [];
  }
}

export const build: DashboardBuilder = async (c) => {
  const custom = c.customRange ?? null;
  const WINDOW_DAYS = custom ? spanDays(custom) : Math.min(c.rangeDays ?? DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS);
  const to = custom ? custom.until : day(new Date());
  const from = custom ? custom.since : shiftDays(to, -(WINDOW_DAYS - 1));
  const historyDays = (custom ? spanDays({ since: custom.until, until: day(new Date()) }) : 0) + WINDOW_DAYS * 2 + 2;
  const prevTo = shiftDays(from, -1);
  const prevFrom = shiftDays(prevTo, -(WINDOW_DAYS - 1));

  let handle: string | null = null;
  let connectedAt: string | null = null;
  let connected = false;
  try {
    const { data } = await c.sb.from("connector_metadata").select("slug, team_name, connected_at").eq("tenant_id", c.tenantId).eq("slug", "x_social").maybeSingle();
    if (data) {
      connected = true;
      handle = (data as { team_name?: string | null }).team_name ?? null;
      connectedAt = (data as { connected_at?: string | null }).connected_at ?? null;
    }
  } catch {
  }

  let companyName: string | null = null;
  try {
    const { data } = await c.sb.from("tenants").select("display_name").eq("id", c.tenantId).maybeSingle();
    companyName = (data as { display_name?: string | null } | null)?.display_name ?? null;
  } catch {
  }

  let read: { read: boolean; reason?: string; error_code?: string } = { read: false, reason: "not_connected" };
  if (connected) {
    try {
      read = await refreshOwnedPostsIfStale(c.tenantId, { force: c.meteredRefresh });
    } catch (e) {
      read = { read: false, reason: (e as Error).message.slice(0, 200), error_code: "x_read_failed" };
    }
  }
  let budget = { used: 0, cap: 0, remaining: 0 };
  try {
    const b = await readBudget(c.sb, c.tenantId);
    budget = { used: b.used, cap: b.cap, remaining: Number.isFinite(b.remaining) ? b.remaining : b.cap };
  } catch {
  }

  let snapshots: SnapshotRow[] = [];
  try {
    snapshots = (await readPostSnapshots(c.sb, c.tenantId, historyDays)).filter((s) => s.captured_on <= to);
  } catch {
    snapshots = [];
  }
  let accounts: AccountSnapshotRow[] = [];
  try {
    accounts = await readAccountSnapshots(c.sb, c.tenantId, historyDays);
  } catch {
    accounts = [];
  }
  const latest = latestPerPost(snapshots);
  const latestById = new Map(latest.map((r) => [r.external_post_id, r]));

  type LedgerRow = {
    id: string;
    channel: string;
    status: string;
    external_url: string | null;
    external_post_id: string | null;
    approved_payload_snapshot: { payload?: Record<string, unknown> } | null;
    metrics: SnapshotRow["metrics"] | null;
    scheduled_at: string | null;
    created_at: string;
    updated_at: string;
  };
  let ledger: LedgerRow[] = [];
  try {
    const { data } = await c.sb
      .from("social_posts")
      .select("id, channel, status, external_url, external_post_id, approved_payload_snapshot, metrics, scheduled_at, created_at, updated_at")
      .eq("tenant_id", c.tenantId)
      .in("channel", Array.from(X_CHANNELS))
      .gte("updated_at", `${from}T00:00:00Z`)
      .order("updated_at", { ascending: false })
      .limit(200);
    ledger = (data ?? []) as LedgerRow[];
  } catch {
    ledger = [];
  }

  const posts: XPostRow[] = [];
  const seenExternal = new Set<string>();
  for (const r of ledger) {
    if (r.status !== "published") continue;
    const payload = r.approved_payload_snapshot?.payload ?? {};
    const text = typeof payload.text === "string" ? payload.text : "";
    const snap = r.external_post_id ? latestById.get(r.external_post_id) : undefined;
    if (r.external_post_id) seenExternal.add(r.external_post_id);
    const postedAt = snap?.posted_at ?? null;
    const zaviFormat = r.channel === "x_image" ? "image" : r.channel === "x_video" ? "video" : Array.isArray(payload.thread) && payload.thread.length ? "thread" : "post";
    if (postedAt && (postedAt.slice(0, 10) < from || postedAt.slice(0, 10) > to)) continue;
    posts.push({
      id: r.id,
      external_post_id: r.external_post_id,
      url: r.external_url,
      text,
      format: zaviFormat,
      kind: kindOf(zaviFormat, snap?.has_link),
      posted_at: postedAt,
      source: "zavi",
      status: "published",
      thumb_url: snap?.thumb_url ?? null,
      media_type: snap?.media_type ?? null,
      ...metricsRow(snap?.metrics ?? r.metrics, snap?.has_link),
    });
  }
  for (const s of latest) {
    if (seenExternal.has(s.external_post_id)) continue;
    if (!s.posted_at || s.posted_at.slice(0, 10) < from || s.posted_at.slice(0, 10) > to) continue;
    posts.push({
      id: `x:${s.external_post_id}`,
      external_post_id: s.external_post_id,
      url: s.url,
      text: s.text ?? "",
      format: s.format ?? "post",
      kind: kindOf(s.format ?? "post", s.has_link),
      posted_at: s.posted_at,
      source: "account",
      status: "published",
      thumb_url: s.thumb_url ?? null,
      media_type: s.media_type ?? null,
      ...metricsRow(s.metrics, s.has_link),
    });
  }
  posts.sort((a, b) => b.views - a.views || (b.posted_at ?? "").localeCompare(a.posted_at ?? ""));

  const windowPosts = posts.filter(p => p.posted_at !== null);
  const metrics = computeMetrics({ from, to, prevFrom, prevTo, snapshots, accounts, posts: windowPosts });

  const account = accounts.length ? accounts[accounts.length - 1] : null;
  let dismissals: Array<{ check_key: string; dismissed_at: string }> = [];
  try {
    const { data } = await c.sb.from("social_profile_check_dismissals").select("check_key, dismissed_at").eq("tenant_id", c.tenantId).eq("channel", "x");
    dismissals = (data ?? []) as typeof dismissals;
  } catch {
    dismissals = [];
  }
  const dismissedAt = new Map(dismissals.map((d) => [d.check_key, d.dismissed_at]));
  const snapshotAt = account?.created_at ?? (account ? `${account.captured_on}T00:00:00Z` : null);
  const attention: XAttention[] = profileChecks(account, companyName, windowPosts[0] ?? null).map((chk) => {
    const at = dismissedAt.get(chk.key);
    const done = !!at && (!snapshotAt || at >= snapshotAt);
    return { ...chk, mode: "manual", status: done ? "done" : "open", decision_id: null, blocking: false };
  });

  const drafts: XDraft[] = [];
  const [staged, steps] = await Promise.all([stagedDrafts(c, X_CHANNELS), latestRunSteps(c)]);
  drafts.push(...(staged ?? []));

  const taken = new Set<string>([
    ...drafts.map((x) => normText(x.text)),
    ...ledger.map((r) => normText(typeof r.approved_payload_snapshot?.payload?.text === "string" ? (r.approved_payload_snapshot.payload.text as string) : "")),
    ...latest.map((r) => normText(r.text ?? "")),
  ]);
  taken.delete("");

  for (const d of steps) {
    const asDraft = stepToDraft(d);
    if (asDraft) {
      if (!taken.has(normText(asDraft.text))) {
        drafts.push(asDraft);
        taken.add(normText(asDraft.text));
      }
      continue;
    }
    const step = ((d.body ?? {}).step ?? {}) as Record<string, unknown>;
    const title = typeof step.title === "string" ? step.title : "";
    if (!title) continue;
    const body = typeof step.body === "string" ? step.body : "";
    attention.push({
      key: `step:${d.id}`,
      title,
      detail: firstSentence(body),
      mode: "approval",
      status: "open",
      effort: typeof step.effort === "string" ? step.effort : "2 min",
      decision_id: d.id,
      link: null,
      blocking: step.blocking === true,
    });
  }
  attention.sort((a, b) => Number(b.blocking) - Number(a.blocking) || Number(a.status === "done") - Number(b.status === "done"));

  const verifiedAccount = connectedAt
    ? accounts.filter(a => a.created_at && a.created_at >= connectedAt).at(-1) ?? null
    : null;
  return {
    connected,
    handle,
    account_handle: verifiedAccount?.username ?? null,
    account_read_at: verifiedAccount?.created_at ?? null,
    account_name: account?.name ?? null,
    window_days: WINDOW_DAYS,
    period: { from, to },
    ranges: X_RANGES,
    read_budget: budget,
    read,
    actions_waiting: attention.filter((a) => a.status === "open").length + drafts.length,
    metrics,
    attention,
    drafts,
    drafts_ok: staged !== null,
    top_posts: posts.slice(0, 25),
    formats: formatTotals(windowPosts),
    checklist: computeChecklist(account, companyName, windowPosts, WINDOW_DAYS, windowPosts.length === posts.length),
    snapshot_days: new Set(snapshots.filter((s) => s.captured_on >= from && s.captured_on <= to).map((s) => s.captured_on)).size,
  };
};
