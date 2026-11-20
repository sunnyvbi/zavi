import { AtSign, FileText, MessageSquare, MessagesSquare, Users } from "lucide-react";
import type {
  ExtraCell,
  ExtraColumn,
  ExtraRow,
  ExtraTableData,
} from "../../actions/ExtraTable";
import type { RedditPayload, Verdict } from "./shared";
import type { RedditInsights } from "./types";
import { agoShort, compactNumber, normSub, relevanceLevel, subLabel } from "./ui";
import { draftDetail, draftReplyAction } from "./draftDetail";
import { REDDIT_ORGANIC_SLUG } from "@/lib/agentRegistry";
import { TENANT_SWITCH_EVENT } from "@/lib/workspace/tenantSwitch";

type Lists = RedditInsights["lists"];
type BrandMention = Lists["brand_mentions"][number];
type Opportunity = RedditInsights["opportunities"][number];

const num = (n: number | null | undefined) => (n === null || n === undefined ? "-" : compactNumber(n));

const sum = (values: Array<number | null | undefined>) =>
  values.reduce<number>((t, v) => t + (typeof v === "number" ? v : 0), 0);

const footerIf = (rows: unknown[], cells: ExtraCell[]): ExtraCell[] | undefined =>
  rows.length < 2 ? undefined : cells;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function threadCell(url: string, title: string, sub: string): ExtraCell {
  return { text: title, sub, href: url, title };
}

export function dedupeBrandMentions(rows: BrandMention[]): Array<BrandMention & { terms: string[] }> {
  const byThread = new Map<string, BrandMention & { terms: string[] }>();
  for (const m of rows) {
    const seen = byThread.get(m.thread_id);
    if (!seen) byThread.set(m.thread_id, { ...m, terms: [m.term] });
    else if (!seen.terms.includes(m.term)) seen.terms.push(m.term);
  }
  return [...byThread.values()];
}

const SENTIMENT: Record<NonNullable<BrandMention["sentiment"]>, ExtraCell> = {
  positive: { text: "Positive", chip: "good" },
  neutral: { text: "Neutral", chip: "muted" },
  negative: { text: "Negative", chip: "bad" },
};

function bannedSubs(payload: RedditPayload | null, insights: RedditInsights): Set<string> {
  const verdicts = new Map((insights.communities ?? []).map((c) => [normSub(c.name), c.rules_verdict]));
  for (const c of payload?.workspace?.communities ?? []) if (c.rules_verdict) verdicts.set(normSub(c.name), c.rules_verdict);
  return new Set([...verdicts].filter(([, v]) => v === "banned").map(([k]) => k));
}

function brandMentions(insights: RedditInsights, terms: string[], onChanged?: () => void, connected = false, banned: Set<string> = new Set()): ExtraTableData {
  const rows = dedupeBrandMentions(insights.lists?.brand_mentions ?? []);
  const total = insights.kpis.brand_mentions.value;
  const termText = terms.length ? terms.join(" and ") : "your brand";
  const showTerm = new Set(rows.flatMap((r) => r.terms)).size > 1;
  const columns: ExtraColumn[] = [
    { label: "Thread", align: "left" },
    ...(showTerm ? [{ label: "Term", align: "left" } as ExtraColumn] : []),
    { label: "Sentiment", align: "left" },
    { label: "Upvotes" },
    { label: "Comments" },
    { label: "Age", align: "left" },
  ];
  return {
    id: "reddit_brand_mentions",
    title: "Brand mentions · last 7 days",
    icon: AtSign,
    columns,
    actionsLabel: "Reply",
    detailInDrawer: true,
    rows: rows.map((m) => {
      const detail = draftDetail(m.thread_id, m.url, m.draft, onChanged, connected, banned.has(normSub(m.subreddit)));
      return {
        id: m.thread_id,
        cells: [
          threadCell(m.url, m.title, `${subLabel(m.subreddit)}${m.author ? ` · u/${m.author}` : ""}`),
          ...(showTerm ? [{ text: m.terms.join(", ") }] : []),
          m.sentiment ? SENTIMENT[m.sentiment] : { text: "-", tone: "dim" as const },
          { text: num(m.score) },
          { text: num(m.comment_count) },
          { text: agoShort(m.observed_at), tone: "dim" as const },
        ],
        actions: detail ? undefined : [draftReplyAction(m.thread_id, onChanged)],
        detail,
      } satisfies ExtraRow;
    }),
    footer: footerIf(rows, [
      { text: plural(rows.length, "thread", "threads") },
      ...(showTerm ? [{ text: "" }] : []),
      { text: "" },
      { text: num(sum(rows.map((m) => m.score))) },
      { text: num(sum(rows.map((m) => m.comment_count))) },
      { text: "" },
    ]),
    empty: terms.length ? `No mentions of ${termText} in the last 7 days.` : "No brand mentions in the last 7 days. Track your brand name in Keywords, then scan.",
    caption: `${total.toLocaleString("en-US")} mention${total === 1 ? "" : "s"} of ${termText} in what Zavi scanned. Newest first; sentiment is inferred by Zavi.`,
  };
}

const DRAFT_STATE: Record<NonNullable<Opportunity["draft"]>["state"], ExtraCell | null> = {
  posted: { text: "Posted", chip: "good" },
  proposed: { text: "In approval queue", chip: "good" },
  drafted: { text: "Drafted", chip: "muted" },
  dismissed: null,
};

function googleCell(g: Opportunity["google"]): ExtraCell {
  if (g.rank !== null && g.rank <= 10) {
    return { text: g.query ? `Google #${g.rank} “${g.query}”` : `Google #${g.rank}`, chip: "good" };
  }
  if (g.checked) return { text: "Not on Google page 1", chip: "muted" };
  return { text: "Not checked", tone: "dim" };
}

function replyOpportunities(insights: RedditInsights, onChanged?: () => void, connected = false, banned: Set<string> = new Set()): ExtraTableData {
  const rows = (insights.opportunities ?? []).slice(0, 10);
  const total = insights.kpis.reply_opportunities.value;
  const threshold = insights.threshold;
  const hasCommentFit = rows.some((o) => o.comment_relevance !== null);
  const fit = (v: number): ExtraCell => ({ text: `${Math.round(v)}/100`, chip: v >= threshold ? "good" : "muted" });
  const columns: ExtraColumn[] = [
    { label: "Thread", align: "left" },
    { label: "Post fit", align: "left" },
    ...(hasCommentFit ? [{ label: "Comment fit", align: "left" } as ExtraColumn] : []),
    { label: "Google", align: "left" },
    { label: "Status", align: "left" },
  ];
  return {
    id: "reddit_reply_opportunities",
    title: "Reply opportunities · last 7 days",
    icon: MessageSquare,
    columns,
    actionsLabel: "Reply",
    detailInDrawer: true,
    narrow: true,
    rows: rows.map((o) => {
      const state = o.draft ? DRAFT_STATE[o.draft.state] : null;
      return {
        id: o.thread_id,
        cells: [
          threadCell(
            o.url,
            o.title,
            [
              subLabel(o.subreddit),
              o.posted_at ? agoShort(o.posted_at) : null,
              o.comment_count !== null ? `${compactNumber(o.comment_count)} comments` : null,
              o.score !== null && o.score !== undefined ? plural(o.score, "upvote", "upvotes") : null,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
          { ...fit(o.post_relevance), ...matched(o.matched_terms) },
          ...(hasCommentFit
            ? [o.comment_relevance !== null ? fit(o.comment_relevance) : { text: "-", tone: "dim" as const }]
            : []),
          googleCell(o.google),
          state ?? { text: "-", tone: "dim" as const },
        ],
        actions: state ? undefined : [draftReplyAction(o.thread_id, onChanged)],
        detail: draftDetail(o.thread_id, o.url, o.draft, onChanged, connected, banned.has(normSub(o.subreddit))),
      } satisfies ExtraRow;
    }),
    footer: footerIf(rows, [
      { text: plural(rows.length, "thread", "threads") },
      { text: "" },
      ...(hasCommentFit ? [{ text: "" }] : []),
      { text: "" },
      { text: "" },
    ]),
    empty: "No reply opportunities yet. Scan Reddit to find buyer questions.",
    caption: `Top ${rows.length} of ${total.toLocaleString("en-US")} threads where a useful reply fits, ranked by post and comment relevance. Nothing is posted by Zavi.`,
  };
}

const relevanceText = (v: number | null): ExtraCell =>
  v === null
    ? { text: "-", tone: "dim" }
    : { text: relevanceLevel(v), meter: { value: v, name: "Relevance" } };

const matched = (terms: string[] | undefined): Pick<ExtraCell, "terms"> => {
  const items = terms ?? [];
  return {
    terms: {
      items,
      name: "Matched keywords",
      heading: items.length === 1 ? "Matched keyword" : `Matched keywords · ${items.length}`,
      buttonLabel: `Show ${items.length} matched keyword${items.length === 1 ? "" : "s"}`,
    },
  };
};

function relevantPosts(insights: RedditInsights): ExtraTableData {
  const rows = (insights.lists?.relevant_posts ?? []).slice(0, 10);
  const { value: total, scanned } = insights.kpis.relevant_posts;
  const threshold = insights.threshold;
  return {
    id: "reddit_relevant_posts",
    title: "Relevant posts · today",
    icon: FileText,
    columns: [{ label: "Post", align: "left" }, { label: "Relevance", align: "left" }, { label: "Upvotes" }],
    rows: rows.map((p) => ({
      id: p.thread_id,
      cells: [
        threadCell(
          p.url,
          p.title,
          [
            subLabel(p.subreddit),
            p.posted_at ? agoShort(p.posted_at) : null,
            p.comment_count !== null && p.comment_count !== undefined
              ? `${compactNumber(p.comment_count)} comment${p.comment_count === 1 ? "" : "s"}`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        { ...relevanceText(p.relevance), ...matched(p.matched_terms) },
        { text: num(p.score) },
      ],
    })),
    footer: footerIf(rows, [
      { text: plural(rows.length, "post", "posts") },
      { text: "" },
      { text: num(sum(rows.map((p) => p.score))) },
    ]),
    empty: `No posts scored ${threshold}+ today. Scan again later or add keywords.`,
    caption: `Top ${rows.length} of ${total.toLocaleString("en-US")} posts scoring ${threshold} or more, out of ${scanned.toLocaleString("en-US")} scanned. Relevance is how closely the post matches your keywords and buyer intent.`,
  };
}

function relevantComments(insights: RedditInsights): ExtraTableData {
  const rows = (insights.lists?.relevant_comments ?? []).slice(0, 10);
  const { value: total, scanned } = insights.kpis.relevant_comments;
  const threshold = insights.threshold;
  return {
    id: "reddit_relevant_comments",
    title: "Relevant comments · today",
    icon: MessagesSquare,
    columns: [{ label: "Comment", align: "left" }, { label: "Relevance", align: "left" }],
    actionsLabel: "Reply",
    rows: rows.map((c) => ({
      id: c.comment_id,
      cells: [
        {
          text: c.excerpt,
          sub: [
            c.author ? `u/${c.author}` : null,
            subLabel(c.subreddit),
            c.score !== null ? `${compactNumber(c.score)} upvote${c.score === 1 ? "" : "s"}` : null,
            c.thread_title,
          ]
            .filter(Boolean)
            .join(" · "),
          href: c.url,
          title: c.excerpt,
        },
        { ...relevanceText(c.relevance), ...matched(c.matched_terms) },
      ],
      actions: [
        {
          label: "Reply",
          href: c.url,
          title: `Reply on Reddit to ${c.author ? `u/${c.author}` : "this comment"}`,
        },
      ],
    })),
    empty: `No comments scored ${threshold}+ today.`,
    caption: `Top ${rows.length} of ${total.toLocaleString("en-US")} comments scoring ${threshold} or more, out of ${scanned.toLocaleString("en-US")} scanned, in threads matching your keywords. Each one is a person you can answer directly.`,
  };
}

const SELF_PROMO_UNSET = "Check rules";
const SELF_PROMO_OPTIONS = [
  { value: "allowed", label: "Allowed" },
  { value: "unclear", label: "Limited" },
  { value: "banned", label: "Not allowed" },
] as const;

const COMMUNITIES_FIELD = "communities";

type SettingsItem = { item: string; item_type?: string | null; status?: string | null };

let verdictQueue: Promise<unknown> = Promise.resolve();

export function saveVerdict(name: string, verdict: string | null): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (typeof window !== "undefined") window.addEventListener(TENANT_SWITCH_EVENT, abort, { once: true });
  const run = verdictQueue
    .then(() => writeVerdict(name, verdict, controller.signal))
    .finally(() => {
      if (typeof window !== "undefined") window.removeEventListener(TENANT_SWITCH_EVENT, abort);
    });
  verdictQueue = run.catch(() => undefined);
  return run;
}

async function writeVerdict(name: string, verdict: string | null, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Workspace changed before this saved. Set it again in this workspace.");
  const { apiFetch } = await import("@/lib/api");
  const read = await apiFetch(`/api/channels/${REDDIT_ORGANIC_SLUG}/settings`, { signal });
  if (!read.ok) throw new Error("Couldn't read your communities. Try again in a moment.");
  const body = (await read.json().catch(() => null)) as { fields?: Record<string, SettingsItem[]> } | null;
  const items = body?.fields?.[COMMUNITIES_FIELD] ?? [];
  const key = normSub(name);
  const known = items.some((it) => normSub(it.item) === key);
  const next: SettingsItem[] = known
    ? items.map((it) => (normSub(it.item) === key ? { ...it, item_type: verdict } : it))
    : [
        ...items,
        {
          item: name.trim().replace(/^\/?r\//i, ""),
          item_type: verdict,
          status: verdict === "banned" ? "paused" : "tracking",
          origin: "custom",
        } as SettingsItem,
      ];
  const res = await apiFetch(`/api/channels/${REDDIT_ORGANIC_SLUG}/settings/${COMMUNITIES_FIELD}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: next }),
    signal,
  });
  if (res.status === 403) throw new Error("Only an owner or an admin can change this.");
  if (!res.ok) throw new Error("Couldn't save that. Try again in a moment.");
}

function subreddits(
  payload: RedditPayload,
  insights: RedditInsights,
  onChanged?: () => void,
): ExtraTableData {
  const rows = (insights.communities ?? []).slice(0, 10);
  const saved = new Map((payload.workspace?.communities ?? []).map((c) => [normSub(c.name), c]));
  const showSize = rows.some((r) => r.subscribers !== null || r.posts_per_day !== null);
  const worthReading = (r: RedditInsights["communities"][number]) =>
    r.saved || r.recommended || (r.relevance !== null && relevanceLevel(r.relevance) !== "Low");
  const columns: ExtraColumn[] = [
    { label: "Subreddit", align: "left" },
    { label: "Relevance", align: "left" },
    ...(showSize ? ([{ label: "Members" }, { label: "Posts / day" }] as ExtraColumn[]) : []),
    { label: "Self-promo", align: "left" },
  ];
  return {
    id: "reddit_subreddits",
    title: "Relevant subreddits",
    icon: Users,
    columns,
    rows: rows.map((r) => {
      const bare = r.name.replace(/^\/?r\//i, "");
      const verdict: Verdict | null = saved.get(normSub(r.name))?.rules_verdict ?? r.rules_verdict;
      return {
        id: r.name,
        tail: !worthReading(r),
        cells: [
          {
            text: subLabel(bare),
            sub: r.relevance_why ?? undefined,
            href: `https://www.reddit.com/r/${encodeURIComponent(bare)}/`,
          },
          relevanceText(r.relevance),
          ...(showSize
            ? [
                { text: compactNumber(r.subscribers) },
                {
                  text:
                    r.posts_per_day === null
                      ? "-"
                      : r.posts_per_day_capped
                        ? `${r.posts_per_day}+`
                        : String(r.posts_per_day),
                },
              ]
            : []),
          {
            text: verdict ? SELF_PROMO_OPTIONS.find((o) => o.value === verdict)!.label : SELF_PROMO_UNSET,
            select: {
              value: verdict,
              unsetLabel: SELF_PROMO_UNSET,
              options: SELF_PROMO_OPTIONS,
              label: `Self-promo in ${subLabel(bare)} (your reading of its rules)`,
              onChange: async (next) => {
                await saveVerdict(bare, next);
                onChanged?.();
              },
            },
          },
        ],
      } satisfies ExtraRow;
    }),
    tailToggle: {
      show: () => "Show more",
      hide: "Show less",
      noneAbove: "No subreddit scored Medium or higher yet.",
    },
    empty: "No subreddits scored yet. Add the ones your buyers post in, then scan.",
    caption: "Relevance out of 100: how closely each community's conversations match your business.",
  };
}

export function redditKpiTables(payload: unknown, onChanged?: () => void): ExtraTableData[] {
  const p = payload as RedditPayload | null;
  const insights = p?.insights;
  if (!insights || !insights.has_data || !insights.kpis) return [];
  const brandTerms = (p?.workspace?.keywords ?? [])
    .filter((k) => k.type === "brand" && k.status === "tracking")
    .map((k) => k.term);
  const connected = p?.account?.connected === true;
  const banned = bannedSubs(p, insights);
  return [
    brandMentions(insights, brandTerms, onChanged, connected, banned),
    replyOpportunities(insights, onChanged, connected, banned),
    relevantPosts(insights),
    relevantComments(insights),
    subreddits(p as RedditPayload, insights, onChanged),
  ];
}
