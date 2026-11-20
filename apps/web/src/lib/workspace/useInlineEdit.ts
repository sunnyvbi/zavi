import { useCallback, useRef } from "react";
import { useAgentRun } from "./useAgentRun";
import type { useChatThread } from "./useChatThread";
import { failEditingMessage, stopEditingMessage } from "./editingMessage";

export type EditMessage = (messageId: string, text: string) => Promise<void>;

export function useInlineEdit(
  chat: ReturnType<typeof useChatThread>,
  agentSlug: string,
  threadId: string | null | undefined,
): EditMessage | undefined {
  const { send } = useAgentRun();
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const edit = useCallback<EditMessage>(
    async (messageId, text) => {
      if (!threadId) return;
      const c = chatRef.current;
      const start = c.rows.findIndex((r) => r.id === messageId || r.id === `m:${messageId}`);
      const hidden = start < 0 ? [] : c.rows.slice(start).map((r) => r.id);
      const stoppedRunId = c.activeRunId;
      if (stoppedRunId) c.markRunStopped(stoppedRunId);
      c.hideRows(hidden);
      const optimisticId = c.appendOptimisticUser(text);
      stopEditingMessage(messageId);
      const res = await send(agentSlug, text, threadId, { edit_of_message_id: messageId });
      if (!res || res.kind === "error") {
        c.unhideRows(hidden);
        if (optimisticId) c.removeOptimisticUser(optimisticId);
        if (stoppedRunId) c.unmarkRunStopped(stoppedRunId);
        failEditingMessage(messageId, text, res?.message ?? "Couldn't save your edit. Try again.");
        return;
      }
      void c.refetch();
    },
    [agentSlug, send, threadId],
  );

  return threadId ? edit : undefined;
}
