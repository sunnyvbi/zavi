// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const reads: Record<string, unknown> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    if ((init?.method ?? "GET") !== "GET") {
      return Promise.resolve({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ error: { code: "test_refused", message: "That address cannot receive a test." } }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reads[url] ?? {}) });
  },
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => ({ email: "founder@yopmail.com" }) }));

import { EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";

const ID = "55555555-5555-4555-8555-555555555555";
const BASE = `/api/email-cards/channel_actions/${ID}`;
const ANCHOR = { top: 500, bottom: 530, left: 100, right: 300, width: 200, height: 30, x: 100, y: 500, toJSON: () => ({}) };
const BUBBLE = { top: 0, bottom: 90, left: 0, right: 200, width: 200, height: 90, x: 0, y: 0, toJSON: () => ({}) };

function card(): EmailCardView {
  return {
    rail: "channel_actions",
    id: ID,
    class: "email_campaign.create_and_send",
    status: "pending",
    open: true,
    route: "zavi_list",
    list: { name: "Yopmail testers", people: 6 },
    sender: { email: "hello@yopmail.com", name: "Yop" },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: null,
    editable: true,
    versions: [1, 2, 3].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>Version ${n}</p>`, tested_by_me: false, tested_by_approver: false })),
    can_approve: [false, false, false],
    reasons: [],
  } as EmailCardView;
}

beforeEach(() => {
  for (const k of Object.keys(reads)) delete reads[k];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return (this.getAttribute("role") === "tooltip" ? BUBBLE : ANCHOR) as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a refused test send keeps its reason readable", () => {
  for (const name of [/Send test of A/, /Edit this version/, /Send a test first/]) {
    it(`the hint on ${name} opens below the control, never over the error notice above it`, async () => {
      reads[BASE] = { card: card() };
      reads[`${BASE}/count`] = { people: 6 };
      reads["/api/workspace/email-pause"] = { paused: false, held: null };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const send = (await screen.findByRole("button", { name: /Send test of A/ })) as HTMLButtonElement;
      await waitFor(() => expect(send.disabled).toBe(false));
      fireEvent.click(send);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("The test was not sent"));
      const control = screen.getAllByRole("button", { name }).find((b) => !(b as HTMLButtonElement).disabled || /first/.test(b.textContent ?? "")) as HTMLElement;
      fireEvent.focus(control);
      const tip = await screen.findByRole("tooltip");
      await waitFor(() => expect(tip.style.visibility).toBe("visible"));
      expect(parseFloat(tip.style.top)).toBeGreaterThanOrEqual(ANCHOR.bottom);
    });
  }
});
