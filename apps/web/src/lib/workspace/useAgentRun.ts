"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import { parseSendError } from "./chatSendError";
import { buildChatSendBody, type ChatSendExtras } from "./chatSendBody";
import { getStaffModelParam } from "./staffModelParam";

export type ChatSendResult =
  | {
      kind: "queued";
      thread_id: string;
      user_message_id: string;
      run_id: string;
    }
  | {
      kind: "non_run";
      thread_id: string;
      action: string;
    };

export type ChatSendError = {
  kind: "error";
  status: number;
  code: string | null;
  message: string | null;
  required_tier?: string | null;
};

type UseAgentRunState = {
  inflight: boolean;
  lastRunId: string | null;
  error: string | null;
};

export function useAgentRun() {
  const [state, setState] = useState<UseAgentRunState>({
    inflight: false,
    lastRunId: null,
    error: null,
  });

  const send = useCallback(
    async (
      slug: string,
      message: string,
      threadId?: string | null,
      extras?: ChatSendExtras,
    ): Promise<ChatSendResult | ChatSendError | null> => {
      setState({ inflight: true, lastRunId: null, error: null });
      try {
        const model = extras?.model ?? getStaffModelParam();
        const body = buildChatSendBody(message, threadId, model ? { ...extras, model } : extras);
        const res = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          idempotent: true,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const { code, message, required_tier } = parseSendError(text);
          setState({
            inflight: false,
            lastRunId: null,
            error:
              code === "insufficient_credits" ||
              code === "plan_upgrade_required" ||
              code === "invalid_command"
                ? null
                : message ?? text,
          });
          return { kind: "error", status: res.status, code, message, required_tier };
        }
        const data = (await res.json()) as {
          thread_id: string;
          user_message_id?: string;
          run_id?: string;
          ok?: boolean;
          action?: string;
        };
        if (typeof data.run_id === "string") {
          setState({ inflight: false, lastRunId: data.run_id, error: null });
          return {
            kind: "queued",
            thread_id: data.thread_id,
            user_message_id: data.user_message_id ?? "",
            run_id: data.run_id,
          };
        }
        if (data.ok === true && typeof data.action === "string") {
          setState({ inflight: false, lastRunId: null, error: null });
          return {
            kind: "non_run",
            thread_id: data.thread_id,
            action: data.action,
          };
        }
        setState({
          inflight: false,
          lastRunId: null,
          error: "unexpected response shape",
        });
        return null;
      } catch (e) {
        setState({
          inflight: false,
          lastRunId: null,
          error: (e as Error).message,
        });
        return null;
      }
    },
    [],
  );

  return { ...state, send };
}
