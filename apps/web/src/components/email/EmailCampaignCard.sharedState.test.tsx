// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];
const server = vi.hoisted(() => ({ cards: {} as Record<string, unknown> }));

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
    const test = url.match(/^\/api\/email-cards\/channel_actions\/([^/]+)\/test$/);
    if (method === "POST" && test) {
      const c = server.cards[test[1]] as { versions: Array<{ variant: number; tested_by_me: boolean; tested_by_approver: boolean }>; can_approve: boolean[] };
      c.versions = c.versions.map((v) => (v.variant === body.variant ? { ...v, tested_by_me: true, tested_by_approver: true } : v));
      c.can_approve = c.versions.map((v) => v.tested_by_approver);
      return ok({ ok: true });
    }
    const get = url.match(/^\/api\/email-cards\/channel_actions\/([^/]+)$/);
    if (method === "GET" && get && server.cards[get[1]]) return ok({ card: structuredClone(server.cards[get[1]]) });
    return ok({});
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";

const ID = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

function card(id: string): EmailCardView {
  return {
    rail: "channel_actions",
    id,
    class: "email_campaign.create_and_send",
    status: "pending",
    open: true,
    route: "sendgrid",
    list: { name: "Brightloop members", people: 238 },
    sender: { email: "hello@brightloop.test", name: "Brightloop" },
    reply_to: null,
    unsubscribe_group_id: "7",
    viewer_can_approve: true,
    chosen_variant: null,
    versions: [1, 2].map((n) => ({
      variant: n,
      subject: `Subject ${n}`,
      preview_text: `Preview ${n}`,
      html: `<p>Version ${n}</p>`,
      tested_by_me: false,
      tested_by_approver: false,
    })),
    can_approve: [false, false],
    reasons: [],
  };
}

const gets = (id: string) => calls.filter((c) => c.method === "GET" && c.url === `/api/email-cards/channel_actions/${id}`).length;

beforeEach(() => {
  calls.length = 0;
  server.cards = { [ID]: card(ID), [OTHER]: card(OTHER) };
});
afterEach(cleanup);

describe("EmailCampaignCard: two mounted copies of one card", () => {
  it("a test sent from the lane copy shows in the side-chat copy without a remount, and leaves another card alone", async () => {
    const lane = render(<div data-testid="lane"><EmailCampaignCard rail="channel_actions" id={ID} /></div>);
    const side = render(<div data-testid="side"><EmailCampaignCard rail="channel_actions" id={ID} /></div>);
    const other = render(<div data-testid="other"><EmailCampaignCard rail="channel_actions" id={OTHER} /></div>);
    const A = within(lane.getByTestId("lane"));
    const B = within(side.getByTestId("side"));
    const C = within(other.getByTestId("other"));

    await waitFor(() => expect(B.getByTestId("email-card-step-test").getAttribute("data-done")).toBe("false"));
    await waitFor(() => expect(C.getByTestId("email-card-step-test").getAttribute("data-done")).toBe("false"));
    expect(B.getByTestId("email-card-step-test").textContent).toContain("Not done");
    const sideNode = B.getByTestId("email-card-step-test");
    const otherBefore = gets(OTHER);
    const idBefore = gets(ID);

    fireEvent.click(A.getByRole("button", { name: /Send test of A to me/ }));

    await waitFor(() => expect(A.getByTestId("email-card-step-test").getAttribute("data-done")).toBe("true"));
    await waitFor(() => expect(B.getByTestId("email-card-step-test").getAttribute("data-done")).toBe("true"));
    expect(B.getByTestId("email-card-step-test")).toBe(sideNode);
    expect(B.getByTestId("email-card-step-test").textContent).toContain("Done");
    expect((B.getByRole("button", { name: /Approve and send A/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/test"))).toHaveLength(1);
    expect(gets(ID) - idBefore).toBe(2);

    await new Promise((r) => setTimeout(r, 50));
    expect(gets(OTHER)).toBe(otherBefore);
    expect(gets(ID) - idBefore).toBe(2);
    expect(C.getByTestId("email-card-step-test").getAttribute("data-done")).toBe("false");
  });
});
