// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
const openStatic = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
let role: string | null = "owner";
vi.mock("../../WorkspaceShell", () => ({ useWorkspace: () => ({ openAgentTab: vi.fn(), role }) }));
vi.mock("../../layout/shared", () => ({ useOpenStatic: () => openStatic }));
vi.mock("@/app/approvals/ApprovalsIsland", () => ({ DecisionBody: () => <div>decision body</div> }));

import { NeedsYouNow } from "./NeedsYouNow";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const row = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  agent_run_id: null,
  decision_class: "pm.needs_action",
  handler: "pm.needs_action",
  body: { rationale: `Ticket ${n}.` },
  status: "proposed",
  emitted_at: `2026-10-17T10:00:0${n}.000Z`,
  agent_slug: "pm",
  needs_owner_admin: false,
});

beforeEach(() => {
  role = "owner";
  apiFetch.mockReset();
  openStatic.mockReset();
});
afterEach(cleanup);

describe("NeedsYouNow", () => {
  it("reads the Needs-you home with true totals and shows the server's count", async () => {
    apiFetch.mockResolvedValue(
      json(200, { decisions: [1, 2, 3, 4, 5].map(row), next_cursor: "c", totals: { needs_you: 42, growth: 9, channel: 3 } }),
    );
    render(<NeedsYouNow />);
    expect(await screen.findByText("(42 Pending)")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith("/api/approvals?home=needs_you&count=1&limit=5");
    fireEvent.click(screen.getByRole("button", { name: /See all 42/ }));
    expect(openStatic).toHaveBeenCalledWith("needs-you");
  });

  it("an approve here lowers the count and is tagged needs_you", async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith("/api/approvals?home=")
        ? json(200, { decisions: [row(1), row(2)], next_cursor: null, totals: { needs_you: 2, growth: 0, channel: 0 } })
        : json(200, { ok: true }),
    );
    render(<NeedsYouNow />);
    await screen.findByText("(2 Pending)");
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(screen.getByText("(1 Pending)")).toBeTruthy());
    expect(apiFetch.mock.calls.some(([u]) => String(u).endsWith("/approve?surface=needs_you"))).toBe(true);
  });

  it("a failed read shows the error, never a zero", async () => {
    apiFetch.mockResolvedValue(json(500, {}));
    render(<NeedsYouNow />);
    expect(await screen.findByText(/Could not load this list \(HTTP 500\)\./)).toBeTruthy();
    expect(screen.queryByText(/Pending\)/)).toBeNull();
  });

  it("a Composio write or an owner-only row never gets a bare Approve; its live card opens in place (F3)", async () => {
    role = "member";
    const composio = { ...row(1), decision_class: "composio.moves_money", handler: "composio.execute_tool", body: { fingerprint: "f".repeat(64) } };
    const ownerOnly = { ...row(2), needs_owner_admin: true };
    apiFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/approvals?home=")) return json(200, { decisions: [composio, ownerOnly], next_cursor: null, totals: { needs_you: 2, growth: 0, channel: 0 } });
      const one = [composio, ownerOnly].find((d) => url === `/api/approvals/${d.id}`);
      if (one) return json(200, { decision: { ...one, dispatched_at: null, dispatch_error: null }, home: { kind: "needs_you" }, needs_owner_admin: true, viewer_role: "member" });
      return json(404, {});
    });
    render(<NeedsYouNow />);
    await screen.findByText("(2 Pending)");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await waitFor(() => expect(screen.getAllByText("Only an owner or admin can approve this")).toHaveLength(2));
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes("/approve"))).toBe(false);
  });

  it("a high-stakes row keeps its summary and consequences, with the live card as the only frame", async () => {
    role = "owner";
    const composio = { ...row(1), decision_class: "composio.moves_money", handler: "composio.execute_tool", body: { fingerprint: "f".repeat(64) } };
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith("/api/approvals?home=")
        ? json(200, { decisions: [composio, row(2)], next_cursor: null, totals: { needs_you: 2, growth: 0, channel: 0 } })
        : json(404, {}),
    );
    render(<NeedsYouNow />);
    await screen.findByText("(2 Pending)");
    const rows = screen.getAllByTestId("needs-you-now-row");
    const high = rows.find((r) => r.getAttribute("data-slip") === "header")!;
    expect(high.textContent).toContain("If approved");
    expect(high.textContent).toContain("If rejected");
    expect(rows.some((r) => r.getAttribute("data-slip") === "card")).toBe(true);
  });
});
