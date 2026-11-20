
import { apiFetch } from "@/lib/api";
import { approveDecision, type ApproveExtras } from "@/lib/approvals/approveDecision";
import { ApiError, type ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { postContent } from "../actions/types";
import { xCheckToView, xDraftToView } from "./cardViews";
import { pairedPostCard } from "./pairedPostCard";
import type { XAttention, XDraft, XPayload } from "./XAgentDashboard";

export function copyKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function sameCopy(a: string, b: string): boolean {
  const x = copyKey(a);
  const y = copyKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function attentionActionId(a: XAttention): string | null {
  if (a.decision_id) return a.decision_id;
  return a.key.startsWith("step:") ? a.key.slice("step:".length) : null;
}

export type XPanelSections = {
  cards: ChannelActionView[];
  attention: XAttention[];
  stagedFor: Map<string, XDraft>;
  stagedCardIds: Set<string>;
};

export function xPanelSections(args: {
  switched: boolean;
  drafts: XDraft[];
  attention: XAttention[];
  channelActions: ChannelActionView[];
  matchesDraft?: (draft: XDraft, action: ChannelActionView) => boolean;
}): XPanelSections {
  const { switched, drafts, attention, channelActions, matchesDraft } = args;
  if (!switched) {
    return {
      cards: drafts.map((d) => xDraftToView(d)),
      attention,
      stagedFor: new Map(),
      stagedCardIds: new Set(),
    };
  }

  const staged = drafts.filter((d) => d.source === "staged");
  const stagedFor = new Map<string, XDraft>();
  const paired = new Set<string>();
  for (const a of channelActions) {
    const text = postContent({ ...a, edited_body: null }).text;
    if (!text) continue;
    const hit = staged.find((s) => !paired.has(s.decision_id) && sameCopy(s.original_text ?? s.text, text) && (!matchesDraft || matchesDraft(s, a)));
    if (!hit) continue;
    stagedFor.set(a.id, hit);
    paired.add(hit.decision_id);
  }

  const loose = staged.filter((s) => !paired.has(s.decision_id));
  for (const s of loose) stagedFor.set(s.decision_id, s);
  const cards = [...loose.map((d) => xDraftToView(d)), ...channelActions.map((action) => { const staged = stagedFor.get(action.id); return staged ? pairedPostCard(action, staged) : action; })];

  const cardIds = new Set(cards.map((c) => c.id));
  const kept = attention.filter((row) => {
    if (row.mode === "approval") return false;
    const id = attentionActionId(row);
    return !id || !cardIds.has(id);
  });

  return { cards, attention: kept, stagedFor, stagedCardIds: new Set(loose.map((l) => l.decision_id)) };
}

export async function publishPost(args: {
  channel: string;
  staged: XDraft | null;
  content: { text: string; thread: string[] | null; image_path?: string; post_revision?: string };
  extra?: Record<string, string>;
  platform?: string;
  publishNow?: boolean;
  approve?: (decisionId: string, extras?: ApproveExtras) => Promise<Response | null>;
}): Promise<string> {
  const { channel, staged, content, extra: fields, platform = "X", publishNow = false } = args;
  const thread = content.thread?.length ? content.thread : undefined;

  let decisionId: string;
  let extras: ApproveExtras | null = null;
  if (staged) {
    decisionId = staged.decision_id;
    const sameText = staged.text === content.text;
    const sameThread = (staged.thread ?? []).join("\n") === (content.thread ?? []).join("\n");
    if (!sameText || !sameThread) extras = { payload_text: content.text, thread: content.thread ?? null };
    if (content.image_path) extras = { ...extras, image_path: content.image_path };
    if (publishNow) extras = { ...extras, scheduled_at: null };
    const revision = content.post_revision ?? staged.post_revision;
    if (revision) extras = { ...extras, expected_post_revision: revision };
  } else {
    const res = await apiFetch("/api/social/propose", {
      method: "POST",
      body: JSON.stringify({ channel: content.image_path && channel === "x" ? "x_image" : content.image_path && channel === "linkedin" ? "linkedin_image" : channel, payload: { ...fields, text: content.text, ...(content.image_path ? { image_path: content.image_path } : {}), ...(thread ? { thread } : {}) } }),
      idempotent: true,
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; decision_id?: string; existing?: boolean; status?: string };
    if (!res.ok || !body.decision_id) throw new ApiError(body.error?.message ?? "Could not stage the post.", res.status, body);
    decisionId = body.decision_id;
    if (body.existing && body.status !== "proposed") return decisionId;
    if (body.existing && publishNow) extras = { scheduled_at: null };
  }

  const approve = args.approve ?? approveDecision;
  const approved = extras ? await approve(decisionId, extras) : await approve(decisionId);
  if (!approved) throw new Error("Nothing was posted.");
  if (!approved.ok) {
    const body = (await approved.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `${platform} did not take the post. Try again.`);
  }
  return decisionId;
}

export function stagedProposalFor(payload: unknown, text: string, opts?: { exact?: boolean; matches?: (draft: XDraft) => boolean }): XDraft | null {
  if ((payload as { drafts_ok?: unknown } | null)?.drafts_ok === false) {
    throw new Error("Zavi could not check what is already waiting to post. Try again.");
  }
  const drafts = (payload as { drafts?: unknown } | null)?.drafts;
  if (!Array.isArray(drafts) || !text.trim()) return null;
  const staged = (drafts as XDraft[]).filter((d) => d && d.source === "staged" && typeof d.text === "string");
  const key = copyKey(text);
  return staged.find((d) => (opts?.exact ? copyKey(d.original_text ?? d.text) === key : sameCopy(d.original_text ?? d.text, text)) && (!opts?.matches || opts.matches(d))) ?? null;
}

export function stagedCardProposal(action: ChannelActionView, channel: string): XDraft | null {
  if (action.run_id !== null && !action.staged_draft_id) return null;
  const original = postContent({ ...action, edited_body: null });
  return {
    decision_id: action.staged_draft_id ?? action.id,
    post_revision: action.post_revision,
    source: "staged",
    label: null,
    needs_confirm: false,
    channel,
    text: original.text,
    thread: original.thread,
    image_path: null,
    video_path: null,
    scheduled_at: null,
    rationale: null,
    emitted_at: null,
  };
}

export function stagedCardsFromPayload(payload: unknown, actions: ChannelActionView[], matchesDraft?: (draft: XDraft, action: ChannelActionView) => boolean): ChannelActionView[] {
  const d = (payload ?? null) as XPayload | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.drafts)) return [];
  const now = new Date().toISOString();
  const { cards, attention } = xPanelSections({
    switched: true,
    drafts: d.drafts,
    attention: Array.isArray(d.attention) ? d.attention : [],
    channelActions: actions,
    matchesDraft,
  });
  return [
    ...cards.filter((card) => !d.drafts.some((draft) => draft.decision_id === card.id && draft.snoozed_until && draft.snoozed_until > now)),
    ...attention.filter((a) => a.status !== "done").map((a) => xCheckToView(a)),
  ];
}
