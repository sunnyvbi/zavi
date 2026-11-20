// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { CHANNEL_ACTIONS_CHANGED_EVENT, CHANNEL_RUN_STARTED_EVENT } from "./topActions/api";
import { requestCampaignReview } from "./managed-campaigns/campaignReviewRequest";
import { closeCampaignReview } from "./managed-campaigns/openCampaignReview";
import { invalidateCampaignReviews } from "./managed-campaigns/campaignReviewPrefetch";

const ID = "20000000-0000-4000-8000-000000000002";
const OTHER = "20000000-0000-4000-8000-000000000009";
const TYPED = "https://www.linkedin.com/posts/acme_launch-activity-7123456789012345678-abcd";
const PLACEHOLDER = "https://www.linkedin.com/posts/…";
const TITLE = "Review your LinkedIn campaign";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
let actions: ChannelActionView[] = [];
let fail = false;
let gate: Promise<void> | null = null;
const draft = (id = ID) => makeAction("create_ad", { id, channel_slug: "linkedin_ads", title: "Review LinkedIn " + id,
  body: { step: { responsibility: "client", body: "b", deliverable: { kind: "ad", label: "d", content: "x", presentation: { type: "campaign_draft", channel: "linkedin_ads", name: "n" } } } } as never });
const review = { draft: { name: "n", group_name: "g", rationale: "r", post_preview: "p", post_urn: "urn:li:share:7000000000000000001", country: "US" }, accounts: [{ id: "1", name: "A", currency: "USD" }], suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:1", name: "United States" }], excluded_locations: [] } };
const mount = () => render(<ChannelActionsLane slug="linkedin_ads" legacy={<p>legacy</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>{null}</ChannelActionsLane>);
const postField = () => screen.queryByPlaceholderText(PLACEHOLDER) as HTMLInputElement | null;
const dialogOpen = () => !!screen.queryByText(TITLE)?.closest("dialog")?.hasAttribute("open");
const changed = () => window.dispatchEvent(new CustomEvent(CHANNEL_ACTIONS_CHANGED_EVENT, { detail: { slug: "linkedin_ads" } }));
const started = () => window.dispatchEvent(new CustomEvent(CHANNEL_RUN_STARTED_EVENT, { detail: { slug: "linkedin_ads" } }));
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

beforeEach(() => {
  apiFetch.mockReset(); fail = false; gate = null;
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (fail) throw new Error("down");
    if (u.endsWith("/review")) return ok(review);
    if (u.endsWith("/prepare")) return ok({ exact_change: { rows: [] } });
    if (u.includes("/actions")) {
      const snapshot = actions;
      if (gate) await gate;
      return ok({ actions: snapshot, more: 0, store: "channel_actions" });
    }
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  spec.current = { name: "LinkedIn Ads", sponsoredPostReview: { actionReviewPath: "/api/channels/linkedin_ads/actions", title: "LinkedIn" } };
  actions = [draft()];
});
afterEach(() => { cleanup(); closeCampaignReview(ID); closeCampaignReview(OTHER); invalidateCampaignReviews(); });

async function openAndType() {
  const view = mount();
  await screen.findByTestId(`action-${ID}`);
  act(() => requestCampaignReview(ID));
  await waitFor(() => expect(postField()?.value).toBe(review.draft.post_urn));
  fireEvent.change(postField()!, { target: { value: TYPED } });
  return view;
}

async function remountLikeAPageRefetch(view: ReturnType<typeof mount>) {
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  view.unmount();
  mount();
  expect(screen.getByRole("status").textContent).toContain("Reading what is waiting on this channel");
  expect(postField()).toBeNull();
  await act(async () => { release(); await gate; });
  gate = null;
}

describe("an open LinkedIn review across a refetch", () => {
  it("reopens with the typed post link after the lane remounts behind its loading skeleton", async () => {
    const view = await openAndType();
    await remountLikeAPageRefetch(view);
    await waitFor(() => expect(postField()?.value).toBe(TYPED));
    expect(dialogOpen()).toBe(true);
    await settle();
    expect(postField()!.value).toBe(TYPED);
    expect(apiFetch.mock.calls.filter(([u]) => String(u).endsWith(`/${ID}/review`)).length).toBe(1);
  });

  it("sends the typed post, not the draft's suggested one, when created after the remount", async () => {
    const view = await openAndType();
    fireEvent.click(screen.getByRole("checkbox", { name: /everyone in these locations/ }));
    await remountLikeAPageRefetch(view);
    await waitFor(() => expect(postField()?.value).toBe(TYPED));
    const create = screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u).endsWith("/prepare"))).toBe(true));
    const [, init] = apiFetch.mock.calls.find(([u]) => String(u).endsWith("/prepare"))!;
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ post: TYPED, use_broad_audience: true });
  });

  it("keeps Create blocked after the remount until an audience choice is made", async () => {
    const view = await openAndType();
    await remountLikeAPageRefetch(view);
    await waitFor(() => expect(postField()?.value).toBe(TYPED));
    await settle();
    const create = screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /everyone in these locations/ }));
    await waitFor(() => expect(create.disabled).toBe(false));
  });

  it("keeps edited budget and locations across the remount too", async () => {
    const view = await openAndType();
    fireEvent.change(screen.getByLabelText("Spend up to, per day (USD)"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove United States" }));
    await remountLikeAPageRefetch(view);
    await waitFor(() => expect(postField()?.value).toBe(TYPED));
    expect((screen.getByLabelText("Spend up to, per day (USD)") as HTMLInputElement).value).toBe("42");
    expect(screen.queryByRole("button", { name: "Remove United States" })).toBeNull();
    expect(screen.getByText("Add at least one included location.")).toBeTruthy();
  });

  it("closes when the refetched list no longer has the action", async () => {
    const view = await openAndType();
    actions = [draft(OTHER)];
    await remountLikeAPageRefetch(view);
    await screen.findByTestId(`action-${OTHER}`);
    await settle();
    expect(postField()).toBeNull();
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("closes in place when a silent refresh drops the action", async () => {
    await openAndType();
    actions = [draft(OTHER)];
    act(changed);
    await screen.findByTestId(`action-${OTHER}`);
    await settle();
    expect(postField()).toBeNull();
  });

  it("does not reopen after the founder cancelled it, and a fresh open starts from the draft", async () => {
    const view = await openAndType();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(postField()).toBeNull();
    await remountLikeAPageRefetch(view);
    await screen.findByTestId(`action-${ID}`);
    await settle();
    expect(postField()).toBeNull();
    act(() => requestCampaignReview(ID));
    await waitFor(() => expect(postField()?.value).toBe(review.draft.post_urn));
  });

  it("does not reopen on another card that was never reviewed", async () => {
    actions = [draft(), draft(OTHER)];
    const view = await openAndType();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await remountLikeAPageRefetch(view);
    await settle();
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it.each([
    ["a silent refresh", async () => { act(changed); }],
    ["a run-started reload", async () => { act(started); }],
    ["a failed reload then a recovery", async () => { fail = true; act(started); await settle(); fail = false; act(changed); }],
    ["a new card of the same kind arriving", async () => { actions = [draft(OTHER), draft()]; act(changed); }],
  ])("stays open with the typed link through %s", async (_label, trigger) => {
    await openAndType();
    await trigger();
    await settle();
    expect(dialogOpen()).toBe(true);
    expect(postField()!.value).toBe(TYPED);
  });
});
