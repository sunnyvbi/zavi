import type { ActionItem } from "../../actions/types";
import {
  RedditApprovalRequired, RedditDeliveryRefused, RedditDeliveryUnconfirmed, redditDeliveryStatus, redditPublishKey, redditPublishTargetKey,
  resumeRedditSubmission, submitToReddit, type RedditDelivery,
} from "./publish";
import {
  readRedditPublishState, redditPublishLockName, restoreRedditPublishStates,
  verifyRedditPublishStorage, writeRedditPublishState, writeRedditPublishStates, REDDIT_PUBLISH_IDLE, type RedditPublishState,
} from "./redditPublishStore";

type PublishOptions = { ownProposal?: boolean; publishNow?: boolean; beforeSubmit?: () => Promise<void> };
const pending = new Map<string, Promise<RedditDelivery>>();
const DIFFERENT_TEXT = "A different version of this draft was already submitted. This edit was not posted. Check Reddit before making another reply.";

export async function publishRedditAction(
  action: ActionItem,
  content: { text: string; post_revision?: string },
  options: PublishOptions = {},
): Promise<RedditDelivery> {
  const key = redditPublishKey(action);
  await restoreRedditPublishStates();
  const sourceKey = `source:${action.action_type}:${action.id}`;
  const requestKey = redditPublishLockName(sourceKey);
  const lockName = redditPublishLockName(`target:${redditPublishTargetKey(action, content.text)}`);
  const existing = pending.get(requestKey);
  if (existing) {
    const delivery = await existing;
    const submitted = readRedditPublishState(sourceKey);
    if (submitted.targetKey && submitted.targetKey !== redditPublishTargetKey(action, content.text)) {
      throw new RedditDeliveryUnconfirmed(delivery.decisionId, DIFFERENT_TEXT);
    }
    return delivery;
  }
  if (!navigator.locks) throw new Error("Reddit posting is unavailable in this browser. Try another browser.");
  const request = navigator.locks.request(requestKey, () => navigator.locks.request(lockName, async () => {
    verifyRedditPublishStorage();
    const source = readRedditPublishState(sourceKey);
    const original = source.decisionId ? source : readRedditPublishState(key);
    const target = action.action_type === "reply" ? readRedditPublishState(redditPublishTargetKey(action, content.text)) : original;
    const saved = original.decisionId && !(original.status === "refused" && target.decisionId && target.status !== "refused") ? original : target;
    const aliases = new Set([sourceKey, key]);
    let targetKey = saved.decisionId && saved.status !== "refused"
      ? saved.targetKey
      : redditPublishTargetKey(action, content.text);
    if (targetKey && action.action_type === "reply") aliases.add(targetKey);
    if (saved.decisionId && saved.status !== "refused") aliases.add(redditPublishKey({ ...action, id: saved.decisionId }));
    const transition = (state: RedditPublishState, persist = true) => writeRedditPublishStates(aliases, { ...state, ...(targetKey ? { targetKey } : {}) }, persist);
    const verifySubmittedText = (decisionId: string) => {
      if (targetKey && targetKey !== redditPublishTargetKey(action, content.text)) {
        throw new RedditDeliveryUnconfirmed(decisionId, DIFFERENT_TEXT);
      }
    };
    if (saved.status === "posted" && saved.decisionId) {
      verifySubmittedText(saved.decisionId);
      transition(saved);
      return { status: "published" as const, decisionId: saved.decisionId };
    }
    transition({ status: "posting", error: null, decisionId: saved.decisionId });
    const remember = (decisionId: string) => {
      try {
        const submittedTarget = redditPublishTargetKey(action, content.text);
        if (targetKey && action.action_type === "reply" && targetKey !== submittedTarget) {
          aliases.delete(targetKey);
          writeRedditPublishState(targetKey, REDDIT_PUBLISH_IDLE);
        }
        targetKey = submittedTarget;
        if (targetKey && action.action_type === "reply") aliases.add(targetKey);
        aliases.add(redditPublishKey({ ...action, id: decisionId }));
        transition({ status: "posting", error: null, decisionId });
      } catch {
        throw new RedditDeliveryUnconfirmed(decisionId);
      }
    };
    try {
      let delivery: RedditDelivery;
      if (saved.decisionId && saved.status !== "refused") {
        try {
          delivery = await redditDeliveryStatus(saved.decisionId, 1);
        } catch (error) {
          if (!(error instanceof RedditDeliveryUnconfirmed)) throw error;
          if (saved.status === "approval_required") await options.beforeSubmit?.();
          delivery = await resumeRedditSubmission(saved.decisionId, action, content, { ...options, approvePending: saved.status === "approval_required", onDecision: remember });
        }
      } else {
        await options.beforeSubmit?.();
        delivery = await submitToReddit(action, content, { ...options, ...(saved.status === "refused" ? { ownProposal: false } : {}), onDecision: remember });
      }
      verifySubmittedText(delivery.decisionId);
      try {
        const state = {
          status: delivery.status === "published" ? "posted" : "scheduled",
          decisionId: delivery.decisionId, error: null,
        } as const;
        aliases.add(redditPublishKey({ ...action, id: delivery.decisionId }));
        transition(state);
      } catch {
        transition({
          status: delivery.status === "published" ? "posted" : "scheduled",
          decisionId: delivery.decisionId, error: null,
        }, false);
      }
      return delivery;
    } catch (error) {
      const remembered = readRedditPublishState(key);
      if (remembered.status === "posted" && remembered.decisionId) {
        return { status: "published" as const, decisionId: remembered.decisionId };
      }
      const uncertain = error instanceof RedditDeliveryUnconfirmed
        ? error
        : remembered.decisionId && !(error instanceof RedditDeliveryRefused) && !(error instanceof RedditApprovalRequired)
          ? new RedditDeliveryUnconfirmed(remembered.decisionId)
          : null;
      try {
        transition({
          status: uncertain ? "unconfirmed" : error instanceof RedditApprovalRequired ? "approval_required" : error instanceof RedditDeliveryRefused ? "refused" : "idle",
          decisionId: uncertain?.decisionId ?? (error instanceof RedditDeliveryRefused || error instanceof RedditApprovalRequired ? error.decisionId : null),
          error: uncertain?.message ?? (error instanceof Error ? error.message : "Could not post to Reddit."),
        });
      } catch {
        if (remembered.decisionId) throw new RedditDeliveryUnconfirmed(remembered.decisionId);
      }
      throw uncertain ?? error;
    }
  }));
  pending.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (pending.get(requestKey) === request) pending.delete(requestKey);
  }
}
