// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { CHANNEL_ACTIONS_CHANGED_EVENT } from "./topActions/api";
import { closeCampaignReview } from "./managed-campaigns/openCampaignReview";
import { CAMPAIGN_REVIEW_TTL_MS, invalidateCampaignReviews } from "./managed-campaigns/campaignReviewPrefetch";

const A = "30000000-0000-4000-8000-00000000000a";
const B = "30000000-0000-4000-8000-00000000000b";
const C = "30000000-0000-4000-8000-00000000000c";
const LOADING = ["Reading the draft…", "Reading the post…"];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const draft = (id: string, extra: Partial<ChannelActionView> = {}) => ({ ...makeAction("create_ad", { id, channel_slug: "linkedin_ads", title: "Review LinkedIn " + id,
  body: { step: { responsibility: "client", body: "b", deliverable: { kind: "ad", label: "d", content: "x", presentation: { type: "campaign_draft", channel: "linkedin_ads", name: "n" } } } } as never }), ...extra }) as ChannelActionView;
const nameOf = (id: string) => id === A ? "Draft A" : id === B ? "Draft B" : "Draft C";
const reviewFor = (name: string) => ({ draft: { name, group_name: "g", rationale: "r", post_preview: `Post of ${name}`, post_urn: "urn:li:share:7000000000000000001", country: "US" }, accounts: [{ id: "1", name: "Acct", currency: "USD" }], suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:1", name: "United States" }], excluded_locations: [] } });
let actions: ChannelActionView[] = [];
let gates: Record<string, Promise<void> | undefined> = {};
let failures: Record<string, number> = {};
const reviewPath = (id: string) => `/api/channels/linkedin_ads/actions/${id}/review`;
const reviewReads = () => apiFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.endsWith("/review"));
const mount = () => render(<ChannelActionsLane slug="linkedin_ads" legacy={<p>legacy</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>{null}</ChannelActionsLane>);
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const showsLoading = () => LOADING.some((t) => document.body.textContent?.includes(t));
const openCard = (id: string) => fireEvent.click(within(screen.getByTestId(`action-${id}`)).getByRole("button", { name: "Review and create" }));
const cancel = () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
const sheetOpen = () => !!screen.queryByText("Review your LinkedIn campaign");

beforeEach(() => {
  apiFetch.mockReset(); gates = {}; failures = {};
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/review")) {
      const id = decodeURIComponent(u.split("/").at(-2)!);
      if (gates[id]) await gates[id];
      if (failures[id]) { failures[id]--; return { ok: false, status: 503, json: async () => ({ error: { message: "LinkedIn Ads is busy right now.", code: "linkedin_ads_busy" } }) }; }
      return ok(reviewFor(nameOf(id)));
    }
    if (u.includes("/post-preview")) return ok({ post_preview: null });
    if (u.includes("/actions")) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  spec.current = { name: "LinkedIn Ads", sponsoredPostReview: { actionReviewPath: "/api/channels/linkedin_ads/actions", title: "LinkedIn" } };
  actions = [draft(A)];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); [A, B, C].forEach(closeCampaignReview); invalidateCampaignReviews(); });

it("reads no review for three pending drafts until one is opened, then exactly one read for that card", async () => {
  actions = [draft(A), draft(B), draft(C)];
  mount();
  await screen.findByTestId(`action-${C}`);
  await settle();
  await settle();
  expect(reviewReads()).toEqual([]);
  openCard(B);
  expect(await screen.findByText("Draft B")).toBeTruthy();
  await settle();
  expect(reviewReads()).toEqual([reviewPath(B)]);
});

it("reopening the same card within five minutes reads nothing more and opens filled with no loading state", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  mount();
  await screen.findByTestId(`action-${A}`);
  openCard(A);
  expect(await screen.findByText("Draft A")).toBeTruthy();
  cancel();
  expect(sheetOpen()).toBe(false);
  await settle();
  clock.mockReturnValue(now + CAMPAIGN_REVIEW_TTL_MS - 1000);
  openCard(A);
  expect(showsLoading()).toBe(false);
  expect(screen.getByText("Draft A")).toBeTruthy();
  expect((screen.getByLabelText("Spend up to, per day (USD)") as HTMLInputElement).value).toBe("15");
  await settle();
  expect(showsLoading()).toBe(false);
  expect(reviewReads()).toEqual([reviewPath(A)]);
});

it("reads the review again once the five minutes are up", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  mount();
  await screen.findByTestId(`action-${A}`);
  openCard(A);
  expect(await screen.findByText("Draft A")).toBeTruthy();
  cancel();
  await settle();
  clock.mockReturnValue(now + CAMPAIGN_REVIEW_TTL_MS + 1);
  openCard(A);
  expect(await screen.findByText("Draft A")).toBeTruthy();
  await settle();
  expect(reviewReads()).toEqual([reviewPath(A), reviewPath(A)]);
});

it("does not cache a failed read: reopening after a busy answer reads again and fills the form", async () => {
  failures[A] = 1;
  mount();
  await screen.findByTestId(`action-${A}`);
  openCard(A);
  expect((await screen.findByRole("alert")).textContent).toContain("LinkedIn Ads is busy right now.");
  expect(screen.queryByText("Draft A")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await settle();
  expect(reviewReads()).toHaveLength(1);
  openCard(A);
  expect(await screen.findByText("Draft A")).toBeTruthy();
  await settle();
  expect(reviewReads()).toEqual([reviewPath(A), reviewPath(A)]);
});

it("never shows one action's cached review in another action's dialog", async () => {
  let releaseB!: () => void;
  gates[B] = new Promise<void>((r) => { releaseB = r; });
  actions = [draft(A), draft(B)];
  mount();
  await screen.findByTestId(`action-${B}`);
  openCard(A);
  expect(await screen.findByText("Draft A")).toBeTruthy();
  cancel();
  await settle();
  openCard(B);
  expect(screen.getByRole("status").textContent).toBe("Reading the draft…");
  expect(document.body.textContent).not.toContain("Draft A");
  await act(async () => { releaseB(); await gates[B]; });
  expect(await screen.findByText("Draft B")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Draft A");
  expect(reviewReads()).toEqual([reviewPath(A), reviewPath(B)]);
});

it("does not read the review for a card that cannot be reviewed", async () => {
  const zaviStep = { step: { responsibility: "zavi", body: "b", deliverable: { kind: "ad", label: "d", content: "x", presentation: { type: "campaign_draft", channel: "linkedin_ads", name: "n" } } } } as never;
  actions = [draft(A, { body: zaviStep } as Partial<ChannelActionView>), draft(B, { status: "approved" } as unknown as Partial<ChannelActionView>)];
  mount();
  await screen.findByTestId(`action-${B}`);
  await settle();
  expect(reviewReads()).toEqual([]);
});

it("reads the review again for a new post revision, and only for the open card", async () => {
  actions = [draft(A), draft(B)];
  mount();
  await screen.findByTestId(`action-${A}`);
  openCard(A);
  expect(await screen.findByText("Draft A")).toBeTruthy();
  expect(reviewReads()).toHaveLength(1);
  actions = [draft(A, { post_revision: "r2" } as Partial<ChannelActionView>), draft(B, { post_revision: "r2" } as Partial<ChannelActionView>)];
  window.dispatchEvent(new CustomEvent(CHANNEL_ACTIONS_CHANGED_EVENT, { detail: { slug: "linkedin_ads" } }));
  await waitFor(() => expect(reviewReads()).toHaveLength(2));
  await settle();
  expect(reviewReads()).toEqual([reviewPath(A), reviewPath(A)]);
  expect(screen.getByText("Draft A")).toBeTruthy();
});
