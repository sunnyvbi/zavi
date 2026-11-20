// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type Call = { url: string; method: string };
const calls: Call[] = [];
const answers: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const a = answers[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body), clone() { return this; } });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";

const ID = "d5018618-6c49-48eb-a4f1-572779ad9f9e";
const FALLBACK = "Zavi could not finish this send. Ask Zavi for a new draft.";
const WIN = { text: "At least 12 clicks by day 7", metric: "clicks", threshold: 12, frozen: false };
const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");

function sweepSentences(): { paused: string; stopped: string; expired: string } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const latest = files.filter((f) => /function public\.email_redispatch_released_sweep\(/.test(readFileSync(join(MIGRATIONS, f), "utf8"))).pop();
  if (!latest) throw new Error("no migration defines email_redispatch_released_sweep");
  const m = /dispatch_error = case when v_paused\s+then '((?:[^']|'')*)'\s+when v_stopped\s+then '((?:[^']|'')*)'\s+else '((?:[^']|'')*)' end/.exec(readFileSync(join(MIGRATIONS, latest), "utf8"));
  if (!m) throw new Error(`${latest} no longer writes the paused/expired dispatch_error in the expected shape`);
  return { paused: m[1].replace(/''/g, "'"), stopped: m[2].replace(/''/g, "'"), expired: m[3].replace(/''/g, "'") };
}

function card(over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail: "decisions",
    id: ID,
    class: "bulk_outbound.send",
    status: "failed",
    open: false,
    route: "zavi_list",
    list: { name: "Cakely regulars", people: 40 },
    sender: { email: "hello@cakely.test", name: null },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: 1,
    versions: [{ variant: 1, subject: "Fresh from the oven today", preview_text: "Chocolate cake box", html: "<p>Cake</p>", tested_by_me: true, tested_by_approver: true }],
    can_approve: [false],
    reasons: [],
    retryable: false,
    may_have_sent: false,
    win_line: WIN,
    ...over,
  };
}

const serve = (c: EmailCardView) => {
  answers[`GET /api/email-cards/${c.rail}/${c.id}`] = { status: 200, body: { card: c } };
};
const status = () => screen.getByTestId("email-card-status").textContent ?? "";
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

describe("Notion Flow 86: a send released a day after approval says why and claims no goal", () => {
  it.each([
    ["expired", "failed"],
    ["expired", "dispatch_failed"],
    ["paused", "failed"],
    ["paused", "dispatch_failed"],
  ] as const)("a %s release on a %s card shows its own sentence and no day-7 goal", async (which, st) => {
    const s = sweepSentences();
    const reason = s[which];
    const other = s[which === "expired" ? "paused" : "expired"];
    serve(card({ status: st, failure_reason: reason }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(status()).toContain("Failed"));
    expect(text()).toContain(reason);
    expect(text()).not.toContain(other);
    expect(text()).not.toContain("Zavi could not finish this send");
    expect(text()).toContain("This one cannot be tried again.");
    expect(text()).not.toContain("Ask Zavi to draft it again");
    expect(screen.queryByTestId("email-card-win-line")).toBeNull();
    expect(text()).not.toContain("Goal for day 7");
    expect(text()).not.toContain("Set when sent");
    expect(text()).not.toContain(WIN.text);
    expect(screen.queryByRole("button", { name: /try again|retry/i })).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("control: a dispatch_failed card with an unknown error keeps the generic copy and still has no goal", async () => {
    serve(card({ status: "dispatch_failed", failure_reason: FALLBACK }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(status()).toContain("Failed"));
    expect(text()).toContain(FALLBACK);
    expect(screen.queryByTestId("email-card-win-line")).toBeNull();
  });

  it("control: a sent card keeps its frozen day-7 goal", async () => {
    serve(card({ status: "sent", sent_at: "2099-10-30T05:00:41Z", sent_count: 40, win_line: { ...WIN, frozen: true } }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(status()).toContain("Sent"));
    const line = screen.getByTestId("email-card-win-line").textContent ?? "";
    expect(line).toContain("Goal for day 7");
    expect(line).toContain(WIN.text);
    expect(line).toContain("Set when this email was sent");
  });

  it("control: a failed card an owner can retry keeps its goal, since it may still go out", async () => {
    serve(card({ status: "failed", retryable: true, failure_reason: FALLBACK }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(status()).toContain("Failed"));
    expect(screen.getByTestId("email-card-win-line").textContent).toContain("Set when sent, from your past emails to this list");
  });

  it("control: a may_have_sent card keeps Delivery unknown and its goal line", async () => {
    serve(card({ status: "dispatch_failed", may_have_sent: true, failure_reason: "Zavi did not hear back from its sending service about this send, so it may have gone out. Zavi will not send it again, so nobody gets it twice." }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(status()).toContain("Delivery unknown"));
    expect(screen.getByTestId("email-card-win-line")).toBeDefined();
  });
});
