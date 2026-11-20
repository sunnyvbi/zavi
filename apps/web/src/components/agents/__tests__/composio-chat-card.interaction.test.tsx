// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  approveDecision: vi.fn(),
  rejectDecision: vi.fn(),
  row: null as Record<string, unknown> | null,
  reads: 0,
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts?: unknown) => {
    if (path === `/api/approvals/${ID}` && !opts) {
      m.reads++;
      return Promise.resolve(
        new Response(JSON.stringify({ decision: m.row, home: { kind: "needs_you" }, needs_owner_admin: false, viewer_role: "owner" }), { status: 200 }),
      );
    }
    return m.apiFetch(path, opts);
  },
}));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: m.approveDecision, rejectDecision: m.rejectDecision }));

import { ApprovalBlock } from "../ApprovalBlock";

const ID = "99999999-9999-4999-8999-999999999999";
const FP = "c".repeat(64);
const body = { decision_id: ID, decision_class: "composio.write", title: "Gmail: Send email" };

beforeEach(() => {
  m.apiFetch.mockReset();
  m.approveDecision.mockReset();
  m.rejectDecision.mockReset();
  m.reads = 0;
  m.row = {
    id: ID,
    decision_class: "composio.write",
    handler: "composio.execute_tool",
    status: "proposed",
    dispatched_at: null,
    dispatch_error: null,
    body: { kind: "composio_write", app_name: "Gmail", action: "Send email", arguments: { to: "a@b.co" }, labels: [], fingerprint: FP },
  };
});
afterEach(cleanup);

describe("in-chat Composio card", () => {
  it("Approve sends the card's fingerprint through approveDecision, never a bare approve", async () => {
    m.approveDecision.mockResolvedValue(new Response("{}", { status: 200 }));
    render(<ApprovalBlock body={body} viewerRole="owner" />);
    expect(await screen.findByText("a@b.co")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(m.approveDecision).toHaveBeenCalledWith(ID, { expected_fingerprint: FP }, undefined, { surface: "chat" }));
    expect(m.apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/approve"), expect.anything());
  });

  it("a stale card (409) shows the error and reloads the row", async () => {
    m.approveDecision.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "stale_card", message: "This card changed. Reload it and review again." } }), { status: 409 }),
    );
    render(<ApprovalBlock body={body} viewerRole="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("This card changed. Reload it and review again.")).toBeTruthy();
    expect(m.reads).toBeGreaterThanOrEqual(2);
  });

  it("Reject posts the reject endpoint", async () => {
    m.rejectDecision.mockResolvedValue(new Response("{}", { status: 200 }));
    render(<ApprovalBlock body={body} viewerRole="member" />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(m.rejectDecision).toHaveBeenCalledWith(ID, { surface: "chat" }));
    expect(m.approveDecision).not.toHaveBeenCalled();
  });
});
