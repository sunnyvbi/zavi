import type { TenantId } from "@/services/tenant-client";

export const SITE_COMMENTS_SETTING = "site_preview_comments";
export const MAX_COMMENT_BODY = 2000;
export const MAX_MENTIONS = 20;
export const MAX_ANCHOR_TEXT = 160;
export const MAX_PAGE_PATH = 200;
export const MAX_THREADS_PER_SITE = 300;
export const THREAD_STATUSES = ["open", "resolved", "sent"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_RE = /^\/[A-Za-z0-9_\-./:%~]{0,199}$/;
const SECTION_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function stripControl(s: string, keepNewlines: boolean): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x7f || (c < 0x20 && !(keepNewlines && (c === 0x0a || c === 0x09)))) {
      if (!keepNewlines) out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

export type ThreadRow = {
  id: string;
  tenant_id: string;
  site_id: string;
  page_path: string;
  selector: string;
  section: string | null;
  anchor_text: string | null;
  rel_x: number;
  rel_y: number;
  status: ThreadStatus;
  sent_run_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type CommentRow = {
  id: string;
  tenant_id: string;
  thread_id: string;
  author_id: string;
  body: string;
  mentions: string[];
  created_at: string;
};

export type NewThread = Omit<ThreadRow, "id" | "tenant_id" | "status" | "sent_run_id" | "created_at" | "updated_at">;
export type NewComment = Omit<CommentRow, "id" | "tenant_id" | "created_at">;

export type SiteCommentStore = {
  listThreads(tid: TenantId, siteId: string): Promise<ThreadRow[]>;
  listComments(tid: TenantId, threadIds: string[]): Promise<CommentRow[]>;
  getThread(tid: TenantId, id: string): Promise<ThreadRow | null>;
  createThread(tid: TenantId, row: NewThread): Promise<ThreadRow>;
  deleteThread(tid: TenantId, id: string): Promise<void>;
  addComment(tid: TenantId, row: NewComment): Promise<CommentRow>;
  setStatus(tid: TenantId, id: string, status: ThreadStatus): Promise<ThreadRow | null>;
};

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function cleanBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = stripControl(raw.replace(/\r\n?/g, "\n"), true).trim();
  if (t.length === 0 || t.length > MAX_COMMENT_BODY) return null;
  return t;
}

export function cleanPagePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().split(/[?#]/)[0] ?? "";
  return PATH_RE.test(t) && !t.startsWith("//") && t.length <= MAX_PAGE_PATH ? t : null;
}

export function cleanSection(raw: unknown): string | null {
  return typeof raw === "string" && SECTION_RE.test(raw) ? raw : null;
}

export function cleanAnchorText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = stripControl(raw, false).replace(/\s+/g, " ").trim().slice(0, MAX_ANCHOR_TEXT);
  return t.length > 0 ? t : null;
}

export function cleanRel(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export type MentionCheck = { ok: true; ids: string[] } | { ok: false; code: "bad_mentions" | "mention_not_member" };

export function checkMentions(raw: unknown, memberIds: readonly string[]): MentionCheck {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return { ok: false, code: "bad_mentions" };
  const ids: string[] = [];
  for (const v of raw) {
    if (!isUuid(v)) return { ok: false, code: "bad_mentions" };
    const id = v.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_MENTIONS) return { ok: false, code: "bad_mentions" };
  const members = new Set(memberIds.map((m) => m.toLowerCase()));
  if (!ids.every((id) => members.has(id))) return { ok: false, code: "mention_not_member" };
  return { ok: true, ids };
}

export function mentionRecipients(mentions: readonly string[], authorId: string): string[] {
  const author = authorId.toLowerCase();
  const out: string[] = [];
  for (const m of mentions) {
    const id = m.toLowerCase();
    if (id !== author && !out.includes(id)) out.push(id);
  }
  return out;
}

export function isThreadStatus(v: unknown): v is ThreadStatus {
  return typeof v === "string" && (THREAD_STATUSES as readonly string[]).includes(v);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type MentionEmail = { subject: string; html: string; text: string };

export function renderMentionEmail(args: {
  siteLabel: string;
  pagePath: string;
  body: string;
  link: string;
  render: (p: { title: string; intro: string; body: string; ctaText: string; ctaUrl: string; preheader: string; footerNote: string }) => string;
}): MentionEmail {
  const excerpt = args.body.length > 400 ? `${args.body.slice(0, 399)}…` : args.body;
  const subject = `You were mentioned in a comment on ${args.siteLabel}`;
  const where = `${args.siteLabel} ${args.pagePath}`;
  const text = `A teammate mentioned you in a comment on ${where}:\n\n"${excerpt}"\n\nOpen it: ${args.link}`;
  const html = args.render({
    title: "You were <em>mentioned</em>",
    intro: `A teammate mentioned you in a comment on ${escapeHtml(where)}.`,
    body: `<div style="padding:0 0 0 13px;border-left:2px solid #e4e4e0;white-space:pre-wrap;">${escapeHtml(excerpt)}</div>`,
    ctaText: "Open the comment",
    ctaUrl: args.link,
    preheader: excerpt.slice(0, 120),
    footerNote: "You're getting this because a member of your workspace mentioned you in a site comment.",
  });
  return { subject, html, text };
}

export type MentionSendDeps = {
  emailFor: (userId: string) => Promise<string | null>;
  send: (to: string, mail: MentionEmail) => Promise<void>;
};

export async function sendMentionEmails(
  recipients: readonly string[],
  authorId: string,
  mail: MentionEmail,
  deps: MentionSendDeps,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const seenAddresses = new Set<string>();
  for (const userId of mentionRecipients(recipients, authorId)) {
    const email = await deps.emailFor(userId).catch(() => null);
    if (!email) continue;
    const key = email.trim().toLowerCase();
    if (seenAddresses.has(key)) continue;
    seenAddresses.add(key);
    try {
      await deps.send(email, mail);
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}

const THREAD_COLS =
  "id, tenant_id, site_id, page_path, selector, section, anchor_text, rel_x, rel_y, status, sent_run_id, created_by, created_at, updated_at";
const COMMENT_COLS = "id, tenant_id, thread_id, author_id, body, mentions, created_at";

export function realSiteCommentStore(): SiteCommentStore {
  const tc = async (tid: TenantId) => (await import("@/services/tenant-client")).tenantClient(tid);
  return {
    async listThreads(tid, siteId) {
      const { data, error } = await (await tc(tid))
        .from("site_comment_threads")
        .select(THREAD_COLS)
        .eq("site_id", siteId)
        .order("created_at", { ascending: false })
        .limit(MAX_THREADS_PER_SITE);
      if (error) throw new Error(error.message);
      return ((data ?? []) as ThreadRow[]).reverse();
    },
    async listComments(tid, threadIds) {
      if (threadIds.length === 0) return [];
      const { data, error } = await (await tc(tid))
        .from("site_comments")
        .select(COMMENT_COLS)
        .in("thread_id", threadIds)
        .order("created_at", { ascending: true })
        .limit(5000);
      if (error) throw new Error(error.message);
      return (data ?? []) as CommentRow[];
    },
    async getThread(tid, id) {
      const { data, error } = await (await tc(tid)).from("site_comment_threads").select(THREAD_COLS).eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as ThreadRow | null;
    },
    async createThread(tid, row) {
      const { data, error } = await (await tc(tid))
        .from("site_comment_threads")
        .insert({ ...row })
        .select(THREAD_COLS)
        .single();
      if (error || !data) throw new Error(error?.message ?? "insert failed");
      return data as ThreadRow;
    },
    async deleteThread(tid, id) {
      await (await tc(tid)).from("site_comment_threads").delete().eq("id", id);
    },
    async addComment(tid, row) {
      const { data, error } = await (await tc(tid))
        .from("site_comments")
        .insert({ ...row })
        .select(COMMENT_COLS)
        .single();
      if (error || !data) throw new Error(error?.message ?? "insert failed");
      return data as CommentRow;
    },
    async setStatus(tid, id, status) {
      const { data, error } = await (await tc(tid))
        .from("site_comment_threads")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select(THREAD_COLS)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as ThreadRow | null;
    },
  };
}
