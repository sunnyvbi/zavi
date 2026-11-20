
import type { WorkspaceThreadMeta } from "@/components/workspace/useAgentThreads";
import { cleanPreview } from "@/components/workspace/threadHistory";
import { stripChannelMention } from "./channelMention";

export type BuildSessionState = "building" | "ready" | "failed" | "publishing" | "publish_failed" | "replaced";

export const REPLACED_BUILD_LABEL = "Replaced by a newer build";

export type BuildSessionSite = {
  hostname: string;
  live_url: string | null;
  status: string;
  name?: string | null;
  repo?: string | null;
};

export function siteName(site: BuildSessionSite | null | undefined): string | null {
  const name = typeof site?.name === "string" ? site.name.trim() : "";
  return name || null;
}

export function buildSessionTitle(session: BuildSessionMeta, useSiteName: boolean): string {
  return (useSiteName ? siteName(session.site) : null) || session.title || session.request || "Untitled build";
}

export type BuildSessionMeta = {
  id: string;
  title: string;
  request: string;
  state: BuildSessionState;
  run_status: string;
  created_at: string;
  last_activity_at: string;
  last_request_at?: string;
  refine_count: number;
  is_current: boolean;
  site?: BuildSessionSite;
  old_pipeline?: boolean;
  chat_thread_ids?: string[];
};

export type SiteBadge = {
  label: "Live" | "Building" | "Paused" | "Failed" | "Not published";
  tone: "success" | "progress" | "muted" | "danger";
};

const UNPUBLISHED_SITE_STATUSES: ReadonlySet<string> = new Set(["provisioning", "building"]);

export function siteBuiltNotPublished(
  site: BuildSessionSite | null | undefined,
  state: BuildSessionState | undefined,
): boolean {
  return !!site && state === "ready" && !site.live_url && UNPUBLISHED_SITE_STATUSES.has(site.status);
}

const RUN_IN_PROGRESS: ReadonlySet<BuildSessionState> = new Set<BuildSessionState>(["building", "publishing"]);

export function siteBadge(site: BuildSessionSite | null | undefined, state?: BuildSessionState): SiteBadge | null {
  if (!site) return null;
  if (siteBuiltNotPublished(site, state)) return { label: "Not published", tone: "muted" };
  switch (site.status) {
    case "live":
      return { label: "Live", tone: "success" };
    case "provisioning":
    case "building":
    case "publishing":
      if (state !== undefined && !RUN_IN_PROGRESS.has(state)) return null;
      return { label: "Building", tone: "progress" };
    case "paused":
    case "waking":
      return { label: "Paused", tone: "muted" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    default:
      return null;
  }
}

export function siteHref(site: BuildSessionSite | null | undefined): string | null {
  const url = site?.live_url ?? null;
  return typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

export type HistoryStatus = "running" | "completed" | "error";

export type UnreadReplyPreview = { text: string; kind: "question" | "reply"; at: string };

const PREVIEW_MAX = 140;

export function firstSentence(raw: string | null | undefined): string {
  if (!raw) return "";
  const blocks = raw
    .split(/\n\s*\n|\n(?=\s*(?:#{1,6}|[-*+]|\d+\.)\s)/)
    .map((b) => cleanPreview(b))
    .filter((b) => b.length > 0);
  const block = blocks.find((b) => b.length >= 12) ?? blocks[0] ?? "";
  const m = block.match(/^(.+?[.!?])(?=\s|$)/);
  let text = (m ? m[1] : block).trim();
  if (text.length > PREVIEW_MAX) text = `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}…`;
  return text;
}

function settleReply(
  reply: UnreadReplyPreview | null,
  id: string,
  ctx: DotContext | undefined,
): UnreadReplyPreview | null {
  if (!reply) return null;
  const seenAt = ctx?.seen?.[id];
  const at = Date.parse(reply.at);
  if (seenAt !== undefined && Number.isFinite(at) && seenAt >= at) return null;
  return reply;
}

export function unreadReplyPreview(thread: WorkspaceThreadMeta): UnreadReplyPreview | null {
  const r = thread.unread_reply;
  if (!thread.unread || !r) return null;
  const text = firstSentence(r.head);
  return { text: text || (r.kind === "question" ? "Has a question for you." : "Replied."), kind: r.kind, at: r.at };
}

export type HistoryItem =
  | {
      kind: "chat";
      id: string;
      agentSlug: string;
      title: string;
      at: number | null;
      status: HistoryStatus | null;
      reply?: UnreadReplyPreview | null;
    }
  | {
      kind: "build";
      id: string;
      title: string;
      at: number | null;
      state: BuildSessionState;
      status: HistoryStatus | null;
      site?: BuildSessionSite;
    };

function toEpoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function chatHistoryStatus(
  thread: WorkspaceThreadMeta,
): HistoryStatus | null {
  const ps = thread.presentation_status;
  if (ps === "running") return "running";
  if (ps === "answered") return "completed";
  if (ps === "failed") return "error";
  if (ps === "cancelled") return null;

  const raw = thread.run_status;
  if (["queued", "running", "dispatching", "claimed", "blocked"].includes(raw ?? "")) {
    return "running";
  }
  if (["success", "done", "completed", "answered"].includes(raw ?? "")) {
    return "completed";
  }
  if (
    ["failed", "error", "parse_failed", "dispatch_error", "timed_out"].includes(
      raw ?? "",
    )
  ) {
    return "error";
  }
  return thread.unread ? "completed" : null;
}

export const HISTORY_DOT_TTL_MS = 15 * 60 * 1000;

export type DotContext = {
  now?: number;
  seen?: Record<string, number>;
  siteNames?: boolean;
  foldBuildChats?: boolean;
  stable?: boolean;
};

export function settleHistoryStatus(
  status: HistoryStatus | null,
  id: string,
  finishedAt: number | null,
  ctx: DotContext = {},
): HistoryStatus | null {
  if (status === null || status === "running") return status;
  const now = ctx.now ?? Date.now();
  if (status === "completed" && finishedAt !== null && now - finishedAt > HISTORY_DOT_TTL_MS) {
    return null;
  }
  const seenAt = ctx.seen?.[id];
  if (seenAt !== undefined && (finishedAt === null || seenAt >= finishedAt)) return null;
  return status;
}

export function buildHistoryStatus(state: BuildSessionState): HistoryStatus {
  if (state === "building" || state === "publishing") return "running";
  if (state === "failed" || state === "publish_failed") return "error";
  return "completed";
}

export function chatHistoryTitle(thread: WorkspaceThreadMeta): string {
  return (
    stripChannelMention(thread.title?.trim() ?? null) ||
    stripChannelMention(cleanPreview(thread.last_message)) ||
    "New Chat"
  );
}

function requestKey(s: BuildSessionMeta): string {
  return (s.request || s.title || "").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

export const BUILD_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function visibleBuildSessions(sessions: BuildSessionMeta[]): BuildSessionMeta[] {
  const byRequest = new Map<string, number[]>();
  for (const s of sessions) {
    const key = requestKey(s);
    const created = toEpoch(s.created_at);
    if (key && created !== null) byRequest.set(key, [...(byRequest.get(key) ?? []), created]);
  }
  return sessions.filter((s) => {
    if (s.state !== "failed" && s.state !== "publish_failed") return true;
    const created = toEpoch(s.created_at);
    if (created === null) return true;
    const retried = (byRequest.get(requestKey(s)) ?? []).some(
      (other) => other > created && other - created <= BUILD_RETRY_WINDOW_MS,
    );
    return !retried;
  });
}

export function mergeHistory(
  threads: WorkspaceThreadMeta[],
  sessions: BuildSessionMeta[],
  ctx?: DotContext,
): HistoryItem[] {
  const settle = (status: HistoryStatus | null, id: string, at: number | null) =>
    ctx ? settleHistoryStatus(status, id, at, ctx) : status;
  const stable = ctx?.stable === true;
  const folded = new Set(ctx?.foldBuildChats ? sessions.flatMap((s) => s.chat_thread_ids ?? []) : []);
  const seen = new Set<string>();
  const created = new Map<string, number | null>();
  const orderAt = new Map<string, number | null>();
  const items: HistoryItem[] = [];
  for (const t of threads) {
    if (folded.has(t.id) || (stable && seen.has(`chat:${t.id}`))) continue;
    seen.add(`chat:${t.id}`);
    const at = toEpoch(t.last_message_at) ?? toEpoch(t.created_at);
    const raw = chatHistoryStatus(t);
    const createdAt = toEpoch(t.created_at) ?? at;
    created.set(`chat:${t.id}`, createdAt);
    orderAt.set(`chat:${t.id}`, stable ? createdAt : at);
    items.push({
      kind: "chat",
      id: t.id,
      agentSlug: t.agent_slug,
      title: chatHistoryTitle(t),
      at,
      status: settle(stable && raw === "running" ? null : raw, t.id, at),
      reply: settleReply(unreadReplyPreview(t), t.id, ctx),
    });
  }
  for (const s of visibleBuildSessions(sessions)) {
    if (stable && seen.has(`build:${s.id}`)) continue;
    seen.add(`build:${s.id}`);
    const at = toEpoch(s.last_activity_at) ?? toEpoch(s.created_at);
    created.set(`build:${s.id}`, toEpoch(s.created_at) ?? at);
    orderAt.set(`build:${s.id}`, toEpoch(s.last_request_at) ?? at);
    items.push({
      kind: "build",
      id: s.id,
      title: ctx?.siteNames ? buildSessionTitle(s, true) : s.title || "Untitled build",
      at,
      state: s.state,
      status: settle(buildHistoryStatus(s.state), s.id, at),
      ...(s.site ? { site: s.site } : {}),
    });
  }
  const order = (item: HistoryItem) => orderAt.get(`${item.kind}:${item.id}`) ?? null;
  const sorted = items.sort((a, b) => {
    const ta = order(a);
    const tb = order(b);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return stable ? disambiguateTitles(sorted, created) : sorted;
}

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const SHORT_DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function titleSuffixes(item: HistoryItem, createdAt: number | null): string[] {
  const out: string[] = [];
  const name = item.kind === "build" ? siteName(item.site) : null;
  if (name && name !== item.title) out.push(name);
  if (createdAt !== null) {
    out.push(SHORT_DATE.format(createdAt));
    out.push(SHORT_DATE_TIME.format(createdAt));
  }
  return out;
}

export function disambiguateTitles(items: HistoryItem[], created: Map<string, number | null>): HistoryItem[] {
  const byTitle = new Map<string, HistoryItem[]>();
  for (const item of items) byTitle.set(item.title, [...(byTitle.get(item.title) ?? []), item]);
  const renamed = new Map<HistoryItem, string>();
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const options = group.map((item) => titleSuffixes(item, created.get(`${item.kind}:${item.id}`) ?? null));
    const depth = Math.max(...options.map((o) => o.length));
    for (let level = 0; level < depth; level += 1) {
      const labels = group.map((item, i) => {
        const suffix = options[i]![Math.min(level, options[i]!.length - 1)];
        return suffix ? `${item.title} · ${suffix}` : item.title;
      });
      if (new Set(labels).size === labels.length || level === depth - 1) {
        const seenLabel = new Map<string, number>();
        group.forEach((item, i) => {
          const n = (seenLabel.get(labels[i]!) ?? 0) + 1;
          seenLabel.set(labels[i]!, n);
          renamed.set(item, n > 1 ? `${labels[i]} (${n})` : labels[i]!);
        });
        break;
      }
    }
  }
  return renamed.size ? items.map((item) => (renamed.has(item) ? { ...item, title: renamed.get(item)! } : item)) : items;
}
