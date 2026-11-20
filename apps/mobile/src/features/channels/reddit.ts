
import type { ChannelSettingField, SettingItem } from "./channelSettings";

export const REDDIT_SLUG = "reddit_organic";

export type RedditDraft = { text: string | null; state: string; decision_id?: string | null } | null;

export type BrandMention = {
  thread_id: string;
  url: string;
  subreddit: string;
  title: string;
  author: string | null;
  term: string;
  sentiment: "positive" | "neutral" | "negative" | null;
  score: number | null;
  comment_count: number | null;
  observed_at: string;
  draft?: RedditDraft;
};

export type Opportunity = {
  thread_id: string;
  url: string;
  subreddit: string;
  title: string;
  posted_at: string | null;
  score: number | null;
  comment_count: number | null;
  post_relevance: number;
  comment_relevance: number | null;
  matched_terms?: string[];
  google?: { checked: boolean; rank: number | null; query: string | null } | null;
  draft: RedditDraft;
};

export type RelevantPost = {
  thread_id: string;
  url: string;
  subreddit: string;
  title: string;
  posted_at: string | null;
  relevance: number | null;
  matched_terms?: string[];
  score: number | null;
  comment_count: number | null;
};

export type RelevantComment = {
  comment_id: string;
  thread_id: string;
  url: string;
  subreddit: string;
  thread_title: string;
  author: string | null;
  excerpt: string;
  relevance: number | null;
  matched_terms?: string[];
  score: number | null;
};

export type CommunityRow = {
  name: string;
  relevance: number | null;
  relevance_why: string | null;
  subscribers: number | null;
  posts_per_day: number | null;
  posts_per_day_capped?: boolean;
  rules_verdict: string | null;
  saved?: boolean;
  recommended?: boolean;
};

type Kpi = { value?: number | null; previous?: number | null; scanned?: number | null };

export type SweepState = {
  enabled?: boolean;
  last: { status: string; started_at: string | null; finished_at: string | null } | null;
  budget?: { exhausted?: boolean } | null;
};

export type RedditInsights = {
  has_data: boolean;
  threshold?: number;
  sweep?: SweepState;
  today?: { posts_scanned?: number; communities_scanned?: number; posts_relevant?: number };
  kpis?: {
    brand_mentions?: Kpi;
    reply_opportunities?: Kpi;
    relevant_posts?: Kpi;
    relevant_comments?: Kpi;
    subreddits?: Kpi;
  };
  opportunities?: Opportunity[];
  lists?: { brand_mentions?: BrandMention[]; relevant_posts?: RelevantPost[]; relevant_comments?: RelevantComment[] };
  communities?: CommunityRow[];
};

export type RedditPayload = {
  workspace_v2?: boolean;
  workspace?: {
    keywords?: Array<{ term: string; type: string | null; status: string | null }>;
    communities?: Array<{ name: string; rules_verdict: string | null }>;
  } | null;
  insights?: RedditInsights | null;
};

export function redditOff(p: RedditPayload | null | undefined): boolean {
  return p?.workspace_v2 === false;
}

export function hasData(p: RedditPayload | null | undefined): boolean {
  return !!p?.insights?.has_data && !!p.insights.kpis;
}

export function formatCount(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 100_000) return `${Math.round(n / 1000)}K`;
  if (abs >= 10_000) return `${trim(n / 1000)}K`;
  return Math.round(n).toLocaleString("en-US");
}

export type RedditDelta = { text: string; up: boolean };

export function kpiDelta(value: number | null | undefined, previous: number | null | undefined): RedditDelta | null {
  if (typeof value !== "number" || typeof previous !== "number" || value === previous) return null;
  const up = value > previous;
  if (previous === 0) return { text: `${up ? "+" : "-"}${Math.abs(value - previous)}`, up };
  const pct = Math.round(((value - previous) / previous) * 1000) / 10;
  return { text: `${pct > 0 ? "+" : "-"}${Math.abs(pct)}%`, up };
}

export type RedditTableId = "brand" | "replies" | "posts" | "comments" | "subreddits";

export type RedditTile = {
  key: string;
  label: string;
  icon: "atSign" | "messageSquare" | "file" | "messages" | "users";
  table: RedditTableId;
  value: string;
  delta: RedditDelta | null;
};

const TILES: Array<Omit<RedditTile, "value" | "delta"> & { kpi: keyof NonNullable<RedditInsights["kpis"]> }> = [
  { key: "brand_mentions", kpi: "brand_mentions", label: "Brand mentions", icon: "atSign", table: "brand" },
  { key: "reply_opportunities", kpi: "reply_opportunities", label: "Reply opportunities", icon: "messageSquare", table: "replies" },
  { key: "relevant_posts", kpi: "relevant_posts", label: "Relevant posts", icon: "file", table: "posts" },
  { key: "relevant_comments", kpi: "relevant_comments", label: "Relevant comments", icon: "messages", table: "comments" },
  { key: "subreddits", kpi: "subreddits", label: "Subreddits saved", icon: "users", table: "subreddits" },
];

export function redditTiles(p: RedditPayload | null | undefined): RedditTile[] {
  const kpis = hasData(p) ? p?.insights?.kpis : undefined;
  return TILES.map(({ kpi, ...t }) => {
    const k = kpis?.[kpi];
    const v = k?.value;
    return {
      ...t,
      value: kpis ? (typeof v === "number" ? formatCount(v) : "-") : "—",
      delta: kpis && kpi !== "subreddits" ? kpiDelta(v, k?.previous) : null,
    };
  });
}

export function compactNumber(n: number): string {
  const one = (v: number) => (v < 100 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v)));
  if (Math.abs(n) >= 1_000_000) return `${one(n / 1_000_000)}M`;
  if (Math.abs(n) >= 1000) return `${one(n / 1000)}K`;
  return String(Math.round(n));
}

export const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : compactNumber(n));

export function agoShort(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const subLabel = (name: string) => `r/${name.replace(/^r\//i, "")}`;
export const normSub = (s: string) => s.trim().replace(/^r\//i, "").replace(/\/$/, "").toLowerCase();

export function relevanceLevel(v: number): "High" | "Medium" | "Low" {
  return v >= 75 ? "High" : v >= 50 ? "Medium" : "Low";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const grouped = (n: number | null | undefined) => (typeof n === "number" ? n.toLocaleString("en-US") : "0");

export type Tone = "good" | "muted" | "bad";

export type Cell =
  | { kind: "text"; text: string; dim?: boolean; align?: "right" }
  | { kind: "link"; text: string; url: string; sub?: string }
  | { kind: "chip"; text: string; tone: Tone }
  | { kind: "meter"; value: number | null; terms: string[] }
  | { kind: "verdict"; name: string; value: string | null };

export type RowAction =
  | { kind: "draft"; threadId: string; draft: { text: string; state: string } | null }
  | { kind: "reply"; url: string; label: string };

export type TableRow = { key: string; cells: Cell[]; action?: RowAction };

export type RedditTable = {
  id: RedditTableId;
  title: string;
  icon: RedditTile["icon"];
  columns: Array<{ label: string; width: number; align?: "right" }>;
  rows: TableRow[];
  footer: string[] | null;
  empty: string;
  caption: string;
  tailFrom?: number;
};

const sentimentChip = (s: BrandMention["sentiment"]): Cell =>
  s === "positive"
    ? { kind: "chip", text: "Positive", tone: "good" }
    : s === "negative"
      ? { kind: "chip", text: "Negative", tone: "bad" }
      : s === "neutral"
        ? { kind: "chip", text: "Neutral", tone: "muted" }
        : { kind: "text", text: "—", dim: true };

export function usableDraft(d: RedditDraft | undefined): { text: string; state: string } | null {
  if (!d || !d.text || !d.text.trim() || d.state === "dismissed") return null;
  return { text: d.text, state: d.state };
}

const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((a, x) => a + (typeof x === "number" ? x : 0), 0);

function brandTable(p: RedditPayload): RedditTable {
  const ins = p.insights as RedditInsights;
  const byThread = new Map<string, BrandMention & { terms: string[] }>();
  for (const m of ins.lists?.brand_mentions ?? []) {
    const hit = byThread.get(m.thread_id);
    if (hit) {
      if (!hit.terms.includes(m.term)) hit.terms.push(m.term);
    } else byThread.set(m.thread_id, { ...m, terms: [m.term] });
  }
  const rows = [...byThread.values()];
  const showTerm = new Set(rows.flatMap((r) => r.terms)).size > 1;
  const brandTerms = (p.workspace?.keywords ?? []).filter((k) => k.type === "brand" && k.status === "tracking").map((k) => k.term);
  const total = ins.kpis?.brand_mentions?.value ?? 0;
  return {
    id: "brand",
    title: "Brand mentions · last 7 days",
    icon: "atSign",
    columns: [
      { label: "Thread", width: 220 },
      ...(showTerm ? [{ label: "Term", width: 120 }] : []),
      { label: "Sentiment", width: 104 },
      { label: "Upvotes", width: 84, align: "right" as const },
      { label: "Comments", width: 92, align: "right" as const },
      { label: "Age", width: 80 },
    ],
    rows: rows.map((r) => ({
      key: r.thread_id,
      cells: [
        { kind: "link", text: r.title, url: r.url, sub: `${subLabel(r.subreddit)}${r.author ? ` · u/${r.author}` : ""}` },
        ...(showTerm ? [{ kind: "text", text: r.terms.join(", ") } as Cell] : []),
        sentimentChip(r.sentiment),
        { kind: "text", text: num(r.score), align: "right" },
        { kind: "text", text: num(r.comment_count), align: "right" },
        { kind: "text", text: agoShort(r.observed_at), dim: true },
      ],
      action: { kind: "draft", threadId: r.thread_id, draft: usableDraft(r.draft) },
    })),
    footer:
      rows.length >= 2
        ? [plural(rows.length, "thread"), ...(showTerm ? [""] : []), "", num(sum(rows.map((r) => r.score))), num(sum(rows.map((r) => r.comment_count))), ""]
        : null,
    empty: "No brand mentions in the last 7 days. Track your brand name in Keywords, then scan.",
    caption: `${grouped(total)} ${total === 1 ? "mention" : "mentions"} of ${brandTerms.length ? brandTerms.join(" and ") : "your brand"} in what Zavi scanned. Newest first; sentiment is inferred by Zavi.`,
  };
}

function fitCell(v: number | null, threshold: number): Cell {
  if (v === null || v === undefined) return { kind: "text", text: "—", dim: true };
  return { kind: "chip", text: `${Math.round(v)}/100`, tone: v >= threshold ? "good" : "muted" };
}

function repliesTable(p: RedditPayload): RedditTable {
  const ins = p.insights as RedditInsights;
  const threshold = ins.threshold ?? 50;
  const rows = (ins.opportunities ?? []).slice(0, 10);
  const anyComment = rows.some((r) => r.comment_relevance !== null && r.comment_relevance !== undefined);
  const anyGoogle = rows.some((r) => r.google?.checked || (r.google?.rank ?? null) !== null);
  const google = (g: Opportunity["google"]): Cell => {
    if (g && g.rank !== null && g.rank <= 10) return { kind: "chip", text: g.query ? `Google #${g.rank} “${g.query}”` : `Google #${g.rank}`, tone: "good" };
    if (g?.checked) return { kind: "chip", text: "Not on Google page 1", tone: "muted" };
    return { kind: "text", text: "—", dim: true };
  };
  const status = (d: RedditDraft): Cell =>
    d?.state === "posted"
      ? { kind: "chip", text: "Posted", tone: "good" }
      : d?.state === "proposed"
        ? { kind: "chip", text: "In approval queue", tone: "good" }
        : d?.state === "drafted"
          ? { kind: "chip", text: "Drafted", tone: "muted" }
          : { kind: "text", text: "—", dim: true };
  return {
    id: "replies",
    title: "Reply opportunities · last 7 days",
    icon: "messageSquare",
    columns: [
      { label: "Thread", width: 220 },
      { label: "Post fit", width: 92 },
      ...(anyComment ? [{ label: "Comment fit", width: 112 }] : []),
      ...(anyGoogle ? [{ label: "Google", width: 170 }] : []),
      { label: "Upvotes", width: 84, align: "right" as const },
      { label: "Status", width: 150 },
    ],
    rows: rows.map((r) => ({
      key: r.thread_id,
      cells: [
        {
          kind: "link",
          text: r.title,
          url: r.url,
          sub: [subLabel(r.subreddit), r.posted_at ? agoShort(r.posted_at) : null, r.comment_count !== null ? `${compactNumber(r.comment_count)} comments` : null]
            .filter(Boolean)
            .join(" · "),
        },
        fitCell(r.post_relevance, threshold),
        ...(anyComment ? [fitCell(r.comment_relevance, threshold)] : []),
        ...(anyGoogle ? [google(r.google)] : []),
        { kind: "text", text: num(r.score), align: "right" },
        status(r.draft),
      ],
      action: { kind: "draft", threadId: r.thread_id, draft: usableDraft(r.draft) },
    })),
    footer:
      rows.length >= 2
        ? [plural(rows.length, "thread"), "", ...(anyComment ? [""] : []), ...(anyGoogle ? [""] : []), num(sum(rows.map((r) => r.score))), ""]
        : null,
    empty: "No reply opportunities yet. Scan Reddit to find buyer questions.",
    caption: `Top ${rows.length} of ${grouped(ins.kpis?.reply_opportunities?.value)} threads where a useful reply fits, ranked by post and comment relevance. Nothing is posted by Zavi.`,
  };
}

function postsTable(p: RedditPayload): RedditTable {
  const ins = p.insights as RedditInsights;
  const threshold = ins.threshold ?? 50;
  const rows = (ins.lists?.relevant_posts ?? []).slice(0, 10);
  const k = ins.kpis?.relevant_posts;
  return {
    id: "posts",
    title: "Relevant posts · today",
    icon: "file",
    columns: [
      { label: "Post", width: 240 },
      { label: "Relevance", width: 170 },
      { label: "Upvotes", width: 84, align: "right" },
    ],
    rows: rows.map((r) => ({
      key: r.thread_id,
      cells: [
        {
          kind: "link",
          text: r.title,
          url: r.url,
          sub: [subLabel(r.subreddit), agoShort(r.posted_at), r.comment_count !== null ? plural(r.comment_count, "comment") : null]
            .filter(Boolean)
            .join(" · "),
        },
        { kind: "meter", value: r.relevance, terms: r.matched_terms ?? [] },
        { kind: "text", text: num(r.score), align: "right" },
      ],
    })),
    footer: rows.length >= 2 ? [plural(rows.length, "post"), "", num(sum(rows.map((r) => r.score)))] : null,
    empty: `No posts scored ${threshold}+ today. Scan again later or add keywords.`,
    caption: `Top ${rows.length} of ${grouped(k?.value)} posts scoring ${threshold} or more, out of ${grouped(k?.scanned)} scanned. Relevance is how closely the post matches your keywords and buyer intent.`,
  };
}

function commentsTable(p: RedditPayload): RedditTable {
  const ins = p.insights as RedditInsights;
  const threshold = ins.threshold ?? 50;
  const rows = (ins.lists?.relevant_comments ?? []).slice(0, 10);
  const k = ins.kpis?.relevant_comments;
  return {
    id: "comments",
    title: "Relevant comments · today",
    icon: "messages",
    columns: [
      { label: "Comment", width: 260 },
      { label: "Relevance", width: 170 },
    ],
    rows: rows.map((r) => ({
      key: r.comment_id,
      cells: [
        {
          kind: "link",
          text: r.excerpt,
          url: r.url,
          sub: [r.author ? `u/${r.author}` : null, subLabel(r.subreddit), r.score !== null ? `${compactNumber(r.score)} ${r.score === 1 ? "upvote" : "upvotes"}` : null, r.thread_title]
            .filter(Boolean)
            .join(" · "),
        },
        { kind: "meter", value: r.relevance, terms: r.matched_terms ?? [] },
      ],
      action: {
        kind: "reply",
        url: r.url,
        label: r.author ? `Reply on Reddit to u/${r.author}` : "Reply on Reddit to this comment",
      },
    })),
    footer: null,
    empty: `No comments scored ${threshold}+ today.`,
    caption: `Top ${rows.length} of ${grouped(k?.value)} comments scoring ${threshold} or more, out of ${grouped(k?.scanned)} scanned, in threads matching your keywords. Each one is a person you can answer directly.`,
  };
}

export function verdictFor(p: RedditPayload, name: string, fallback: string | null): string | null {
  const hit = (p.workspace?.communities ?? []).find((c) => normSub(c.name) === normSub(name));
  return hit ? hit.rules_verdict : fallback;
}

function subredditsTable(p: RedditPayload): RedditTable {
  const ins = p.insights as RedditInsights;
  const all = (ins.communities ?? []).slice(0, 10);
  const worth = (c: CommunityRow) => !!c.saved || !!c.recommended || (c.relevance !== null && relevanceLevel(c.relevance) !== "Low");
  const rows = [...all.filter(worth), ...all.filter((c) => !worth(c))];
  const anySize = rows.some((c) => c.subscribers !== null || c.posts_per_day !== null);
  return {
    id: "subreddits",
    title: "Relevant subreddits",
    icon: "users",
    columns: [
      { label: "Subreddit", width: 200 },
      { label: "Relevance", width: 150 },
      ...(anySize ? [{ label: "Members", width: 92, align: "right" as const }, { label: "Posts / day", width: 96, align: "right" as const }] : []),
      { label: "Self-promo", width: 130 },
    ],
    rows: rows.map((c) => ({
      key: c.name,
      cells: [
        { kind: "link", text: subLabel(c.name), url: `https://www.reddit.com/r/${encodeURIComponent(c.name.replace(/^r\//i, ""))}/`, sub: c.relevance_why ?? undefined },
        { kind: "meter", value: c.relevance, terms: [] },
        ...(anySize
          ? [
              { kind: "text", text: c.subscribers === null ? "—" : compactNumber(c.subscribers), align: "right" } as Cell,
              {
                kind: "text",
                text: c.posts_per_day === null ? "—" : `${c.posts_per_day}${c.posts_per_day_capped ? "+" : ""}`,
                align: "right",
              } as Cell,
            ]
          : []),
        { kind: "verdict", name: c.name, value: verdictFor(p, c.name, c.rules_verdict) },
      ],
    })),
    footer: null,
    tailFrom: all.filter(worth).length,
    empty: "No subreddits scored yet. Add the ones your buyers post in, then scan.",
    caption: "Relevance out of 100: how closely each community's conversations match your business.",
  };
}

export function redditTable(p: RedditPayload | null | undefined, id: RedditTableId): RedditTable | null {
  if (!p || !hasData(p)) return null;
  switch (id) {
    case "brand":
      return brandTable(p);
    case "replies":
      return repliesTable(p);
    case "posts":
      return postsTable(p);
    case "comments":
      return commentsTable(p);
    case "subreddits":
      return subredditsTable(p);
  }
}

export const VERDICT_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: "Check rules" },
  { value: "allowed", label: "Allowed" },
  { value: "unclear", label: "Limited" },
  { value: "banned", label: "Not allowed" },
];

export const verdictLabel = (v: string | null) => VERDICT_OPTIONS.find((o) => o.value === v)?.label ?? "Check rules";

export function withVerdict(items: SettingItem[], name: string, verdict: string | null): SettingItem[] {
  const bare = name.replace(/^r\//i, "");
  const i = items.findIndex((x) => normSub(x.item) === normSub(bare));
  if (i >= 0) return items.map((x, j) => (j === i ? { ...x, item_type: verdict } : x));
  return [...items, { item: bare, item_type: verdict, status: verdict === "banned" ? "paused" : "tracking", origin: "custom" }];
}

export type ScanState = { lastAt: string | null; fresh: boolean; running: boolean; enabled: boolean; budgetExhausted: boolean };

export function scanState(p: RedditPayload | null | undefined, now = Date.now()): ScanState | null {
  const sweep = p?.insights?.sweep;
  if (!sweep) return null;
  const last = sweep.last ?? null;
  const done = last && (last.status === "complete" || last.status === "partial") ? last.finished_at : null;
  const t = done ? Date.parse(done) : Number.NaN;
  return {
    lastAt: last ? last.finished_at ?? last.started_at : null,
    fresh: !Number.isNaN(t) && now - t < 86_400_000,
    running: last?.status === "running",
    enabled: sweep.enabled !== false,
    budgetExhausted: sweep.budget?.exhausted === true,
  };
}

export function scanBlocked(s: ScanState): string | null {
  if (!s.enabled) return "Reddit scanning is turned off.";
  if (s.budgetExhausted) return "This week's scan budget is used up. Scans resume as the 7-day window rolls.";
  return null;
}

export function scanError(status: number | null, body?: { error?: { code?: string; message?: string }; reason?: string; message?: string } | null): string {
  if (status === null) return "Couldn't reach Zavi. Check your connection.";
  if (status === 409) return "A scan is already running.";
  if (status === 403) {
    if (body?.reason === "plan_upgrade_required" || body?.error?.code === "plan_upgrade_required") {
      return body?.message ?? body?.error?.message ?? "Reddit scans need a paid plan.";
    }
    return "Only an owner or an admin can start a scan.";
  }
  if (status === 429) {
    if (body?.error?.code === "tenant_limit_reached" && body.error.message) return body.error.message;
    return "This week's scan budget is used up, or a scan ran a few minutes ago.";
  }
  if (status === 422) {
    const reason = body?.reason ?? (body?.error as { reason?: string } | undefined)?.reason;
    if (reason === "disabled") return "Reddit scanning is turned off.";
    if (reason === "not_configured") return "Reddit scanning isn't set up yet.";
    return "Track a keyword, a competitor or a subreddit first, then scan.";
  }
  return "Couldn't start the scan. Try again in a moment.";
}

export type ThreadErrorBody = { error?: string | { code?: string; message?: string }; message?: string } | null;

export function sendError(status: number | null, body?: ThreadErrorBody): string {
  if (status === null) return "Couldn't reach Zavi. Check your connection.";
  const err = typeof body?.error === "object" ? body.error : null;
  const code = typeof body?.error === "string" ? body.error : err?.code;
  const message = body?.message ?? err?.message;
  if (status === 409) {
    if (code === "already_exists") return "Already saved.";
    return message || "You already replied on this thread, so Zavi kept that reply.";
  }
  if (status === 429) return "You've drafted a lot this hour. Try again later.";
  if (status === 404) return "This thread is no longer available.";
  if (status === 403) return "Only an owner or an admin can change this.";
  if (status === 400) return "That doesn't look right. Check the value and try again.";
  return "Couldn't save that. Try again in a moment.";
}

export const DRAFT_MAX_CHARS = 4000;

export function draftEditBlocked(text: string): string | null {
  const t = text.trim();
  if (!t) return "Write a reply first.";
  if (t.length > DRAFT_MAX_CHARS) return `Keep it to 4,000 characters. It's ${grouped(t.length)} now.`;
  return null;
}

export function threadBanned(p: RedditPayload, threadId: string): boolean {
  const ins = p.insights;
  const sub =
    (ins?.opportunities ?? []).find((o) => o.thread_id === threadId)?.subreddit ??
    (ins?.lists?.brand_mentions ?? []).find((m) => m.thread_id === threadId)?.subreddit;
  if (!sub) return false;
  const scanned = (ins?.communities ?? []).find((c) => normSub(c.name) === normSub(sub))?.rules_verdict ?? null;
  return verdictFor(p, sub, scanned) === "banned";
}

export const BANNED_POST_LINE = "This community does not allow self-promotion, so Zavi won't post here. You can still copy the reply.";

export function replyPasteHint(copied: boolean): string {
  return copied
    ? "Reply copied. Opening the thread… On Reddit, tap “Join the conversation”, paste it, read it over, then Comment."
    : "Opening the thread… Copying didn't work, so use Copy, then paste it into “Join the conversation”.";
}

export const REDDIT_SETTINGS: ChannelSettingField[] = [
  {
    kind: "list",
    id: "keywords",
    label: "Keywords",
    help: "Phrases Zavi searches for. The type steers how it reads a thread.",
    itemTypes: ["problem", "brand", "product", "competitor", "category", "comparison", "industry"],
    suggest: "/api/reddit/workspace/suggest",
  },
  {
    kind: "list",
    id: "competitors",
    label: "Competitors",
    help: "Brands Zavi watches for in the same threads, so it can tell you where you are being compared.",
    suggest: "/api/reddit/workspace/suggest",
  },
  {
    kind: "list",
    id: "communities",
    label: "Communities",
    help: "Where Zavi is allowed to look. It will not post anywhere you have not listed.",
    itemTypeOptions: {
      unsetLabel: "Rules: not checked",
      label: (item) => `What the rules of r/${item} say`,
      options: [
        { value: "allowed", label: "Founders may answer, product may be named" },
        { value: "unclear", label: "Unclear, it does not say" },
        { value: "banned", label: "Self-promotion is banned" },
      ],
    },
  },
];
