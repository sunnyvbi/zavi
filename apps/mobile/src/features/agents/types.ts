import type { AgentSummary, RunPanel } from "@zavi/shared";
import type { RunStatus } from "../../lib/status";

export type AgentRow = AgentSummary & {
  is_chat_eligible: boolean;
  locked_tier?: string | null;
  custom?: boolean;
  runs_total: number;
  latest_run: {
    id: string;
    finished_at: string | null;
    status: string;
    presentation_status?: "answered" | "failed" | "running" | "cancelled";
  } | null;
  parse_ok_rate: number | null;
};

export type AgentsResponse = { agents: AgentRow[]; drafts: unknown[] };

export type ChatAttachment = { path: string; kind?: "image" | "doc" };

export type ChatMessage = {
  id: string;
  sender_role: "user" | "agent" | "assistant" | "system";
  body: string;
  agent_run_id: string | null;
  created_at: string;
  attachments?: ChatAttachment[] | null;
  meta?: Record<string, unknown> | null;
};

export type ChatThread = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string;
};

export type ChatHistoryResponse = {
  thread: ChatThread | null;
  messages: ChatMessage[];
};

export type AgentThreadRow = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  last_message: string | null;
  run_status: string | null;
  presentation_status: "running" | "failed" | "answered" | "cancelled" | null;
  pending: boolean;
  unread?: boolean;
  channel_slug?: string | null;
  channel_action_id?: string | null;
};

export type ThreadsResponse = { threads: AgentThreadRow[] };

export type SendChatResponse = {
  thread_id: string;
  user_message_id: string;
  run_id: string;
};

export type RunRow = {
  id?: string;
  status: RunStatus | string;
  finished_at?: string | null;
};
export type RunStatusResponse = { run: RunRow };

export type RunProgressResponse = {
  status: RunStatus | string;
} & RunPanel;
