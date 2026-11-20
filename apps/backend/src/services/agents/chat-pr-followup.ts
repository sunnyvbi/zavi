
import { createHash } from "node:crypto";

import { isPureAcknowledgment, isPureGratitude } from "./acknowledgment-classify";
import { isDeferredIntentRequest } from "./deferred-intent-classify";

export type OpenEngineerPr = {
  decision_id: string;
  run_id: string;
  pr_number: number;
  pr_repo: string;
  pr_url: string;
  head_branch: string;
};

export function isSafeCheckoutRef(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    !s.startsWith("-") &&
    /^[A-Za-z0-9._/-]+$/.test(s)
  );
}

export function shortHash(instruction: string): string {
  return createHash("sha256")
    .update(instruction.trim())
    .digest("hex")
    .slice(0, 12);
}

export function followupDedupeKey(args: {
  thread_id: string;
  decision_id: string;
  instruction: string;
}): string {
  return `chat-followup:${args.thread_id}:${args.decision_id}:${shortHash(args.instruction)}`;
}

const NEW_TASK_MARKERS = [
  /\bnew\s+(task|feature|pr|change|ticket)\b/i,
  /\b(separate|different|unrelated)\b/i,
  /\binstead\s+(build|create|make|do)\b/i,
  /\bstart\s+(a\s+)?(new|fresh)\b/i,
  /\bforget\s+(that|the\s+pr)\b/i,
];

const CONTINUATION_MARKERS = [
  /\b(also|additionally|and\s+also|plus)\b/i,
  /\b(actually|instead\s+of\s+that|on\s+second\s+thought)\b/i,
  /\b(change|update|tweak|adjust|rename|fix|add|remove|swap|replace|make)\b/i,
  /\b(forgot|missed|left\s+out|omitted|didn'?t\s+(include|add|generate|create|commit|push|ship))\b[\s\S]{0,40}?(\bfiles?\b|\.(js|ts|tsx|jsx|py|go|rb|css|html|json|sql)\b|\bdist\b|\bbuild\b|\bcompiled\b|\bmigrations?\b|\btests?\b|\bcommits?\b|\bbranch\b|\bgenerated?\b)/i,
];

const NEGATIVE_FEEDBACK_MARKERS = [
  /\b(not|isn'?t|wasn'?t|isnt|wasnt)\s+(the\s+|a\s+)?(right|correct|proper|good)\s+(fix|solution|approach|implementation|change|answer)\b/i,
  /\b(this|that|it|that'?s|the\s+(fix|solution|approach|implementation|code|pr))\s+(is|was|looks|seems|'?s)?\s*(wrong|incorrect|not\s+right|not\s+correct)\b/i,
  /\b(wrong|incorrect)\s+(fix|solution|approach|implementation|root\s*cause|change)\b/i,
  /\b(does\s?n'?t|do\s?n'?t|did\s?n'?t|does\s+not|did\s+not)\s+(work|fix|solve|help|address)\b/i,
  /\b(think\s+(deep|deeper|harder|again|more)|re-?investigate|re-?think|rethink|look\s+(again|deeper)|try\s+again|dig\s+deeper|root\s+cause)\b/i,
];

export type FollowupClassification =
  | {
      action: "route";
      pr: OpenEngineerPr;
    }
  | {
      action: "clarify";
      prs: OpenEngineerPr[];
    }
  | {
      action: "skip";
    };

export function classifyFollowupCandidates(args: {
  message: string;
  openPrs: OpenEngineerPr[];
}): FollowupClassification {
  const msg = args.message.trim();
  const openPrs = args.openPrs.filter((p) => isSafeCheckoutRef(p.head_branch));

  if (openPrs.length === 0 || msg.length === 0) {
    return { action: "skip" };
  }

  if (isPureAcknowledgment(args.message) || isPureGratitude(args.message)) {
    return { action: "skip" };
  }

  if (isDeferredIntentRequest(args.message)) {
    return { action: "skip" };
  }

  if (NEGATIVE_FEEDBACK_MARKERS.some((re) => re.test(msg))) {
    return { action: "skip" };
  }

  if (openPrs.length > 1) {
    return { action: "clarify", prs: openPrs };
  }

  const pr = openPrs[0];
  const looksNewTask = NEW_TASK_MARKERS.some((re) => re.test(msg));
  if (looksNewTask) {
    return { action: "clarify", prs: openPrs };
  }

  const looksContinuation = CONTINUATION_MARKERS.some((re) => re.test(msg));
  if (looksContinuation) {
    return { action: "route", pr };
  }

  return { action: "clarify", prs: openPrs };
}

export type EngineerPrFollowupPayload = {
  kind: "engineer_pr_followup";
  checkout_ref: string;
  target_pr_number: number;
  target_pr_repo: string;
  target_pr_url: string;
  instruction: string;
  source: "chat" | "slack";
  thread_id: string;
  user_message_id: string;
  slack_routing: Record<string, unknown> | null;
};

export function buildFollowupPayload(args: {
  pr: OpenEngineerPr;
  instruction: string;
  source: "chat" | "slack";
  thread_id: string;
  user_message_id: string;
  slack_routing?: Record<string, unknown> | null;
}): EngineerPrFollowupPayload {
  return {
    kind: "engineer_pr_followup",
    checkout_ref: args.pr.head_branch,
    target_pr_number: args.pr.pr_number,
    target_pr_repo: args.pr.pr_repo,
    target_pr_url: args.pr.pr_url,
    instruction: args.instruction,
    source: args.source,
    thread_id: args.thread_id,
    user_message_id: args.user_message_id,
    slack_routing: args.slack_routing ?? null,
  };
}

export function buildClarifyText(prs: OpenEngineerPr[]): string {
  if (prs.length === 1) {
    return `Apply this to PR #${prs[0].pr_number} (${prs[0].pr_repo}), or start a new change?`;
  }
  const list = prs
    .slice(0, 5)
    .map((p) => `#${p.pr_number} (${p.pr_repo})`)
    .join(", ");
  return `You have multiple open PRs from me — ${list}. Which one should I apply this to, or is this a new change?`;
}
