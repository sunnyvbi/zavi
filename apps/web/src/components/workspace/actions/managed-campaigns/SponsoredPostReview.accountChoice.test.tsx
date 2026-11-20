import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SponsoredPostReview } from "./SponsoredPostReview";
import { forgetLinkedInAudienceOptions } from "./LinkedInAudiencePicker";
import { holdCampaignReview, invalidateCampaignReviews } from "./campaignReviewPrefetch";
import type { ActionItem } from "../types";
import { LINKEDIN_ADS_BILLING_HOLD, MANAGED_ACCOUNT_BILLING_HOLD } from "../../agent/linkedinAdsTables";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));

let n = 0;
let action = { id: "choice-0", body: {}, channel_slug: "linkedin_ads" } as ActionItem;
const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
const wallet = { id: "77", name: "Zavi shared", currency: "USD", funding_source: "wallet", account_binding_id: "b-wallet" };
const own = { id: "11", name: "Acme", currency: "USD", funding_source: "provider", account_binding_id: "b-own" };
const NO_ACCOUNT = "No LinkedIn ad account is in use yet. Connect LinkedIn Ads in Connectors, then open this review again.";
const WALLET_ONLY = "No LinkedIn ad account is in use yet. Authorize the shared wallet under Ad account and shared wallet on the LinkedIn Ads page, then open this review again.";
const ON_WALLET = "This campaign runs on the Zavi account and uses your shared ads balance when you approve its launch.";
const ON_OWN = "This campaign runs on your connected LinkedIn ad account. LinkedIn bills it directly.";
let review: Record<string, unknown>;
const reviewWith = (accounts: unknown[], extra: Record<string, unknown> = {}) => ({
  draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Company post", post_urn: "urn:li:share:7123456789012345678", country: "US" },
  accounts,
  suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] },
  ...extra,
});
const prepares = () => api.mock.calls.filter(([p]) => String(p).endsWith("/prepare"));
const calledWith = (text: string) => api.mock.calls.some(([p]) => String(p).includes(text));

beforeEach(() => {
  action = { id: `choice-${++n}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  invalidateCampaignReviews();
  forgetLinkedInAudienceOptions();
  api.mockReset();
  api.mockImplementation(async (path: string) => path.endsWith("/review") ? review
    : path.includes("/targeting?") ? { options: [] }
    : path.includes("/post-preview?") ? { post_urn: "urn:li:share:7123456789012345678", post_preview: "Company post", author: "page" }
    : path.includes("/locations?") ? { locations: [] }
    : { exact_change: { rows: [] } });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

function open() {
  const onApprove = vi.fn().mockResolvedValue(true);
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove, onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={vi.fn()} />);
  return onApprove;
}
function reopen(next: Record<string, unknown>) {
  cleanup();
  action = { id: `choice-${++n}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  invalidateCampaignReviews();
  review = next;
  return open();
}
const create = () => screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
const billing = () => screen.getByTestId("account-billing").textContent;
async function readyExceptAccount() {
  await screen.findByText("Pilot");
  fireEvent.click(screen.getByRole("checkbox", { name: /Show this to everyone/ }));
}
async function nothingCreated(approve: ReturnType<typeof vi.fn>) {
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form!);
  fireEvent.click(create());
  await new Promise((r) => setTimeout(r, 450));
  expect(prepares()).toHaveLength(0);
  expect(approve).not.toHaveBeenCalled();
}

it.each([
  ["the review does not say which account is in use", {}],
  ["the founder has no account in use (they stopped using their own)", { selected_account_binding_id: null }],
])("P2 money: with only the shared wallet offered and no account in use when %s, runs on nothing and creates nothing", async (_label, extra) => {
  review = reviewWith([wallet], extra);
  const approve = open();
  await readyExceptAccount();
  expect(billing()).toBe(WALLET_ONLY);
  expect(screen.queryByTestId("account-billing-hold")).toBeNull();
  expect(screen.queryByText(/Zavi shared/)).toBeNull();
  await nothingCreated(approve);
  expect(calledWith("account_binding_id=b-wallet")).toBe(false);
  expect(calledWith("account_id=77")).toBe(false);
});

it("P2 money: with no account in use, runs on the founder's own account and never on the shared wallet beside it", async () => {
  review = reviewWith([wallet, own]);
  const approve = open();
  await readyExceptAccount();
  expect(billing()).toBe(ON_OWN);
  expect((screen.getByLabelText("Spend up to, per day (USD)") as HTMLInputElement).value).toBe("15");
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(JSON.parse(prepares()[0][1].body)).toMatchObject({ account_id: "11", account_binding_id: "b-own" });
  expect(calledWith("account_binding_id=b-wallet")).toBe(false);
});

it("P2: runs on the account in use, the wallet included, and says whose money it is", async () => {
  review = reviewWith([wallet, own], { selected_account_binding_id: "b-wallet" });
  let approve = open();
  await readyExceptAccount();
  expect(billing()).toBe(ON_WALLET);
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(JSON.parse(prepares()[0][1].body)).toMatchObject({ account_id: "77", account_binding_id: "b-wallet" });
  approve = reopen(reviewWith([wallet, own], { selected_account_binding_id: "b-own" }));
  await readyExceptAccount();
  expect(billing()).toBe(ON_OWN);
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(JSON.parse(prepares()[1][1].body)).toMatchObject({ account_id: "11", account_binding_id: "b-own" });
});

it.each([
  ["the founder's own account", [own, { ...own, id: "12", name: "Acme side", account_binding_id: "b-side", billing_hold: true }], "b-side", "account_id=12", ON_OWN, LINKEDIN_ADS_BILLING_HOLD],
  ["the shared wallet", [own, { ...wallet, billing_hold: true }], "b-wallet", "account_id=77", ON_WALLET, MANAGED_ACCOUNT_BILLING_HOLD],
])("Review 32 P5: never runs on %s while LinkedIn holds it for billing, says why, and does not slide to another account", async (_label, accounts, inUse, query, hint, hold) => {
  review = reviewWith(accounts, { selected_account_binding_id: inUse });
  const approve = open();
  await readyExceptAccount();
  expect(billing()).toBe(hint);
  expect(screen.getByTestId("account-billing-hold").textContent).toBe(hold);
  expect(screen.queryByText(NO_ACCOUNT)).toBeNull();
  expect(screen.queryByText(/Choose another account/)).toBeNull();
  await nothingCreated(approve);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("LinkedIn has paused this ad account for billing.");
  expect(calledWith("account_id=11")).toBe(false);
});

it("Review 32 P5: with no account in use, the first-own-account default skips a held account", async () => {
  review = reviewWith([{ ...own, billing_hold: true }, { ...own, id: "12", name: "Acme side", account_binding_id: "b-side" }]);
  const approve = open();
  await readyExceptAccount();
  expect(billing()).toBe(ON_OWN);
  expect(screen.queryByTestId("account-billing-hold")).toBeNull();
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(approve).toHaveBeenCalled());
  expect(JSON.parse(prepares()[0][1].body)).toMatchObject({ account_id: "12", account_binding_id: "b-side" });
  expect(calledWith("account_id=11")).toBe(false);
});

it("Review 33 P3: after Create is refused, reopening reads the account list again instead of the 5-minute copy", async () => {
  const path = `${spec.actionReviewPath}/${action.id}/review`;
  review = reviewWith([own], { selected_account_binding_id: "b-own" });
  const release = holdCampaignReview(path);
  api.mockImplementation(async (p: string) => {
    if (p.endsWith("/prepare")) throw Object.assign(new Error("The selected advertiser account changed. Review it again."), { status: 409, code: "linkedin_ads_conflict" });
    return p.endsWith("/review") ? review : p.includes("/post-preview?") ? { post_urn: "urn:li:share:7123456789012345678", post_preview: "Company post", author: "page" } : { options: [], locations: [] };
  });
  const reads = () => api.mock.calls.filter(([p]) => String(p).endsWith("/review")).length;
  open();
  await readyExceptAccount();
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  expect((await screen.findByRole("alert")).textContent).toBe("The selected advertiser account changed. Review it again.");
  expect(reads()).toBe(1);
  cleanup();
  review = reviewWith([{ ...own, id: "99", name: "Acme new", account_binding_id: "b-new" }], { selected_account_binding_id: "b-new" });
  open();
  await screen.findByText("Pilot");
  expect(reads()).toBe(2);
  expect(billing()).toBe(ON_OWN);
  await waitFor(() => expect(calledWith("account_id=99")).toBe(true));
  release();
});

it("Review 33 P5: the live preview shows the post text LinkedIn returned, not Zavi's saved summary", async () => {
  review = reviewWith([own], { selected_account_binding_id: "b-own", draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Zavi's short summary of the post", post_urn: "urn:li:share:7123456789012345678", country: "US" } });
  api.mockImplementation(async (p: string) => p.endsWith("/review") ? review
    : p.includes("/post-preview?") ? { post_urn: "urn:li:share:7123456789012345678", post_preview: "The full real post as it is on LinkedIn", author: "page" }
    : { options: [], locations: [] });
  open();
  const preview = await screen.findByRole("complementary", { name: "Preview" });
  await waitFor(() => expect(preview.textContent).toContain("The full real post as it is on LinkedIn"));
  expect(preview.textContent).not.toContain("Zavi's short summary of the post");
});

it("with nothing in use and every own account held for billing, names the hold instead of claiming no account exists", async () => {
  review = reviewWith([{ ...own, billing_hold: true }]);
  const approve = open();
  await readyExceptAccount();
  expect(billing()).toBe(ON_OWN);
  expect(screen.getByTestId("account-billing-hold").textContent).toBe(LINKEDIN_ADS_BILLING_HOLD);
  expect(screen.queryByText(NO_ACCOUNT)).toBeNull();
  await nothingCreated(approve);
});

it("with only the shared wallet on offer and nothing in use, points at the wallet permission, not at Connectors", async () => {
  review = reviewWith([wallet]);
  const approve = open();
  await readyExceptAccount();
  expect(billing()).toBe(WALLET_ONLY);
  expect(screen.getByTestId("create-blocked-reason").textContent).toBe("Authorize the shared wallet first.");
  await nothingCreated(approve);
});
