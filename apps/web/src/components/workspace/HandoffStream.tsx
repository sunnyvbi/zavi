"use client";

import { looksLikeNarration } from "@zavi/shared";
import { useRef } from "react";
import type { HandoffRun } from "@/lib/workspace/useHandoffProgress";
import { useRunStreamDraft } from "@/lib/workspace/useRunStreamDraft";
import { isStreamTokensEnabled } from "@/lib/workspace/streamTokensFlag";
import { streamDraftPreview } from "@/lib/workspace/streamDraftPreview";
import { RunNarrative } from "./RunNarrative";
import { ChatBubble } from "./ChatBubble";

export function HandoffStream({ run, recoveryExhausted = false, onReload }: {
  run: HandoffRun;
  recoveryExhausted?: boolean;
  onReload?: () => void;
}) {
  const recoveryStatus = useRef<HTMLParagraphElement>(null);
  const enabled = isStreamTokensEnabled();
  const draft = useRunStreamDraft(enabled ? run.run_id : null, enabled);
  const text = streamDraftPreview(draft.text);
  const live = draft.status === "complete" || (draft.status === "streaming" && !looksLikeNarration(text));
  const waitingForReply = run.status === "success" && !(draft.status === "complete" && text);
  return <>
    <RunNarrative model={run.panel} agentSlug={run.agent_slug} compact drafting={live && !!text}
      askClaimed={!!run.started_at} startedAt={run.started_at} endedAt={run.finished_at} />
    {waitingForReply && <div className="my-2 text-[14px] text-ink/80">
      <p role="status" tabIndex={-1} ref={recoveryStatus}>{recoveryExhausted
        ? "Your specialist finished, but the answer hasn’t loaded yet."
        : "Loading your completed answer…"}</p>
      {recoveryExhausted && onReload && <button type="button" onClick={() => {
        recoveryStatus.current?.focus();
        onReload();
      }}
        className="mt-2 rounded-md border border-ink/20 px-3 py-2 font-medium hover:bg-ink/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        Reload answer
      </button>}
    </div>}
    {live && text && <ChatBubble role="assistant" text={text} agentSlug={run.agent_slug}
      isStreaming={draft.status !== "complete"} />}
  </>;
}
