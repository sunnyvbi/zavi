import { Suspense, createElement, lazy } from "react";
import type { ExtraRowAction, ExtraRowDetail } from "../../actions/ExtraTable";

const RedditReplyDraft = lazy(() => import("./RedditReplyDraft").then((m) => ({ default: m.RedditReplyDraft })));

export function draftReplyAction(threadId: string, onChanged?: () => void): ExtraRowAction {
  return {
    label: "Draft reply",
    busyLabel: "Drafting…",
    retryLabel: "Retry draft",
    onClick: async () => {
      const { requestReplyDraft } = await import("./shared");
      const error = await requestReplyDraft(threadId);
      if (error) throw new Error(error);
      onChanged?.();
    },
  };
}

export function draftDetail(
  threadId: string,
  url: string,
  draft: { text: string | null; state: string; rule_status?: string | null; source?: string; decision_id?: string | null; action_source?: "decision" | "channel_action" | null } | null | undefined,
  onChanged?: () => void,
  connected = false,
  bannedCommunity = false,
): ExtraRowDetail | undefined {
  const text = draft?.text?.trim();
  if (!text || draft?.state === "dismissed") return undefined;
  return {
    title: "Drafted reply",
    text,
    openLabel: "Show draft",
    closeLabel: "Hide draft",
    content: createElement(Suspense, { fallback: null }, createElement(RedditReplyDraft, {
      key: threadId,
      threadId,
      url,
      text,
      posted: draft?.state === "posted",
      connected,
      onChanged,
      ruleStatus: bannedCommunity ? "not_allowed" : draft?.rule_status ?? null,
      suggestionId: draft?.source === "run" ? draft.decision_id ?? null : null,
      suggestionSource: draft?.action_source ?? undefined,
    })),
  };
}
