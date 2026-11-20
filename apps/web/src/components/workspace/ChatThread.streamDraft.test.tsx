// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ChatThreadState } from "./ChatThread";
import { buildRunPanel } from "@zavi/shared";
import type { HandoffRun } from "@/lib/workspace/useHandoffProgress";
import { findScrollParent } from "@/lib/workspace/scrollParent";
import { useRunStreamDraft } from "@/lib/workspace/useRunStreamDraft";

vi.mock("@/lib/workspace/scrollParent", () => ({ findScrollParent: vi.fn(() => null) }));

const handoffs: HandoffRun[] = [];
vi.mock("@/lib/workspace/useHandoffProgress", () => ({ useHandoffProgress: () => handoffs }));

const draft = { text: "", status: "streaming" };

vi.mock("@/lib/workspace/useRunStreamDraft", () => ({
  useRunStreamDraft: vi.fn(() => draft),
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

vi.mock("./RunActivityFeed", () => ({
  RunActivityFeed: ({ liveThought }: { liveThought?: string }) => (
    <div data-testid="activity-feed">{liveThought ?? "working…"}</div>
  ),
}));

vi.mock("@/components/agents/ApprovalBlock", () => ({
  ApprovalBlock: () => <div data-testid="approval-block" />,
}));

const { ChatThread } = await import("./ChatThread");

const PLAN_PREAMBLE_DRAFT =
  '<plan>{"classify":{"tier":"tier1","confidence":0.95},"summary":"Write 4-email host onboarding sequence","steps":["Draft 4 triggered emails"],"files":[]}</plan>\n\n' +
  "Four assumptions I made visible at the top of each email so you can confirm the triggers match your ESP setup.";

function state(over: Partial<ChatThreadState> = {}): ChatThreadState {
  return {
    rows: [
      {
        id: "u1",
        kind: "chat_user",
        created_at: "2026-09-19T01:21:45.000Z",
        agent_run_id: "run-1",
        body: { text: "write me a host onboarding sequence" },
      },
    ] as unknown as ChatThreadState["rows"],
    activityRows: [],
    activityByRun: new Map(),
    loading: false,
    errorMsg: null,
    activeRunId: "run-1",
    activeTrigger: "chat",
    activeRunStartedAt: "2026-09-19T01:21:51.000Z",
    activeRunTurnStartedAt: "2026-09-19T01:21:45.000Z",
    pendingRunId: null,
    ...over,
  };
}

beforeEach(() => {
  handoffs.length = 0;
  draft.text = "";
  draft.status = "streaming";
  vi.mocked(findScrollParent).mockReturnValue(null);
  vi.mocked(useRunStreamDraft).mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ChatThread in-flight — live draft with an envelope PREAMBLE", () => {
  it("shows the streamed prose that follows a closed <plan> (the 127-208s blank)", () => {
    draft.text = PLAN_PREAMBLE_DRAFT;
    render(<ChatThread agentSlug="operator" state={state()} />);

    expect(screen.getByTestId("activity-feed").textContent).toContain("Four assumptions I made visible");
    expect(screen.queryByTestId("bubble-assistant")).toBeNull();
  });

  it("puts a short completed answer in the bubble, never in the narrative", () => {
    draft.text = "It is 42.";
    draft.status = "complete";
    render(<ChatThread agentSlug="operator" state={state()} />);

    expect(screen.getByTestId("bubble-assistant").textContent).toContain("It is 42.");
    expect(screen.getByTestId("activity-feed").textContent).not.toContain("It is 42.");
  });

  it("moves the prose to the answer bubble once it is answer-shaped, and keeps the panel", () => {
    draft.text = PLAN_PREAMBLE_DRAFT + "\n\n## Email 1 — Welcome\n\n" + "Body copy for the email. ".repeat(12);
    render(<ChatThread agentSlug="operator" state={state()} />);

    const bubble = screen.getByTestId("bubble-assistant");
    expect(bubble.textContent).toContain("Four assumptions I made visible");
    expect(bubble.dataset.streaming).toBe("yes");
    expect(screen.getByTestId("activity-feed").textContent).not.toContain("Four assumptions");
  });

  it("never renders the envelope's machine payload, in either home", () => {
    for (const text of [PLAN_PREAMBLE_DRAFT, PLAN_PREAMBLE_DRAFT + "\n\n" + "More answer. ".repeat(30)]) {
      draft.text = text;
      const { container, unmount } = render(<ChatThread agentSlug="operator" state={state()} />);
      const shown = container.textContent ?? "";
      expect(shown).not.toContain("<plan>");
      expect(shown).not.toContain("classify");
      expect(shown).not.toContain("evidence_needed");
      unmount();
    }
  });

  it("falls back to the working feed while the envelope body is still streaming", () => {
    draft.text = '<plan>{"classify":{"tier":"tier1","conf';
    render(<ChatThread agentSlug="operator" state={state()} />);

    expect(screen.queryByTestId("bubble-assistant")).toBeNull();
    expect(screen.getByTestId("activity-feed")).toBeTruthy();
  });

  it("falls back to the working feed for an envelope-ONLY answer (no prose to show)", () => {
    draft.text = '<product_pm_backlog>{"items":[{"t":"x"}]}</product_pm_backlog>';
    render(<ChatThread agentSlug="pm" state={state()} />);

    expect(screen.queryByTestId("bubble-assistant")).toBeNull();
    expect(screen.getByTestId("activity-feed")).toBeTruthy();
  });

  it("shows the working feed before the first token arrives", () => {
    draft.text = "";
    render(<ChatThread agentSlug="operator" state={state()} />);

    expect(screen.queryByTestId("bubble-assistant")).toBeNull();
    expect(screen.getByTestId("activity-feed")).toBeTruthy();
  });
});

describe("handed-off specialist answer", () => {
  it("streams the child after the parent has ended and replaces it when the saved reply arrives", () => {
    handoffs.push({ run_id: "child", agent_slug: "chatgpt_ads", status: "running", panel: buildRunPanel([], { state: "running" }) });
    draft.text = "3 rental ad options are ready.";
    const settled = state({ activeRunId: null, pendingRunId: null });
    const view = render(<ChatThread agentSlug="operator" state={settled} />);
    expect(screen.getByText(draft.text)).toBeTruthy();
    expect(screen.getByTestId("bubble-assistant").dataset.streaming).toBe("yes");
    handoffs[0].status = "success";
    handoffs[0].panel.state = "finished";
    view.rerender(<ChatThread agentSlug="operator" state={settled} />);
    expect(screen.getByTestId("bubble-assistant").dataset.streaming).toBe("yes");
    draft.status = "complete";
    view.rerender(<ChatThread agentSlug="operator" state={settled} />);
    expect(screen.getByText(draft.text)).toBeTruthy();
    expect(screen.getByTestId("bubble-assistant").dataset.streaming).toBe("no");
    view.rerender(<ChatThread agentSlug="operator" state={{ ...settled, rows: [{ id: "answer", kind: "chat_assistant", agent_run_id: "child", created_at: "2026-10-15T00:00:00Z", body: { text: draft.text } }] as any }} />);
    expect(screen.queryByTestId("bubble-assistant")?.dataset.streaming).not.toBe("yes");
    expect(screen.getAllByText(draft.text)).toHaveLength(1);
  });
});

describe("parallel handoff children", () => {
  it("keeps a finished child until the combined parent reply lists it in childRunIds", () => {
    handoffs.push({ run_id: "child-a", agent_slug: "chatgpt_ads", status: "success", panel: buildRunPanel([], { state: "finished" }) });
    draft.text = "Child A finished its part.";
    draft.status = "complete";
    const settled = state({ activeRunId: null, pendingRunId: null });
    const view = render(<ChatThread agentSlug="operator" state={settled} />);
    expect(screen.getByText(draft.text)).toBeTruthy();
    const combined = { id: "combined", kind: "chat_assistant", agent_run_id: "parent-run", childRunIds: ["child-a"], created_at: "2026-10-15T00:00:00Z", body: { text: "Parallel handoff, all finished." } };
    view.rerender(<ChatThread agentSlug="operator" state={{ ...settled, rows: [...settled.rows, combined] as any }} />);
    expect(screen.queryByText(draft.text)).toBeNull();
  });
});

describe("handed-off specialist narration", () => {
  it("keeps a narration-shaped child turn out of the answer bubble", () => {
    handoffs.push({ run_id: "child", agent_slug: "chatgpt_ads", status: "running", panel: buildRunPanel([], { state: "running" }) });
    draft.text = "Found it";
    render(<ChatThread agentSlug="operator" state={state({ activeRunId: null, pendingRunId: null })} />);
    expect(screen.queryByText("Found it")).toBeNull();
  });
});

describe("stream selection and visibility", () => {
  it("subscribes to the pending run when the old active run already has a saved reply", () => {
    const next = state({ pendingRunId: "new-run" });
    next.rows = [...next.rows, { ...next.rows[0], id: "answer", kind: "chat_assistant" }];
    render(<ChatThread agentSlug="operator" state={next} />);
    expect(useRunStreamDraft).toHaveBeenCalledWith("new-run", true);
  });

  it("follows streamed content growth only while the reader stays at the bottom", () => {
    let resized = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect = disconnect;
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1200, configurable: true },
      offsetParent: { value: document.body },
    });
    scroller.scrollTop = 800;
    vi.mocked(findScrollParent).mockReturnValue(scroller);
    const view = render(<ChatThread agentSlug="operator" state={state()} />);
    Object.defineProperty(scroller, "scrollHeight", { value: 1600, configurable: true });
    act(() => resized());
    expect(scroller.scrollTop).toBe(1600);
    scroller.scrollTop = 100;
    act(() => scroller.dispatchEvent(new Event("scroll")));
    Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
    act(() => resized());
    expect(scroller.scrollTop).toBe(100);
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
