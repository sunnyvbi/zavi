// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ADVICE_PENDING_LINE, ADVICE_POLL_MS, ADVICE_UNAVAILABLE_LINE, LiveDecisionCard, SUPERSEDED_LINE, liveDecisionNotes } from "./LiveDecisionCard";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";

const ID = "55555555-5555-4555-8555-555555555555";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const cut = (over: Partial<LiveDecisionRow> = {}): LiveDecisionRow => ({
  id: ID,
  decision_class: "google_ads.update_campaign_budget_review",
  handler: "google_ads.update_campaign_budget_review",
  body: { campaign_id: "1", name: "Search - hosts", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, origin: "user_initiated_chat" },
  status: "proposed",
  dispatched_at: null,
  dispatch_error: null,
  ...over,
});
const lookup = (row: LiveDecisionRow, extra: Record<string, unknown> = {}) =>
  json(200, { decision: row, home: { kind: "growth" }, needs_owner_admin: false, viewer_role: "owner", ...extra });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => apiFetch.mockReset());

describe("LiveDecisionCard on a founder's own Google cut", () => {
  it("shows $20 -> $10 and the warning line once the advice lands (re-reads while it is missing)", async () => {
    apiFetch
      .mockResolvedValueOnce(lookup(cut({ founder_advice: null })))
      .mockResolvedValue(lookup(cut({ founder_advice: { warnings: ["it is not set up to get conversions, so zero conversions says nothing"] } })));
    render(<LiveDecisionCard decisionId={ID} title="Google Ads: Search - hosts" surface="chat" />);
    expect(await screen.findByRole("button", { name: "Approve $10/day" })).toBeTruthy();
    const text = () => document.body.textContent ?? "";
    expect(text()).toContain("$20");
    expect(text()).toContain("$10");
    await waitFor(
      () => expect(text()).toContain("Autopilot notes: it is not set up to get conversions, so zero conversions says nothing."),
      { timeout: ADVICE_POLL_MS + 3_000 },
    );
  }, 12_000);

  it("a member on a spend raise sees the owner/admin line, no Approve", async () => {
    apiFetch.mockResolvedValue(
      lookup(cut({ body: { campaign_id: "1", daily_budget_usd: 30, expected_current_daily_budget_usd: 20, origin: "user_initiated_chat" }, founder_advice: { warnings: [] } }), {
        needs_owner_admin: true,
        viewer_role: "member",
      }),
    );
    render(<LiveDecisionCard decisionId={ID} title="Google Ads" surface="chat" />);
    expect(await screen.findByText("Only an owner or admin can approve this")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("a card a newer budget change superseded says so and offers nothing", async () => {
    apiFetch.mockResolvedValue(lookup(cut({ status: "superseded", founder_advice: { warnings: [] } })));
    render(<LiveDecisionCard decisionId={ID} title="Google Ads" surface="chat" />);
    expect(await screen.findByText(SUPERSEDED_LINE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("superseded while open: Approve answers decision_closed, the re-read shows it closed with no error", async () => {
    apiFetch
      .mockResolvedValueOnce(lookup(cut({ founder_advice: { warnings: [] } })))
      .mockResolvedValueOnce(json(409, { error: { code: "decision_closed", message: "Closed elsewhere.", status: "superseded" } }))
      .mockResolvedValue(lookup(cut({ status: "superseded", founder_advice: { warnings: [] } })));
    render(<LiveDecisionCard decisionId={ID} title="Google Ads" surface="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve $10/day" }));
    expect(await screen.findByText(SUPERSEDED_LINE)).toBeTruthy();
    expect(screen.queryByText("Closed elsewhere.")).toBeNull();
  });
});

describe("liveDecisionNotes", () => {
  it("keeps the analysis' objection apart from the rules it failed (no '.;' join)", () => {
    const n = liveDecisionNotes({ body: { cut_guard_note: "The ad is working." }, founder_advice: { warnings: ["Pausing is your call", "it was changed recently and is still settling"] } });
    expect(n.disagrees).toBe("The ad is working.");
    expect(n.notes).toBe("Pausing is your call; it was changed recently and is still settling.");
    expect(n.held).toBeNull();
  });

  it("keeps the rule words exactly as written (names like ChatGPT, Zavi, Autopilot)", () => {
    const words = (w: string) => liveDecisionNotes({ body: {}, founder_advice: { warnings: [w] } }).notes;
    expect(words("ChatGPT paid campaign management needs your explicit permission")).toBe("ChatGPT paid campaign management needs your explicit permission.");
    expect(words("Zavi already raised this budget recently")).toBe("Zavi already raised this budget recently.");
  });

  it("a failed check alone is a note, never a disagreement", () => {
    const n = liveDecisionNotes({ body: {}, founder_advice: { warnings: ["you paused it yourself"] } });
    expect(n.disagrees).toBeNull();
    expect(n.notes).toBe("you paused it yourself.");
  });

  it("an Autopilot hold carries its words and evidence; nothing at all gives no lines", () => {
    const n = liveDecisionNotes({ body: {}, cgo_hold: { words: ["a", "b"], evidence: "7-day spend $40" } });
    expect(n).toEqual({ held: "Autopilot held this: a; b.", evidence: "7-day spend $40", disagrees: null, notes: null, adviceUnavailable: null });
    expect(liveDecisionNotes({ body: {} })).toEqual({ held: null, evidence: null, disagrees: null, notes: null, adviceUnavailable: null });
  });

  it("bug #7 must-catch: a founder card whose warnings are late or failed says so, never silently nothing", () => {
    const row = cut({ founder_advice: null });
    expect(liveDecisionNotes(row).adviceUnavailable).toBeNull();
    expect(liveDecisionNotes(row, true).adviceUnavailable).toBe(ADVICE_PENDING_LINE);
    expect(liveDecisionNotes(cut({ founder_advice: { warnings: [], unavailable: true } })).adviceUnavailable).toBe(ADVICE_UNAVAILABLE_LINE);
  });

  it("must-not-touch: real warnings, an Autopilot hold that never gets advice, and checked-clean cards show no such line", () => {
    expect(liveDecisionNotes(cut({ founder_advice: { warnings: [] } }), true).adviceUnavailable).toBeNull();
    const held = cut({ body: { campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 }, founder_advice: null });
    expect(liveDecisionNotes(held, true).adviceUnavailable).toBeNull();
  });
});
