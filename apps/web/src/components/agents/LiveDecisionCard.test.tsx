// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

vi.mock("@/components/workspace/actions/BusinessControlsApprovalCard", () => ({
  BusinessControlsApprovalCard: ({ decisionId }: { decisionId: string }) => <div data-testid="bc-card">{decisionId}</div>,
}));

import { LiveDecisionCard, LiveDecisionCardView, liveApproveExtras, liveDecisionOutcomeLine, LIVE_DECISION_POLL_MS, OUTCOME_UNKNOWN_POLL_WINDOW_MS } from "./LiveDecisionCard";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";

const ID = "44444444-4444-4444-8444-444444444444";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const metaRow = (over: Partial<LiveDecisionRow> = {}): LiveDecisionRow => ({
  id: ID,
  decision_class: "meta_ads.launch_campaign",
  handler: "meta_ads.launch_campaign",
  body: { name: "Spring promo", daily_budget_usd: 40 },
  status: "proposed",
  dispatched_at: null,
  dispatch_error: null,
  ...over,
});
const lookup = (row: LiveDecisionRow, extra: Record<string, unknown> = {}) =>
  json(200, { decision: row, home: { kind: "growth" }, needs_owner_admin: true, viewer_role: "owner", ...extra });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => apiFetch.mockReset());

describe("LiveDecisionCard", () => {
  it("a pending Meta change for an owner shows Approve", async () => {
    apiFetch.mockResolvedValueOnce(lookup(metaRow()));
    render(<LiveDecisionCard decisionId={ID} title="Meta: launch" surface="growth" />);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(`/api/approvals/${ID}`);
  });

  it("a member on an owner/admin-only change gets no Approve button and the exact line", async () => {
    apiFetch.mockResolvedValueOnce(lookup(metaRow(), { viewer_role: "member" }));
    render(<LiveDecisionCard decisionId={ID} title="Meta: launch" surface="needs_you" />);
    expect(await screen.findByText("Only an owner or admin can approve this")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("an unwired handler never offers Approve, even to an owner; Reject stays", async () => {
    apiFetch.mockResolvedValueOnce(lookup(metaRow({ decision_class: "refund_stripe", handler: "stripe.refund", body: {} }), { needs_owner_admin: false }));
    render(<LiveDecisionCard decisionId={ID} title="Stripe: refund" surface="needs_you" />);
    expect(await screen.findByText(/can't run this kind of action yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("gmail.send is wired (the email handler alias): it offers Approve", async () => {
    apiFetch.mockResolvedValueOnce(lookup(metaRow({ decision_class: "send_email", handler: "gmail.send", body: {} }), { needs_owner_admin: false }));
    render(<LiveDecisionCard decisionId={ID} title="Email: send" surface="needs_you" />);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("after Approve it says it is running, then Done once the re-read returns acted; the surface is sent", async () => {
    apiFetch
      .mockResolvedValueOnce(lookup(metaRow()))
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(lookup(metaRow({ status: "approved" })))
      .mockResolvedValue(lookup(metaRow({ status: "acted" })));
    const onResolved = vi.fn();
    render(<LiveDecisionCard decisionId={ID} title="Meta: launch" surface="growth" onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved. Running it now.")).toBeTruthy();
    expect(apiFetch.mock.calls[1][0]).toBe(`/api/approvals/${ID}/approve?surface=growth`);
    expect(onResolved).toHaveBeenCalledWith(ID, "approved", expect.objectContaining({ id: ID, status: "approved" }));
    await waitFor(() => expect(screen.getByText("Done.")).toBeTruthy(), { timeout: 7_000 });
  }, 10_000);

  it("a failed dispatch shows the error and the retry guidance", async () => {
    apiFetch.mockResolvedValueOnce(lookup(metaRow({ status: "dispatch_failed", dispatch_error: "Meta said: budget too low" })));
    render(<LiveDecisionCard decisionId={ID} title="Meta: launch" surface="chat" />);
    expect(await screen.findByText("Meta said: budget too low Ask Zavi in this chat to try again, or reject it.")).toBeTruthy();
  });

  it("a 404 shows the not-in-list line", async () => {
    apiFetch.mockResolvedValueOnce(json(404, { error: { code: "not_found" } }));
    render(<LiveDecisionCard decisionId={ID} title="Meta: launch" surface="chat" />);
    expect(await screen.findByText("This card is not in your list any more.")).toBeTruthy();
  });

  it("a read error says so instead of spinning", async () => {
    apiFetch.mockResolvedValueOnce(json(500, {}));
    render(<LiveDecisionCard decisionId={ID} title="Meta: launch" surface="chat" />);
    expect(await screen.findByText("Could not load this card (HTTP 500).")).toBeTruthy();
  });

  it("Reject sends the surface and shows the outcome", async () => {
    apiFetch
      .mockResolvedValueOnce(lookup(metaRow()))
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValue(lookup(metaRow({ status: "rejected" })));
    render(<LiveDecisionCard decisionId={ID} title="Meta: launch" surface="needs_you" />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Rejected. Nothing was changed.")).toBeTruthy();
    expect(apiFetch.mock.calls[1][0]).toBe(`/api/approvals/${ID}/reject?surface=needs_you`);
  });
});

describe("liveDecisionOutcomeLine", () => {
  it("covers every final state and trims a long error", () => {
    expect(liveDecisionOutcomeLine("pending", { dispatch_error: null })).toBeNull();
    expect(liveDecisionOutcomeLine("closed", { dispatch_error: null })).toBe("Closed. Nothing was changed.");
    expect(liveDecisionOutcomeLine("failed", { dispatch_error: null })).toBe("It did not go through. Ask Zavi in this chat to try again, or reject it.");
    const long = liveDecisionOutcomeLine("failed", { dispatch_error: "x".repeat(500) })!;
    expect(long.startsWith("x".repeat(299) + "…")).toBe(true);
  });

  it("a change still dispatching on time reads as running", () => {
    const html = renderToStaticMarkup(
      <LiveDecisionCardView
        decisionId={ID}
        title="Meta: launch"
        row={metaRow({ status: "dispatching", dispatched_at: "2026-10-17T00:00:00Z" })}
        loadError={null}
        viewerRole="owner"
        busy={false}
        actionError={null}
        onApprove={() => {}}
        onReject={() => {}}
        now={Date.parse("2026-10-17T00:00:05Z")}
      />,
    );
    expect(html).toContain("Approved. Running it now.");
    expect(html).not.toContain(">Approve<");
  });
});

describe("what the live card sends and renders (review of #4402)", () => {
  it("echoes a social post's revision and loaded time, and a web-only money card's seal", () => {
    expect(
      liveApproveExtras(
        metaRow({ decision_class: "social.publish.v2", handler: null, post_revision: "rev-9", body: { channel: "x", payload: { text: "hi" }, scheduled_at: null } }),
      ),
    ).toEqual({ expected_post_revision: "rev-9", expected_scheduled_at: null });
    expect(liveApproveExtras(metaRow({ decision_class: "stripe.create_payment", handler: "stripe.create_payment", body: { fingerprint: "f1" } }))).toEqual({
      expected_fingerprint: "f1",
    });
    expect(liveApproveExtras(metaRow({ decision_class: "extension.money_step", handler: "extension.money_step", body: { fingerprint: "f2" } }))).toEqual({
      expected_fingerprint: "f2",
    });
    expect(liveApproveExtras(metaRow())).toEqual({});
  });

  it("the Approve sends those extras", async () => {
    const social = metaRow({ decision_class: "social.publish.v2", handler: null, post_revision: "rev-9", body: { channel: "x", payload: { text: "hi" }, scheduled_at: "2026-10-20T16:00:00.000Z" } });
    apiFetch.mockResolvedValueOnce(lookup(social, { needs_owner_admin: false })).mockResolvedValue(json(200, { ok: true }));
    render(<LiveDecisionCard decisionId={ID} title="Post" surface="growth" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiFetch.mock.calls[1][0]).toBe(`/api/approvals/${ID}/approve?surface=growth`));
    expect(JSON.parse(String((apiFetch.mock.calls[1][1] as { body: string }).body))).toEqual({
      expected_post_revision: "rev-9",
      expected_scheduled_at: "2026-10-20T16:00:00.000Z",
    });
  });

  it("a moved post answers with its new time and the card asks again", async () => {
    const social = metaRow({ decision_class: "social.publish.v2", handler: null, post_revision: "r", body: { channel: "x", payload: { text: "hi" }, scheduled_at: null } });
    apiFetch
      .mockResolvedValueOnce(lookup(social, { needs_owner_admin: false }))
      .mockResolvedValueOnce(json(409, { error: { code: "schedule_changed", current_scheduled_at: null } }))
      .mockResolvedValue(lookup(social, { needs_owner_admin: false }));
    render(<LiveDecisionCard decisionId={ID} title="Post" surface="growth" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("This was changed to publish when approved. Approve again?")).toBeTruthy();
  });

  it("business results settings render their own card, with no generic Approve (F2)", async () => {
    apiFetch.mockResolvedValue(json(404, {}));
    render(<LiveDecisionCard decisionId={ID} decisionClass="growth.save_business_controls" title="Settings" surface="needs_you" />);
    expect((await screen.findByTestId("bc-card")).textContent).toBe(ID);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("'outcome unknown' is re-read for a bounded window only, then polling stops (F6)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stuck = metaRow({ decision_class: "composio.write", handler: "composio.execute_tool", status: "dispatching", dispatched_at: "2026-01-01T00:00:00Z" });
    apiFetch.mockResolvedValue(lookup(stuck));
    render(<LiveDecisionCard decisionId={ID} title="Write" surface="chat" />);
    await screen.findByText(/Outcome unknown/);
    await vi.advanceTimersByTimeAsync(OUTCOME_UNKNOWN_POLL_WINDOW_MS + 2 * LIVE_DECISION_POLL_MS);
    const settled = apiFetch.mock.calls.length;
    expect(settled).toBeGreaterThan(1);
    expect(settled).toBeLessThanOrEqual(2 + OUTCOME_UNKNOWN_POLL_WINDOW_MS / LIVE_DECISION_POLL_MS);
    await vi.advanceTimersByTimeAsync(10 * LIVE_DECISION_POLL_MS);
    expect(apiFetch.mock.calls.length).toBe(settled);
  });
});

describe("LiveDecisionCard: budget choice and the move card (plan 2026-10-23)", () => {
  const RID = "77777777-7777-4777-8777-777777777777";
  const raise: LiveDecisionRow = { id: RID, decision_class: "google_ads.update_campaign_budget_review", handler: null, body: { campaign_id: "c1", campaign_name: "Atlanta", daily_budget_usd: 70, expected_current_daily_budget_usd: 40 }, status: "proposed", dispatched_at: null, dispatch_error: null };
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const over = { kind: "over", month_label: "October", projection_usd: 27040, monthly_usd: 27000, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null };
  it("a lookup with budget_choice over shows the raise button, which posts raise_budget_to_usd", async () => {
    apiFetch.mockImplementation(async (...a: unknown[]) =>
      String(a[0]).includes("/approve") ? res(200, { ok: true }) : res(200, { decision: raise, home: { kind: "growth" }, needs_owner_admin: true, viewer_role: "owner", budget_choice: over, move: null }),
    );
    render(<LiveDecisionCard decisionId={RID} title="Google Ads" surface="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and raise budget to $27,100" }));
    expect(screen.queryByRole("button", { name: /^Approve( \$|$)/ })).toBeNull();
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => String(c[0]).includes("/approve"))).toBe(true));
    const post = apiFetch.mock.calls.find((c) => String(c[0]).includes("/approve"))!;
    expect(JSON.parse(String((post[1] as { body: string }).body))).toMatchObject({ raise_budget_to_usd: 27100 });
  });
  it("a 409 budget_raise_changed re-shows the panel with the new number, with the server's words", async () => {
    const moved = { ...over, raise_to_usd: 27200 };
    apiFetch.mockImplementation(async (...a: unknown[]) =>
      String(a[0]).includes("/approve")
        ? res(409, { error: { code: "budget_raise_changed", message: "The numbers moved: this now needs a $27,200 monthly budget.", budget_choice: moved } })
        : res(200, { decision: raise, home: { kind: "growth" }, needs_owner_admin: true, viewer_role: "owner", budget_choice: over, move: null }),
    );
    render(<LiveDecisionCard decisionId={RID} title="Google Ads" surface="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and raise budget to $27,100" }));
    expect(await screen.findByRole("button", { name: "Approve and raise budget to $27,200" })).toBeTruthy();
    expect(screen.getByText("The numbers moved: this now needs a $27,200 monthly budget.")).toBeTruthy();
  });
  it("a lookup with move renders the one move card", async () => {
    apiFetch.mockImplementation(async (...a: unknown[]) =>
      String(a[0]).endsWith("/move-fit")
        ? res(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } })
        : res(200, { decision: raise, home: { kind: "growth" }, needs_owner_admin: true, viewer_role: "owner", budget_choice: null, move: { key: "run-root", still_filing: false, lines: [{ id: RID, decision_class: raise.decision_class, title: "Raise Atlanta from $40 to $70 a day", status: "proposed", side: "adds", daily_delta_usd: 30, dispatch_error: null, waits_on_cuts: false, blocked: null }] } }),
    );
    render(<LiveDecisionCard decisionId={RID} title="Google Ads" surface="chat" />);
    expect(await screen.findByTestId("move-card")).toBeTruthy();
  });
  it("Find the money elsewhere: the raise opens as a move card with the candidates unticked; none found keeps the panel and says so", async () => {
    const lookupRes = () => res(200, { decision: raise, home: { kind: "growth" }, needs_owner_admin: true, viewer_role: "owner", budget_choice: { ...over, find_money: "available" }, move: null });
    const fm = { kind: "candidates", why: null, budget_choice: over, candidates: [{ platform: "google", level: "campaign", object_id: "g1", name: "Dallas", from_usd: 100, to_usd: 80, frees_daily_usd: 20, why: "worse" }], move: { key: `raise:${RID}`, still_filing: false, lines: [{ id: RID, decision_class: raise.decision_class, title: "Raise Atlanta from $40 to $70 a day", status: "proposed", side: "adds", daily_delta_usd: 30, dispatch_error: null, waits_on_cuts: false, blocked: null }] } };
    apiFetch.mockImplementation(async (...a: unknown[]) => {
      const url = String(a[0]);
      if (url.endsWith("/find-money")) return res(200, fm);
      if (url.endsWith("/move-fit")) return res(200, { ok: true, net_daily_usd: 30, budget_choice: over });
      return lookupRes();
    });
    render(<LiveDecisionCard decisionId={RID} title="Google Ads" surface="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Find the money elsewhere" }));
    expect(await screen.findByTestId("move-card")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Cut Dallas $100 to $80/day · frees $20/day" }) as HTMLInputElement).checked).toBe(false);
    cleanup();
    apiFetch.mockImplementation(async (...a: unknown[]) => (String(a[0]).endsWith("/find-money") ? res(200, { ...fm, kind: "none", why: "set_aside", candidates: [] }) : lookupRes()));
    render(<LiveDecisionCard decisionId={RID} title="Google Ads" surface="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Find the money elsewhere" }));
    expect(await screen.findByText("Cuts can't make room this month: the money is already set aside for raises you approved. Raise the budget instead.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and raise budget to $27,100" })).toBeTruthy();
    expect(screen.queryByTestId("move-card")).toBeNull();
  });
  it("must-catch (Codex re-check F4): find-money answering fits or no_budget re-reads the card; daily_limit_only has its own words; not_enough the neutral ones", async () => {
    const lookup = (bc: unknown) => res(200, { decision: raise, home: { kind: "growth" }, needs_owner_admin: true, viewer_role: "owner", budget_choice: bc, move: null });
    const fmNone = (why: string) => ({ kind: "none", why, candidates: [], budget_choice: null, move: { key: `raise:${RID}`, still_filing: false, lines: [] } });
    for (const why of ["fits", "no_budget"]) {
      let lookups = 0;
      apiFetch.mockImplementation(async (...a: unknown[]) => {
        if (String(a[0]).endsWith("/find-money")) return res(200, fmNone(why));
        lookups += 1;
        return lookup(lookups === 1 ? { ...over, find_money: "available" } : { kind: "fits" });
      });
      render(<LiveDecisionCard decisionId={RID} title="Google Ads" surface="chat" />);
      fireEvent.click(await screen.findByRole("button", { name: "Find the money elsewhere" }));
      expect(await screen.findByRole("button", { name: "Approve $70/day" })).toBeTruthy();
      expect(lookups).toBe(2);
      expect(screen.queryByText(/Raise the budget instead/)).toBeNull();
      cleanup();
    }
    for (const [why, words] of [["daily_limit_only", "Your daily limit blocks this raise, not the month. Raise the daily limit instead."], ["not_enough", "Cutting other ads can't make enough room this month. Raise the budget instead."], ["no_candidates", "Cutting other ads can't make enough room this month. Raise the budget instead."], ["non_usd", "Cutting other ads can't make enough room this month. Raise the budget instead."]] as const) {
      apiFetch.mockImplementation(async (...a: unknown[]) => (String(a[0]).endsWith("/find-money") ? res(200, fmNone(why)) : lookup({ ...over, find_money: "available" })));
      render(<LiveDecisionCard decisionId={RID} title="Google Ads" surface="chat" />);
      fireEvent.click(await screen.findByRole("button", { name: "Find the money elsewhere" }));
      expect(await screen.findByText(words)).toBeTruthy();
      cleanup();
    }
  });
});

