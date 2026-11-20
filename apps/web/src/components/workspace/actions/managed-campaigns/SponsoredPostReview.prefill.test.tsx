// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SponsoredPostReview } from "./SponsoredPostReview";
import { forgetLinkedInAudienceOptions } from "./LinkedInAudiencePicker";
import type { ActionItem } from "../types";
import { closeCampaignReview, openCampaignReview } from "./openCampaignReview";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
const action = { id: "action-1", body: {}, channel_slug: "linkedin_ads" } as ActionItem;
const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
const SENIOR = { urn: "urn:li:seniority:6", name: "Senior" };
const VP = { urn: "urn:li:seniority:9", name: "VP" };
const SOFTWARE = { urn: "urn:li:industry:4", name: "Software Development" };
const BAND = { urn: "urn:li:staffCountRange:(11,50)", name: "11-50 employees" };
const CEO = { urn: "urn:li:title:1", name: "Chief Executive Officer" };
const review = (audience_suggestions: Record<string, string[]>) => ({
  draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Company post", post_urn: "urn:li:share:7123456789012345678", country: "US", audience_suggestions },
  accounts: [{ id: "11", name: "Account one", currency: "USD", funding_source: "provider" }],
  suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] },
});
const options: Record<string, Array<{ urn: string; name: string }>> = { seniorities: [SENIOR, VP], industries: [SOFTWARE], staffCountRanges: [BAND], titles: [CEO] };
let gate: Promise<void> | null = null;
beforeEach(() => {
  forgetLinkedInAudienceOptions();
  closeCampaignReview(action.id);
  gate = null;
  api.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
const serve = (r: ReturnType<typeof review>) => api.mockImplementation(async (path: string) => {
  if (path.endsWith("/review")) return r;
  if (path.includes("/targeting?")) {
    if (gate) await gate;
    const facet = /facet=(\w+)/.exec(path)![1];
    return { options: options[facet] ?? [] };
  }
  return path.includes("/locations?") ? { locations: [] } : { exact_change: { rows: [] } };
});
function open() {
  const onApprove = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();
  openCampaignReview(action.id);
  render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove, onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={vi.fn()} onClose={onClose} />);
  return { onApprove, onClose };
}
const create = () => screen.getByRole("button", { name: "Create paused campaign" }) as HTMLButtonElement;
const prepareBody = () => JSON.parse(api.mock.calls.find(([p]) => String(p).endsWith("/prepare"))![1].body);
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

it("opens with Zavi's suggested seniority, industry and company size already chosen, sends their LinkedIn ids, and closes on Cancel without a discard prompt", async () => {
  serve(review({ titles: [], seniorities: ["senior", "Owner"], industries: ["Software"], staffCountRanges: ["11-50 employees"] }));
  const { onApprove, onClose } = open();
  await screen.findByRole("button", { name: "Remove Software Development" });
  expect(screen.getByRole("button", { name: "Senior" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "VP" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "11-50 employees" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("checkbox", { name: /location and language only/ })).toBeNull();
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(onApprove).toHaveBeenCalled());
  expect(prepareBody()).toMatchObject({ audience: { titles: [], seniorities: [SENIOR.urn], industries: [SOFTWARE.urn], staffCountRanges: [BAND.urn] }, use_broad_audience: false });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalled();
});

it("a suggested job title wins over a suggested seniority, since LinkedIn refuses both", async () => {
  serve(review({ titles: ["Chief Executive Officer"], seniorities: ["Senior"], industries: [], staffCountRanges: [] }));
  open();
  await screen.findByRole("button", { name: "Remove Chief Executive Officer" });
  await tick();
  expect(screen.getByRole("button", { name: "Senior" }).getAttribute("aria-pressed")).toBe("false");
  expect((screen.getByRole("group", { name: "Seniority options" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
});

it("must catch: a broad-audience tick made while the suggestions are still loading is never overwritten by them", async () => {
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  serve(review({ titles: [], seniorities: ["Senior"], industries: [], staffCountRanges: [] }));
  const { onApprove } = open();
  fireEvent.click(await screen.findByRole("checkbox", { name: /location and language only/ }));
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
  expect((screen.getByRole("checkbox", { name: /location and language only/ }) as HTMLInputElement).checked).toBe(true);
  await waitFor(() => expect(create().disabled).toBe(false));
  fireEvent.click(create());
  await waitFor(() => expect(onApprove).toHaveBeenCalled());
  expect(prepareBody()).toMatchObject({ use_broad_audience: true, audience: { seniorities: [] } });
});

it("a founder who removed every suggested chip and reopens the sheet does not get them back", async () => {
  serve(review({ titles: [], seniorities: ["Senior"], industries: [], staffCountRanges: [] }));
  open();
  const pill = await screen.findByRole("button", { name: "Senior" });
  await waitFor(() => expect(pill.getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(pill);
  expect(screen.getByRole("button", { name: "Senior" }).getAttribute("aria-pressed")).toBe("false");
  await tick();
  cleanup();
  open();
  await screen.findByRole("button", { name: "Senior" });
  await tick();
  expect(screen.getByRole("button", { name: "Senior" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("checkbox", { name: /location and language only/ })).toBeTruthy();
});
