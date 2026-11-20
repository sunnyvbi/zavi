"use client";

import { useState } from "react";
import { useChannelChatOpener } from "../../actions/channelChat";
import { FamilyCard } from "../../actions/card/FamilyCard";
import { cardLink } from "../../actions/card/styles";
import { CardButton } from "../../actions/card/CardButton";
import type { ActionItem } from "../../actions/types";
import { reddit_organic } from "../../actions/platforms/reddit_organic";
import { closeRedditSuggestionManually, redditPublishKey, redditReplyItem } from "./publish";
import { redditPublishLabel, useRedditPublish } from "./useRedditPublish";
import { send } from "./shared";

const REPLY_LIMIT = 4000;

type RedditReplyDraftProps = {
  threadId: string;
  url: string;
  text: string;
  posted: boolean;
  connected: boolean;
  onChanged?: () => void;
  ruleStatus?: string | null;
  suggestionId?: string | null;
  suggestionSource?: "channel_action" | "decision";
};

export function RedditReplyDraft(props: RedditReplyDraftProps) {
  const { threadId, url, posted, connected, onChanged, ruleStatus, suggestionId, suggestionSource } = props;
  const [state, setState] = useState({ busy: false, error: "", message: "", finished: false });
  const action = redditReplyItem(threadId, url, props.text, ruleStatus);
  const { state: publication, publish } = useRedditPublish(redditPublishKey(action), connected, posted);
  const openChat = useChannelChatOpener();
  const askAboutDraft = () => openChat?.({ target: "channel", draft: { text: `Help me revise this Reddit reply to ${url}:\n\n${props.text}`, nonce: Date.now() } });
  const save = async (text: string, draft_state: "drafted" | "posted" | "dismissed" = "drafted") => {
    if (!text.trim()) throw new Error("Write a reply before saving.");
    if (text.length > REPLY_LIMIT) throw new Error(`Shorten the reply to ${REPLY_LIMIT} characters before saving.`);
    const error = await send(`/api/reddit/threads/${encodeURIComponent(threadId)}`, "PATCH", { draft_state, draft_text: text });
    if (error) throw new Error(error);
    onChanged?.();
  };
  const updateStatus = async (status: "acted" | "rejected" | "snoozed") => {
    if (status === "snoozed") return false;
    setState({ busy: true, error: "", message: "", finished: false });
    try {
      const error = await send(`/api/reddit/threads/${encodeURIComponent(threadId)}`, "PATCH", {
        draft_state: status === "acted" ? "posted" : "dismissed",
      });
      if (error) throw new Error(error);
      const cardError = status === "acted" && suggestionId ? await closeRedditSuggestionManually(suggestionId, suggestionSource) : null;
      setState({ busy: false, error: cardError ?? "", message: status === "acted" ? "Marked as posted." : "Draft dismissed.", finished: true });
      onChanged?.();
      return true;
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : "Could not update the draft.", message: "", finished: false });
      return false;
    }
  };
  const postReply = async (text: string) => {
    try {
      await publish(action, text, async () => {
        try {
          await save(text, "posted");
          return null;
        } catch {
          return "Your reply was posted, but the draft status could not be saved. Refresh to check it before posting again.";
        }
      }, () => save(text));
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : "Could not publish the reply.", message: "", finished: false });
    }
    return false;
  };
  return (
    <div className="space-y-3">
      {state.error && <p role="alert" className="text-ca-action text-ca-danger">{state.error}</p>}
      {publication.error && <p role="alert" className="text-ca-action text-ca-danger">{publication.error}</p>}
      {state.message && <p role="status" className="text-ca-action text-ca-secondary">{state.message}</p>}
      {posted || state.finished || publication.status === "posted" || publication.status === "scheduled" || publication.status === "unconfirmed" ? (
        <div className="space-y-3 rounded-2xl border border-ca-border bg-ca-bg p-5">
          {(publication.status === "posted" || publication.status === "scheduled") && (
            <p role="status" className="text-ca-action font-medium text-ca-success">{publication.status === "posted" ? "Posted to Reddit." : "Scheduled"}</p>
          )}
          <p className="whitespace-pre-wrap text-ca-body text-ca-xdark">{props.text}</p>
          {publication.status === "scheduled" && <CardButton onClick={() => void postReply(props.text)}>Check again</CardButton>}
        </div>
      ) : (
        <div className="space-y-2">
          <a href={url} target="_blank" rel="noopener noreferrer" className={cardLink}>Open the original thread</a>
          <FamilyCard
            action={action}
            platform={{ ...reddit_organic, charLimit: REPLY_LIMIT, noSnooze: true, markDone: true }}
            busy={state.busy || publication.status === "posting"}
            handlers={{
              onSetStatus: (_action, status) => updateStatus(status),
              onRedo: async () => { askAboutDraft(); },
              onSaveText: (_action, text) => save(text),
              ...(openChat ? { onOpenChat: askAboutDraft, onOpenRedoChat: askAboutDraft } : {}),
              ...(connected ? { onPublish: (_action: ActionItem, content: { text: string }) => postReply(content.text) } : {}),
            }}
          />
        </div>
      )}
      {publication.status === "unconfirmed" && <CardButton variant="primary" onClick={() => void postReply(props.text)}>{redditPublishLabel(publication, connected)}</CardButton>}
    </div>
  );
}
