// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ id }: { id: string }) => <div data-testid="email-card">{id}</div>,
}));
vi.mock("@/components/workspace/actions/BusinessControlsApprovalCard", () => ({
  BusinessControlsApprovalCard: ({ decisionId }: { decisionId: string }) => <div data-testid="bc-card">{decisionId}</div>,
}));

import { LiveDecisionCard, LIVE_DECISION_POLL_MS } from "./LiveDecisionCard";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";

const ID = "44444444-4444-4444-8444-444444444444";
const row = (decision_class: string, status: string): LiveDecisionRow => ({
  id: ID,
  decision_class,
  handler: decision_class,
  body: { name: "Spring promo", daily_budget_usd: 40 },
  status,
  dispatched_at: null,
  dispatch_error: null,
});
const serve = (r: LiveDecisionRow) =>
  apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ decision: r, home: { kind: "growth" }, needs_owner_admin: true, viewer_role: "owner" }), { status: 200, headers: { "content-type": "application/json" } }),
  );
const reads = () => apiFetch.mock.calls.filter((c) => c[0] === `/api/approvals/${ID}`).length;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  apiFetch.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe("a card with its own view is not polled underneath it", () => {
  it.each([
    ["email_campaign.create_and_send", "approved", "email-card"],
    ["email_campaign.create_and_send", "dispatching", "email-card"],
    ["bulk_outbound.send", "approved", "email-card"],
    ["growth.save_business_controls", "approved", "bc-card"],
  ])("%s %s: one read, then silence, class learned from the row", async (cls, status, testId) => {
    serve(row(cls, status));
    render(<LiveDecisionCard decisionId={ID} title="Campaign" surface="growth" />);
    expect(await screen.findByTestId(testId)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * LIVE_DECISION_POLL_MS);
    });
    expect(reads()).toBe(1);
  });

  it("the class handed in as a prop polls no more than the one read", async () => {
    serve(row("email_campaign.create_and_send", "approved"));
    render(<LiveDecisionCard decisionId={ID} title="Campaign" surface="growth" decisionClass="email_campaign.create_and_send" />);
    expect(await screen.findByTestId("email-card")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * LIVE_DECISION_POLL_MS);
    });
    expect(reads()).toBeLessThanOrEqual(1);
  });

  it("control: a running card of any other class still re-reads", async () => {
    serve({ ...row("composio.write", "approved"), handler: "composio.execute_tool" });
    render(<LiveDecisionCard decisionId={ID} title="Meta" surface="growth" />);
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_DECISION_POLL_MS);
      });
    }
    expect(reads()).toBeGreaterThan(2);
  });
});
