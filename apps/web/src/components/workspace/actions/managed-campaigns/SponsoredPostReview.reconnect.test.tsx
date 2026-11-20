import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SponsoredPostReview } from "./SponsoredPostReview";
import { forgetLinkedInAudienceOptions } from "./LinkedInAudiencePicker";
import { invalidateCampaignReviews } from "./campaignReviewPrefetch";
import type { ActionItem } from "../types";

const api = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
vi.mock("@/app/connectors/ConnectButton", () => ({ startConnectFlow: connect }));

const MESSAGE = "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu.";
const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
let n = 0;

function mount(code: string | undefined, message = MESSAGE) {
  api.mockImplementation(async () => { throw Object.assign(new Error(message), { code }); });
  const action = { id: `reconnect-${++n}`, body: {}, channel_slug: "linkedin_ads" } as ActionItem;
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove: vi.fn(), onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={vi.fn()} />);
}

beforeEach(() => {
  invalidateCampaignReviews();
  forgetLinkedInAudienceOptions();
  api.mockReset();
  connect.mockReset();
  connect.mockResolvedValue(undefined);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

it.each(["linkedin_ads_token_revoked", "linkedin_ads_not_connected"])("offers Reconnect, not Try again, for %s and starts the connect flow in place", async (code) => {
  mount(code);
  const button = await screen.findByRole("button", { name: "Reconnect LinkedIn Ads" });
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(connect).toHaveBeenCalledWith("linkedin_ads", { returnHere: true }));
});

it("decides on the error code, not the message text", async () => {
  mount("linkedin_ads_token_revoked", "Something unrelated");
  expect(await screen.findByRole("button", { name: "Reconnect LinkedIn Ads" })).toBeTruthy();
});

it("keeps Try again for other errors, even when the message mentions reconnecting", async () => {
  mount("linkedin_ads_busy", MESSAGE);
  expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reconnect LinkedIn Ads" })).toBeNull();
  expect(connect).not.toHaveBeenCalled();
});
