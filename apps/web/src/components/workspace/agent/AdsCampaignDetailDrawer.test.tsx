// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
import { AdsCampaignDetailDrawer } from "./AdsCampaignDetailDrawer";

const ad = { ad_id: "a1", ad_name: "Hero", spend_usd: 10, ctr_percent: 1.2, frequency: 1.1, roas: 2, effective_status: "ACTIVE", creative: { body: "Book now", title: "Hero card", call_to_action: null, destination_url: null, thumbnail_url: "https://img/t.jpg", image_url: "https://img/full.jpg", is_dynamic_creative: false, variant_count: 1 } };
const adSet = { ad_set_id: "s1", ad_set_name: "Set one", optimization_event: null, bid_strategy: null, bid_amount_usd: null, attribution_window: null, daily_budget_usd: 20, effective_status: "ACTIVE", advantage_audience: false, automatic_placements: true, age_min: null, age_max: null, genders: null, custom_audiences: [], excluded_custom_audiences: [], targeting_sentences: [], spend_usd: 10, ads: [ad] };
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ campaign_id: "c1", ad_sets: [adSet] }) });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); });

it("opens as a named modal with focus on Close, and Escape closes the image before the details", async () => {
  const onClose = vi.fn();
  render(<AdsCampaignDetailDrawer campaignId="c1" campaignName="Spring promo" agentSlug="performance-marketer" window="30d" onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: "Details for Spring promo" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(await screen.findByRole("button", { name: "View full image for Hero" }));
  expect(screen.getByRole("button", { name: "Close image" })).toBeTruthy();
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("button", { name: "Close image" })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
