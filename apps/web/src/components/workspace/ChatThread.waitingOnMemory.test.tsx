// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChatThreadState } from "./ChatThread";
import type { HandoffRun } from "@/lib/workspace/useHandoffProgress";
import { findScrollParent } from "@/lib/workspace/scrollParent";

vi.mock("@/lib/workspace/scrollParent", () => ({ findScrollParent: vi.fn(() => null) }));

const handoffs: HandoffRun[] = [];
vi.mock("@/lib/workspace/useHandoffProgress", () => ({ useHandoffProgress: () => handoffs }));

const draft = { text: "", status: "streaming" };

vi.mock("@/lib/workspace/useRunStreamDraft", () => ({
  useRunStreamDraft: vi.fn(() => draft),
}));

const runStatus: { body: Record<string, unknown> } = { body: {} };
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) =>
    path.startsWith("/api/agents/runs/")
      ? { ok: true, json: async () => runStatus.body }
      : { ok: false, json: async () => ({}) }),
}));

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ seedComposer: vi.fn(), openAgentTab: vi.fn() }),
}));

vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ send: vi.fn(), inflight: false }),
}));

vi.mock("./ChatBubble", () => ({
  ChatBubble: ({
    role,
    text,
    isStreaming,
  }: {
    role: string;
    text: string;
    isStreaming?: boolean;
  }) => (
    <div
      data-testid={`bubble-${role}`}
      data-streaming={isStreaming ? "yes" : "no"}
    >
      {text}
    </div>
  ),
}));

vi.mock("@/components/agents/ApprovalBlock", () => ({
  ApprovalBlock: () => <div data-testid="approval-block" />,
}));

const { ChatThread } = await import("./ChatThread");

function state(over: Partial<ChatThreadState> = {}): ChatThreadState {
  return {
    rows: [
      {
        id: "u1",
        kind: "chat_user",
        created_at: "2026-10-19T01:21:45.000Z",
        agent_run_id: "run-1",
        body: { text: "what should I do this week?" },
      },
    ] as unknown as ChatThreadState["rows"],
    activityRows: [],
    activityByRun: new Map(),
    loading: false,
    errorMsg: null,
    activeRunId: "run-1",
    activeTrigger: "chat",
    activeRunStartedAt: null,
    activeRunTurnStartedAt: "2026-10-19T01:21:45.000Z",
    pendingRunId: null,
    ...over,
  };
}

beforeEach(() => {
  handoffs.length = 0;
  draft.text = "";
  draft.status = "streaming";
  vi.mocked(findScrollParent).mockReturnValue(null);
});
afterEach(() => { cleanup(); });

describe("a run held while a new workspace's memory is written", () => {
  it("says Zavi is still reading the site instead of Getting started", async () => {
    runStatus.body = { run: { status: "queued", started_at: null }, queue_ahead: 0, waiting_on: "memory" };
    render(<ChatThread agentSlug="operator" state={state()} />);
    expect((await screen.findAllByText("Zavi is still reading your site…")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Getting started…")).toBeNull();
  });

  it("keeps Getting started for a queued run that is not waiting on memory", async () => {
    runStatus.body = { run: { status: "queued", started_at: null }, queue_ahead: 0 };
    render(<ChatThread agentSlug="operator" state={state()} />);
    expect((await screen.findAllByText("Getting started…")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Zavi is still reading your site…")).toBeNull();
  });
});
