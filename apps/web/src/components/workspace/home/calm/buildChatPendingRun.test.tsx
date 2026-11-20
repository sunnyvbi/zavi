// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type * as React from "react";

const run = vi.hoisted(() => ({
  send: vi.fn(),
  shownPendingRunIds: [] as Array<string | null>,
  statusRows: [] as string[],
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("../../WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      userEmail: "founder@example.com",
      setTabDirty: noop,
      setTabThreadId: noop,
      role: "owner",
      composerSeeds: {},
      consumeComposerSeed: noop,
      closeTab: noop,
      openTab: () => "t",
    }),
  };
});
vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ inflight: false, error: null, send: run.send }),
}));
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
vi.mock("../../ThreadBar", () => ({ ThreadBar: () => null }));
vi.mock("../../ChatExpandButton", () => ({ ChatExpandButton: () => null, HEADER_CARD_SHADOW: "" }));
vi.mock("../../chat/TeamNoteStrip", () => ({ TeamNoteStrip: () => null }));
vi.mock("../../InlineStatusRow", () => ({
  InlineStatusRow: ({ runId }: { runId: string }) => {
    run.statusRows.push(runId);
    return null;
  },
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: [{ id: "m:old", kind: "chat_user", agent_run_id: null }],
    loading: false,
    errorMsg: null,
    reload: () => {},
    refetch: async () => {},
    appendOptimisticUser: () => "opt-1",
    appendOptimisticSystem: () => {},
    removeOptimisticUser: () => {},
    markRunStopped: () => {},
    unmarkRunStopped: () => {},
    activeRunId: null,
    activeRunStartedAt: null,
    activeRunTurnStartedAt: null,
    activeTrigger: null,
    activityByRun: new Map(),
    activityRows: [],
    offeredTeamNote: null,
  }),
}));
vi.mock("../../ChatThread", () => ({
  ChatThread: ({ state }: { state: { pendingRunId: string | null } }) => {
    run.shownPendingRunIds.push(state.pendingRunId);
    return <div data-testid="thread-pending-run">{state.pendingRunId ?? ""}</div>;
  },
}));

import { HomeChatPanel } from "./HomeChatPanel";

Element.prototype.scrollIntoView = () => {};

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

const base = {
  greeting: "Good afternoon.",
  pulse: <span>pulse</span>,
  suggestions: [] as string[],
  expanded: false,
  onExpandedChange: () => {},
  width: 430,
  dragging: false,
  side: "left" as const,
  surface: "card" as const,
  showThreadBar: false,
  showExpand: false,
  separatorProps: {} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"],
};

function BuildSurface() {
  const [threadId, setThreadId] = useState<string | null>(FIRST);
  return (
    <>
      <button type="button" onClick={() => setThreadId(SECOND)}>
        open other conversation
      </button>
      <button type="button" onClick={() => setThreadId(FIRST)}>
        back to first conversation
      </button>
      <HomeChatPanel {...base} initialThreadId={threadId} onThreadChange={() => {}} />
    </>
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

const stopButton = () => screen.queryByRole("button", { name: "Stop this run" });

afterEach(() => {
  cleanup();
  run.send.mockReset();
  run.shownPendingRunIds.length = 0;
  run.statusRows.length = 0;
});

describe("the Build chat's working state belongs to the conversation it was sent in", () => {
  it("drops the running reply's Stop and working row when another conversation is opened, and does not bring them back", async () => {
    run.send.mockResolvedValue({ kind: "queued", thread_id: FIRST, user_message_id: "m1", run_id: "run-1" });
    render(<BuildSurface />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what does my pricing page say?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await flush();
    expect(stopButton()).not.toBeNull();
    expect(screen.getByTestId("thread-pending-run").textContent).toBe("run-1");

    run.shownPendingRunIds.length = 0;
    run.statusRows.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "open other conversation" }));
    await flush();

    expect(stopButton()).toBeNull();
    expect(screen.getByTestId("thread-pending-run").textContent).toBe("");
    expect(run.shownPendingRunIds.at(-1)).toBeNull();
    const statusRowsAfterSwitch = run.statusRows.length;

    run.shownPendingRunIds.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "back to first conversation" }));
    await flush();
    expect(stopButton()).toBeNull();
    expect(run.shownPendingRunIds).not.toContain("run-1");
    expect(run.statusRows).toHaveLength(statusRowsAfterSwitch);
  });
});
