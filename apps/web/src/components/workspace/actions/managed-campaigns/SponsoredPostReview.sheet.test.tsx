import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SponsoredPostReview } from "./SponsoredPostReview";
import { forgetLinkedInAudienceOptions } from "./LinkedInAudiencePicker";
import { invalidateCampaignReviews } from "./campaignReviewPrefetch";
import type { ActionItem } from "../types";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));

let n = 0;
let action = { id: "sheet-0", body: {}, channel_slug: "linkedin_ads" } as ActionItem;
const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
type R = ReturnType<typeof baseReview>;
const baseReview = () => ({
  draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Company post", post_urn: "urn:li:share:7123456789012345678" as string | undefined, country: "US", audience_suggestions: { titles: ["Chief Executive Officer"], seniorities: [], industries: [], staffCountRanges: [] } },
  accounts: [{ id: "11", name: "Account one", currency: "USD", funding_source: "provider" as "provider" | "wallet" }],
  suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] as Array<{ id: string; name: string }>, location_search_failed: undefined as string | undefined },
  own_account_unavailable: undefined as string | undefined,
});
let reviewOf: () => Promise<R> = async () => baseReview();
const reviewReads = () => api.mock.calls.filter(([p]) => String(p).endsWith("/review")).length;

beforeEach(() => {
  action = { id: `sheet-${++n}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  invalidateCampaignReviews();
  forgetLinkedInAudienceOptions();
  reviewOf = async () => baseReview();
  api.mockReset();
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? reviewOf() : path.includes("/targeting?")
    ? { options: [{ urn: "urn:li:title:1", name: "Chief Executive Officer" }] }
    : path.includes("/post-preview?") ? { post_urn: "urn:li:share:7123456789012345678", post_preview: "Company post", author: "page" }
    : path.includes("/locations?") ? { locations: [] }
    : { exact_change: { rows: [] } });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

function open(onApprove: ActionHandlers["onApprove"] = vi.fn().mockResolvedValue(true)) {
  const onClose = vi.fn();
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove, onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={onClose} />);
  return onClose;
}
type ActionHandlers = import("../types").ActionHandlers;
const create = () => screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
async function readyToCreate() {
  await screen.findByRole("button", { name: "Remove Chief Executive Officer" });
  await waitFor(() => expect(create().disabled).toBe(false));
}

it("keeps the sheet open with the founder's inputs and an inline error when approving does not start", async () => {
  const onApprove = vi.fn().mockResolvedValue(false);
  const onClose = open(onApprove);
  await readyToCreate();
  fireEvent.change(screen.getByLabelText("Spend up to, per day (USD)"), { target: { value: "40" } });
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(onApprove).toHaveBeenCalled());
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not start creating this campaign/);
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Spend up to, per day (USD)") as HTMLInputElement).value).toBe("40");
  expect(screen.getAllByRole("button", { name: "Chief Executive Officer" }).length).toBeGreaterThan(0);
  expect(create().disabled).toBe(false);
});

it("still closes when approving starts", async () => {
  const onClose = open(vi.fn().mockResolvedValue(true));
  await readyToCreate();
  fireEvent.click(create());
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it("offers Try again when the draft cannot be read, reads it once per click, and never retries on its own", async () => {
  let fail = true;
  reviewOf = async () => { if (fail) throw Object.assign(new Error("LinkedIn Ads is busy right now. Try again in a few minutes."), { code: "linkedin_ads_busy" }); return baseReview(); };
  const onClose = open();
  const again = await screen.findByRole("button", { name: "Try again" });
  expect(reviewReads()).toBe(1);
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(reviewReads()).toBe(1);
  fail = false;
  fireEvent.click(again);
  expect(await screen.findByText("Pilot")).toBeTruthy();
  expect(reviewReads()).toBe(2);
  expect(onClose).not.toHaveBeenCalled();
});

it("when the draft cannot be read, the footer's one action is Try again, with no Cancel, while the X still closes", async () => {
  let fail = true;
  reviewOf = async () => { if (fail) throw Object.assign(new Error("Every ad account on this LinkedIn login is already connected to another Zavi workspace."), { code: "linkedin_ads_account_taken" }); return baseReview(); };
  const onClose = open();
  await screen.findByText(/already connected to another Zavi workspace/);
  const footer = document.querySelector("footer")!;
  const footerButtons = Array.from(footer.querySelectorAll("button")).map((b) => b.textContent);
  expect(footerButtons).toEqual(["Try again"]);
  expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fail = false;
  fireEvent.click(footer.querySelector("button")!);
  expect(await screen.findByText("Pilot")).toBeTruthy();
  expect(reviewReads()).toBe(2);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  cleanup();
  invalidateCampaignReviews();
  action = { id: `sheet-${++n}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  fail = true;
  const closed = open();
  await screen.findByText(/already connected to another Zavi workspace/);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(closed).toHaveBeenCalledTimes(1);
  expect(reviewReads()).toBe(3);
});

it("on a draft with no post link, says a post is needed beside Create and labels the preview as Zavi's suggested text", async () => {
  reviewOf = async () => { const r = baseReview(); r.draft.post_urn = undefined; r.draft.post_preview = "Hiring managers waste 10 hours a week."; return r; };
  open();
  await screen.findByText("Pilot");
  expect(create().disabled).toBe(true);
  expect(screen.getByTestId("create-blocked-reason").className).toBe("sr-only");
  expect(document.body.textContent).not.toContain("Paste the LinkedIn post to promote.");
  expect(screen.getByTestId("suggested-post-text").textContent).toMatch(/suggested text, not a chosen post/);
  fireEvent.change(screen.getByLabelText("The post to promote"), { target: { value: "https://www.linkedin.com/posts/acme_share-7123456789012345678" } });
  expect(screen.queryByTestId("suggested-post-text")).toBeNull();
  expect(screen.queryByTestId("post-needed")).toBeNull();
});

it("says plainly when the founder's own LinkedIn accounts could not be read, and never shows raw service text", async () => {
  reviewOf = async () => ({ ...baseReview(), accounts: [{ id: "77", name: "Zavi shared", currency: "USD", funding_source: "wallet" as const }], own_account_unavailable: "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu." });
  open();
  const note = await screen.findByTestId("own-account-unavailable");
  expect(note.textContent).toBe("Your own LinkedIn ad accounts cannot be read right now (LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu).");
  cleanup();
  invalidateCampaignReviews();
  action = { id: `sheet-${++n}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  reviewOf = async () => ({ ...baseReview(), own_account_unavailable: "linkedin_ads_http_error: 503 {\"message\":\"upstream\"}" });
  open();
  const raw = await screen.findByTestId("own-account-unavailable");
  expect(raw.textContent).toBe("Your own LinkedIn ad accounts cannot be read right now.");
});

it("shows why Zavi's places could not be looked up, with a Try again that reads the review again", async () => {
  let failed = true;
  reviewOf = async () => { const r = baseReview(); if (failed) { r.suggested.locations = []; r.suggested.location_search_failed = "LinkedIn did not answer the location search, so Zavi filled in no place."; } return r; };
  open();
  expect(await screen.findByText(/LinkedIn did not answer the location search/)).toBeTruthy();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByText(/LinkedIn did not answer the location search/)).toBeNull());
  expect(reviewReads()).toBe(2);
});

it.each([["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))], ["the header X", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))], ["Escape", () => fireEvent(screen.getAllByRole("dialog")[0], new Event("cancel"))]])("asks before discarding typed changes when closed with %s, and closes at once when nothing changed", async (_label, close) => {
  const onClose = open();
  await screen.findByText("Pilot");
  close();
  expect(onClose).toHaveBeenCalledTimes(1);
  cleanup();
  action = { id: `sheet-${++n}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  const onClose2 = open();
  await screen.findByText("Pilot");
  fireEvent.change(screen.getByLabelText("Spend up to, per day (USD)"), { target: { value: "40" } });
  close();
  expect(onClose2).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Discard your changes?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByLabelText("Spend up to, per day (USD)") as HTMLInputElement).value).toBe("40");
  close();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(onClose2).toHaveBeenCalledTimes(1);
});
