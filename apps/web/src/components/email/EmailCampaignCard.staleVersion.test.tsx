// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];
type Answer = { status: number; body: unknown; error?: Error; gate?: Promise<unknown> };
const answers: Record<string, Answer> = {};
const queued: Record<string, Answer[]> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const a = queued[`${method} ${url}`]?.shift() ?? answers[`${method} ${url}`] ?? { status: 200, body: {} };
    const answer = () => ("error" in a && a.error ? Promise.reject(a.error) : Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) }));
    return a.gate ? a.gate.then(answer) : answer();
  },
}));
const confirm = vi.hoisted(() => ({ fn: vi.fn(async (_o: { title: string; description?: string }) => true) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: confirm.fn }));
const viewer = vi.hoisted(() => ({ email: null as string | null }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => (viewer.email ? { email: viewer.email } : null) }));

import { EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";

const ID = "22222222-2222-4222-8222-222222222222";
const BASE = `/api/email-cards/channel_actions/${ID}`;

function card(over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail: "channel_actions",
    id: ID,
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
    versions: [1, 2, 3].map((n) => ({
      variant: n,
      subject: `Subject ${n}`,
      preview_text: `Preview ${n}`,
      html: `<p>Version ${n}</p><a href="javascript:alert(1)">bad</a><script>parent.x=1</script>`,
      tested_by_me: false,
      tested_by_approver: false,
    })),
    can_approve: [false, false, false],
    reasons: [],
    ...over,
  };
}

const serve = (c: EmailCardView) => {
  answers[`GET ${BASE}`] = { status: 200, body: { card: c } };
};

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  for (const k of Object.keys(queued)) delete queued[k];
  confirm.fn.mockClear();
  confirm.fn.mockResolvedValue(true);
  viewer.email = null;
});
afterEach(cleanup);

const STALE = "version_changed";
const LINE = "Someone changed this version after you opened it, so nothing was done. Reload to see the current text, then try again.";
const seenOf = (n: number) => String(n).repeat(64);
const withSeen = (over: Partial<EmailCardView> = {}) =>
  card({
    editable: true,
    can_approve: [true, true, true],
    versions: card().versions.map((v) => ({
      ...v,
      seen: seenOf(v.variant),
      tested_by_me: true,
      tested_by_approver: true,
      content: { subject: v.subject, preview_text: v.preview_text, title: "T", paragraphs: ["One."], button: { label: "Go", url: "https://brightloop.test" } },
    })),
    ...over,
  });

describe("EmailCampaignCard sends the version the founder read", () => {
  it("a save carries the version the editor opened with; a stale save says to reload and keeps the text", async () => {
    serve(withSeen());
    answers[`PATCH ${BASE}/variants/2`] = { status: 409, body: { error: { code: STALE, message: LINE } } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByRole("button", { name: /Edit this version/ });
    fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /Edit this version/ }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version B" }));
    await waitFor(() => screen.getByText("Not saved"));
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ seen: seenOf(2), content: { subject: "Mine" } });
    expect(screen.getByText(LINE)).toBeDefined();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Mine");
  });

  it("Approve carries the selected version the approver read", async () => {
    serve(withSeen());
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 241 } };
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByRole("button", { name: /Approve and send/ });
    fireEvent.click(screen.getByRole("tab", { name: /C · Subject 3/ }));
    fireEvent.click(screen.getByRole("button", { name: /Approve and send C/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/approve"))!.body).toMatchObject({ variant: 3, seen: seenOf(3) });
  });
});
