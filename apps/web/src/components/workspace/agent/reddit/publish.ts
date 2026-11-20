import { apiFetch } from "@/lib/api";
import { approveDecision, type ApproveExtras } from "@/lib/approvals/approveDecision";
import { setChannelAction } from "@/lib/workspace/channelActionsApi";
import { REDDIT_ORGANIC_SLUG } from "@/lib/agentRegistry";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { postContent, type ActionItem } from "../../actions/types";
import { redditPublishBlocked, redditPublishTarget, type RedditPublishTarget } from "../../actions/platforms/_shared";
import { publishPost, stagedCardProposal, stagedProposalFor } from "../xStagedPosts";
import { redditDraftMatchesAction } from "./stagedPosts";
import type { XDraft } from "../XAgentDashboard";

const UNCONFIRMED = "Zavi could not confirm whether Reddit posted it. Check your Reddit account before trying again.";

export class RedditDeliveryUnconfirmed extends Error {
  constructor(readonly decisionId: string, message = UNCONFIRMED) {
    super(message);
  }
}

export class RedditDeliveryRefused extends Error {
  constructor(readonly decisionId: string, message: string) { super(message); }
}

export class RedditApprovalRequired extends Error {
  constructor(readonly decisionId: string) { super("This draft still needs approval. Review it, then approve it again."); }
}

export type RedditDelivery = { decisionId: string; status: "published" | "scheduled" };
export type RedditSubmitOptions = {
  ownProposal?: boolean;
  publishNow?: boolean;
  onDecision?: (decisionId: string) => void;
  staged?: XDraft;
  approvePending?: boolean;
};

const REFUSED_COPY: Record<string, string> = {
  disconnected: "Reddit did not post it: your Reddit account is no longer connected. Reconnect Reddit, then try again.",
  reconnect_required: "Reddit did not post it: reconnect Reddit, then try again.",
  unauthorized_destination: "Reddit did not post it: your account can no longer post there. The community may be private, restricted or banned, or the thread locked or removed.",
  vendor_rejected: "Reddit refused it. The thread may be locked or removed, or the community's rules or Reddit's limits stopped it. Check Reddit before trying again.",
  channel_disabled: "Nothing was posted: Reddit posting is switched off in Zavi.",
  snapshot_changed: "Nothing was posted: the reply changed after it was approved.",
  social_publish_paused: "Nothing was posted: Reddit posting is switched off in Zavi.",
};
const REFUSED_DEFAULT = "Reddit did not post it. Check Reddit before trying again.";
const NOT_SENT = "Nothing was posted: Zavi could not send it to Reddit. Check that Reddit is still connected, then try again.";
const ALREADY_APPROVED = new Set(["approved", "dispatching", "acted", "dispatch_failed"]);

function refusedCopy(code: string | null | undefined): string | null {
  if (!code) return null;
  if (/publishing isn't enabled/i.test(code)) return REFUSED_COPY.social_publish_paused;
  const known = Object.keys(REFUSED_COPY).find((key) => new RegExp(`(^|[^a-z_])${key}($|[^a-z_])`).test(code));
  return known ? REFUSED_COPY[known] : null;
}

async function approvedElsewhere(res: Response): Promise<boolean> {
  const body = (await res.clone().json().catch(() => null)) as { error?: { code?: unknown; status?: unknown } } | null;
  return body?.error?.code === "decision_closed" && typeof body.error.status === "string" && ALREADY_APPROVED.has(body.error.status);
}

async function refusalMessage(res: Response): Promise<string> {
  const body = (await res.clone().json().catch(() => null)) as { error?: { message?: unknown } | string } | null;
  const err = body?.error;
  const message = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : null;
  return message ? `Nothing was posted: ${message}` : "Nothing was posted: Zavi refused this approval. Check the draft, then try again.";
}

export async function redditDeliveryStatus(decisionId: string, attempts = 20): Promise<RedditDelivery> {
  try {
    const db = createBrowserSupabase();
    const tenantId = await getActiveTenantId(db);
    if (!tenantId) throw new RedditDeliveryUnconfirmed(decisionId);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { data, error } = await db
        .from("social_posts")
        .select("status,last_error")
        .eq("tenant_id", tenantId)
        .eq("decision_id", decisionId)
        .maybeSingle();
      if (error) throw new RedditDeliveryUnconfirmed(decisionId);
      if (data?.status === "published" || data?.status === "scheduled") return { decisionId, status: data.status };
      if (data?.status === "failed" && data.last_error === "transient_exhausted") throw new RedditDeliveryUnconfirmed(decisionId);
      if (data?.status === "failed" || data?.status === "cancelled") {
        throw new RedditDeliveryRefused(decisionId, refusedCopy(data.last_error) || REFUSED_DEFAULT);
      }
      if (!data) {
        const decision = await db.from("decisions").select("status,dispatch_error")
          .eq("tenant_id", tenantId).eq("id", decisionId).maybeSingle();
        if (decision.error) throw new RedditDeliveryUnconfirmed(decisionId);
        const row = decision.data as { status?: string; dispatch_error?: string | null } | null;
        const status = row?.status;
        if (status === "dispatch_failed" || status === "failed" || status === "rejected") throw new RedditDeliveryRefused(decisionId, refusedCopy(row?.dispatch_error) ?? NOT_SENT);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new RedditDeliveryUnconfirmed(decisionId);
  } catch (error) {
    if (error instanceof RedditDeliveryUnconfirmed || error instanceof RedditDeliveryRefused) throw error;
    throw new RedditDeliveryUnconfirmed(decisionId);
  }
}

export async function submitToReddit(
  action: ActionItem,
  content: { text: string; post_revision?: string },
  opts: RedditSubmitOptions = {},
): Promise<RedditDelivery> {
  const { ownProposal = true, publishNow = false } = opts;
  const blocked = redditPublishBlocked(action, content.text);
  if (blocked) throw new Error(blocked);
  const target = redditPublishTarget(action) as RedditPublishTarget;
  let proposal = opts.staged ?? (ownProposal ? stagedCardProposal(action, target.channel) : null);
  if (!proposal) {
    const res = await apiFetch("/api/agents/reddit_organic/dashboard");
    if (!res.ok) throw new Error("Zavi could not check what is already waiting to post. Try again.");
    proposal = stagedProposalFor(await res.json(), postContent({ ...action, edited_body: null }).text, {
      exact: true,
      matches: (draft) => redditDraftMatchesAction(draft, action),
    });
    if (proposal) proposal = { ...proposal, post_revision: action.post_revision };
  }
  const decisionId = await publishPost({
    channel: proposal?.channel ?? target.channel,
    staged: proposal,
    content: { ...content, thread: null },
    extra: target.fields,
    platform: "Reddit",
    publishNow,
    approve: async (id: string, extras?: ApproveExtras) => {
      opts.onDecision?.(id);
      let approved: Response | null;
      try {
        approved = extras ? await approveDecision(id, extras) : await approveDecision(id);
      } catch {
        throw new RedditDeliveryUnconfirmed(id);
      }
      if (approved && approved.status === 409 && await approvedElsewhere(approved)) return new Response(null, { status: 200 });
      if (approved && (approved.status >= 500 || approved.status === 409)) throw new RedditDeliveryUnconfirmed(id);
      if (approved && approved.status >= 400) throw new RedditDeliveryRefused(id, await refusalMessage(approved));
      return approved;
    },
  });
  return redditDeliveryStatus(decisionId);
}

export async function resumeRedditSubmission(
  decisionId: string, action: ActionItem, content: { text: string; post_revision?: string }, options: RedditSubmitOptions,
): Promise<RedditDelivery> {
  const db = createBrowserSupabase();
  const tenantId = await getActiveTenantId(db);
  if (!tenantId) throw new RedditDeliveryUnconfirmed(decisionId);
  const { data, error } = await db.from("decisions").select("status,body")
    .eq("tenant_id", tenantId).eq("id", decisionId).maybeSingle();
  if (error || data?.status !== "proposed") throw new RedditDeliveryUnconfirmed(decisionId);
  if (!options.approvePending) throw new RedditApprovalRequired(decisionId);
  const body = data.body as { channel?: string; payload?: Record<string, unknown>; scheduled_at?: string | null } | null;
  const target = redditPublishTarget(action);
  if (typeof target === "string" || body?.channel !== target.channel) throw new RedditDeliveryUnconfirmed(decisionId);
  const original = stagedCardProposal({ ...action, id: decisionId, run_id: null }, target.channel);
  if (!original) throw new RedditDeliveryUnconfirmed(decisionId);
  const payload = body.payload ?? {};
  const staged: XDraft = {
    ...original,
    text: typeof payload.text === "string" ? payload.text : "",
    scheduled_at: body.scheduled_at ?? null,
    thread_url: typeof payload.thread_url === "string" ? payload.thread_url : undefined,
    subreddit: typeof payload.subreddit === "string" ? payload.subreddit : undefined,
    title: typeof payload.title === "string" ? payload.title : undefined,
  };
  if (!redditDraftMatchesAction(staged, action)) throw new RedditDeliveryUnconfirmed(decisionId);
  return submitToReddit(action, content, { ...options, staged });
}

export async function publishToReddit(action: ActionItem, content: { text: string; post_revision?: string }, ownProposal = true): Promise<boolean> {
  const { publishRedditAction } = await import("./redditPublishCoordinator");
  const delivery = await publishRedditAction(action, content, { ownProposal });
  if (delivery.status === "scheduled") throw new Error("Scheduled on Reddit. It has not been posted yet; check again later.");
  return true;
}

export function redditPublishKey(action: ActionItem): string {
  const target = redditPublishTarget(action);
  if (typeof target === "string") return `item:${action.id}`;
  if (target.channel === "reddit_comment") {
    const parts = new URL(target.fields.thread_url).pathname.split("/").filter(Boolean);
    return JSON.stringify(["reply-source", action.id, parts[1]?.toLowerCase(), parts[3]?.toLowerCase(), parts[5]?.toLowerCase() ?? "", postContent({ ...action, edited_body: null }).text.trim()]);
  }
  return `post:${action.id}`;
}

export function redditPublishViewAlias(key: string): string {
  if (!key.startsWith('["reply-source",')) return key;
  const parts: unknown[] = JSON.parse(key);
  return JSON.stringify(["reply", ...parts.slice(2)]);
}

export function redditPublishTargetKey(action: ActionItem, text: string): string {
  const target = redditPublishTarget(action);
  if (typeof target === "string") return redditPublishKey(action);
  if (target.channel === "reddit_comment") {
    const parts = new URL(target.fields.thread_url).pathname.split("/").filter(Boolean);
    return JSON.stringify(["reply", parts[1]?.toLowerCase(), parts[3]?.toLowerCase(), parts[5]?.toLowerCase() ?? "", text.trim()]);
  }
  return JSON.stringify([target.fields.subreddit.toLowerCase(), target.fields.title, text]);
}

function redditItem(id: string, title: string, actionType: ActionItem["action_type"], body: ActionItem["body"]): ActionItem {
  return {
    id, channel_slug: REDDIT_ORGANIC_SLUG, run_id: null, position: 0, run_of: 1,
    blocking: false, action_type: actionType, title,
    body, status: "pending", note: null, snoozed_until: null,
    impact: null, impact_reason: null, score: 0, score_inputs: {}, proposed_at: "",
    repeat_of: null, redo_of: null, source: "channel_action", executable: false,
    exec_status: null, edited_body: null,
  };
}

export function redditReplyItem(id: string, threadUrl: string, text: string, ruleStatus?: string | null): ActionItem {
  const presentation = { type: "reddit_reply", thread_url: threadUrl, ...(ruleStatus ? { rule_status: ruleStatus } : {}) };
  return redditItem(id, "Reply to this thread", "reply", {
    step: { deliverable: { kind: "reply", content: text, presentation } },
    link: threadUrl,
  });
}

export function redditPostItem(
  id: string,
  post: { subreddit: string; title: string; text: string; post_type?: string; required_flair?: string; rule_status?: string },
): ActionItem {
  const presentation = {
    type: "reddit_post",
    subreddit: post.subreddit,
    title: post.title,
    post_type: post.post_type ?? "text",
    rule_status: post.rule_status,
    required_flair: post.required_flair,
  };
  return redditItem(id, post.title, "text_post", { step: { body: post.text, deliverable: { kind: "post", content: post.text, presentation } } });
}

export async function closeRedditSuggestionManually(id: string, source?: "channel_action" | "decision"): Promise<string | null> {
  const failed = "Marked as posted, but Zavi could not close this card. Refresh to check it.";
  try {
    if (source === "channel_action") {
      await setChannelAction(id, { action: "acted" });
      return null;
    }
    const res = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/archive`, { method: "POST" });
    return res.ok ? null : failed;
  } catch {
    return failed;
  }
}

export async function markRedditSuggestionPosted(id: string, source?: "channel_action" | "decision"): Promise<string | null> {
  const failed = "Posted to Reddit, but Zavi could not mark this card as done. Refresh before posting again.";
  try {
    if (source === "channel_action") {
      await setChannelAction(id, { action: "acted" });
      return null;
    }
    const res = await approveDecision(id);
    return res?.ok ? null : failed;
  } catch {
    return failed;
  }
}
