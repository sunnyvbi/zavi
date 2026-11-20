import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));

import { emailCardHandlers } from "@/routes/email-cards";
import { LIVE_COUNT_WAIT_MS, type CardDeps } from "../cards";
import { confirmedEmailOf, sendBulkTestEmail, sendToolCardTest, TestSendError } from "../test-send";
import { shaOf, type ChosenVersion } from "../variants";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { UNSUBSCRIBE_HREF } from "@/services/email-templates/render";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const KEY = "SG.brightloopKey.secret";

const version = (n: number) => ({
  content: { subject: `Subject ${n}`, preview_text: "", title: "t", paragraphs: ["p"], button: { label: "Go", url: "https://brightloop.test" } },
  html: `<p>v${n}</p><a href="${UNSUBSCRIBE_HREF.sendgrid}">Unsubscribe</a>`,
  text: `v${n} Unsubscribe: ${UNSUBSCRIBE_HREF.sendgrid}`,
  render_sha: "",
});
function sealed(n: number) {
  const v = version(n);
  return { ...v, render_sha: shaOf("email-r1", v.html, v.text) };
}
const sgBody = {
  tool: "sendgrid",
  credential: { kind: "sendgrid_key", key_digest: sendgridKeyDigest(KEY) },
  audience_id: "L1",
  audience_name: "Members",
  audience_count: 200,
  from_name: "Brightloop",
  from_email: "hello@brightloop.test",
  reply_to: null,
  sendgrid_sender_id: "41",
  sendgrid_suppression_group_id: "7",
  variants: [sealed(1), sealed(2)],
  template_snapshot: {
    logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: "", postal_address: "1 St",
    show_cards: false, company_name: null, own_host: null, campaign_slug: "s-20261011",
  },
  renderer_version: "email-r1",
};

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

function harness(o: { body?: Record<string, unknown>; liveCount?: CardDeps["liveCount"]; winLine?: unknown; marksDown?: boolean; marks?: string[]; count?: number | null; retryable?: boolean; groupName?: string | null; role?: string; tested?: boolean[]; open?: boolean; tenantOk?: boolean; approve?: Record<string, unknown>; forTest?: Record<string, unknown>; plannedId?: string } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const enqueued: unknown[] = [];
  const toolTests: Array<{ to: string; n: number }> = [];
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (o.tenantOk === false) return { ok: false, code: "not_found" };
      if (name === "email_card_view_state") {
        const tested = o.tested ?? [false, false];
        return {
          ok: true, class: "email_campaign.create_and_send", body: o.body ?? (o.plannedId ? { ...sgBody, planned_send_id: o.plannedId } : sgBody), open: o.open ?? true, status: o.retryable ? "failed" : "pending", role: o.role ?? "owner", versions: 2, retryable: o.retryable ?? false,
          tests: tested.map((t, i) => ({ variant: i + 1, tested_by_me: t, tested_by_approver: t })),
        };
      }
      if (name === "email_card_for_test") return o.forTest ?? { ok: true, class: "email_campaign.create_and_send", body: sgBody, test_sha: "c".repeat(64) };
      if (name === "record_email_test_send") return { ok: true };
      if (name === "approve_email_card") return o.approve ?? { ok: true, replayed: false, attempt: 1 };
      if (name === "edit_email_card_variant") return { ok: true };
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: o.liveCount ?? (async () => (o.count === undefined ? 204 : o.count)),
    confirmedEmail: async () => "owner@brightloop.test",
    sendToolTest: (async (_t: string, _b: unknown, v: ChosenVersion, to: string) => {
      toolTests.push({ to, n: v.n });
      return { via: "SendGrid" };
    }) as CardDeps["sendToolTest"],
    enqueue: async (e) => {
      enqueued.push(e);
    },
    groupName: async () => o.groupName ?? null,
  };
  const marks = async () => {
    if (o.marksDown) throw new Error("down");
    return new Set(o.marks ?? []);
  };
  const winLineOf = (async () => (o.winLine === undefined ? null : o.winLine)) as never;
  return { h: emailCardHandlers(deps, marks, winLineOf), calls, enqueued, toolTests };
}

const as = (user = "u-owner") => mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: user });
const req = (body: unknown = {}, rail = "channel_actions") => ({ params: { rail, id: CARD }, body }) as never;

describe("approve", () => {
  it("an owner with a test of that version: approved with the live count, and the worker event fires", async () => {
    as();
    const { h, calls, enqueued } = harness({ tested: [true, false] });
    const r = res();
    await h.approve(req({ variant: 1, request_id: "req-12345678" }), r as never);
    expect(r.statusCode).toBe(200);
    expect(calls.find((c) => c.name === "approve_email_card")!.args).toEqual({
      p_rail: "channel_actions", p_id: CARD, p_variant: 1, p_actor_user_id: "u-owner", p_event_key: "req-12345678", p_approved_count: 204,
    });
    expect(enqueued).toEqual([{ id: `approve:${CARD}:1`, name: "channel-action.approved", data: { action_id: CARD } }]);
  });

  it("no test: 409 test_required; a member: 403; another workspace's card: 404", async () => {
    as();
    for (const [o, code, status] of [
      [{ approve: { ok: false, code: "test_required" } }, "test_required", 409],
      [{ approve: { ok: false, code: "not_authorized" }, role: "member" }, "not_authorized", 403],
      [{ tenantOk: false }, "not_found", 404],
    ] as const) {
      const { h, enqueued } = harness(o);
      const r = res();
      await h.approve(req({ variant: 2, request_id: "req-12345678" }), r as never);
      expect(r.statusCode).toBe(status);
      expect(r.body.error.code).toBe(code);
      expect(enqueued).toEqual([]);
    }
  });

  it("Try again reads the list again: the fresh count is sent, and an unreadable count refuses with nothing sent", async () => {
    as();
    const { h, calls, enqueued } = harness({ open: false, retryable: true, count: 251 });
    await h.approve(req({ variant: 1, request_id: "req-12345678" }), res() as never);
    expect(calls.find((c) => c.name === "approve_email_card")!.args).toMatchObject({ p_approved_count: 251 });
    expect(enqueued).toHaveLength(1);
    const blind = harness({ open: false, retryable: true, count: null });
    const r = res();
    await blind.h.approve(req({ variant: 1, request_id: "req-12345678" }), r as never);
    expect([r.statusCode, r.body.error.code]).toEqual([409, "count_required"]);
    expect(blind.calls.some((c) => c.name === "approve_email_card")).toBe(false);
  });

  it("a Zavi-list card fires decision.approved", async () => {
    as();
    const { h, enqueued } = harness({ approve: { ok: true, changed: true, status: "approved" } });
    await h.approve(req({ variant: 1, request_id: "req-12345678" }, "decisions"), res() as never);
    expect(enqueued).toMatchObject([{ id: `approve:${CARD}`, name: "decision.approved", data: { decision_id: CARD, tenant_id: T } }]);
  });
});

describe("test send", () => {
  it("goes to the requester's confirmed login address; a body naming a recipient is refused", async () => {
    as();
    const { h, toolTests, calls } = harness();
    const r = res();
    await h.test(req({ variant: 2 }), r as never);
    expect(r.statusCode).toBe(200);
    expect(toolTests).toEqual([{ to: "owner@brightloop.test", n: 2 }]);
    expect(calls.map((c) => c.name)).toEqual(["email_card_for_test", "record_email_test_send"]);
    expect(calls[1].args).toMatchObject({ p_variant: 2, p_test_sha: "c".repeat(64) });

    const bad = res();
    await h.test(req({ variant: 1, to: "someone@else.test" }), bad as never);
    expect(bad.statusCode).toBe(400);
    expect(toolTests).toHaveLength(1);
  });

  it("an executed card refuses a test; the 6th in an hour is refused; an unconfirmed address is refused", async () => {
    as();
    for (const [forTest, code, status] of [
      [{ ok: false, code: "not_open", status: "executed" }, "not_open", 409],
      [{ ok: false, code: "rate_limited" }, "rate_limited", 429],
    ] as const) {
      const { h, toolTests } = harness({ forTest });
      const r = res();
      await h.test(req({ variant: 1 }), r as never);
      expect([r.statusCode, r.body.error.code]).toEqual([status, code]);
      expect(toolTests).toEqual([]);
    }
    await expect(confirmedEmailOf("u", async () => ({ email: "x@brightloop.test", confirmed: false }))).rejects.toBeInstanceOf(TestSendError);
  });
});

describe("edit a version", () => {
  const content = {
    subject: "Sharper",
    preview_text: "",
    title: "t",
    paragraphs: ["p"],
    button: { label: "Go", url: "https://brightloop.test" },
  };
  it("a member may edit an open card's version; only {content} is accepted", async () => {
    as("u-member");
    const { h, calls } = harness({ role: "member" });
    const ok = res();
    await h.editVariant({ params: { rail: "channel_actions", id: CARD, n: "2" }, body: { content } } as never, ok as never);
    expect(ok.statusCode).toBe(200);
    expect(calls.find((c) => c.name === "edit_email_card_variant")!.args).toMatchObject({ p_variant: 2, p_user_id: "u-member" });
    const bad = res();
    await h.editVariant({ params: { rail: "channel_actions", id: CARD, n: "2" }, body: { content, audience_id: "other" } } as never, bad as never);
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.message).toMatch(/ask Zavi in chat for a new draft/);
  });

  it("a decided card refuses an edit (409); another workspace's card is 404", async () => {
    as();
    const done = res();
    await harness({ open: false }).h.editVariant({ params: { rail: "channel_actions", id: CARD, n: "1" }, body: { content } } as never, done as never);
    expect([done.statusCode, done.body.error.code]).toEqual([409, "not_open"]);
    const other = res();
    await harness({ tenantOk: false }).h.editVariant({ params: { rail: "channel_actions", id: CARD, n: "1" }, body: { content } } as never, other as never);
    expect(other.statusCode).toBe(404);
  });
});

describe("view", () => {
  it("shows each version's test status; approve is allowed per version only once an approver tested it", async () => {
    as();
    const { h } = harness({ tested: [false, true], groupName: "Product news" });
    const r = res();
    await h.view(req(), r as never);
    expect(r.body.card).toMatchObject({ unsubscribe_group_id: "7", unsubscribe_group_name: "Product news" });
    expect(r.body.card).toMatchObject({ route: "sendgrid", list: { name: "Members", people: 204 }, sender: { email: "hello@brightloop.test" }, can_approve: [false, true] });
    expect(r.body.card.versions.map((v: { subject: string }) => v.subject)).toEqual(["Subject 1", "Subject 2"]);
    as("u-member");
    const m = res();
    await harness({ tested: [true, true], role: "member" }).h.view(req(), m as never);
    expect(m.body.card.can_approve).toEqual([false, false]);
    expect(m.body.card.reasons[0]).toMatch(/owner or admin/);
  });

  it("a card whose list is marked as a test list: no version can be approved, and it says why", async () => {
    as();
    const r = res();
    await harness({ tested: [true, true], marks: [`sendgrid:${sgBody.audience_id}`] }).h.view(req(), r as never);
    expect(r.body.card).toMatchObject({ test_list: true, can_approve: [false, false], retryable: false });
    expect(r.body.card.reasons[0]).toMatch(/test list/);
    const other = res();
    await harness({ tested: [true, true], marks: ["sendgrid:another-list"] }).h.view(req(), other as never);
    expect(other.body.card).toMatchObject({ test_list: false, can_approve: [true, true] });
  });

  it("test lists that cannot be read: not approvable until they can be, and it says why", async () => {
    as();
    const r = res();
    await harness({ tested: [true, true], marksDown: true }).h.view(req(), r as never);
    expect(r.body.card).toMatchObject({ test_list: false, test_list_unknown: true, can_approve: [false, false] });
    expect(r.body.card.reasons[0]).toMatch(/could not check your test lists/);
  });

  it("approve refused by the database as a test list answers 409 with the sentence", async () => {
    as();
    const r = res();
    await harness({ tested: [true, true], approve: { ok: false, code: "test_list" } }).h.approve(req({ variant: 1, request_id: "req-12345678" }), r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toMatchObject({ code: "test_list", message: expect.stringMatching(/test list/) });
    });

  it("carries the win line read-only; a card whose win line cannot be told still opens", async () => {
    as();
    const line = { text: "2.0% of delivered visit your site", metric: "visitors", threshold: 0.02, frozen: false };
    const r = res();
    await harness({ winLine: line }).h.view(req(), r as never);
    expect(r.body.card.win_line).toEqual(line);
    const n = res();
    await harness({}).h.view(req(), n as never);
    expect(n.body.card.win_line).toBeNull();
    expect(n.body.card.versions).toHaveLength(2);
  });

  it("must catch N4: a planned draft whose plan cannot be read says it is planned (the card then offers no send)", async () => {
    as();
    const r = res();
    await harness({ plannedId: "33333333-3333-4333-8333-333333333333" }).h.view(req(), r as never);
    expect(r.body.card).toMatchObject({ planned: null, planned_expected: true });
    const n = res();
    await harness({}).h.view(req(), n as never);
    expect(n.body.card).toMatchObject({ planned: null, planned_expected: false });
  });
});

const chosen = (n = 1): ChosenVersion => {
  const v = sealed(n);
  return { n, subject: v.content.subject, preview_text: null, html: v.html, text: v.text, render_sha: v.render_sha };
};

function fakeFetch() {
  const sent: Array<{ url: string; auth: string; body: any }> = [];
  const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response("", { status: 202 });
  }) as unknown as typeof fetch;
  return { f, sent };
}

const kvSender = {
  bulkKey: () => "SG.bulk",
  resolveSendgrid: async () => null,
  checkSender: (async () => ({ ok: true, sender: { domain: "brightloop.test", from_address: "hello@brightloop.test", from_name: "Brightloop" }, postal_address: "1 Main St" })) as never,
};

describe("test-send adapters", () => {
  it("SendGrid: the workspace key, the sealed sender and unsubscribe group, [Test] subject, one recipient", async () => {
    const { f, sent } = fakeFetch();
    await sendToolCardTest(T, sgBody as never, chosen(2), "owner@brightloop.test", {
      fetch: f,
      resolveSendgrid: async () => ({ api_key: KEY, key_digest: sendgridKeyDigest(KEY) }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe(`Bearer ${KEY}`);
    expect(sent[0].body).toMatchObject({
      personalizations: [{ to: [{ email: "owner@brightloop.test" }] }],
      from: { email: "hello@brightloop.test", name: "Brightloop" },
      subject: "[Test] Subject 2",
      asm: { group_id: 7 },
    });
    expect(sent[0].body.content[1].value).toContain("<%asm_group_unsubscribe_raw_url%>");
    expect(sent[0].body.content[1].value).toContain("<p>v2</p>");
  });

  it("SendGrid: a new key connected after the card was made sends the test with the new key", async () => {
    const { f, sent } = fakeFetch();
    await sendToolCardTest(T, sgBody as never, chosen(1), "owner@brightloop.test", {
      fetch: f,
      resolveSendgrid: async () => ({ api_key: "SG.other", key_digest: sendgridKeyDigest("SG.other") }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe("Bearer SG.other");
  });

  it("SendGrid: nothing connected sends nothing", async () => {
    const { f, sent } = fakeFetch();
    await expect(
      sendToolCardTest(T, sgBody as never, chosen(1), "owner@brightloop.test", { fetch: f, resolveSendgrid: async () => null }),
    ).rejects.toMatchObject({ code: "not_connected" });
    expect(sent).toHaveLength(0);
  });

  it("Klaviyo: the bulk sender and the workspace's verified From, labelled in both parts, and Klaviyo is only read to re-prove the sealed connection", async () => {
    const { f, sent } = fakeFetch();
    const exec = vi.fn(async (c: { tool_slug: string; arguments: Record<string, unknown> }) =>
      ({ ok: true, status: 200, error: null, outcome_unknown: false, data: { data: { type: "list", id: c.arguments.id, attributes: { name: "Members", profile_count: 200 } } } }));
    const kvBody = { ...sgBody, tool: "klaviyo", credential: { kind: "composio", connected_account_id: "ca-kv", auth_config_id: "ac-kv" }, sendgrid_sender_id: undefined, sendgrid_suppression_group_id: undefined };
    const out = await sendToolCardTest(T, kvBody as never, chosen(1), "owner@brightloop.test", {
      fetch: f,
      exec: exec as never,
      resolveAccount: (async () => ({ tenant_id: T, connected_account_id: "ca-kv", auth_config_id: "ac-kv" })) as never,
      ...kvSender,
    });
    expect(out.via).toMatch(/Klaviyo has no test API/);
    expect(sent[0].auth).toBe("Bearer SG.bulk");
    expect(sent[0].body.from).toEqual({ email: "hello@brightloop.test", name: "Brightloop" });
    expect(sent[0].body.custom_args).toEqual({ tenant_id: T, email_card_test: "1" });
    expect(sent[0].body.content[0].value).toMatch(/^Klaviyo has no test API/);
    expect(sent[0].body.content[1].value).toMatch(/Zavi preview copy/);
    expect(exec.mock.calls.map((c) => (c[0] as { tool_slug: string }).tool_slug)).toEqual(["KLAVIYO_GET_LIST", "KLAVIYO_GET_LIST"]);
  });

  it.each([
    ["bulk_check_failed", "We could not check whether bulk email is ready. Try again.", /could not check your sending address/, /verified sending address|not verified/],
    ["sending_domain_not_verified", "Your sending domain is not verified yet, so bulk email cannot go out.", /not verified yet/, /could not check/],
  ])("Klaviyo: %s sends nothing, and only a real read says the domain is not verified", async (code, sentence, says, never) => {
    const { f, sent } = fakeFetch();
    const exec = vi.fn(async (c: { arguments: Record<string, unknown> }) => ({ ok: true, status: 200, error: null, outcome_unknown: false, data: { data: { type: "list", id: c.arguments.id, attributes: { name: "Members", profile_count: 200 } } } }));
    const kvBody = { ...sgBody, tool: "klaviyo", credential: { kind: "composio", connected_account_id: "ca-kv", auth_config_id: "ac-kv" }, sendgrid_sender_id: undefined, sendgrid_suppression_group_id: undefined };
    const failed = await sendToolCardTest(T, kvBody as never, chosen(1), "owner@brightloop.test", {
      fetch: f,
      exec: exec as never,
      resolveAccount: (async () => ({ tenant_id: T, connected_account_id: "ca-kv", auth_config_id: "ac-kv" })) as never,
      ...kvSender,
      checkSender: (async () => ({ ok: false, code, sentence })) as never,
    }).catch((e: Error) => e);
    expect(failed).toMatchObject({ code: "sender_not_ready" });
    expect((failed as Error).message).toMatch(says);
    expect((failed as Error).message).not.toMatch(never);
    expect((failed as Error).message).toContain("Nothing was sent.");
    expect(sent).toHaveLength(0);
  });

  it("Klaviyo: disconnected: no test is sent", async () => {
    const kvBody = { ...sgBody, tool: "klaviyo", credential: { kind: "composio", connected_account_id: "ca-kv", auth_config_id: "ac-kv" }, sendgrid_sender_id: undefined, sendgrid_suppression_group_id: undefined };
    const { f, sent } = fakeFetch();
    await expect(
      sendToolCardTest(T, kvBody as never, chosen(1), "owner@brightloop.test", {
        fetch: f,
        exec: vi.fn() as never,
        resolveAccount: (async () => null) as never,
        ...kvSender,
      }),
    ).rejects.toMatchObject({ code: "not_connected" });
    expect(sent).toHaveLength(0);
  });

  it("Klaviyo: a new account connected after the card was made is the one read", async () => {
    const { f, sent } = fakeFetch();
    const kvBody = { ...sgBody, tool: "klaviyo", credential: { kind: "composio", connected_account_id: "ca-kv", auth_config_id: "ac-kv" }, sendgrid_sender_id: undefined, sendgrid_suppression_group_id: undefined };
    const exec = vi.fn(async (c: { arguments: Record<string, unknown> }) => ({ ok: true, status: 200, error: null, outcome_unknown: false, data: { data: { type: "list", id: c.arguments.id, attributes: { name: "Members", profile_count: 200 } } } }));
    await sendToolCardTest(T, kvBody as never, chosen(1), "owner@brightloop.test", {
      fetch: f,
      exec: exec as never,
      resolveAccount: (async () => ({ tenant_id: T, connected_account_id: "ca-new", auth_config_id: "ac-new" })) as never,
      ...kvSender,
    });
    expect(sent).toHaveLength(1);
    expect(exec.mock.calls.length).toBeGreaterThan(0);
    expect(exec.mock.calls.every(([c]) => (c as unknown as { connected_account_id: string }).connected_account_id === "ca-new")).toBe(true);
  });

  const kvCard = { ...sgBody, tool: "klaviyo", credential: { kind: "composio", connected_account_id: "ca-kv", auth_config_id: "ac-kv" }, sendgrid_sender_id: undefined, sendgrid_suppression_group_id: undefined };
  const kvAccount = (async () => ({ tenant_id: T, connected_account_id: "ca-kv", auth_config_id: "ac-kv" })) as never;
  const kvList = (c: { arguments: Record<string, unknown> }) => ({ ok: true, status: 200, error: null, outcome_unknown: false, data: { data: { type: "list", id: c.arguments.id, attributes: { name: "M", profile_count: 1 } } } });
  const kvBusy = { ok: false, status: 429, data: null, error: "Too many requests", outcome_unknown: false };

  it("Klaviyo: a rate limit on the read after the test went out still records the test, so pressing test again never mails a second copy", async () => {
    const { f, sent } = fakeFetch();
    let n = 0;
    const exec = async (c: { arguments: Record<string, unknown> }) => (++n === 1 ? kvList(c) : kvBusy);
    const out = await sendToolCardTest(T, kvCard as never, chosen(1), "owner@brightloop.test", { fetch: f, exec: exec as never, resolveAccount: kvAccount, ...kvSender });
    expect(out.via).toMatch(/Klaviyo has no test API/);
    expect(sent).toHaveLength(1);
  });

  it("Klaviyo: a blip before the test is not called a disconnect, and nothing is sent", async () => {
    const { f, sent } = fakeFetch();
    await expect(
      sendToolCardTest(T, kvCard as never, chosen(1), "owner@brightloop.test", { fetch: f, exec: (async () => kvBusy) as never, resolveAccount: kvAccount, ...kvSender }),
    ).rejects.toMatchObject({ code: "provider_unavailable", message: expect.not.stringMatching(/not connected/i) });
    expect(sent).toHaveLength(0);
  });

  it("Klaviyo: a key refused after the test went out says the test went out and could not be counted", async () => {
    const { f, sent } = fakeFetch();
    let n = 0;
    const exec = async (c: { arguments: Record<string, unknown> }) => (++n === 1 ? kvList(c) : { ...kvBusy, status: 401, error: "Incorrect authentication credentials" });
    await expect(
      sendToolCardTest(T, kvCard as never, chosen(1), "owner@brightloop.test", { fetch: f, exec: exec as never, resolveAccount: kvAccount, ...kvSender }),
    ).rejects.toMatchObject({ code: "not_connected", message: expect.stringMatching(/^The test email went out, but Zavi cannot count it\./) });
    expect(sent).toHaveLength(1);
  });

  it("Mailchimp: a throwaway draft, Mailchimp's own test to the one recipient, and the draft is not deleted while the test is queued", async () => {
    const slugs: string[] = [];
    let stored: { html: string; plain_text: string } = { html: "", plain_text: "" };
    const exec = vi.fn(async (c: { tool_slug: string; arguments: Record<string, unknown> }) => {
      slugs.push(c.tool_slug);
      if (c.tool_slug === "MAILCHIMP_ADD_CAMPAIGN") return { ok: true, status: 200, data: { id: "c-test" }, error: null, outcome_unknown: false };
      if (c.tool_slug === "MAILCHIMP_SET_CAMPAIGN_CONTENT") stored = { html: String(c.arguments.html), plain_text: String(c.arguments.plain_text) };
      if (c.tool_slug === "MAILCHIMP_GET_CAMPAIGN_CONTENT") return { ok: true, status: 200, data: { data: stored }, error: null, outcome_unknown: false };
      if (c.tool_slug === "MAILCHIMP_SEND_TEST_EMAIL") expect(c.arguments).toEqual({ campaign_id: "c-test", test_emails: ["owner@brightloop.test"], send_type: "html" });
      return { ok: true, status: 200, data: {}, error: null, outcome_unknown: false };
    });
    const body = { ...sgBody, tool: "mailchimp", credential: { kind: "composio", connected_account_id: "ca", auth_config_id: "ac" } };
    await sendToolCardTest(T, body as never, chosen(1), "owner@brightloop.test", {
      exec: exec as never,
      resolveAccount: (async () => ({ tenant_id: T, toolkit: "mailchimp", connected_account_id: "ca", auth_config_id: "ac" })) as never,
    });
    expect(slugs).toEqual(["MAILCHIMP_LIST_CAMPAIGNS", "MAILCHIMP_ADD_CAMPAIGN", "MAILCHIMP_SET_CAMPAIGN_CONTENT", "MAILCHIMP_GET_CAMPAIGN_CONTENT", "MAILCHIMP_SEND_TEST_EMAIL"]);
    expect(slugs).not.toContain("MAILCHIMP_SEND_CAMPAIGN");
    const create = exec.mock.calls.find(([c]) => c.tool_slug === "MAILCHIMP_ADD_CAMPAIGN")?.[0].arguments;
    expect(create?.settings__subject__line).toBe("Subject 1");
    expect(create?.settings__auto__footer).toBe(false);
  });

  it("Zavi list: the bulk key and verified From, the unsubscribe slot filled, no ledger involved", async () => {
    const { f, sent } = fakeFetch();
    const v: ChosenVersion = { ...chosen(1), html: `<a href="${UNSUBSCRIBE_HREF.zavi_list}">u</a>`, text: `u: ${UNSUBSCRIBE_HREF.zavi_list}` };
    await sendBulkTestEmail(T, { from_address: "hello@northwind.test", reply_to: "front@northwind.test" }, v, "owner@northwind.test", {
      fetch: f,
      bulkKey: () => "SG.bulk",
      checkSender: (async () => ({ ok: true, sender: { domain: "northwind.test", from_address: "hello@northwind.test", from_name: "Northwind Clinic" }, postal_address: "400 Elm St" })) as never,
      replyTo: async () => "front@northwind.test",
    });
    expect(sent[0].auth).toBe("Bearer SG.bulk");
    expect(sent[0].body.reply_to).toEqual({ email: "front@northwind.test" });
    expect(sent[0].body.from).toEqual({ email: "hello@northwind.test", name: "Northwind Clinic" });
    expect(sent[0].body.custom_args).toEqual({ tenant_id: T, email_card_test: "1" });
    expect(sent[0].body.tracking_settings).toEqual({ open_tracking: { enable: true }, click_tracking: { enable: false, enable_text: false } });
    expect(sent[0].body.content[1].value).not.toContain(UNSUBSCRIBE_HREF.zavi_list);
  });
});

it.each(["queued", "dispatching"])("replays the same queued event without requeueing an in-flight send: %s", async (exec_status) => {
  as();
  const { h, enqueued } = harness({ open: false, approve: { ok: true, replayed: true, attempt: 1, exec_status } });
  const r = res();
  await h.approve(req({ variant: 1, request_id: "req-12345678" }), r as never);
  expect(r.statusCode).toBe(200);
  expect(enqueued).toEqual(exec_status === "queued" ? [{ id: `approve:${CARD}:1`, name: "channel-action.approved", data: { action_id: CARD } }] : []);
});

describe("the people on a card that has not gone out", () => {
  const drafted4 = (tool: string) => ({ ...sgBody, tool, audience_count: 4 });

  it.each(["mailchimp", "klaviyo"])("%s: a list cut from 4 to 1 after drafting shows 1, and the old number is nowhere on the list", async (tool) => {
    as();
    const { h } = harness({ body: drafted4(tool), count: 1 });
    const r = res();
    await h.view(req(), r as never);
    expect(r.body.card.list).toEqual({ name: "Members", people: 1 });
  });

  it.each(["mailchimp", "klaviyo"])("%s: a list grown from 4 to 9 after drafting shows 9", async (tool) => {
    as();
    const { h } = harness({ body: drafted4(tool), count: 9 });
    const r = res();
    await h.view(req(), r as never);
    expect(r.body.card.list.people).toBe(9);
  });

  it("a failed read says it could not check and never serves the drafted 4", async () => {
    as();
    for (const liveCount of [async () => null, async () => { throw new Error("tool down"); }]) {
      const { h } = harness({ body: drafted4("klaviyo"), liveCount: liveCount as CardDeps["liveCount"] });
      const r = res();
      await h.view(req(), r as never);
      expect(r.statusCode).toBe(200);
      expect(r.body.card.list).toEqual({ name: "Members", people: null, unchecked: true });
    }
  });

  it("a read that hangs cannot hold the card: it answers unchecked at the wait limit, and a late answer changes nothing", async () => {
    as();
    vi.useFakeTimers();
    try {
      let answer: (n: number) => void = () => undefined;
      const { h } = harness({ body: drafted4("klaviyo"), liveCount: () => new Promise<number>((resolve) => { answer = resolve; }) });
      const r = res();
      const going = h.view(req(), r as never);
      await vi.advanceTimersByTimeAsync(LIVE_COUNT_WAIT_MS + 1);
      await going;
      answer(7);
      await vi.advanceTimersByTimeAsync(1);
      expect(r.body.card.list).toEqual({ name: "Members", people: null, unchecked: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed card that can be tried again reads fresh too", async () => {
    as();
    const { h } = harness({ body: drafted4("klaviyo"), retryable: true, open: false, count: 1 });
    const r = res();
    await h.view(req(), r as never);
    expect(r.body.card.list.people).toBe(1);
  });

  it("a declined card asks the tool nothing and shows no drafted number", async () => {
    as();
    const liveCount = vi.fn(async () => 1);
    const { h } = harness({ body: drafted4("klaviyo"), open: false, liveCount: liveCount as CardDeps["liveCount"] });
    const r = res();
    await h.view(req(), r as never);
    expect(liveCount).not.toHaveBeenCalled();
    expect(r.body.card.list).toEqual({ name: "Members", people: null });
  });
});

describe("the count the founder saw in the dialog", () => {
  const approve = async (o: { seen_people?: number; count: number; retryable?: boolean }) => {
    as();
    const made = harness({ tested: [true, false], count: o.count, retryable: o.retryable, open: !o.retryable });
    const r = res();
    await made.h.approve(req({ variant: 1, request_id: "req-12345678", ...(o.seen_people === undefined ? {} : { seen_people: o.seen_people }) }), r as never);
    return { r, stamped: made.calls.find((c) => c.name === "approve_email_card")?.args.p_approved_count, enqueued: made.enqueued };
  };

  it.each([false, true])("a list that grew more than 10% while the dialog was open approves and queues nothing (Try again: %s)", async (retryable) => {
    const { r, stamped, enqueued } = await approve({ seen_people: 4, count: 5, retryable });
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("list_grew_since_shown");
    expect(r.body.error.message).toMatch(/nothing was sent/i);
    expect(stamped).toBeUndefined();
    expect(enqueued).toEqual([]);
  });

  it("exactly 10% growth goes, stamped with what was seen, so the send's own guard measures from the dialog", async () => {
    const { r, stamped } = await approve({ seen_people: 100, count: 110 });
    expect(r.statusCode).toBe(200);
    expect(stamped).toBe(100);
    expect((await approve({ seen_people: 100, count: 111 })).r.statusCode).toBe(409);
  });

  it("a list that shrank while the dialog was open stamps the real number", async () => {
    const { r, stamped } = await approve({ seen_people: 4, count: 1 });
    expect(r.statusCode).toBe(200);
    expect(stamped).toBe(1);
  });

  it("a request with no dialog number behaves as before", async () => {
    expect((await approve({ count: 500 })).stamped).toBe(500);
  });

  it("the number cannot be a string or negative", async () => {
    as();
    const { h, calls } = harness({ tested: [true, false] });
    const r = res();
    await h.approve(req({ variant: 1, request_id: "req-12345678", seen_people: -1 }), r as never);
    expect(r.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});
