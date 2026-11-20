// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { LiveDecisionCard, LiveDecisionCardView } from "../LiveDecisionCard";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";

const ID = "55555555-5555-4555-8555-555555555555";
const raise = (over: Partial<LiveDecisionRow> = {}): LiveDecisionRow => ({
  id: ID,
  decision_class: "google_ads.update_campaign_budget_review",
  handler: null,
  body: { campaign_id: "c1", campaign_name: "Sales Search", daily_budget_usd: 150, expected_current_daily_budget_usd: 120 },
  status: "proposed",
  dispatched_at: null,
  dispatch_error: null,
  ...over,
});
const view = (row: LiveDecisionRow) =>
  render(<LiveDecisionCardView decisionId={ID} title="Google Ads" row={row} loadError={null} viewerRole="owner" busy={false} actionError={null} onApprove={() => {}} onReject={() => {}} />);

afterEach(() => cleanup());
beforeEach(() => apiFetch.mockReset());

describe("Transfer slip on LiveDecisionCard", () => {
  it("waiting: the slab leads with the new daily budget, platform and status; one primary that names it", () => {
    view(raise());
    const slab = screen.getByTestId("slip-slab");
    expect(slab.getAttribute("data-stage")).toBe("waiting");
    expect(within(slab).getByTestId("slip-amount").textContent).toBe("$150");
    expect(slab.textContent).toContain("Google Ads");
    expect(slab.textContent).toContain("+$30/day");
    expect(screen.getByTestId("slip-status").textContent).toBe("Needs your yes");
    expect(screen.getByRole("button", { name: "Approve $150/day" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("approved but not yet handed over is 'queued', never 'sent'; dispatching is sending", () => {
    view(raise({ status: "approved" }));
    expect(screen.getByTestId("slip-status").textContent).toBe("Approved");
    expect(screen.getByTestId("slip-tracker").textContent).toContain("Queued, about to send");
    cleanup();
    view(raise({ status: "dispatching", dispatched_at: new Date().toISOString() }));
    expect(screen.getByTestId("slip-status").textContent).toBe("Sending");
    expect(screen.getByTestId("slip-tracker").textContent).toContain("Working on it");
  });

  it("done: the receipt shows the change and the monthly budget the approve wrote, nothing else", () => {
    view(raise({ status: "acted", body: { ...raise().body, budget_choice: { at: "x", hold_idem: "k:raise", monthly_usd: 28400, daily_limit_usd: null } } }));
    expect(screen.getByTestId("slip-status").textContent).toBe("Done");
    const receipt = screen.getByTestId("slip-receipt");
    expect(receipt.textContent).toContain("$120");
    expect(receipt.textContent).toContain("$150/day");
    expect(screen.getByTestId("slip-limits-now").textContent).toContain("Monthly ad budget$28,400");
    expect(receipt.textContent).not.toContain("k:raise");
  });

  it("failed never claims the old budget stayed, and does not blame the platform", () => {
    view(raise({ status: "dispatch_failed", dispatch_error: "kill_switch" }));
    const slab = screen.getByTestId("slip-slab");
    expect(slab.textContent).not.toContain("Stays at");
    expect(slab.textContent).toContain("You asked for");
    expect(screen.getByTestId("slip-tracker").textContent).toContain("Stopped with an error");
    expect(screen.getByTestId("slip-tracker").textContent).not.toMatch(/didn't go through|nothing changed/i);
    expect(screen.getByTestId("slip-tracker").textContent).not.toContain("said no");
  });

  it("rejected says the old budget stays", () => {
    view(raise({ status: "rejected" }));
    expect(screen.getByTestId("slip-slab").textContent).toContain("Stays at");
    expect(screen.getByTestId("slip-amount").textContent).toBe("$120");
  });

  it("a member sees why, not a button", () => {
    render(
      <LiveDecisionCardView decisionId={ID} title="t" row={raise()} loadError={null} viewerRole="member" needsOwnerAdmin busy={false} actionError={null} onApprove={() => {}} onReject={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(screen.getByText("Only an owner or admin can approve this")).toBeTruthy();
  });

  it("a re-mounted card draws the row its list holds at once (no Loading flash), then re-reads", async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ decision: raise({ status: "acted" }), home: { kind: "growth" }, needs_owner_admin: false, viewer_role: "owner" }), { status: 200 }));
    render(<LiveDecisionCard decisionId={ID} title="t" surface="needs_you" initialRow={raise({ status: "approved" })} />);
    expect(screen.queryByText("Loading the action…")).toBeNull();
    expect(screen.getByTestId("slip-status").textContent).toBe("Approved");
    expect((await screen.findByTestId("slip-receipt")).textContent).toContain("$150/day");
  });

  it("a card that is gone says so, even when its list still held a row", async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }));
    render(<LiveDecisionCard decisionId={ID} title="t" surface="needs_you" initialRow={raise()} />);
    expect(await screen.findByText("This card is not in your list any more.")).toBeTruthy();
  });
});
