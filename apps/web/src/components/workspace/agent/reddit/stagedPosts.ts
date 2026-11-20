import type { ActionItem } from "../../actions/types";
import { redditPublishTarget, THREAD_RE } from "../../actions/platforms/_shared";
import { stagedCardsFromPayload } from "../xStagedPosts";
import type { XDraft } from "../XAgentDashboard";
import { REDDIT_ORGANIC_SLUG } from "@/lib/agentRegistry";

function parentKey(value: string): string | null {
  if (!THREAD_RE.test(value)) return null;
  const parts = new URL(value).pathname.split("/").filter(Boolean);
  return `${parts[1].toLowerCase()}/${parts[3].toLowerCase()}/${(parts[5] ?? "").toLowerCase()}`;
}

export function redditDraftMatchesAction(draft: XDraft, action: ActionItem): boolean {
  const target = redditPublishTarget(action);
  if (typeof target === "string" || draft.channel !== target.channel) return false;
  if (target.channel === "reddit_comment") {
    const draftParent = parentKey(draft.thread_url ?? "");
    return draftParent !== null && draftParent === parentKey(target.fields.thread_url);
  }
  return draft.subreddit?.replace(/^\/?r\//i, "").toLowerCase() === target.fields.subreddit.toLowerCase()
    && draft.title === target.fields.title;
}

export function redditStagedCards(payload: unknown, actions: ActionItem[]): ActionItem[] {
  const drafts = new Map(((payload as { drafts?: XDraft[] } | null)?.drafts ?? []).map((d) => [d.decision_id, d]));
  return stagedCardsFromPayload(payload, actions, redditDraftMatchesAction).map((card) => {
    const d = drafts.get(card.id);
    if (!d) return card;
    const reply = d.channel === "reddit_comment";
    const presentation = reply
      ? { type: "reddit_reply", thread_url: d.thread_url }
      : { type: "reddit_post", subreddit: d.subreddit, title: d.title, post_type: "text" };
    return {
      ...card,
      channel_slug: REDDIT_ORGANIC_SLUG,
      title: reply ? "Reply on Reddit" : (d.title ?? card.title),
      action_type: reply ? "reply" : card.action_type,
      body: { ...card.body, step: { ...card.body.step, deliverable: { ...card.body.step?.deliverable, presentation } } },
    } as ActionItem;
  });
}
