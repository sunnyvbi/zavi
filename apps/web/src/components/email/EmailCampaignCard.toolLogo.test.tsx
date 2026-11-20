// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

let served: unknown = null;
vi.mock("@/lib/api", () => ({
  apiFetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ card: served }), clone() { return this; } }),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";

const ID = "d5018618-6c49-48eb-a4f1-572779ad9f9e";
const PUBLIC = join(__dirname, "../../../public");

function card(route: string): EmailCardView {
  return {
    rail: "decisions",
    id: ID,
    class: "bulk_outbound.send",
    status: "pending",
    open: true,
    route,
    list: { name: "Zavi QA", people: 1 },
    sender: { email: "hello@cakely.test", name: null },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: 1,
    versions: [{ variant: 1, subject: "Fresh today", preview_text: "Cake", html: "<p>Cake</p>", tested_by_me: true, tested_at: null, tested_by: null }],
    can_approve: [true],
    reasons: [],
    retryable: false,
    may_have_sent: false,
    win_line: null,
  } as unknown as EmailCardView;
}

afterEach(cleanup);

describe("the tool logo in the card header", () => {
  it.each([
    ["klaviyo", "Klaviyo", "/logos/klaviyo-icon.svg", "bg-[#232426]"],
    ["mailchimp", "Mailchimp", "/logos/mailchimp-icon.svg", "bg-[#ffe01b]"],
    ["sendgrid", "SendGrid", "/logos/sendgrid-icon.svg", "bg-white"],
  ])("%s shows its own logo on its own tile beside the name, from a file that exists", async (route, name, src, tile) => {
    served = card(route);
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    const logo = await screen.findByTestId("slip-logo");
    expect(logo.getAttribute("src")).toBe(src);
    expect(logo.getAttribute("alt")).toBe("");
    expect(existsSync(join(PUBLIC, src))).toBe(true);
    const box = logo.parentElement as HTMLElement;
    expect(box.className.split(/\s+/)).toContain(tile);
    expect(box.textContent).toBe("");
    const row = box.parentElement as HTMLElement;
    expect(within(row).getByText(name)).toBeTruthy();
  });

  it("a Zavi list keeps the plain mark and shows no logo", async () => {
    served = card("zavi_list");
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await screen.findByText("Zavi");
    expect(screen.queryByTestId("slip-logo")).toBeNull();
    expect(screen.getByText("@")).toBeTruthy();
  });
});
