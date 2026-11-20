import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposioWriteCardView, type ComposioDecisionRow } from "../ApprovalBlock";
import { isExactActionCard, outcomeAppName } from "@/app/approvals/approvalsHelpers";

const ID = "55555555-5555-4555-8555-555555555555";
const NOW = Date.parse("2026-09-27T12:00:00Z");
const view = (row: ComposioDecisionRow, role: "owner" | "admin" | "member" | null = "owner") =>
  renderToStaticMarkup(
    <ComposioWriteCardView decisionId={ID} title="t" row={row} loadError={null} viewerRole={role} busy={false} actionError={null} onApprove={() => {}} onReject={() => {}} now={NOW} />,
  );
const row = (decision_class: string, handler: string, body: Record<string, unknown>, over: Partial<ComposioDecisionRow> = {}): ComposioDecisionRow => ({
  id: ID, decision_class, handler, body: { ...body, governed_by: "chokepoint" }, status: "proposed", dispatched_at: null, dispatch_error: null, ...over,
});

describe("exact-action cards on the live surface", () => {
  it("a Jira card shows its exact fields with Approve", () => {
    const html = view(row("create_jira_issue", "jira.create_issue", { project_key: "OPS", issue_type: "Task", summary: "Refund stuck", description_markdown: "Details" }));
    expect(html).toContain(">Project<");
    expect(html).toContain(">OPS<");
    expect(html).toContain(">Refund stuck<");
    expect(html).toMatch(/<button[^>]*>Approve<\/button>/);
  });

  it("a charge shows amount and fee; an admin may approve, a member may not", () => {
    const charge = row("stripe.create_payment", "stripe.create_payment", { amount: 1999, currency: "usd", application_fee_amount: 100, client_reference: "order-7", fingerprint: "f".repeat(64) });
    const admin = view(charge, "admin");
    expect(admin).toContain(">19.99 USD<");
    expect(admin).toContain("Moves money");
    expect(admin).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve/);
    const member = view(charge, "member");
    expect(member).not.toMatch(/>Approve<\/button>/);
    expect(member).toContain("Only an owner or admin can approve this");
  });

  it("a payout whose outcome is unknown says to check Stripe", () => {
    const html = view(row("stripe.remit_to_tenant", "stripe.remit_to_tenant", { client_reference: "order-7", currency: "usd", net_minor: 8500, gross_minor: 10000, reserve_minor: 1000, fee_minor: 500 }, { status: "dispatching", dispatched_at: "2026-09-27T11:00:00Z" }));
    expect(html).toContain("Outcome unknown, check Stripe.");
  });
});

describe("isExactActionCard / outcomeAppName", () => {
  it("chokepoint cards and email cards are exact; other bodies are not", () => {
    expect(isExactActionCard("create_jira_issue", { governed_by: "chokepoint" })).toBe(true);
    expect(isExactActionCard("send_email", { to: "a@b.co", subject: "s", body_text: "x" })).toBe(true);
    expect(isExactActionCard("create_jira_issue", { project_key: "OPS", rationale: "x" })).toBe(false);
    expect(isExactActionCard("send_email", { rendered_markdown: "x" })).toBe(false);
  });
  it("names the app to check", () => {
    expect(outcomeAppName("stripe.remit_to_tenant", {})).toBe("Stripe");
    expect(outcomeAppName("github.open_pr_direct", {})).toBe("GitHub");
    expect(outcomeAppName("composio.write", { app_name: "Square" })).toBe("Square");
    expect(outcomeAppName("something.else", {})).toBe("the app");
  });
});

describe("channel panel card shows the exact action too", () => {
  it("an exact-action card lists its fields; any other body is unchanged", async () => {
    const { InlineActionBody, hasInlineBody } = await import("@/components/workspace/layout/InlineActionBody");
    const jira = { decision_class: "create_jira_issue", body: { governed_by: "chokepoint", project_key: "OPS", summary: "Refund stuck", description_markdown: "Line 1\nLine 2" } };
    expect(hasInlineBody(jira)).toBe(true);
    const html = renderToStaticMarkup(<InlineActionBody decision={jira} />);
    expect(html).toContain(">Project<");
    expect(html).toContain(">OPS<");
    expect(html).toContain("Line 1\nLine 2");
    const other = { decision_class: "create_jira_issue", body: { project_key: "OPS", rationale: "x" } };
    expect(hasInlineBody(other)).toBe(false);
  });
});

describe("a stopped run's card stays, marked", () => {
  it("the full card shows the note while pending", async () => {
    const r = row("create_jira_issue", "jira.create_issue", { project_key: "OPS", summary: "s" });
    const html = renderToStaticMarkup(
      <ComposioWriteCardView decisionId={ID} title="t" row={r} loadError={null} viewerRole="owner" busy={false} actionError={null} onApprove={() => {}} onReject={() => {}} now={NOW} runStopped />,
    );
    expect(html).toContain("This run was stopped.");
    expect(html).toMatch(/<button[^>]*>Approve<\/button>/);
  });
  it("the plain card shows the note; an unmarked card does not", async () => {
    const { ApprovalBlock } = await import("../ApprovalBlock");
    const marked = renderToStaticMarkup(<ApprovalBlock body={{ decision_id: "d", decision_class: "operator.file-jira-issue", title: "File a Jira issue", run_stopped: true }} />);
    expect(marked).toContain("This run was stopped.");
    const plain = renderToStaticMarkup(<ApprovalBlock body={{ decision_id: "d", decision_class: "operator.file-jira-issue", title: "File a Jira issue" }} />);
    expect(plain).not.toContain("This run was stopped.");
  });
});
