import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionItem } from "../types";

const api = vi.hoisted(() => vi.fn());
const reloads = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
vi.mock("@/lib/workspace/buildLinkOnLoad", () => ({ reloadWithoutBuild: reloads }));

const action = { id: "action-1", body: {}, channel_slug: "linkedin_ads" } as ActionItem;
const spec = { title: "LinkedIn", actionReviewPath: "/api/channels/linkedin_ads/actions" };
const review = () => ({
  draft: { name: "Pilot", group_name: "Group", rationale: "Reach the buyer", post_preview: "Company post", post_urn: "urn:li:share:7123456789012345678", country: "US", audience_suggestions: { titles: ["Chief Executive Officer"], seniorities: [], industries: [], staffCountRanges: [] } },
  accounts: [{ id: "11", name: "Account one", currency: "USD", funding_source: "provider" }],
  suggested: { daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [] },
});
let prepareGate: (() => void) | null = null;
beforeEach(() => {
  vi.resetModules();
  reloads.mockReset();
  api.mockReset();
  prepareGate = null;
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/review")) return review();
    if (path.endsWith("/prepare")) {
      if (prepareGate === null) return { exact_change: { rows: [] } };
      await new Promise<void>((r) => { prepareGate = r; });
      return { exact_change: { rows: [] } };
    }
    if (path.includes("/post-preview?")) return { post_urn: "urn:li:share:7123456789012345678", post_preview: "Company post", author: "page" };
    if (path.includes("/targeting?")) return { options: [{ urn: "urn:li:title:1", name: "Chief Executive Officer" }] };
    return { locations: [] };
  });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => cleanup());

async function mount() {
  const { SponsoredPostReview } = await import("./SponsoredPostReview");
  const switches = await import("@/lib/workspace/tenantSwitch");
  const onApprove = vi.fn().mockResolvedValue(true);
  const onPrepared = vi.fn();
  const view = render(<SponsoredPostReview action={action} spec={spec} handlers={{ onApprove, onSetStatus: vi.fn(), onRedo: vi.fn() }} onPrepared={onPrepared} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Chief Executive Officer" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /Use location and language only/ }));
  const budget = screen.getByLabelText("Spend up to, per day (USD)") as HTMLInputElement;
  fireEvent.change(budget, { target: { value: "42" } });
  const create = () => screen.getByRole("button", { name: /Create paused campaign|Creating/ }) as HTMLButtonElement;
  await waitFor(() => expect(create().disabled).toBe(false));
  return { switches, onApprove, onPrepared, budget, create, view };
}
const prepares = () => api.mock.calls.filter(([p]) => String(p).endsWith("/prepare")).length;

it("a company switch in another tab keeps the half-filled review, shows a Reload notice, and never creates it", async () => {
  const { switches, onApprove, budget, create } = await mount();
  act(() => switches.reloadUnlessUnsavedWork());
  expect(reloads).not.toHaveBeenCalled();
  const notice = await screen.findByText(/You switched to another company in a different tab/);
  expect(notice.textContent).toContain("Zavi will not create this campaign");
  expect(budget.value).toBe("42");
  expect(create().disabled).toBe(true);
  fireEvent.submit(create().form ?? document.querySelector("form")!);
  await act(async () => { await Promise.resolve(); });
  expect(prepares()).toBe(0);
  expect(onApprove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(reloads).toHaveBeenCalledTimes(1);
});

it("a switch that lands while the review is being prepared never approves it against the new company", async () => {
  const { switches, onApprove, onPrepared, create } = await mount();
  prepareGate = () => {};
  fireEvent.click(create());
  await waitFor(() => expect(prepares()).toBe(1));
  act(() => switches.reloadUnlessUnsavedWork());
  await act(async () => { prepareGate?.(); await Promise.resolve(); await Promise.resolve(); });
  await screen.findByText(/You switched to another company in a different tab/);
  expect(onPrepared).not.toHaveBeenCalled();
  expect(onApprove).not.toHaveBeenCalled();
});

it("closing the review after the switch reloads into the new company, and a review that never saw a switch does not", async () => {
  const first = await mount();
  first.view.unmount();
  expect(reloads).not.toHaveBeenCalled();
  cleanup();
  const second = await mount();
  act(() => second.switches.reloadUnlessUnsavedWork());
  expect(reloads).not.toHaveBeenCalled();
  second.view.unmount();
  expect(reloads).toHaveBeenCalledTimes(1);
});
