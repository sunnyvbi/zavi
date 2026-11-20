// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string };
const calls: Call[] = [];
let onPost: (url: string) => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({}) });
const reads: Record<string, unknown> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method !== "GET") return onPost(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reads[url] ?? {}) });
  },
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => ({ email: "founder@yopmail.com" }) }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { requestTimeout } from "@/lib/workspace/emailPlanApi";
import { EmailCampaignCard, actionErrorText, type EmailCardView } from "./EmailCampaignCard";

const ID = "44444444-4444-4444-8444-444444444444";
const BASE = `/api/email-cards/channel_actions/${ID}`;
const PLAIN = "Zavi could not reach the server. Check the card again in a minute before retrying.";
const RAW = /Failed to fetch|timeout|\(502\)|502|Something went wrong/i;

function card(over: Partial<EmailCardView> = {}): EmailCardView {
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
    versions: [1, 2, 3].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>Version ${n}</p>`, tested_by_me: n === 1, tested_by_approver: n === 1 })),
    can_approve: [true, false, false],
    reasons: [],
    ...over,
  };
}

const posts = () => calls.filter((c) => c.method === "POST");

function setup(c: EmailCardView) {
  reads[BASE] = { card: c };
  reads[`${BASE}/count`] = { people: 6 };
  reads["/api/workspace/email-pause"] = { paused: false, held: null };
  render(
    <>
      <ConfirmDialogHost />
      <EmailCampaignCard rail="channel_actions" id={ID} />
    </>,
  );
}

const never = () => new Promise(() => undefined);
const FAILURES: ReadonlyArray<[string, () => Promise<unknown>]> = [
  ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
  ["a timeout", never],
  ["a 502", async () => ({ ok: false, status: 502, json: async () => null })],
];

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(reads)) delete reads[k];
  requestTimeout.ms = 30;
});
afterEach(() => {
  cleanup();
  requestTimeout.ms = 30_000;
});

describe("ROI #5: a failed card action never shows the founder a raw error", () => {
  for (const [name, fail] of FAILURES) {
    it(`Approve and send on ${name}: plain line, no raw text, one POST`, async () => {
      onPost = fail;
      setup(card());
      const b = (await screen.findByRole("button", { name: /Approve and send A/ })) as HTMLButtonElement;
      await waitFor(() => expect(b.disabled).toBe(false));
      fireEvent.click(b);
      const d = await screen.findByRole("alertdialog");
      fireEvent.click(within(d).getByRole("button", { name: /^Send now$/ }));
      await waitFor(() => expect(posts().length).toBe(1));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(PLAIN));
      await new Promise((r) => setTimeout(r, 80));
      expect(document.body.textContent).not.toMatch(RAW);
      expect(posts().length).toBe(1);
    });
  }

  it("keeps a server-provided reason and a session-expired line as they are", () => {
    expect(actionErrorText(new Error("Pick a list first."))).toBe("Pick a list first.");
    expect(actionErrorText(new TypeError("Failed to fetch"))).toBe(PLAIN);
    expect(actionErrorText(new Error("timeout"))).toBe(PLAIN);
    expect(actionErrorText(new Error("Something went wrong (502)."))).toBe(PLAIN);
    expect(actionErrorText(undefined)).toBe(PLAIN);
  });
});
