// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChatThreadState } from "./ChatThread";
import { GROWTH_OFFICER_SLUG } from "@/lib/agentRegistry";

const setup = vi.hoisted(() => ({ state: null as unknown }));

vi.mock("./setup/SetupProvider", () => ({
  useSetupOptional: () => (setup.state ? { state: setup.state } : null),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));
vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ seedComposer: vi.fn(), openAgentTab: vi.fn() }),
}));
vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ send: vi.fn(), inflight: false }),
}));

const { ChatThread } = await import("./ChatThread");
const { SetupMascot } = await import("./setup/SetupMascot");
const { READY_LINE, strategyProgressLine } = await import("./setup/setupCopy");

const emptyThread: ChatThreadState = {
  rows: [],
  activityRows: [],
  activityByRun: new Map(),
  loading: false,
  errorMsg: null,
  activeRunId: null,
  activeTrigger: null,
  activeRunStartedAt: null,
  activeRunTurnStartedAt: null,
  pendingRunId: null,
} as unknown as ChatThreadState;

const skipped = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  docs: { status: "skipped", files: 0, facts: 0 },
  connectors: { status: "skipped" },
  done: true,
  home_seen: false,
  draft: { status: "done", run_id: "run-1", attempts: 1, can_retry: false, free_retry: false },
  one_state: true,
  ...over,
});

afterEach(() => {
  cleanup();
  setup.state = null;
});

describe("B12: the Growth chat says one thing after Skip setup", () => {
  it("drops 'No messages yet with Zavi.' once the strategy has a status", () => {
    for (const status of ["running", "done", "failed"]) {
      setup.state = skipped({ draft: { status, run_id: "run-1", attempts: 1, can_retry: false, free_retry: false } });
      render(<ChatThread agentSlug={GROWTH_OFFICER_SLUG} emptyStateName="Zavi" state={emptyThread} />);
      expect(screen.queryByText("No messages yet with Zavi.")).toBeNull();
      cleanup();
    }
  });

  it("keeps the line before the strategy draft has any status", () => {
    setup.state = skipped({ draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: false } });
    render(<ChatThread agentSlug={GROWTH_OFFICER_SLUG} emptyStateName="Zavi" state={emptyThread} />);
    expect(screen.getByText("No messages yet with Zavi.")).toBeTruthy();
  });

  it("keeps the line with setup_strategy_one_state off", () => {
    setup.state = skipped({ one_state: undefined });
    render(<ChatThread agentSlug={GROWTH_OFFICER_SLUG} emptyStateName="Zavi" state={emptyThread} />);
    expect(screen.getByText("No messages yet with Zavi.")).toBeTruthy();
  });

  it("keeps the line for other agents' chats", () => {
    setup.state = skipped();
    render(<ChatThread agentSlug="operator" emptyStateName="Zavi" state={emptyThread} />);
    expect(screen.getByText("No messages yet with Zavi.")).toBeTruthy();
  });

  it("the Growth side chat shows the strategy status alone after Skip setup, never beside the empty-state line", () => {
    const cases: Array<[string, string]> = [
      ["done", READY_LINE],
      ["running", strategyProgressLine()],
      ["failed", "Something went wrong cooking your strategy. Try again from the page."],
    ];
    for (const [status, line] of cases) {
      const state = skipped({ draft: { status, run_id: "run-1", attempts: 1, can_retry: false, free_retry: false } });
      setup.state = state;
      render(
        <ChatThread
          agentSlug={GROWTH_OFFICER_SLUG}
          emptyStateName="Zavi"
          emptyState={<SetupMascot state={state as never} />}
          state={emptyThread}
        />,
      );
      expect(screen.getByRole("status").textContent).toBe(line);
      expect(screen.queryByText(/No messages yet/)).toBeNull();
      cleanup();
    }
  });
});
