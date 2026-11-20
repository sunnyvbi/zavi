import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { getBoolSetting } from "@/services/settings";
import type { SiteRow, SiteStore } from "@/services/sites/contract";
import { isVisibleSite } from "@/services/sites/site-build-status";
import { siteIdFromEditsApp } from "@/services/sites/site-inline-edits";
import { isSafeSelector } from "./website-edits";
import {
  SITE_COMMENTS_SETTING,
  checkMentions,
  cleanAnchorText,
  cleanBody,
  cleanPagePath,
  cleanRel,
  cleanSection,
  isThreadStatus,
  isUuid,
  mentionRecipients,
  realSiteCommentStore,
  renderMentionEmail,
  sendMentionEmails,
  type CommentRow,
  type SiteCommentStore,
  type ThreadRow,
} from "@/services/sites/site-comments";

const WRITE_ROLES = ["owner", "admin", "member"] as const;

export type MentionNotice = {
  tenant_id: string;
  site: SiteRow;
  thread: ThreadRow;
  comment: CommentRow;
  recipients: string[];
};

export type SiteCommentDeps = {
  sites: Pick<SiteStore, "get">;
  enabled: (tenant_id: string) => Promise<boolean>;
  store: SiteCommentStore;
  members: (auth: AuthedRequest) => Promise<string[]>;
  notify: (n: MentionNotice) => Promise<void>;
};

export function realSiteCommentDeps(): SiteCommentDeps {
  return {
    sites: {
      get: async (tid, id) => (await import("@/services/sites/store")).siteStore().get(tid, id),
    },
    enabled: (tid) => getBoolSetting(SITE_COMMENTS_SETTING, tid),
    store: realSiteCommentStore(),
    members: async (auth) => {
      const { tenantClient } = await import("@/services/tenant-client");
      const { data, error } = await tenantClient(auth.tenant_id).from("tenant_users").select("user_id");
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
    },
    notify: async (n) => {
      if (!process.env.SYSTEM_SENDGRID_API_KEY) return;
      const [{ sgSend, resolveMemberEmail }, { renderEmail, webOrigin }] = await Promise.all([
        import("@/email/sendAuthEmail"),
        import("@/email/theme"),
      ]);
      const mail = renderMentionEmail({
        siteLabel: n.site.label,
        pagePath: n.thread.page_path,
        body: n.comment.body,
        link: `${webOrigin()}/workspace`,
        render: (p) => renderEmail({ ...p, kicker: "Comments", footerVariant: "neutral" }),
      });
      await sendMentionEmails(n.recipients, n.comment.author_id, mail, {
        emailFor: resolveMemberEmail,
        send: (to, m) => sgSend(to, m.subject, m.html, m.text),
      });
    },
  };
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

type Ctx = { auth: AuthedRequest; site: SiteRow };

async function siteFor(req: Request, res: Response, deps: SiteCommentDeps, appId: unknown, write: boolean): Promise<Ctx | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (write && !(await requireTenantRole(auth, WRITE_ROLES, res))) return null;
  const tid = auth.tenant_id;
  if (!(await deps.enabled(tid).catch(() => false))) {
    refuse(res, 403, "feature_disabled", "Comments are off for this workspace.");
    return null;
  }
  const siteId = siteIdFromEditsApp(appId);
  if (!siteId) {
    refuse(res, 400, "not_a_site", "app_id must name a site (site:<id>).");
    return null;
  }
  let site: SiteRow | null;
  try {
    site = await deps.sites.get(tid, siteId);
  } catch {
    refuse(res, 503, "site_unreadable", "We couldn't read this site. Try again.");
    return null;
  }
  if (!site || site.tenant_id !== tid || site.id !== siteId || !isVisibleSite(site)) {
    refuse(res, 403, "not_your_app", "this site is not registered to your workspace");
    return null;
  }
  return { auth, site };
}

async function threadFor(ctx: Ctx, deps: SiteCommentDeps, res: Response, id: unknown): Promise<ThreadRow | null> {
  if (!isUuid(id)) {
    refuse(res, 404, "not_found", "That comment thread doesn't exist.");
    return null;
  }
  let thread: ThreadRow | null;
  try {
    thread = await deps.store.getThread(ctx.auth.tenant_id, id);
  } catch {
    refuse(res, 503, "comments_unreadable", "We couldn't read comments right now. Try again.");
    return null;
  }
  if (!thread || thread.tenant_id !== ctx.auth.tenant_id || thread.site_id !== ctx.site.id) {
    refuse(res, 404, "not_found", "That comment thread doesn't exist.");
    return null;
  }
  return thread;
}

export function publicComment(c: CommentRow) {
  return { id: c.id, author_id: c.author_id, body: c.body, mentions: c.mentions ?? [], created_at: c.created_at };
}

export function publicThread(t: ThreadRow, comments: CommentRow[]) {
  return {
    id: t.id,
    page_path: t.page_path,
    selector: t.selector,
    section: t.section,
    anchor_text: t.anchor_text,
    rel_x: t.rel_x,
    rel_y: t.rel_y,
    status: t.status,
    sent_run_id: t.sent_run_id,
    created_by: t.created_by,
    created_at: t.created_at,
    updated_at: t.updated_at,
    comments: comments.map(publicComment),
  };
}

async function mentionsFor(ctx: Ctx, deps: SiteCommentDeps, res: Response, raw: unknown): Promise<string[] | null> {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return [];
  let members: string[];
  try {
    members = await deps.members(ctx.auth);
  } catch {
    refuse(res, 503, "members_unreadable", "We couldn't check your team right now. Try again.");
    return null;
  }
  const check = checkMentions(raw, members);
  if (!check.ok) {
    refuse(
      res,
      400,
      check.code,
      check.code === "mention_not_member" ? "You can only mention members of this workspace." : "Those mentions aren't valid.",
    );
    return null;
  }
  return check.ids;
}

async function notifyQuietly(deps: SiteCommentDeps, ctx: Ctx, thread: ThreadRow, comment: CommentRow): Promise<void> {
  const recipients = mentionRecipients(comment.mentions ?? [], ctx.auth.user_id);
  if (recipients.length === 0) return;
  try {
    await deps.notify({ tenant_id: ctx.auth.tenant_id, site: ctx.site, thread, comment, recipients });
  } catch {
    return;
  }
}

export async function handleListSiteComments(req: Request, res: Response, deps: SiteCommentDeps): Promise<void> {
  const ctx = await siteFor(req, res, deps, req.query?.app_id, false);
  if (!ctx) return;
  try {
    const threads = (await deps.store.listThreads(ctx.auth.tenant_id, ctx.site.id)).filter(
      (t) => t.tenant_id === ctx.auth.tenant_id && t.site_id === ctx.site.id,
    );
    const ids = new Set(threads.map((t) => t.id));
    const comments = (await deps.store.listComments(ctx.auth.tenant_id, [...ids])).filter(
      (c) => c.tenant_id === ctx.auth.tenant_id && ids.has(c.thread_id),
    );
    const byThread = new Map<string, CommentRow[]>();
    for (const c of comments) byThread.set(c.thread_id, [...(byThread.get(c.thread_id) ?? []), c]);
    res.json({ me: ctx.auth.user_id, threads: threads.map((t) => publicThread(t, byThread.get(t.id) ?? [])) });
  } catch {
    refuse(res, 503, "comments_unreadable", "We couldn't read comments right now. Try again.");
  }
}

export async function handleCreateSiteComment(req: Request, res: Response, deps: SiteCommentDeps): Promise<void> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ctx = await siteFor(req, res, deps, b.app_id, true);
  if (!ctx) return;
  if (!isSafeSelector(b.selector)) return refuse(res, 400, "bad_selector", "That element can't be commented on.");
  const page_path = cleanPagePath(b.page_path);
  if (!page_path) return refuse(res, 400, "bad_path", "That page can't be commented on.");
  const body = cleanBody(b.body);
  if (!body) return refuse(res, 400, "bad_body", "Write a comment of up to 2000 characters.");
  const mentions = await mentionsFor(ctx, deps, res, b.mentions);
  if (!mentions) return;
  const tid = ctx.auth.tenant_id;
  let thread: ThreadRow;
  try {
    thread = await deps.store.createThread(tid, {
      site_id: ctx.site.id,
      page_path,
      selector: (b.selector as string).trim(),
      section: cleanSection(b.section),
      anchor_text: cleanAnchorText(b.anchor_text),
      rel_x: cleanRel(b.rel_x),
      rel_y: cleanRel(b.rel_y),
      created_by: ctx.auth.user_id,
    });
  } catch {
    return refuse(res, 503, "comment_not_saved", "Your comment wasn't saved. Try again.");
  }
  let comment: CommentRow;
  try {
    comment = await deps.store.addComment(tid, { thread_id: thread.id, author_id: ctx.auth.user_id, body, mentions });
  } catch {
    await deps.store.deleteThread(tid, thread.id).catch(() => undefined);
    return refuse(res, 503, "comment_not_saved", "Your comment wasn't saved. Try again.");
  }
  await notifyQuietly(deps, ctx, thread, comment);
  res.status(201).json({ thread: publicThread(thread, [comment]) });
}

export async function handleReplySiteComment(req: Request, res: Response, deps: SiteCommentDeps): Promise<void> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ctx = await siteFor(req, res, deps, b.app_id, true);
  if (!ctx) return;
  const thread = await threadFor(ctx, deps, res, req.params?.id);
  if (!thread) return;
  const body = cleanBody(b.body);
  if (!body) return refuse(res, 400, "bad_body", "Write a reply of up to 2000 characters.");
  const mentions = await mentionsFor(ctx, deps, res, b.mentions);
  if (!mentions) return;
  let comment: CommentRow;
  try {
    comment = await deps.store.addComment(ctx.auth.tenant_id, { thread_id: thread.id, author_id: ctx.auth.user_id, body, mentions });
  } catch {
    return refuse(res, 503, "comment_not_saved", "Your reply wasn't saved. Try again.");
  }
  await notifyQuietly(deps, ctx, thread, comment);
  res.status(201).json({ comment: publicComment(comment) });
}

export async function handleSetSiteCommentStatus(req: Request, res: Response, deps: SiteCommentDeps): Promise<void> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ctx = await siteFor(req, res, deps, b.app_id, true);
  if (!ctx) return;
  if (!isThreadStatus(b.status)) return refuse(res, 400, "bad_status", "Status must be open, resolved or sent.");
  const thread = await threadFor(ctx, deps, res, req.params?.id);
  if (!thread) return;
  let next: ThreadRow | null;
  try {
    next = await deps.store.setStatus(ctx.auth.tenant_id, thread.id, b.status);
  } catch {
    return refuse(res, 503, "comment_not_saved", "That change wasn't saved. Try again.");
  }
  if (!next) return refuse(res, 404, "not_found", "That comment thread doesn't exist.");
  res.json({ thread: { id: next.id, status: next.status, updated_at: next.updated_at } });
}

export const siteCommentsMutationLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.auth?.tenant_id ? `t:${req.auth.tenant_id}:${req.auth.user_id}` : `ip:${req.ip ?? "unknown"}`),
  handler: (_req: Request, res: Response) =>
    res.status(429).json({ error: { code: "rate_limited", message: "Too many comments; slow down." } }),
});

export async function listSiteComments(req: Request, res: Response): Promise<void> {
  await handleListSiteComments(req, res, realSiteCommentDeps());
}

export async function createSiteComment(req: Request, res: Response): Promise<void> {
  await handleCreateSiteComment(req, res, realSiteCommentDeps());
}

export async function replySiteComment(req: Request, res: Response): Promise<void> {
  await handleReplySiteComment(req, res, realSiteCommentDeps());
}

export async function setSiteCommentStatus(req: Request, res: Response): Promise<void> {
  await handleSetSiteCommentStatus(req, res, realSiteCommentDeps());
}
