// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api, requestKey: () => ({ signature: "test", id: "11111111-1111-4111-8111-111111111111" }) }));
import { CampaignEditor } from "./CampaignEditor";
import { SheetSelect } from "./AdsSheet";
import { chatgpt_ads } from "../platforms/chatgpt_ads";

const options = { conversion_events: [], inclusion_audiences: [], exclusion_audiences: [], product_feeds: [], warnings: [] };

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string) => (path.endsWith("/resources") ? options : { rows: [] }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => cleanup());

function assertNoZoomOnFocus(el: Element) {
  const classes = el.className.split(/\s+/);
  expect(classes).toContain("text-base");
  expect(classes).toContain("min-h-11");
  expect(classes).not.toContain("h-10");
  expect(classes.some((c) => /^text-\[(1[0-5]|[0-9])px\]$/.test(c) || c === "text-sm" || c === "text-xs")).toBe(false);
}

it("every typed field in the campaign sheet, location search included, is 16px and at least 44px tall, so iOS does not zoom on focus", () => {
    render(<CampaignEditor spec={chatgpt_ads.campaignWorkspace!} campaign="new" prefix="" currency="USD" onBack={() => {}} onSaved={() => {}} />);
    assertNoZoomOnFocus(screen.getByLabelText("Campaign name"));
    const fields = Array.from(document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), select, textarea"))
      .filter((el) => el.className.includes("rounded-[10px]"));
    expect(fields.length).toBeGreaterThan(1);
    expect(screen.getByLabelText("Include locations search")).toBeTruthy();
    fields.forEach(assertNoZoomOnFocus);
});

it("the shared sheet select is 16px and at least 44px tall", () => {
  render(<SheetSelect aria-label="Pick"><option>One</option></SheetSelect>);
  assertNoZoomOnFocus(screen.getByLabelText("Pick"));
});
