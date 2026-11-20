import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposioWriteCardView, type ComposioDecisionRow } from "../ApprovalBlock";

const ID = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-09-25T12:00:00Z");
const row = (over: Partial<ComposioDecisionRow> = {}): ComposioDecisionRow => ({
  id: ID,
  decision_class: "composio.moves_money",
  handler: "composio.execute_tool",
  body: {
    kind: "composio_write",
    app_name: "Square",
    action: "Create refund",
    tool_slug: "SQUARE_CREATE_REFUND",
    arguments: { amount: 500, charge: "ch_1" },
    labels: ["moves_money"],
    fingerprint: "a".repeat(64),
  },
  status: "proposed",
  dispatched_at: null,
  dispatch_error: null,
  ...over,
});
const view = (r: ComposioDecisionRow, role: "owner" | "admin" | "member" | null = "owner") =>
  renderToStaticMarkup(
    <ComposioWriteCardView
      decisionId={ID}
      title="Square: Create refund"
      row={r}
      loadError={null}
      viewerRole={role}
      busy={false}
      actionError={null}
      onApprove={() => {}}
      onReject={() => {}}
      now={NOW}
    />,
  );

describe("in-chat Composio card", () => {
  it("pending: the full card (app, action, every field, red label) with Approve + Reject", () => {
    const html = view(row());
    expect(html).toContain("Square: Create refund");
    expect(html).toContain(">amount<");
    expect(html).toContain(">500<");
    expect(html).toContain(">ch_1<");
    expect(html).toContain("Moves money");
    expect(html).toMatch(/<button[^>]*>Approve<\/button>/);
    expect(html).toContain(">Reject<");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve/);
  });
  it("a member sees the card, but no Approve button, only the owner or admin reason", () => {
    const html = view(row(), "member");
    expect(html).toContain("Square: Create refund");
    expect(html).not.toMatch(/>Approve<\/button>/);
    expect(html).toContain("Only an owner or admin can approve this");
    expect(html).toContain(">Reject<");
  });
  it("a member can approve a plain Composio write", () => {
    const html = view(row({ decision_class: "composio.write", body: { ...row().body, labels: [] } }), "member");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve/);
    expect(html).not.toContain("Only the workspace owner");
  });
  it("a crashed write shows Outcome unknown, check <App>, and no Approve", () => {
    const html = view(row({ status: "dispatching", dispatched_at: "2026-09-25T11:30:00Z" }));
    expect(html).toContain("Outcome unknown, check Square.");
    expect(html).not.toContain(">Approve<");
  });
  it("a write still running shows no Approve and no Outcome unknown", () => {
    const html = view(row({ status: "dispatching", dispatched_at: "2026-09-25T11:59:00Z" }));
    expect(html).toContain("Running it now");
    expect(html).not.toContain("Outcome unknown");
    expect(html).not.toContain(">Approve<");
  });
  it("done / rejected / failed read plainly", () => {
    expect(view(row({ status: "acted" }))).toContain("Done.");
    expect(view(row({ status: "rejected" }))).toContain("Rejected. Nothing was changed.");
    expect(view(row({ status: "dispatch_failed", dispatch_error: "card_declined" }))).toContain("card_declined");
  });
});

describe("the in-chat Approve uses the checked path", () => {
  const src = readFileSync(join(__dirname, "../LiveDecisionCard.tsx"), "utf8");
  it("approves via approveDecision with the card's fingerprint (never an RPC)", () => {
    expect(src).toMatch(/approveDecision\(row\.id, liveApproveExtras\(row\)/);
    expect(src).toMatch(/\.\.\.approveExtrasFor\(/);
    expect(src).not.toMatch(/approve_decision/);
  });
});
