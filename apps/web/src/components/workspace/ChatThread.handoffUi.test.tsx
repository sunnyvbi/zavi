// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { buildRunPanel } from "@zavi/shared";
import { ChatThread, type ChatThreadState } from "./ChatThread";
import type { HandoffRun } from "@/lib/workspace/useHandoffProgress";

const fixture = vi.hoisted(() => ({ runs: [] as HandoffRun[], draft: { text: "", status: "idle" } }));
vi.mock("@/lib/workspace/useHandoffProgress", () => ({ useHandoffProgress: () => fixture.runs }));
vi.mock("@/lib/workspace/useRunStreamDraft", () => ({ useRunStreamDraft: () => fixture.draft }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })) }));
vi.mock("./WorkspaceShell", () => ({ useWorkspace: () => ({ role: "owner", seedComposer: vi.fn(), openAgentTab: vi.fn() }) }));
vi.mock("@/lib/workspace/useAgentRun", () => ({ useAgentRun: () => ({ send: vi.fn(), inflight: false }) }));

const ACK = "Your growth agent is preparing the plan. It will post the answer here.";
const PLAN = "Hand the 30-day strategy request to the growth specialist.";
const started = "2026-11-17T08:00:13Z";
function state(text = ACK): ChatThreadState {
  return {
    rows: [
      { id: "ask", kind: "chat_user", agent_run_id: "parent", created_at: started, body: { text: "What is my 30-day marketing strategy?" }, citations: [] },
      { id: "ack", kind: "chat_assistant", agent_run_id: "parent", created_at: started, body: { text }, citations: [] },
    ],
    activityRows: [],
    activityByRun: new Map([["parent", [{ id: "plan", kind: "chat_activity", agent_run_id: "parent", created_at: started, body: { teKind: "plan", summary: PLAN }, citations: [] }, { id: "handoff", kind: "chat_activity", agent_run_id: "parent", created_at: started, body: { teKind: "tool_call", tool_name: "praxis__handoff", ms: 100, code: "ok", output_preview: "Started" }, citations: [] }]]]),
    loading: false, errorMsg: null, activeRunId: null, activeTrigger: null,
    activeRunStartedAt: null, activeRunTurnStartedAt: null, pendingRunId: null,
  };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T08:01:00Z"));
  fixture.draft = { text: "", status: "idle" };
  fixture.runs = [{ run_id: "child", parent_run_id: "parent", agent_slug: "cgo", status: "running", started_at: started,
    panel: buildRunPanel([
      { id: "say", kind: "reasoning", body: { text: "I will check the saved strategy and connected data." } },
      { id: "call", kind: "tool_call", body: { tool_name: "memory__search", call_id: "one", ms: 200, code: "ok", output_preview: "Strategy found" } },
    ], { state: "running" }),
  }];
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("handoff UI with real answer components", () => {
  it("folds routing details and removes answer actions from the acknowledgement", () => {
    render(<ChatThread agentSlug="operator" state={state()} />);
    const summary = screen.getByText(ACK);
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")?.open).toBe(false);
    expect(screen.getByText(PLAN).closest("details")).toBe(summary.closest("details"));
    expect(screen.queryByRole("button", { name: /good|bad|helpful/i })).toBeNull();
    expect(screen.getByRole("status").parentElement?.textContent).toContain("47s");
  });

  it.each(["Which channel should I use?", "## Results\n\nRevenue grew by 10%."])("preserves an actionable or rich parent reply: %s", text => {
    render(<ChatThread agentSlug="operator" state={state(text)} />);
    expect(screen.getByText(text.startsWith("##") ? "Results" : text).closest("summary")).toBeNull();
    expect(screen.getAllByRole("button", { name: /copy/i })).toHaveLength(2);
  });

  it("retains the original reply display when the server cannot prove a parent link", () => {
    fixture.runs[0].parent_run_id = null;
    render(<ChatThread agentSlug="operator" state={state()} />);
    expect(screen.getByText(ACK).closest("summary")).toBeNull();
    expect(screen.getAllByRole("button", { name: /copy/i })).toHaveLength(2);
  });

  it("does not show Request details when the specialist failed without a reply", () => {
    fixture.runs[0].status = "failed";
    fixture.runs[0].panel.state = "failed";
    render(<ChatThread agentSlug="operator" state={state()} />);
    expect(screen.queryByText("Request details")).toBeNull();
    expect(screen.getByText(ACK)).toBeTruthy();
  });

  it("keeps the finished answer and its actions visible without an old working acknowledgement", () => {
    fixture.runs[0].status = "success";
    fixture.runs[0].panel.state = "finished";
    const complete = state();
    complete.rows.push({ id: "answer", kind: "chat_assistant", agent_run_id: "child", fromAgentSlug: "cgo",
      created_at: started, body: { text: "Your plan is ready. Publish four videos this month." }, citations: [] });
    render(<ChatThread agentSlug="operator" state={complete} />);
    expect(screen.getByText("Request details").tagName).toBe("SUMMARY");
    expect(screen.getByText(ACK).closest("details")?.open).toBe(false);
    expect(screen.getByText("Your plan is ready. Publish four videos this month.").closest("details")).toBeNull();
    expect(screen.getByRole("button", { name: "Good response" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
