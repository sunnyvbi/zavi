// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { LiveDecisionCard } from "./LiveDecisionCard";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";

const ID = "66666666-6666-4666-8666-666666666666";
const CONFIRM = "This turns on “Host Areas (copy)”: +$60/day. The 2 pauses in this move are still open, so your daily spend goes up by $60 until you approve them.";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = (over: Partial<LiveDecisionRow> = {}): LiveDecisionRow => ({
  id: ID,
  decision_class: "meta_ads.set_status_review",
  handler: "meta_ads.set_status_review",
  body: { object_id: "900", level: "adset", status: "ACTIVE", verified_name: "Host Areas (copy)", origin: "user_initiated_chat", founder_chat_order: true, move_group: "g" },
  status: "proposed",
  dispatched_at: null,
  dispatch_error: null,
  founder_advice: { warnings: [] },
  ...over,
});
const lookup = (r: LiveDecisionRow) => json(200, { decision: r, home: { kind: "growth" }, needs_owner_admin: false, viewer_role: "owner" });
const held = () => json(409, { error: { code: "paired_move_waits", message: "Approve the matching cut first.", run_alone: { message: CONFIRM, daily_add: 60, currency: "USD", open_legs: 2, why: "cut_untapped" } } });
const approveCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]).includes("/approve"));
const bodyOf = (c: unknown[]) => JSON.parse(String((c[1] as { body?: string } | undefined)?.body ?? "{}"));

afterEach(() => cleanup());
beforeEach(() => apiFetch.mockReset());

describe("LiveDecisionCard: a held raise of a paired move", () => {
  it("must-catch: Approve shows the confirm (no red error); Run it alone posts run_alone and the card runs", async () => {
    apiFetch
      .mockResolvedValueOnce(lookup(row()))
      .mockResolvedValueOnce(held())
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValue(lookup(row({ status: "approved" })));
    render(<LiveDecisionCard decisionId={ID} title="Meta Ads" surface="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn it on" }));
    expect(await screen.findByText(CONFIRM)).toBeTruthy();
    expect(screen.queryByText("Approve the matching cut first.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn it on" })).toBeNull();
    expect(bodyOf(approveCalls()[0]).run_alone).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Run it alone" }));
    await waitFor(() => expect(approveCalls()).toHaveLength(2));
    expect(bodyOf(approveCalls()[1])).toMatchObject({ run_alone: true });
    expect(await screen.findByText("Approved. Running it now.")).toBeTruthy();
    expect(screen.queryByTestId("run-alone-confirm")).toBeNull();
  });

  it("Cancel closes the confirm, posts nothing, and Approve / Reject come back", async () => {
    apiFetch.mockResolvedValueOnce(lookup(row())).mockResolvedValueOnce(held()).mockResolvedValue(lookup(row()));
    render(<LiveDecisionCard decisionId={ID} title="Meta Ads" surface="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn it on" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("run-alone-confirm")).toBeNull();
    expect(screen.getByRole("button", { name: "Turn it on" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(approveCalls()).toHaveLength(1);
  });

  it("must-not-touch: a paired_move_waits without a confirm (an older server) still shows its message", async () => {
    apiFetch
      .mockResolvedValueOnce(lookup(row()))
      .mockResolvedValueOnce(json(409, { error: { code: "paired_move_waits", message: "Approve the matching cut first." } }));
    render(<LiveDecisionCard decisionId={ID} title="Meta Ads" surface="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn it on" }));
    expect(await screen.findByText("Approve the matching cut first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run it alone" })).toBeNull();
  });
});
