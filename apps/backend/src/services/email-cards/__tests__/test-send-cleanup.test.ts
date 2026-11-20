import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenantRpc: vi.fn(async () => ({ data: null, error: null })),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("@/services/tenant-client", async (orig) => ({ ...(await orig<Record<string, unknown>>()), tenantRpc: mocks.tenantRpc }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";

import { sendToolCardTest, TestSendError, type TestSendDeps } from "../test-send";
import { sendEmailCardTest } from "../cards";
import { shaOf, type ChosenVersion } from "../variants";
import { UNSUBSCRIBE_HREF } from "@/services/email-templates/render";

const T = "11111111-1111-4111-8111-111111111111";
const v: ChosenVersion = { n: 1, subject: "Spring sale", preview_text: null, html: "<p>hi</p>", text: "hi", render_sha: "a".repeat(64) } as ChosenVersion;
const base = {
  audience_id: "L1",
  audience_name: "Members",
  audience_count: 200,
  from_name: "Brightloop",
  from_email: "hello@brightloop.test",
  reply_to: null,
};
const mcBody = { ...base, tool: "mailchimp", credential: { kind: "composio", connected_account_id: "ca", auth_config_id: "ac" } };
const kvBody = { ...base, tool: "klaviyo", credential: { kind: "composio", connected_account_id: "ca-kv", auth_config_id: "ac-kv" } };

type Exec = { ok: boolean; status: number; data: unknown; error: string | null; outcome_unknown: boolean };
const ok = (data: unknown = {}): Exec => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });
const bad = (status: number, outcome_unknown = false): Exec => ({ ok: false, status, data: null, error: `status ${status}`, outcome_unknown });

function mailchimp(opts: { deletes: Array<Exec | "throw" | "hang">; sendTest?: Exec }) {
  const slugs: string[] = [];
  let stored = { html: "", plain_text: "" };
  let d = 0;
  const exec = vi.fn(async (c: { tool_slug: string; arguments: Record<string, unknown> }): Promise<Exec> => {
    slugs.push(c.tool_slug);
    if (c.tool_slug === "MAILCHIMP_ADD_CAMPAIGN") return ok({ id: "c-test" });
    if (c.tool_slug === "MAILCHIMP_SET_CAMPAIGN_CONTENT") stored = { html: String(c.arguments.html), plain_text: String(c.arguments.plain_text) };
    if (c.tool_slug === "MAILCHIMP_GET_CAMPAIGN_CONTENT") return ok({ data: stored });
    if (c.tool_slug === "MAILCHIMP_SEND_TEST_EMAIL") return opts.sendTest ?? ok();
    if (c.tool_slug === "MAILCHIMP_DELETE_CAMPAIGN") {
      const step = opts.deletes[Math.min(d++, opts.deletes.length - 1)];
      if (step === "throw") throw new Error("network");
      if (step === "hang") return new Promise<Exec>(() => undefined);
      return step;
    }
    return ok();
  });
  const report = vi.fn(async () => undefined);
  const deps: Partial<TestSendDeps> = {
    exec: exec as never,
    resolveAccount: (async () => ({ tenant_id: T, toolkit: "mailchimp", connected_account_id: "ca", auth_config_id: "ac" })) as never,
    reportLeftDraft: report,
    cleanupTimeoutMs: 30,
    cleanupBackoffMs: 1,
    draftDeleteDelayMs: 0,
    draftMarker: () => "A1B2C3D4",
  };
  return { exec, slugs, report, deps, deletes: () => slugs.filter((s) => s === "MAILCHIMP_DELETE_CAMPAIGN").length };
}

afterEach(() => {
  vi.useRealTimers();
  mocks.tenantRpc.mockClear();
  mocks.logEvent.mockClear();
  delete process.env.SYSTEM_SENDGRID_API_KEY;
});

describe("Mailchimp test draft cleanup", () => {
  it("names the draft so it is obviously a Zavi test nobody should send", async () => {
    const m = mailchimp({ deletes: [ok()] });
    await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps);
    const add = m.exec.mock.calls.find((c) => c[0].tool_slug === "MAILCHIMP_ADD_CAMPAIGN")![0];
    expect(JSON.stringify(add.arguments)).toContain("ZAVI TEST A1B2C3D4, DO NOT SEND: Spring sale");
  });

  it("a successful test leaves its draft in place when it returns, so Mailchimp can still send the queued test, and deletes it only after the delay", async () => {
    const m = mailchimp({ deletes: [ok()] });
    const out = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", { ...m.deps, draftDeleteDelayMs: 80 });
    expect(out).toEqual({ via: "Mailchimp" });
    expect(m.slugs.at(-1)).toBe("MAILCHIMP_SEND_TEST_EMAIL");
    await new Promise((r) => setTimeout(r, 40));
    expect(m.deletes()).toBe(0);
    await vi.waitFor(() => expect(m.deletes()).toBe(1));
    expect(m.exec.mock.calls.find((c) => c[0].tool_slug === "MAILCHIMP_DELETE_CAMPAIGN")![0].arguments).toEqual({ campaign_id: "c-test" });
    expect(m.report).not.toHaveBeenCalled();
  });

  it("the live delay keeps a successful test's draft for at least four minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = mailchimp({ deletes: [ok()] });
    const { draftDeleteDelayMs: _d, ...live } = m.deps;
    await expect(sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", live)).resolves.toEqual({ via: "Mailchimp" });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(m.deletes()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.deletes()).toBe(1);
  });

  it("a delete that fails once is retried, and the founder hears nothing because the draft is gone", async () => {
    const m = mailchimp({ deletes: [bad(500, true), ok()] });
    const out = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps);
    await vi.waitFor(() => expect(m.deletes()).toBe(2));
    expect(out).toEqual({ via: "Mailchimp" });
    expect(m.report).not.toHaveBeenCalled();
  });

  it("a delayed delete that throws and then fails is retried to the limit and recorded once for ops", async () => {
    const m = mailchimp({ deletes: ["throw", bad(500), bad(503, true)] });
    const out = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps);
    expect(out).toEqual({ via: "Mailchimp" });
    await vi.waitFor(() => expect(m.report).toHaveBeenCalledTimes(1));
    expect(m.deletes()).toBe(3);
    expect(m.report).toHaveBeenCalledWith(T, { tool: "mailchimp", campaign_id: "c-test", name: "ZAVI TEST A1B2C3D4, DO NOT SEND: Spring sale" });
  });

  it("a delayed delete that never answers times out on every attempt and still reports the left draft", async () => {
    const m = mailchimp({ deletes: ["hang"] });
    const started = Date.now();
    const out = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toEqual({ via: "Mailchimp" });
    await vi.waitFor(() => expect(m.report).toHaveBeenCalledTimes(1));
    expect(m.deletes()).toBe(3);
  });

  it("a 404 on delete means the draft is already gone: no retry, no report", async () => {
    const m = mailchimp({ deletes: [bad(404)] });
    const out = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps);
    await vi.waitFor(() => expect(m.deletes()).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.deletes()).toBe(1);
    expect(out.warning).toBeUndefined();
    expect(m.report).not.toHaveBeenCalled();
  });

  it("an outcome-unknown 404 is not trusted as gone", async () => {
    const m = mailchimp({ deletes: [bad(404, true), ok()] });
    await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps);
    await vi.waitFor(() => expect(m.deletes()).toBe(2));
  });

  it("a refused test whose draft also cannot be deleted refuses with both facts in the founder's message", async () => {
    const m = mailchimp({ deletes: [bad(500)], sendTest: bad(400) });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(err.code).toBe("provider_refused");
    expect(err.message).toMatch(/Mailchimp did not accept the test email/);
    expect(err.message).toContain('"ZAVI TEST A1B2C3D4, DO NOT SEND: Spring sale"');
    expect(m.deletes()).toBe(3);
    expect(m.report).toHaveBeenCalledTimes(1);
  });

  it("a reporter that throws does not hide the warning from the founder", async () => {
    const m = mailchimp({ deletes: [bad(500)], sendTest: bad(400) });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", { ...m.deps, reportLeftDraft: async () => Promise.reject(new Error("db down")) }).catch((e) => e);
    expect(err.message).toMatch(/ZAVI TEST A1B2C3D4, DO NOT SEND/);
  });

  it("the live reporter writes an error log and a deduped ops alert keyed by the draft", async () => {
    const m = mailchimp({ deletes: [bad(500)] });
    const { reportLeftDraft: _r, ...live } = m.deps;
    await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", live);
    await vi.waitFor(() => expect(mocks.tenantRpc.mock.calls.some((c) => (c as unknown[])[1] === "enqueue_ops_alert")).toBe(true));
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "email_test.draft_left", tenant_id: T }));
    const alert = mocks.tenantRpc.mock.calls.find((c) => (c as unknown[])[1] === "enqueue_ops_alert") as unknown[] | undefined;
    expect(alert?.[2]).toEqual(expect.objectContaining({ p_dedupe_key: "email_test_draft_left:c-test", p_code: "email_test_draft_left", p_tenant_id: T }));
  });

  it("the warning reaches the test-send result while the test is still recorded", async () => {
    const html = `<p>v1</p><a href="${UNSUBSCRIBE_HREF.mailchimp}">Unsubscribe</a>`;
    const text = `v1 Unsubscribe: ${UNSUBSCRIBE_HREF.mailchimp}`;
    const sealed = {
      content: { subject: "Spring sale", preview_text: "", title: "t", paragraphs: ["p"], button: { label: "Go", url: "https://brightloop.test" } },
      html,
      text,
      render_sha: shaOf("email-r1", html, text),
    };
    const body = {
      ...mcBody,
      variants: [sealed],
      template_snapshot: {
        logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: "", postal_address: "1 St",
        show_cards: false, company_name: null, own_host: null, campaign_slug: "s-20261011",
      },
      renderer_version: "email-r1",
    };
    const rpc = vi.fn(async (_t: string, name: string) =>
      name === "email_card_for_test" ? { ok: true, class: "email_campaign.send", body, test_sha: "s" } : { ok: true },
    );
    const sendToolTest = vi.fn(async () => ({ via: "Mailchimp", warning: "W" }));
    const r = await sendEmailCardTest(T, "decisions" as never, "id", 1, "u", {
      rpc: rpc as never,
      confirmedEmail: async () => "owner@brightloop.test",
      sendToolTest: sendToolTest as never,
    });
    expect(sendToolTest).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, via: "Mailchimp", warning: "W" });
    expect(rpc.mock.calls.map((c) => c[1])).toEqual(["email_card_for_test", "record_email_test_send"]);
  });
});

describe("Klaviyo tests never use the auth/OTP sender", () => {
  const kvExec = vi.fn(async (c: { arguments: Record<string, unknown> }) => ok({ data: { type: "list", id: c.arguments.id, attributes: { name: "Members", profile_count: 200 } } }));
  const sent: Array<{ auth: string; body: any }> = [];
  const fetchStub = (status: number) =>
    vi.fn(async (_u: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return new Response("", { status });
    });
  const ready = (async () => ({ ok: true, sender: { domain: "brightloop.test", from_address: "hello@brightloop.test", from_name: "Brightloop" }, postal_address: "1 St" })) as never;
  const kvDeps = (over: Partial<TestSendDeps>): Partial<TestSendDeps> => ({
    exec: kvExec as never,
    resolveAccount: (async () => ({ tenant_id: T, connected_account_id: "ca-kv", auth_config_id: "ac-kv" })) as never,
    checkSender: ready,
    bulkKey: () => "SG.bulk",
    resolveSendgrid: async () => null,
    ...over,
  });

  afterEach(() => {
    sent.length = 0;
  });

  it("sends through the bulk key from the workspace's verified address, to the requester only, even with the system key set", async () => {
    process.env.SYSTEM_SENDGRID_API_KEY = "SG.system";
    const f = fetchStub(202);
    await sendToolCardTest(T, kvBody as never, v, "owner@brightloop.test", kvDeps({ fetch: f as never }));
    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe("Bearer SG.bulk");
    expect(sent[0].body.personalizations).toEqual([{ to: [{ email: "owner@brightloop.test" }] }]);
    expect(sent[0].body.from.email).toBe("hello@brightloop.test");
    expect(JSON.stringify(sent[0])).not.toContain("SG.system");
  });

  it("fails closed with a clear message when the bulk key is not set, and does not fall back to the system key", async () => {
    process.env.SYSTEM_SENDGRID_API_KEY = "SG.system";
    const f = fetchStub(202);
    await expect(sendToolCardTest(T, kvBody as never, v, "owner@brightloop.test", kvDeps({ fetch: f as never, bulkKey: () => null }))).rejects.toMatchObject({
      code: "sender_not_ready",
      message: expect.stringMatching(/not set up.*Nothing was sent/),
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("fails closed with the readiness sentence when the workspace has no verified sending address", async () => {
    const f = fetchStub(202);
    await expect(
      sendToolCardTest(T, kvBody as never, v, "owner@brightloop.test", kvDeps({
        fetch: f as never,
        checkSender: (async () => ({ ok: false, code: "sending_domain_not_verified", sentence: "Your sending domain is not verified yet." })) as never,
      })),
    ).rejects.toMatchObject({ code: "sender_not_ready", message: expect.stringContaining("Your sending domain is not verified yet.") });
    expect(f).not.toHaveBeenCalled();
  });

  it("a 403 from the bulk sender marks the domain for a recheck and says the address is not verified", async () => {
    const recheck = vi.fn(async () => undefined);
    await expect(
      sendToolCardTest(T, kvBody as never, v, "owner@brightloop.test", kvDeps({ fetch: fetchStub(403) as never, recheckDomain: recheck })),
    ).rejects.toMatchObject({ code: "sending_address_not_verified" });
    expect(recheck).toHaveBeenCalledWith(T);
  });
});

describe("a Klaviyo test through the founder's own SendGrid, when Zavi's sender cannot send it", () => {
  const FOUNDER = "owner@brightloop.test";
  const AUDIENCE = "L1";
  const notReady = (async () => ({ ok: false, code: "bulk_sender_not_configured", sentence: "Bulk email is not set up yet." })) as never;
  const senders = [
    { id: 1, from_email: "hello@brightloop.test", from_name: "Unverified twin", verified: false },
    { id: 2, from_email: "news@brightloop.test", from_name: "News", verified: true },
    { id: 3, from_email: "HELLO@brightloop.test", from_name: "Brightloop", verified: true },
  ];
  function world(opts: { rows?: unknown[]; sendersStatus?: number; mailStatus?: number; kv?: () => Exec } = {}) {
    const mail: Array<{ auth: string; body: any }> = [];
    const reads: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
      if (url.includes("/v3/verified_senders")) {
        reads.push(init.headers.Authorization);
        return new Response(JSON.stringify({ results: opts.rows ?? senders }), { status: opts.sendersStatus ?? 200 });
      }
      mail.push({ auth: init.headers.Authorization, body: JSON.parse(init.body ?? "{}") });
      return new Response("", { status: opts.mailStatus ?? 202 });
    });
    const slugs: string[] = [];
    const exec = vi.fn(async (c: { tool_slug: string; arguments: Record<string, unknown> }) => {
      slugs.push(c.tool_slug);
      return opts.kv ? opts.kv() : ok({ data: { type: "list", id: c.arguments.id, attributes: { name: "Members", profile_count: 200 } } });
    });
    const deps: Partial<TestSendDeps> = {
      fetch: fetchImpl as never,
      exec: exec as never,
      resolveAccount: (async () => ({ tenant_id: T, connected_account_id: "ca-kv", auth_config_id: "ac-kv" })) as never,
      resolveSendgrid: (async () => ({ api_key: "SG.own", key_digest: "d" })) as never,
      checkSender: notReady,
      bulkKey: () => null,
    };
    return { mail, reads, slugs, deps };
  }

  it("mails only the founder, with the founder's key, from the verified sender matching the card, and writes nothing to Klaviyo", async () => {
    process.env.SYSTEM_SENDGRID_API_KEY = "SG.system";
    const w = world();
    const r = await sendToolCardTest(T, kvBody as never, v, FOUNDER, w.deps);
    expect(w.mail).toHaveLength(1);
    expect(w.mail[0].auth).toBe("Bearer SG.own");
    expect(w.mail[0].body.personalizations).toEqual([{ to: [{ email: FOUNDER }] }]);
    expect(w.mail[0].body.from).toEqual({ email: "HELLO@brightloop.test", name: "Brightloop" });
    expect(w.mail[0].body.subject).toBe("[Test] Spring sale");
    expect(w.mail[0].body.content[0].value).toMatch(/^Klaviyo has no test API, so Zavi sent this copy of your email through your SendGrid/);
    expect(w.mail[0].body.content[1].value).toContain("sent through your own SendGrid");
    expect(JSON.stringify(w.mail[0].body)).not.toContain(AUDIENCE);
    expect(w.slugs).toEqual(["KLAVIYO_GET_LIST", "KLAVIYO_GET_LIST"]);
    expect(r.via).toMatch(/^your SendGrid.*Klaviyo has no test API/);
  });

  it.each([
    ["the workspace has no verified domain", (async () => ({ ok: false, code: "sending_domain_not_verified", sentence: "x" })) as never, () => null],
    ["Zavi's sender is stopped", (async () => ({ ok: false, code: "bulk_sending_paused", sentence: "x" })) as never, () => null],
    ["the sender is ready but the bulk key went missing", (async () => ({ ok: true, sender: { domain: "b", from_address: "a@b.test", from_name: "A" }, postal_address: "1" })) as never, () => null],
  ])("is used when %s", async (_n, checkSender, bulkKey) => {
    const w = world();
    await sendToolCardTest(T, kvBody as never, v, FOUNDER, { ...w.deps, checkSender, bulkKey });
    expect(w.mail.map((m) => m.auth)).toEqual(["Bearer SG.own"]);
  });

  it("never replaces a working Zavi sender: the own key is not even read", async () => {
    const w = world();
    const resolveSendgrid = vi.fn(async () => ({ api_key: "SG.own", key_digest: "d" }));
    await sendToolCardTest(T, kvBody as never, v, FOUNDER, {
      ...w.deps,
      resolveSendgrid: resolveSendgrid as never,
      bulkKey: () => "SG.bulk",
      checkSender: (async () => ({ ok: true, sender: { domain: "b", from_address: "hello@brightloop.test", from_name: "B" }, postal_address: "1" })) as never,
    });
    expect(resolveSendgrid).not.toHaveBeenCalled();
    expect(w.mail.map((m) => m.auth)).toEqual(["Bearer SG.bulk"]);
  });

  it("uses the first verified sender when none matches the card, and never an unverified one", async () => {
    const w = world({ rows: senders.slice(0, 2) });
    await sendToolCardTest(T, kvBody as never, v, FOUNDER, w.deps);
    expect(w.mail[0].body.from.email).toBe("news@brightloop.test");
  });

  it("a Klaviyo that is gone sends nothing, even with SendGrid connected", async () => {
    const w = world();
    await expect(sendToolCardTest(T, kvBody as never, v, FOUNDER, { ...w.deps, resolveAccount: (async () => null) as never })).rejects.toMatchObject({ code: "not_connected" });
    expect(w.mail).toHaveLength(0);
    expect(w.reads).toHaveLength(0);
  });

  it.each([
    ["no verified sender", { rows: [senders[0]] }, "sender_not_ready", /through your own SendGrid once it is connected with a verified sender\. Bulk email is not set up yet\. Nothing was sent\./],
    ["a rejected key", { sendersStatus: 401 }, "not_connected", /SendGrid/],
    ["SendGrid down", { sendersStatus: 503 }, "provider_unavailable", /could not read your senders from SendGrid.*Nothing was sent/],
  ])("%s: no mail, and a clear reason", async (_n, opts, code, message) => {
    const w = world(opts);
    await expect(sendToolCardTest(T, kvBody as never, v, FOUNDER, w.deps)).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
    expect(w.mail).toHaveLength(0);
  });

  it("no SendGrid and no Zavi sender: refuses, and a failed read of the connection counts as no SendGrid", async () => {
    const w = world();
    await expect(
      sendToolCardTest(T, kvBody as never, v, FOUNDER, { ...w.deps, resolveSendgrid: (async () => { throw new Error("db"); }) as never }),
    ).rejects.toMatchObject({ code: "sender_not_ready" });
    expect(w.mail).toHaveLength(0);
  });

  describe("the test gate", () => {
    const html = `<p>v1</p><a href="${UNSUBSCRIBE_HREF.klaviyo}">Unsubscribe</a>`;
    const text = `v1 Unsubscribe: ${UNSUBSCRIBE_HREF.klaviyo}`;
    const sealed = {
      content: { subject: "Spring sale", preview_text: "", title: "t", paragraphs: ["p"], button: { label: "Go", url: "https://brightloop.test" } },
      html,
      text,
      render_sha: shaOf("email-r1", html, text),
    };
    const body = {
      ...kvBody,
      variants: [sealed],
      template_snapshot: { logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: "", postal_address: "1 St", show_cards: false, company_name: null, own_host: null, campaign_slug: "s-20261011" },
      renderer_version: "email-r1",
    };
    const run = (opts: Parameters<typeof world>[0]) => {
      const w = world(opts);
      const rpc = vi.fn(async (_t: string, name: string) => (name === "email_card_for_test" ? { ok: true, class: "email_campaign.send", body, test_sha: "sha-of-this-version" } : { ok: true }));
      const out = sendEmailCardTest(T, "decisions" as never, "id", 1, "u", {
        rpc: rpc as never,
        confirmedEmail: async () => FOUNDER,
        sendToolTest: ((t: string, b: never, c: never, to: string) => sendToolCardTest(t, b, c, to, w.deps)) as never,
      });
      return { w, rpc, out };
    };

    it("a test that went out is recorded for that exact version, and only the confirmed login address got it", async () => {
      const { w, rpc, out } = run({});
      expect(await out).toMatchObject({ ok: true });
      expect(rpc.mock.calls.map((c) => c[1])).toEqual(["email_card_for_test", "record_email_test_send"]);
      expect((rpc.mock.calls[1] as unknown[])[2]).toEqual(expect.objectContaining({ p_test_sha: "sha-of-this-version", p_variant: 1, p_user_id: "u" }));
      expect(w.mail[0].body.personalizations).toEqual([{ to: [{ email: FOUNDER }] }]);
      expect(w.mail[0].body.content[1].value).toContain('href="#"');
    });

    it.each([[400], [403], [500]])("SendGrid answering %i records no test, so Approve stays locked", async (mailStatus) => {
      const { rpc, out } = run({ mailStatus });
      expect(await out).toMatchObject({ ok: false, message: expect.stringMatching(/./) });
      expect(rpc.mock.calls.map((c) => c[1])).toEqual(["email_card_for_test"]);
    });

    it("no sender anywhere records no test", async () => {
      const { rpc, out } = run({ rows: [] });
      expect(await out).toMatchObject({ ok: false, code: "sender_not_ready" });
      expect(rpc.mock.calls.map((c) => c[1])).toEqual(["email_card_for_test"]);
    });
  });
});

describe("Mailchimp test draft whose create answer was lost", () => {
  const NAME = "ZAVI TEST A1B2C3D4, DO NOT SEND: Spring sale";
  const camp = (id: string, title: string, status = "save") => ({ id, status, settings: { title }, recipients: { list_id: "L1" } });

  function lostCreate(opts: { create: Exec | "throw"; listed?: unknown[] | "fail"; deletes?: Array<Exec> }) {
    const slugs: string[] = [];
    const deleted: string[] = [];
    let d = 0;
    const exec = vi.fn(async (c: { tool_slug: string; arguments: Record<string, unknown> }): Promise<Exec> => {
      slugs.push(c.tool_slug);
      if (c.tool_slug === "MAILCHIMP_ADD_CAMPAIGN") {
        if (opts.create === "throw") throw new Error("socket hang up");
        return opts.create;
      }
      if (c.tool_slug === "MAILCHIMP_LIST_CAMPAIGNS") {
        if (opts.listed === "fail") return bad(503, true);
        return ok({ campaigns: opts.listed ?? [], total_items: (opts.listed ?? []).length });
      }
      if (c.tool_slug === "MAILCHIMP_DELETE_CAMPAIGN") {
        deleted.push(String(c.arguments.campaign_id));
        const steps = opts.deletes ?? [ok()];
        return steps[Math.min(d++, steps.length - 1)];
      }
      return ok();
    });
    const report = vi.fn(async () => undefined);
    const deps: Partial<TestSendDeps> = {
      exec: exec as never,
      resolveAccount: (async () => ({ tenant_id: T, toolkit: "mailchimp", connected_account_id: "ca", auth_config_id: "ac" })) as never,
      reportLeftDraft: report,
      cleanupTimeoutMs: 30,
      cleanupBackoffMs: 1,
      draftMarker: () => "A1B2C3D4",
    };
    return { exec, slugs, deleted, report, deps };
  }

  it("a create whose answer is lost finds the draft by its exact title, deletes only it, and fails the test the normal way", async () => {
    const m = lostCreate({
      create: bad(0, true),
      listed: [
        camp("c-other", "ZAVI TEST A1B2C3D4, DO NOT SEND: Spring sale 2"),
        camp("c-prefix", "ZAVI TEST A1B2C3D4, DO NOT SEND: Spring sal"),
        camp("c-case", "zavi test a1b2c3d4, do not send: spring sale"),
        camp("c-lost", NAME),
        camp("c-real", "Spring sale"),
      ],
    });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(err.code).toBe("provider_refused");
    expect(err.message).toBe("Mailchimp did not answer clearly, so the test was not sent. Nothing was sent. Try the test again in a minute.");
    expect(m.deleted).toEqual(["c-lost"]);
    expect(m.slugs).not.toContain("MAILCHIMP_SEND_TEST_EMAIL");
    expect(m.report).not.toHaveBeenCalled();
  });

  it("a transport that throws mid-create is treated as lost: the exact-title draft is deleted", async () => {
    const m = lostCreate({ create: "throw", listed: [camp("c-lost", NAME)] });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(m.deleted).toEqual(["c-lost"]);
    expect(m.report).not.toHaveBeenCalled();
  });

  it("a create that answers without an id is looked up and deleted by exact title", async () => {
    const m = lostCreate({ create: ok({ status: "save" }), listed: [camp("c-noid", NAME)] });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(m.deleted).toEqual(["c-noid"]);
    expect(m.report).not.toHaveBeenCalled();
  });

  it("a lookup that finds nothing raises the left-draft alert and tells the founder the draft's name", async () => {
    const m = lostCreate({ create: bad(0, true), listed: [] });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(m.deleted).toEqual([]);
    expect(m.report).toHaveBeenCalledTimes(1);
    expect(m.report).toHaveBeenCalledWith(T, { tool: "mailchimp", campaign_id: null, name: NAME });
    expect(err.message).toContain(`Zavi could not delete its test draft "${NAME}" from Mailchimp.`);
  });

  it("only similar titles are listed: none is deleted and the alert is raised", async () => {
    const m = lostCreate({
      create: bad(0, true),
      listed: [camp("c-other", "ZAVI TEST A1B2C3D4, DO NOT SEND: Spring sale 2"), camp("c-real", "Spring sale")],
    });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(m.slugs).not.toContain("MAILCHIMP_DELETE_CAMPAIGN");
    expect(m.report).toHaveBeenCalledWith(T, { tool: "mailchimp", campaign_id: null, name: NAME });
    expect(err.message).toMatch(/Delete that draft in Mailchimp/);
  });

  it("another test of the same email running at the same time has its own name: its draft is never deleted", async () => {
    const m = lostCreate({
      create: bad(0, true),
      listed: [camp("c-concurrent", "ZAVI TEST 9F8E7D6C, DO NOT SEND: Spring sale"), camp("c-lost", NAME)],
    });
    await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(m.deleted).toEqual(["c-lost"]);
  });

  it("each live attempt gets a fresh marker, kept even when the subject fills the name", async () => {
    const { testDraftName } = await import("../test-send");
    const long = { ...v, subject: "x".repeat(200) } as ChosenVersion;
    expect(testDraftName(long, "A1B2C3D4")).toMatch(/^ZAVI TEST A1B2C3D4, DO NOT SEND: x+$/);
    expect(testDraftName(long, "A1B2C3D4")).toHaveLength(100);
    const seen = new Set<string>();
    const m = lostCreate({ create: bad(0, true), listed: [] });
    for (let i = 0; i < 3; i++) {
      const deps = { ...m.deps };
      delete (deps as Partial<TestSendDeps>).draftMarker;
      await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", deps).catch(() => undefined);
      const last = m.report.mock.calls.at(-1) as unknown as [string, { name: string }];
      seen.add(last[1].name);
    }
    expect(seen.size).toBe(3);
  });

  it("an exact-title campaign that is no longer a draft is never deleted", async () => {
    const m = lostCreate({ create: bad(0, true), listed: [camp("c-sent", NAME, "sent"), camp("c-sch", NAME, "schedule")] });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(m.slugs).not.toContain("MAILCHIMP_DELETE_CAMPAIGN");
    expect(m.report).toHaveBeenCalledTimes(1);
    expect(err.message).toMatch(/could not delete its test draft/);
  });

  it("a lookup that itself fails raises the alert instead of going silent", async () => {
    const m = lostCreate({ create: bad(0, true), listed: "fail" });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(m.slugs).toContain("MAILCHIMP_LIST_CAMPAIGNS");
    expect(m.report).toHaveBeenCalledWith(T, { tool: "mailchimp", campaign_id: null, name: NAME });
    expect(err.message).toMatch(/could not delete its test draft/);
  });

  it("a found draft that cannot be deleted is reported by its id", async () => {
    const m = lostCreate({ create: bad(0, true), listed: [camp("c-lost", NAME)], deletes: [bad(500)] });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(m.deleted).toEqual(["c-lost", "c-lost", "c-lost"]);
    expect(m.report).toHaveBeenCalledWith(T, { tool: "mailchimp", campaign_id: "c-lost", name: NAME });
    expect(err.message).toContain(`"${NAME}"`);
  });

  it("the live reporter alerts on a lost draft with no id, keyed to the tenant and draft name", async () => {
    const m = lostCreate({ create: bad(0, true), listed: [] });
    const { reportLeftDraft: _r, ...live } = m.deps;
    await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", live).catch(() => undefined);
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "email_test.draft_left", tenant_id: T }));
    const alert = mocks.tenantRpc.mock.calls.find((c) => (c as unknown[])[1] === "enqueue_ops_alert") as unknown[] | undefined;
    expect(alert?.[2]).toEqual(expect.objectContaining({ p_dedupe_key: `email_test_draft_left:${T}:${NAME}`, p_code: "email_test_draft_left", p_tenant_id: T }));
  });

  it("a create Mailchimp definitely refused made no draft: no lookup, no alert", async () => {
    const m = lostCreate({ create: bad(400), listed: [camp("c-lost", NAME)] });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(m.slugs.slice(m.slugs.indexOf("MAILCHIMP_ADD_CAMPAIGN"))).not.toContain("MAILCHIMP_LIST_CAMPAIGNS");
    expect(m.slugs).not.toContain("MAILCHIMP_DELETE_CAMPAIGN");
    expect(m.report).not.toHaveBeenCalled();
  });

  const VENDOR_400 = JSON.stringify({
    type: "https://mailchimp.com/developer/marketing/docs/errors/",
    title: "Invalid Resource",
    status: 400,
    detail: "The resource submitted could not be validated. For field-specific details, see the 'errors' array.",
    instance: "9b1c-4d",
    errors: [{ field: "recipients.list_id", message: "The resource submitted could not be validated." }],
  });
  const refused400 = (body: string): Exec => ({ ok: false, status: 400, data: null, error: body, outcome_unknown: false });
  const AUDIENCE_GONE = "Mailchimp no longer has the list this email was drafted for. Nothing was sent. Ask Zavi to draft it again.";
  const noVendorText = (msg: string) => {
    expect(msg).not.toContain("{");
    expect(msg).not.toContain("mailchimp.com/developer");
    expect(msg).not.toContain("Invalid Resource");
    expect(msg).not.toContain("recipients.list_id");
    expect(msg).toContain("Nothing was sent.");
  };

  it("a create refused because the audience is gone tells the founder in a plain sentence, and makes no lookup, delete or alert", async () => {
    const m = lostCreate({ create: refused400(VENDOR_400), listed: [camp("c-lost", NAME)] });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(err.code).toBe("provider_refused");
    expect(err.message).toBe(AUDIENCE_GONE);
    noVendorText(err.message);
    expect(m.slugs.slice(m.slugs.indexOf("MAILCHIMP_ADD_CAMPAIGN"))).toEqual(["MAILCHIMP_ADD_CAMPAIGN"]);
    expect(m.report).not.toHaveBeenCalled();
  });

  it("a vendor JSON refusal after the draft was made still deletes the draft, and the founder gets a plain sentence", async () => {
    const other = JSON.stringify({ type: "https://mailchimp.com/developer/marketing/docs/errors/", title: "Invalid Resource", status: 400, errors: [{ field: "html", message: "bad" }] });
    const m = lostCreate({ create: ok({ id: "c-made" }) });
    const real = m.exec.getMockImplementation()!;
    m.exec.mockImplementation(async (c) => (c.tool_slug === "MAILCHIMP_SET_CAMPAIGN_CONTENT" ? (m.slugs.push(c.tool_slug), refused400(other)) : real(c)));
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(err.message).toBe("Mailchimp did not accept this email. Nothing was sent.");
    noVendorText(err.message);
    expect(m.deleted).toEqual(["c-made"]);
    expect(m.slugs).not.toContain("MAILCHIMP_SEND_TEST_EMAIL");
    expect(m.report).not.toHaveBeenCalled();
  });

  it("an audience-gone refusal whose draft cannot be deleted keeps the plain sentence, adds the left-draft warning and alerts ops", async () => {
    const m = lostCreate({ create: ok({ id: "c-made" }), deletes: [bad(500)] });
    const real = m.exec.getMockImplementation()!;
    m.exec.mockImplementation(async (c) => (c.tool_slug === "MAILCHIMP_SET_CAMPAIGN_CONTENT" ? (m.slugs.push(c.tool_slug), refused400(VENDOR_400)) : real(c)));
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err.message.startsWith(`${AUDIENCE_GONE} `)).toBe(true);
    noVendorText(err.message);
    expect(err.message).toContain(`"${NAME}"`);
    expect(m.deleted).toEqual(["c-made", "c-made", "c-made"]);
    expect(m.report).toHaveBeenCalledWith(T, { tool: "mailchimp", campaign_id: "c-made", name: NAME });
  });

  it("a short plain refusal sentence from Mailchimp is quoted; anything else is not", async () => {
    const m = lostCreate({ create: refused400("Your account cannot create campaigns right now.") });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m.deps).catch((e) => e);
    expect(err.message).toBe('Mailchimp did not accept this email. Mailchimp said: "Your account cannot create campaigns right now." Nothing was sent.');
    const m2 = lostCreate({ create: bad(400) });
    const err2 = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", m2.deps).catch((e) => e);
    expect(err2.message).toBe("Mailchimp did not accept this email. Nothing was sent.");
  });

  it("a disconnected account never reached Mailchimp: no lookup, no alert", async () => {
    const m = lostCreate({ create: bad(0, true), listed: [camp("c-lost", NAME)] });
    const err = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", { ...m.deps, resolveAccount: (async () => null) as never }).catch((e) => e);
    expect(err.code).toBe("not_connected");
    expect(m.exec).not.toHaveBeenCalled();
    expect(m.report).not.toHaveBeenCalled();
  });
});

describe("Mailchimp test drafts left behind by a restart", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const row = (id: string, title: string, created: string, status = "save") => ({ id, status, create_time: created, settings: { title } });

  function withLeftovers(rows: unknown[], deletes: Record<string, Exec>) {
    const m = mailchimp({ deletes: [ok()] });
    const real = m.exec.getMockImplementation()!;
    const deleted: string[] = [];
    m.exec.mockImplementation(async (c) => {
      if (c.tool_slug === "MAILCHIMP_LIST_CAMPAIGNS") {
        m.slugs.push(c.tool_slug);
        return ok({ data: { campaigns: rows } });
      }
      if (c.tool_slug === "MAILCHIMP_DELETE_CAMPAIGN") {
        m.slugs.push(c.tool_slug);
        const id = String(c.arguments.campaign_id);
        deleted.push(id);
        return deletes[id] ?? ok();
      }
      return real(c);
    });
    return { ...m, deleted };
  }

  it("the next test deletes only Zavi's own test drafts older than the delete delay, and nothing that could be the founder's", async () => {
    const m = withLeftovers(
      [
        row("old-test", "ZAVI TEST 0F0F0F0F, DO NOT SEND: Last week", ago(60 * 60_000)),
        row("fresh-test", "ZAVI TEST 1A1A1A1A, DO NOT SEND: Running now", ago(60_000)),
        row("founder-draft", "Spring sale", ago(60 * 60_000)),
        row("lookalike", "ZAVI TEST notes, DO NOT SEND: mine", ago(60 * 60_000)),
        row("sent-test", "ZAVI TEST 2B2B2B2B, DO NOT SEND: Gone out", ago(60 * 60_000), "sent"),
      ],
      {},
    );
    const out = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", { ...m.deps, draftDeleteDelayMs: 5 * 60_000 });
    expect(out).toEqual({ via: "Mailchimp" });
    expect(m.deleted).toEqual(["old-test"]);
    expect(m.report).not.toHaveBeenCalled();
  });

  it("a left draft that cannot be deleted is reported and the founder is told to delete it", async () => {
    const m = withLeftovers([row("old-test", "ZAVI TEST 0F0F0F0F, DO NOT SEND: Last week", ago(60 * 60_000))], { "old-test": bad(500) });
    const out = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", { ...m.deps, draftDeleteDelayMs: 5 * 60_000 });
    expect(m.deleted).toEqual(["old-test", "old-test", "old-test"]);
    expect(m.report).toHaveBeenCalledWith(T, { tool: "mailchimp", campaign_id: "old-test", name: "ZAVI TEST 0F0F0F0F, DO NOT SEND: Last week" });
    expect(out.via).toBe("Mailchimp");
    expect(out.warning).toContain('"ZAVI TEST 0F0F0F0F, DO NOT SEND: Last week"');
    expect(out.warning).toContain("Delete that draft in Mailchimp now");
  });

  it("a campaign list that cannot be read never blocks the test", async () => {
    const m = mailchimp({ deletes: [ok()] });
    const real = m.exec.getMockImplementation()!;
    m.exec.mockImplementation(async (c) => (c.tool_slug === "MAILCHIMP_LIST_CAMPAIGNS" ? bad(500) : real(c)));
    const out = await sendToolCardTest(T, mcBody as never, v, "owner@brightloop.test", { ...m.deps, draftDeleteDelayMs: 5 * 60_000 });
    expect(out).toEqual({ via: "Mailchimp" });
    expect(m.report).not.toHaveBeenCalled();
  });
});
