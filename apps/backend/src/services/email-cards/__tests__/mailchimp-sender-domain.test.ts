import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));

import { emailCardHandlers } from "@/routes/email-cards";
import { cardSendState, cardSenderWarning, sendEmailCardTest, stageCounts, type CardDeps, type SendFacts, type ViewState } from "../cards";
import { TestSendError } from "../test-send";
import { shaOf } from "../variants";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "33333333-3333-4333-8333-333333333333";

const body = (over: Record<string, unknown> = {}) => ({
  tool: "mailchimp",
  credential: { kind: "composio", connected_account_id: "ca_1", auth_config_id: "ac_1" },
  audience_id: "L1",
  audience_name: "Zavi Labs INC",
  audience_count: 1,
  from_email: "developer@zaviagent.com",
  from_name: "Zavi Labs INC",
  reply_to: null,
  subject: "New at Zavi this week",
  preview_text: null,
  body_text: "Hello",
  ...over,
});

const AUTH_FALSE = { ok: true, status: 200, outcome_unknown: false, error: null, data: { authenticated: false, domain: "zaviagent.com", status: "VERIFIED", verified: true } };
const AUTH_TRUE = { ...AUTH_FALSE, data: { ...AUTH_FALSE.data, authenticated: true } };
const NOT_ON_ACCOUNT = {
  ok: false,
  status: 200,
  outcome_unknown: false,
  error: '{"type":"https://mailchimp.com/developer/marketing/docs/errors/","title":"Resource Not Found","status":404,"detail":"The requested resource could not be found."}',
  data: { http_error: "404 Client Error: Not Found for url: https://us14.api.mailchimp.com/3.0/verified-domains/upcar.ai", message: "not found", status_code: 404 },
};

function deps(answer: unknown) {
  const exec = vi.fn(async (_a: { tool_slug: string; arguments: Record<string, unknown> }) => answer);
  return { exec, d: { resolveAccount: vi.fn(async () => ({ tenant_id: T, connected_account_id: "ca_1" })), exec } as never };
}

describe("a Mailchimp send from a domain Mailchimp has not authenticated", () => {
  it("warns, naming the domain, on the answer Mailchimp gave for zaviagent.com", async () => {
    const { d, exec } = deps(AUTH_FALSE);
    const w = await cardSenderWarning(T, "email_campaign.create_and_send", body(), d);
    expect(w).toContain("zaviagent.com is not authenticated");
    expect(exec.mock.calls[0]![0]).toMatchObject({ tool_slug: "MAILCHIMP_GET_DOMAIN_INFO", arguments: { domain_name: "zaviagent.com" } });
  });

  it("warns when the domain was never added to the Mailchimp account", async () => {
    const { d } = deps(NOT_ON_ACCOUNT);
    expect(await cardSenderWarning(T, "email_campaign.create_and_send", body({ from_email: "a@upcar.ai" }), d)).toContain("upcar.ai is not authenticated");
  });

  it("checks the address mail goes out from: the reply-to when the card has one", async () => {
    const { d, exec } = deps(AUTH_FALSE);
    await cardSenderWarning(T, "email_campaign.create_and_send", body({ from_email: "a@clean.test", reply_to: "b@Team.Upcar.AI" }), d);
    expect(exec.mock.calls[0]![0].arguments).toEqual({ domain_name: "team.upcar.ai" });
  });

  it("says nothing for an authenticated domain", async () => {
    const { d, exec } = deps(AUTH_TRUE);
    expect(await cardSenderWarning(T, "email_campaign.create_and_send", body(), d)).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a tool failure", { ok: false, status: 500, outcome_unknown: false, error: "server exploded", data: null }],
    ["an unsure outcome", { ok: false, status: 0, outcome_unknown: true, error: "timed out", data: null }],
    ["an answer with no verdict", { ok: true, status: 200, outcome_unknown: false, error: null, data: { domain: "zaviagent.com" } }],
    ["a verdict that is not a boolean", { ok: true, status: 200, outcome_unknown: false, error: null, data: { authenticated: "false" } }],
  ])("does not claim a domain is unauthenticated on %s", async (_n, answer) => {
    const { d, exec } = deps(answer);
    expect(await cardSenderWarning(T, "email_campaign.create_and_send", body(), d)).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("a read that throws never reaches the founder as a failure", async () => {
    const d = { resolveAccount: async () => { throw new Error("vault down"); }, exec: vi.fn() } as never;
    expect(await cardSenderWarning(T, "email_campaign.create_and_send", body(), d)).toBeNull();
  });

  it("never calls a tool for Zavi's own sender, or for a route without this check", async () => {
    const a = deps(AUTH_FALSE);
    expect(await cardSenderWarning(T, "bulk_outbound.send", body(), a.d)).toBeNull();
    expect(await cardSenderWarning(T, "email_campaign.create_and_send", body({ tool: "klaviyo" }), a.d)).toBeNull();
    expect(a.exec).not.toHaveBeenCalled();
  });
});

function count(o: { people: number | null; warning: string | null | Error }) {
  mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
  const senderWarning = vi.fn(async () => {
    if (o.warning instanceof Error) throw o.warning;
    return o.warning;
  });
  const d: Partial<CardDeps> = {
    rpc: (async () => ({ ok: true, class: "email_campaign.create_and_send", body: body(), open: true, status: "pending", role: "owner", versions: 1, retryable: false })) as unknown as CardDeps["rpc"],
    liveCount: async () => o.people,
    senderWarning,
  };
  const h = emailCardHandlers(d, async () => new Set<string>(), (async () => null) as never);
  const r = { statusCode: 200, body: undefined as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return h.count({ params: { rail: "channel_actions", id: CARD }, body: {} } as never, r as never).then(() => r);
}

describe("the count read before the send dialog", () => {
  it("carries the warning with the people", async () => {
    const r = await count({ people: 1, warning: "not authenticated" });
    expect(r.body).toEqual({ people: 1, sender_warning: "not authenticated" });
  });

  it("adds no field on a clean domain, so the dialog is unchanged", async () => {
    expect((await count({ people: 1, warning: null })).body).toEqual({ people: 1 });
  });

  it("a warning does not rescue a count that could not be read", async () => {
    const r = await count({ people: null, warning: "not authenticated" });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.body?.people).toBeUndefined();
  });
});

describe("the sender warning on a test send", () => {
  const version = { content: { subject: "s", preview_text: "", title: "t", paragraphs: ["p"], button: { label: "b", url: "https://a.test" } }, html: "<p>x</p>", text: "x" };
  const testBody = () => body({
    subject: undefined,
    preview_text: undefined,
    body_text: undefined,
    variants: [{ ...version, render_sha: shaOf("email-r1", version.html, version.text) }],
    template_snapshot: { logo_url: null, brand_color: "#111827", button_color: "#111827", font_key: "system", sign_off: "", postal_address: "1 St", show_cards: false, company_name: "C", own_host: null, campaign_slug: "s-20261027" },
    renderer_version: "email-r1",
  });
  function send(o: { sender: () => Promise<string | null>; tool?: { via: string; warning?: string } | Error; record?: unknown }) {
    const senderWarning = vi.fn(o.sender);
    const names: string[] = [];
    const rpc = async (_t: string, name: string) => {
      names.push(name);
      return name === "email_card_for_test" ? { ok: true, class: "email_campaign.create_and_send", body: testBody(), test_sha: "s" } : (o.record ?? { ok: true });
    };
    const sendToolTest = async () => {
      if (o.tool instanceof Error) throw o.tool;
      return o.tool ?? { via: "Mailchimp" };
    };
    return sendEmailCardTest(T, "channel_actions" as never, CARD, 1, "u", { rpc: rpc as never, confirmedEmail: async () => "o@a.test", sendToolTest: sendToolTest as never, senderWarning }).then((r) => ({ r, senderWarning, names }));
  }

  it("a test that went out carries the warning the send dialogs show", async () => {
    const { r } = await send({ sender: async () => "not authenticated" });
    expect(r).toEqual({ ok: true, via: "Mailchimp", warning: "not authenticated" });
  });

  it("joins the warning a test already had, and neither is lost", async () => {
    const { r } = await send({ tool: { via: "Mailchimp", warning: "draft left behind" }, sender: async () => "not authenticated" });
    expect(r).toEqual({ ok: true, via: "Mailchimp", warning: "draft left behind not authenticated" });
  });

  it("a clean domain adds no field", async () => {
    expect((await send({ sender: async () => null })).r).toEqual({ ok: true, via: "Mailchimp" });
  });

  it("a read that fails shows no warning and does not fail a test that went out", async () => {
    const { r, names } = await send({
      sender: async () => {
        throw new Error("mailchimp down");
      },
    });
    expect(r).toEqual({ ok: true, via: "Mailchimp" });
    expect(names).toEqual(["email_card_for_test", "record_email_test_send"]);
  });

  it("a read that fails keeps the warning the test already had", async () => {
    const { r } = await send({
      tool: { via: "Mailchimp", warning: "draft left behind" },
      sender: async () => {
        throw new Error("mailchimp down");
      },
    });
    expect(r).toEqual({ ok: true, via: "Mailchimp", warning: "draft left behind" });
  });

  it("a test that was refused makes no read and is not called sent", async () => {
    const { r, senderWarning } = await send({ tool: new TestSendError("provider_refused", "refused"), sender: async () => "not authenticated" });
    expect(r).toMatchObject({ ok: false, code: "provider_refused" });
    expect(JSON.stringify(r)).not.toContain("not authenticated");
    expect(senderWarning).not.toHaveBeenCalled();
  });
});

describe("Mailchimp's number is not proof of delivery", () => {
  const view = (tool: string) => ({ status: "acted", class: "email_campaign.create_and_send", body: { tool } }) as unknown as ViewState;
  const facts: SendFacts = {
    card: { status: "executed", exec_status: "executed", approved: true },
    bulk: null,
    results: { sent_count: 1, finished_at: "2026-11-02T11:25:48Z", h1: { provider_status: "ok", delivered: 1, opens: 0, clicks: 0 }, d7: {}, d7_published: false },
  } as SendFacts;

  it("the Mailchimp card keeps the count for rates and calls it Not bounced", () => {
    const s = cardSendState("channel_actions", view("mailchimp"), facts);
    expect(s.hour_1).toMatchObject({ delivered: 1, delivered_label: "Not bounced" });
  });

  it.each(["klaviyo", "sendgrid"])("%s reports a real delivered event and keeps its label", (tool) => {
    const s = cardSendState("channel_actions", view(tool), facts);
    expect(s.hour_1?.delivered_label).toBeUndefined();
  });

  it("a stage with no route gets no label", () => {
    expect(stageCounts({ delivered: 3 })?.delivered_label).toBeUndefined();
  });
});
