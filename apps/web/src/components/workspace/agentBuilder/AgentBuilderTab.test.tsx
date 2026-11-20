// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  routes: {} as Record<string, unknown>,
  calls: [] as Array<{ path: string; method: string; body?: string }>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts?: { method?: string; body?: string }) => {
    const method = opts?.method ?? "GET";
    api.calls.push({ path, method, body: opts?.body });
    const key = `${method} ${path}`;
    const body = key in api.routes ? api.routes[key] : api.routes[path];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  },
}));

const ws = vi.hoisted(() => ({
  role: "owner" as string,
  seedComposer: vi.fn(),
  openAgentTab: vi.fn(),
  openTab: vi.fn(),
  openStatic: vi.fn(),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    role: ws.role,
    seedComposer: ws.seedComposer,
    openAgentTab: ws.openAgentTab,
    openTab: ws.openTab,
  }),
}));
vi.mock("../layout/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../layout/shared")>()),
  useOpenStatic: () => ws.openStatic,
  useModalFocusTrap: () => {},
}));
vi.mock("@/lib/workspace/openBilling", () => ({ openBillingSettings: vi.fn() }));

import { AgentBuilderTab } from "./AgentBuilderTab";

const ID = "44444444-4444-4444-8444-444444444444";
const agent = {
  id: ID,
  slug: "c-aaaaaaaa01",
  name: "Daily standup",
  role: "Writes my morning standup",
  instructions: "Every weekday, tell me what Zavi did since yesterday.",
  deliver: { kind: "chat_thread", thread_id: "t" },
  status: "active",
  paused_reason: null,
  triggers: [
    { id: "t1", kind: "schedule", cron: "0 9 * * 1-5", tz: "America/Los_Angeles", interval_minutes: null, condition: null, enabled: true, next_due_at: null },
  ],
  last_run: { id: "r1", status: "success", test: false, enqueued_at: "2026-09-25T16:00:00Z", finished_at: "2026-09-25T16:01:00Z", summary: "3 things changed" },
};

beforeEach(() => {
  api.routes = {};
  api.calls = [];
  ws.role = "owner";
  ws.seedComposer.mockReset();
  ws.openAgentTab.mockReset();
  ws.openStatic.mockReset();
});
afterEach(cleanup);

describe("the list", () => {
  it("renders a row per agent from the API", async () => {
    api.routes["/api/custom-agents"] = { agents: [agent], refusal: null };
    render(<AgentBuilderTab agentId={null} />);
    expect(await screen.findByText("Daily standup")).toBeTruthy();
    expect(screen.getByText("Weekdays at 9:00 AM (PT)")).toBeTruthy();
    expect(screen.getByText("This conversation")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(ws.openStatic).toHaveBeenCalledWith("agent-builder", { agentId: ID });
  });

  it("a draft (Test run from a chat card, never Created) is not listed", async () => {
    api.routes["/api/custom-agents"] = {
      agents: [agent, { ...agent, id: "draft-1", slug: "c-dddddddd01", name: "Half-made agent", status: "draft", last_run: null }],
      refusal: null,
    };
    render(<AgentBuilderTab agentId={null} />);
    await screen.findByText("Daily standup");
    expect(screen.queryByText("Half-made agent")).toBeNull();
    expect(screen.getAllByTestId("agent-row")).toHaveLength(1);
  });

  it("empty: the same table with one row of empty slots and an Add chip", async () => {
    api.routes["/api/custom-agents"] = { agents: [], refusal: null };
    render(<AgentBuilderTab agentId={null} />);
    await screen.findByTestId("agent-row-empty");
    expect(screen.getByText("No agents yet")).toBeTruthy();
    expect(screen.getAllByText("Not set")).toHaveLength(2);
    expect(screen.getByText("Not run yet")).toBeTruthy();
    expect(screen.getByText("Not scheduled")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "When it runs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Add an agent" }));
    expect(document.activeElement?.id).toBe("agent-ask");
  });

  it("Draft agent sends the ask to a new operator chat", async () => {
    api.routes["/api/custom-agents"] = { agents: [], refusal: null };
    render(<AgentBuilderTab agentId={null} />);
    await screen.findByTestId("agent-row-empty");
    fireEvent.change(screen.getByLabelText("What should your agent do?"), { target: { value: "Every Monday check competitors" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft agent" }));
    expect(ws.seedComposer).toHaveBeenCalledWith({
      agentSlug: "operator",
      text: "Every Monday check competitors",
      thread: "new",
      autoSend: true,
    });
  });

  const refusal = { code: "plan_upgrade_required", message: "Custom agents are available on paid plans.", required_tier: "starter" };

  it("Free, owner: the refusal and Upgrade plan instead of Draft agent", async () => {
    api.routes["/api/custom-agents"] = { agents: [], refusal };
    render(<AgentBuilderTab agentId={null} />);
    expect(await screen.findByText("Custom agents are available on paid plans.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upgrade plan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Draft agent" })).toBeNull();
  });

  it("Free, member: asks the owner, no Upgrade button", async () => {
    ws.role = "member";
    api.routes["/api/custom-agents"] = { agents: [], refusal };
    render(<AgentBuilderTab agentId={null} />);
    expect(await screen.findByText("Custom agents are available on paid plans. Ask your workspace owner to upgrade.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade plan" })).toBeNull();
    expect((screen.getByRole("button", { name: "Draft agent" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the detail page", () => {
  beforeEach(() => {
    api.routes["/api/custom-agents"] = { agents: [agent], refusal: null };
    api.routes[`/api/custom-agents/${ID}/runs`] = {
      runs: [{ id: "r1", status: "success", test: false, enqueued_at: "2026-09-25T16:00:00Z", finished_at: null, summary: "2 changes made on Meta." }],
    };
    api.routes[`/api/custom-agents/${ID}/receipts?run_id=r1&limit=200`] = {
      receipts: [{ id: "x1", run_id: "r1", tool_name: "praxis__action", decision_class: "meta_ads.budget_change", outcome: "succeeded" }],
      next_cursor: "2026-09-25T16:00:00Z,aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    api.routes[
      `/api/custom-agents/${ID}/receipts?run_id=r1&limit=200&before=${encodeURIComponent("2026-09-25T16:00:00Z,aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}`
    ] = {
      receipts: [{ id: "x2", run_id: "r1", tool_name: "slack__post_message", decision_class: null, outcome: "succeeded" }],
      next_cursor: null,
    };
    api.routes["/api/agents/runs/r1"] = { run: { status: "success", output_text: "Raised the budget on Spring promo." } };
    api.routes[`/api/custom-agents/${ID}/notes`] = {
      notes: [{ id: "n1", text: "Spend held at $40 a day.", run_id: "r1", created_at: "2026-09-25T16:00:00Z" }],
    };
  });

  it("shows the header, warning and every section", async () => {
    render(<AgentBuilderTab agentId={ID} />);
    expect(await screen.findByRole("heading", { name: /Daily standup/ })).toBeTruthy();
    expect(screen.getByText("All agents")).toBeTruthy();
    expect(
      screen.getByText("Works on its own and can use any tool your workspace has. Anything it does happens for real."),
    ).toBeTruthy();
    for (const label of ["Test run", "Edit", "Pause", "Archive"]) {
      expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Setup")).toBeTruthy();
    expect(screen.getByText("When it runs:")).toBeTruthy();
    expect(screen.getByText("Sends results to:")).toBeTruthy();
    expect(screen.getByText("Run history")).toBeTruthy();
    expect(await screen.findByText("2 changes made on Meta.")).toBeTruthy();
    expect(await screen.findByText("Meta ads budget change")).toBeTruthy();
    expect(screen.getByText("Acts on its own. Every action is listed here.")).toBeTruthy();
    expect(await screen.findByText("Post message")).toBeTruthy();
    expect(screen.getByText("Saved to the brain")).toBeTruthy();
    expect(await screen.findByText("Spend held at $40 a day.")).toBeTruthy();
    expect(screen.getByText("Chat with this agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chat with Daily standup" }));
    expect(ws.openAgentTab).toHaveBeenCalledWith("c-aaaaaaaa01", { push: true });
  });

  it("Open result expands the run's output in place and collapses again", async () => {
    render(<AgentBuilderTab agentId={ID} />);
    const btn = await screen.findByRole("button", { name: "Open result" });
    expect(screen.queryByTestId("run-result")).toBeNull();
    fireEvent.click(btn);
    expect(await screen.findByText("Raised the budget on Spring promo.")).toBeTruthy();
    expect(api.calls.some((c) => c.path === "/api/agents/runs/r1")).toBe(true);
    fireEvent.click(btn);
    expect(screen.queryByTestId("run-result")).toBeNull();
  });

  it("a failed receipts read says so on the run row, never an empty list", async () => {
    delete api.routes[`/api/custom-agents/${ID}/receipts?run_id=r1&limit=200`];
    render(<AgentBuilderTab agentId={ID} />);
    expect(await screen.findByText("Couldn’t load this run’s actions.")).toBeTruthy();
    expect(screen.queryByText("Meta ads budget change")).toBeNull();
    expect(screen.queryByText("Acts on its own. Every action is listed here.")).toBeNull();
  });

  it("Open result on a run still going says Still running, then shows the output once it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.routes["/api/agents/runs/r1"] = { run: { status: "running", output_text: null } };
      render(<AgentBuilderTab agentId={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open result" }));
      expect(await screen.findByText("Still running.")).toBeTruthy();
      expect(screen.queryByText("The run finished without any output.")).toBeNull();
      api.routes["/api/agents/runs/r1"] = { run: { status: "success", output_text: "" } };
      await vi.advanceTimersByTimeAsync(3100);
      expect(await screen.findByText("The run finished without any output.")).toBeTruthy();
      const reads = api.calls.filter((c) => c.path === "/api/agents/runs/r1").length;
      await vi.advanceTimersByTimeAsync(6500);
      expect(api.calls.filter((c) => c.path === "/api/agents/runs/r1").length).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Test run asks first, and Cancel starts nothing", async () => {
    render(<AgentBuilderTab agentId={ID} />);
    await screen.findByRole("heading", { name: /Daily standup/ });
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    expect(screen.getByText("Run a test now? A test run is a real run, so anything it does happens too.")).toBeTruthy();
    expect(api.calls.some((c) => c.path.endsWith("/test"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Run a test now? A test run is a real run, so anything it does happens too.")).toBeNull();
    expect(api.calls.some((c) => c.path.endsWith("/test"))).toBe(false);
  });

  it("Run test starts the real run only after the confirm", async () => {
    api.routes[`POST /api/custom-agents/${ID}/test`] = { run_id: "r9" };
    api.routes["/api/agents/runs/r9"] = { run: { status: "running" } };
    render(<AgentBuilderTab agentId={ID} />);
    await screen.findByRole("heading", { name: /Daily standup/ });
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/test"))).toBe(true));
  });

  it("Archive asks first; brain notes keep a real Delete", async () => {
    render(<AgentBuilderTab agentId={ID} />);
    await screen.findByRole("heading", { name: /Daily standup/ });
    expect(await screen.findByRole("button", { name: "Delete" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText('Archive "Daily standup"?')).toBeTruthy();
    expect(screen.getByText("It stops running. Its run history and receipts are kept, and you can unarchive it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive agent" })).toBeTruthy();
  });

  it("a double click on Run test starts exactly one real run", async () => {
    api.routes[`POST /api/custom-agents/${ID}/test`] = { run_id: "r9" };
    api.routes["/api/agents/runs/r9"] = { run: { status: "running" } };
    render(<AgentBuilderTab agentId={ID} />);
    await screen.findByRole("heading", { name: /Daily standup/ });
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    const run = screen.getByRole("button", { name: "Run test" });
    act(() => {
      run.click();
      run.click();
    });
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/test"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/test"))).toHaveLength(1);
  });

  it("a run row says Test run, and a failed run says why in plain words", async () => {
    api.routes[`/api/custom-agents/${ID}/runs`] = {
      runs: [
        { id: "r2", status: "dispatch_error", test: true, enqueued_at: "2026-09-25T16:00:00Z", finished_at: null, summary: null, failure: "Stopped: the agent was paused before it ran." },
      ],
    };
    render(<AgentBuilderTab agentId={ID} />);
    expect(await screen.findByText("Stopped: the agent was paused before it ran.")).toBeTruthy();
    expect(screen.getAllByText("Test run").some((el) => el.tagName === "SPAN")).toBe(true);
  });

  it("the opened result is plain text: heading marks and bold marks are gone", async () => {
    api.routes["/api/agents/runs/r1"] = { run: { status: "success", output_text: "## Standup\n- **Raised** the budget by 10%" } };
    render(<AgentBuilderTab agentId={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open result" }));
    const out = await screen.findByTestId("run-result");
    await waitFor(() => expect(out.textContent).toContain("Standup"));
    expect(out.textContent).not.toContain("##");
    expect(out.textContent).not.toContain("**");
    expect(out.textContent).toContain("• Raised the budget by 10%");
  });

  it("paused by the viewer reads 'Paused by you on <date>'; an auto pause keeps its reason", async () => {
    api.routes["/api/custom-agents"] = {
      agents: [{ ...agent, status: "paused", paused_reason: "x", paused_at: "2026-09-26T18:00:00Z", paused_by_self: true, paused_by_name: null }],
      refusal: null,
    };
    const one = render(<AgentBuilderTab agentId={ID} />);
    expect(await screen.findByText(/^Paused by you on Sep 2[67]$/)).toBeTruthy();
    one.unmount();
    api.routes["/api/custom-agents"] = {
      agents: [{ ...agent, status: "paused", paused_reason: "Paused after 3 runs in a row did not finish.", paused_by_self: false, paused_by_name: null }],
      refusal: null,
    };
    render(<AgentBuilderTab agentId={ID} />);
    expect(await screen.findByText("Paused after 3 runs in a row did not finish.")).toBeTruthy();
  });

  it("schedule box: typed words preview, then Save sends only the new schedule", async () => {
    api.routes["POST /api/custom-agents/schedule-preview"] = {
      ok: true, cron: "0 10 * * 1-5", tz: "America/Los_Angeles", label: "Weekdays at 10:00 AM (PT)",
      next: ["2026-09-28T17:00:00Z", "2026-09-29T17:00:00Z", "2026-09-30T17:00:00Z"],
    };
    api.routes[`PATCH /api/custom-agents/${ID}`] = { agent };
    render(<AgentBuilderTab agentId={ID} />);
    await screen.findByRole("heading", { name: /Daily standup/ });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Now: Weekdays at 9:00 AM (PT)")).toBeTruthy();
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("When it runs"), { target: { value: "weekdays at 10am" } });
    expect(await screen.findByText("Weekdays at 10:00 AM (PT)")).toBeTruthy();
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());
    await waitFor(() => expect(api.calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = api.calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(patch.body!)).toEqual({ schedule_cron: "0 10 * * 1-5" });
  });

  it("schedule box: unreadable words block Save; an empty box never blocks an instructions edit", async () => {
    api.routes["POST /api/custom-agents/schedule-preview"] = {
      ok: false, message: "Try something like 'weekdays at 10am' or 'every Monday at 9am'.",
    };
    api.routes[`PATCH /api/custom-agents/${ID}`] = { agent };
    render(<AgentBuilderTab agentId={ID} />);
    await screen.findByRole("heading", { name: /Daily standup/ });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "New words." } });
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("When it runs"), { target: { value: "every other thursday" } });
    expect(await screen.findByText("Try something like 'weekdays at 10am' or 'every Monday at 9am'.")).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("When it runs"), { target: { value: "" } });
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());
    await waitFor(() => expect(api.calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(api.calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ instructions: "New words." });
  });

  it("empty history and brain keep their slots", async () => {
    api.routes[`/api/custom-agents/${ID}/runs`] = { runs: [] };
    api.routes[`/api/custom-agents/${ID}/notes`] = { notes: [] };
    render(<AgentBuilderTab agentId={ID} />);
    expect(await screen.findByText("Runs show here with their result.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Test run" })).toBeTruthy();
    expect(await screen.findByText("No notes saved yet")).toBeTruthy();
  });
});

describe("no credits anywhere", () => {
  it("neither the list nor the detail page mentions credits", async () => {
    api.routes["/api/custom-agents"] = { agents: [agent], refusal: null };
    api.routes[`/api/custom-agents/${ID}/runs`] = { runs: [] };
    api.routes[`/api/custom-agents/${ID}/notes`] = { notes: [] };
    const list = render(<AgentBuilderTab agentId={null} />);
    await screen.findByText("Daily standup");
    expect(list.container.textContent?.toLowerCase()).not.toContain("credit");
    list.unmount();
    const detail = render(<AgentBuilderTab agentId={ID} />);
    await screen.findByText("No notes saved yet");
    expect(detail.container.textContent?.toLowerCase()).not.toContain("credit");
  });

  it("the component source never says credit", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "AgentBuilderTab.tsx"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      .toLowerCase();
    expect(src).not.toContain("credit");
  });
});

describe("Archived list (decision 43)", () => {
  it("shows the archived count; Unarchive calls the route and refreshes both lists", async () => {
    api.routes["/api/custom-agents"] = { agents: [agent], refusal: null };
    api.routes["/api/custom-agents?status=archived"] = {
      agents: [{ ...agent, id: "55555555-5555-4555-8555-555555555555", name: "Old digest", status: "archived" }],
    };
    api.routes["POST /api/custom-agents/55555555-5555-4555-8555-555555555555/unarchive"] = { agent: { ...agent, status: "paused" } };
    render(<AgentBuilderTab agentId={null} />);
    const toggle = await screen.findByRole("button", { name: "Archived (1)" });
    fireEvent.click(toggle);
    expect(screen.getByText("Old digest")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" , description: "Old digest" })).toBeNull();
    const before = api.calls.filter((c) => c.path === "/api/custom-agents").length;
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/unarchive"))).toBe(true),
    );
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/custom-agents").length).toBeGreaterThan(before));
  });
});

describe("QA bug round (2026-09-27)", () => {
  it("B7: the 'Agent archived' banner clears when that agent is unarchived", async () => {
    const OLD = "55555555-5555-4555-8555-555555555555";
    api.routes["/api/custom-agents"] = { agents: [agent], refusal: null };
    api.routes[`/api/custom-agents/${ID}/runs`] = { runs: [] };
    api.routes[`/api/custom-agents/${ID}/notes`] = { notes: [] };
    api.routes[`POST /api/custom-agents/${ID}/status`] = { agent: { ...agent, status: "archived" } };
    api.routes["/api/custom-agents?status=archived"] = { agents: [{ ...agent, id: OLD, name: "Old digest", status: "archived" }] };
    api.routes[`POST /api/custom-agents/${OLD}/unarchive`] = { agent: { ...agent, id: OLD, status: "paused" } };
    const view = render(<AgentBuilderTab agentId={ID} />);
    await screen.findByRole("heading", { name: /Daily standup/ });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive agent" }));
    await waitFor(() => expect(ws.openStatic).toHaveBeenCalledWith("agent-builder", { agentId: null }));
    view.rerender(<AgentBuilderTab agentId={null} />);
    expect(await screen.findByText("Agent archived")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Archived (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(screen.queryByText("Agent archived")).toBeNull());
  });

  it("B15: an open result's button reads Hide result", async () => {
    api.routes["/api/custom-agents"] = { agents: [agent], refusal: null };
    api.routes[`/api/custom-agents/${ID}/runs`] = {
      runs: [{ id: "r1", status: "success", test: true, enqueued_at: "2026-09-25T16:00:00Z", finished_at: null, summary: "Done." }],
    };
    api.routes[`/api/custom-agents/${ID}/notes`] = { notes: [] };
    api.routes["/api/agents/runs/r1"] = { run: { status: "success", output_text: "Done." } };
    render(<AgentBuilderTab agentId={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open result" }));
    expect(await screen.findByRole("button", { name: "Hide result" })).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
  });
});

describe("one run's results page (?run=)", () => {
  const RUN = "55555555-5555-4555-8555-555555555555";
  const OTHER = "66666666-6666-4666-8666-666666666666";
  const runs = [
    { id: RUN, status: "success", test: false, enqueued_at: "2026-09-29T16:00:00Z", finished_at: "2026-09-29T16:04:00Z", summary: "10 TikTok videos" },
    { id: OTHER, status: "error", test: false, enqueued_at: "2026-09-28T16:00:00Z", finished_at: "2026-09-28T16:02:00Z", summary: null, failure: "A tool was down." },
  ];
  const setup = (run: Record<string, unknown>) => {
    api.routes["/api/custom-agents"] = { agents: [agent], refusal: null };
    api.routes[`/api/custom-agents/${ID}/runs`] = { runs };
    api.routes[`/api/agents/runs/${RUN}`] = { run };
  };

  it("renders the result as markdown (tables kept) with the earlier runs and schedule", async () => {
    setup({ status: "success", agent_slug: agent.slug, output_text: "## TikTok\n\n| # | Video |\n|---|---|\n| 1 | S550 |\n\n```watch_result\n{}\n```" });
    render(<AgentBuilderTab agentId={ID} runId={RUN} />);
    const result = await screen.findByTestId("run-results");
    await waitFor(() => expect(result.querySelector("table")).toBeTruthy());
    expect(result.textContent).toContain("S550");
    expect(result.textContent).not.toContain("watch_result");
    expect(screen.getAllByTestId("earlier-run")).toHaveLength(2);
    expect(screen.getByText("This conversation, and by email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chat with this agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agent settings" })).toBeTruthy();
  });

  it("a run of another agent in the same workspace reads as not found", async () => {
    setup({ status: "success", agent_slug: "c-someoneelse", output_text: "private" });
    render(<AgentBuilderTab agentId={ID} runId={RUN} />);
    expect(await screen.findByText(/Couldn’t find this run/)).toBeTruthy();
    expect(screen.queryByText("private")).toBeNull();
  });

  it("a failed run keeps the layout and says why, with no result", async () => {
    api.routes["/api/custom-agents"] = { agents: [agent], refusal: null };
    api.routes[`/api/custom-agents/${ID}/runs`] = { runs };
    api.routes[`/api/agents/runs/${OTHER}`] = { run: { status: "error", agent_slug: agent.slug, output_text: null } };
    render(<AgentBuilderTab agentId={ID} runId={OTHER} />);
    expect(await screen.findByText("A tool was down.")).toBeTruthy();
    expect(screen.getByText("Earlier runs")).toBeTruthy();
  });

  it("picking an earlier run and Agent settings navigate through the tab", async () => {
    setup({ status: "success", agent_slug: agent.slug, output_text: "ok" });
    render(<AgentBuilderTab agentId={ID} runId={RUN} />);
    const rows = await screen.findAllByTestId("earlier-run");
    fireEvent.click(rows[1]!);
    expect(ws.openStatic).toHaveBeenCalledWith("agent-builder", { agentId: ID, runId: OTHER });
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(ws.openStatic).toHaveBeenCalledWith("agent-builder", { agentId: ID });
  });

  it("the agent page links each run to its results page", async () => {
    setup({ status: "success", agent_slug: agent.slug, output_text: "ok" });
    render(<AgentBuilderTab agentId={ID} />);
    const links = await screen.findAllByRole("button", { name: "Open results page" });
    fireEvent.click(links[0]!);
    expect(ws.openStatic).toHaveBeenCalledWith("agent-builder", { agentId: ID, runId: RUN });
  });
});
