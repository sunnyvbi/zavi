// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "./types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import { clearCampaignReview, pendingCampaignReview, requestCampaignReview } from "./managed-campaigns/campaignReviewRequest";

const NEW_ID = "20000000-0000-4000-8000-000000000002";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
let actions: ChannelActionView[] = [];
const scrollIntoView = vi.fn();

const draft = () =>
  makeAction("create_ad", {
    id: NEW_ID,
    channel_slug: "linkedin_ads",
    title: "Review and create your LinkedIn campaign",
    body: { step: { responsibility: "client", body: "Set the budget", deliverable: { kind: "ad", label: "LinkedIn campaign draft", content: "x", presentation: { type: "campaign_draft", channel: "linkedin_ads", name: "LinkedIn campaign - 2026-10-14" } } } } as never,
  });

const actionReads = () => apiFetch.mock.calls.filter(([u]) => String(u).includes("/actions?") || /\/actions$/.test(String(u)));
const reviewReads = () => apiFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.endsWith("/review"));

function lane() {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/review")) return ok({ draft: { name: "LinkedIn campaign - 2026-10-14", group_name: "g", rationale: "You started this", post_preview: "Paste the post", country: "US" }, accounts: [{ id: "50999", name: "Acme", currency: "USD" }], suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] } });
    if (u.includes("/actions")) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
  return render(
    <ChannelActionsLane slug="linkedin_ads" legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      {null}
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  spec.current = { name: "LinkedIn Ads", sponsoredPostReview: { actionReviewPath: "/api/channels/linkedin_ads/actions", title: "LinkedIn" } };
  actions = [makeAction("fix", { id: "card-1", channel_slug: "linkedin_ads", title: "Fix the insight tag" })];
  const left = pendingCampaignReview();
  if (left) clearCampaignReview(left);
});
afterEach(cleanup);

describe("a founder-started campaign draft", () => {
  it("re-reads the list once, then opens the new card's review sheet", async () => {
    lane();
    await screen.findByTestId("action-card-1");
    const before = actionReads().length;
    actions = [...actions, draft()];
    act(() => requestCampaignReview(NEW_ID));
    await screen.findByText("Review your LinkedIn campaign");
    expect(actionReads().length).toBe(before + 1);
    expect(reviewReads()).toEqual([`/api/channels/linkedin_ads/actions/${NEW_ID}/review`]);
    expect(pendingCampaignReview()).toBeNull();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("a card already on the list opens without another read", async () => {
    actions = [...actions, draft()];
    lane();
    await screen.findByTestId(`action-${NEW_ID}`);
    const before = actionReads().length;
    act(() => requestCampaignReview(NEW_ID));
    await screen.findByText("Review your LinkedIn campaign");
    expect(actionReads().length).toBe(before);
  });

  it("a second press for the same reused draft opens it again", async () => {
    actions = [...actions, draft()];
    lane();
    await screen.findByTestId(`action-${NEW_ID}`);
    act(() => requestCampaignReview(NEW_ID));
    await screen.findByText("Review your LinkedIn campaign");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(pendingCampaignReview()).toBeNull();
    scrollIntoView.mockClear();
    act(() => requestCampaignReview(NEW_ID));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("re-reads at most once when the card never arrives", async () => {
    lane();
    await screen.findByTestId("action-card-1");
    const before = actionReads().length;
    act(() => requestCampaignReview(NEW_ID));
    await waitFor(() => expect(actionReads().length).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(actionReads().length).toBe(before + 1);
    expect(screen.queryByText("Review your LinkedIn campaign")).toBeNull();
  });

  it("a channel without the review sheet ignores the request", async () => {
    spec.current = { name: "Test Ads" };
    lane();
    await screen.findByTestId("action-card-1");
    const before = actionReads().length;
    act(() => requestCampaignReview(NEW_ID));
    await new Promise((r) => setTimeout(r, 50));
    expect(actionReads().length).toBe(before);
  });
});
