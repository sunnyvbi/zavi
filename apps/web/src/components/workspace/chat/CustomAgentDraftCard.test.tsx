// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomAgentDraftCard } from "./CustomAgentDraftCard";

const apiFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspaceOptional: () => null,
}));

const WARNING = "Works on its own and can use any tool your workspace has. Anything it does happens for real.";

const card = {
  kind: "draft" as const,
  draft: {
    name: "Standup bot",
    role: "",
    instructions: "Summarize yesterday.",
    tools: [],
    triggers: [{ kind: "schedule" as const, cron: "0 9 * * 1-5", tz: "America/Los_Angeles" }],
    deliver: { kind: "chat_thread", thread_id: "t1" },
  },
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === "/api/custom-agents" && init?.method === "POST") return ok({ agent: { id: "a1", status: "draft" } });
    if (url.endsWith("/test")) return ok({ run_id: "r1" });
    if (url.startsWith("/api/agents/runs/")) return ok({ run: { status: "running" } });
    return ok({});
  });
});
afterEach(cleanup);

describe("CustomAgentDraftCard", () => {
  it("shows the one honest line and no credit numbers", () => {
    const { container } = render(<CustomAgentDraftCard card={card} />);
    expect(screen.getByTestId("custom-agent-warning").textContent).toBe(WARNING);
    expect(container.textContent).not.toMatch(/credit/i);
    expect(container.textContent).not.toMatch(/Estimated cost/);
  });

  it("Test run asks an inline confirm first; Cancel starts nothing", async () => {
    render(<CustomAgentDraftCard card={card} />);
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    expect(screen.getByText("Run a test now? A test run is a real run, so anything it does happens too.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test run" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("custom-agent-test-confirm")).toBeNull();
    expect(screen.getByRole("button", { name: "Test run" })).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("Run test on the confirm starts the real run and says so without credits", async () => {
    render(<CustomAgentDraftCard card={card} />);
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/custom-agents/a1/test", { method: "POST", retryOnNetworkError: false }));
    expect(await screen.findByText("Testing… the result will show here.")).toBeTruthy();
    expect(screen.queryByText("This was a real run. The result is shown here only.")).toBeNull();
  });

  it("a watch refusal card shows the server's sentence and no Upgrade button (B2)", () => {
    render(
      <CustomAgentDraftCard
        card={{ kind: "refusal", refusal: { code: "watch_unobservable", message: "Zavi can only watch public web pages. https://10.0.0.5/ is a private address." } }}
      />,
    );
    expect(screen.getByText("Zavi can only watch public web pages. https://10.0.0.5/ is a private address.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade plan" })).toBeNull();
    expect(screen.queryByText("Ask your workspace owner to upgrade.")).toBeNull();
  });
});

describe("CustomAgentDraftCard test-run guard", () => {
  it("a double click on Run test starts exactly one real run", async () => {
    render(<CustomAgentDraftCard card={card} />);
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    const run = screen.getByRole("button", { name: "Run test" });
    act(() => {
      run.click();
      run.click();
    });
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u).endsWith("/test"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetch.mock.calls.filter(([u]) => String(u).endsWith("/test"))).toHaveLength(1);
  });
});

describe("CustomAgentDraftCard test result", () => {
  it("a finished test reads 'Test run · Finished' and its output is plain text", async () => {
    apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === "/api/custom-agents" && init?.method === "POST") return ok({ agent: { id: "a1", status: "draft" } });
      if (url.endsWith("/test")) return ok({ run_id: "r1" });
      if (url.startsWith("/api/agents/runs/"))
        return ok({ run: { status: "success", output_text: "## Daily summary\n**Shipped the fix.**\n[Zavi](https://zaviagent.com)" } });
      return ok({});
    });
    const { container } = render(<CustomAgentDraftCard card={card} />);
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByText(/Test run · Finished/)).toBeTruthy();
    await waitFor(() => expect(container.textContent).toContain("Zavi (https://zaviagent.com)"));
    expect(container.textContent).not.toContain("##");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).not.toMatch(/success/i);
  });
});
