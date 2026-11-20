import { describe, expect, it, vi } from "vitest";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";

import { confirmedEmailOf, sendBulkTestEmail, sendToolCardTest, TestSendError, type TestSendDeps } from "../test-send";
import { sendEmailCardTest } from "../cards";
import { shaOf } from "../variants";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { UNSUBSCRIBE_HREF } from "@/services/email-templates/render";

const T = "11111111-1111-4111-8111-111111111111";
const FOUNDER_KEY = "SG.brightloopKey.secret";
const ZAVI_SENTENCE = "Zavi could not send the test email right now. Nothing was sent. Try again later.";
const KEY_REJECTED_SENTENCE =
  "SendGrid rejected your SendGrid API key. Reconnect SendGrid on the Connectors page, then send the test again. Nothing was sent.";
const OTHER_4XX_SENTENCE = "SendGrid did not accept the test email. Nothing was sent.";

function sealed(tag: string) {
  const html = `<p>Spring sale</p><a href="${tag}">Unsubscribe</a>`;
  const text = `Spring sale. Unsubscribe: ${tag}`;
  return {
    content: { subject: "Spring sale", preview_text: "", title: "t", paragraphs: ["p"], button: { label: "Go", url: "https://brightloop.test" } },
    html,
    text,
    render_sha: shaOf("email-r1", html, text),
  };
}
const snapshot = {
  logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: "", postal_address: "1 St",
  show_cards: false, company_name: null, own_host: null, campaign_slug: "s-20261011",
};
const listBody = {
  list_id: "33333333-3333-4333-8333-333333333333",
  list_version_id: "44444444-4444-4444-8444-444444444444",
  list_name: "Members",
  from_address: "hello@brightloop.test",
  reply_to: null,
  variants: [sealed(UNSUBSCRIBE_HREF.zavi_list)],
  template_snapshot: snapshot,
  renderer_version: "email-r1",
};
const sgBody = {
  tool: "sendgrid",
  credential: { kind: "sendgrid_key", key_digest: sendgridKeyDigest(FOUNDER_KEY) },
  audience_id: "L1",
  audience_name: "Members",
  audience_count: 200,
  from_name: "Brightloop",
  from_email: "hello@brightloop.test",
  reply_to: null,
  sendgrid_sender_id: "41",
  sendgrid_suppression_group_id: "7",
  variants: [sealed(UNSUBSCRIBE_HREF.sendgrid)],
  template_snapshot: snapshot,
  renderer_version: "email-r1",
};

function provider(status: number) {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.Authorization });
    return new Response('{"errors":[{"message":"The provided authorization grant is invalid, expired, or revoked"}]}', { status });
  });
  return { calls, fetch };
}

function zaviDeps(status: number) {
  const p = provider(status);
  const recheckDomain = vi.fn(async () => "failed");
  const deps: Partial<TestSendDeps> = {
    fetch: p.fetch as never,
    bulkKey: () => "SG.zavi-bulk",
    checkSender: (async () => ({ ok: true, sender: { domain: "brightloop.test", from_address: "hello@brightloop.test", from_name: "Brightloop" } })) as never,
    replyTo: async () => null,
    recheckDomain: recheckDomain as never,
  };
  return { ...p, recheckDomain, deps };
}

function founderDeps(status: number) {
  const p = provider(status);
  const deps: Partial<TestSendDeps> = {
    fetch: p.fetch as never,
    resolveSendgrid: async () => ({ api_key: FOUNDER_KEY, key_digest: sendgridKeyDigest(FOUNDER_KEY) }) as never,
  };
  return { ...p, deps };
}

function cardRpc(cls: "bulk_outbound.send" | "email_campaign.send", body: unknown) {
  return vi.fn(async (_t: string, name: string) =>
    name === "email_card_for_test" ? { ok: true, class: cls, body, test_sha: "s" } : { ok: true },
  );
}

function expectNoCode(message: string) {
  expect(message).not.toMatch(/status/i);
  expect(message).not.toMatch(/\d/);
}

describe("a Zavi-list test that SendGrid refuses with Zavi's own key", () => {
  it("401: the founder reads that Zavi could not send it, with no status code, and the card records no test", async () => {
    const z = zaviDeps(401);
    const rpc = cardRpc("bulk_outbound.send", listBody);
    const r = await sendEmailCardTest(T, "decisions" as never, "id", 1, "u", {
      rpc: rpc as never,
      confirmedEmail: async () => "founder@yopmail.com",
      sendListTest: ((t: never, b: never, v: never, to: never) => sendBulkTestEmail(t, b, v, to, z.deps)) as never,
    });
    expect(z.calls).toEqual([{ url: "https://api.sendgrid.com/v3/mail/send", auth: "Bearer SG.zavi-bulk" }]);
    expect(r).toEqual({ ok: false, code: "provider_refused", message: ZAVI_SENTENCE });
    expectNoCode((r as { message: string }).message);
    expect(rpc.mock.calls.map((c) => c[1])).toEqual(["email_card_for_test"]);
    expect(z.recheckDomain).not.toHaveBeenCalled();
  });

  it("400: the same plain sentence, and the status is kept on the error for us", async () => {
    const z = zaviDeps(400);
    const err = await sendBulkTestEmail(T, { from_address: "hello@brightloop.test" }, sealed(UNSUBSCRIBE_HREF.zavi_list) as never, "founder@yopmail.com", z.deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(err).toMatchObject({ code: "provider_refused", status: 400, message: ZAVI_SENTENCE });
    expectNoCode(err.message);
  });
});

describe("a SendGrid-card test that SendGrid refuses with the founder's own key", () => {
  it("401: the founder is told their key was rejected and to reconnect it, with no status code, and the card records no test", async () => {
    const f = founderDeps(401);
    const rpc = cardRpc("email_campaign.send", sgBody);
    const r = await sendEmailCardTest(T, "decisions" as never, "id", 1, "u", {
      rpc: rpc as never,
      confirmedEmail: async () => "founder@yopmail.com",
      sendToolTest: ((t: never, b: never, v: never, to: never) => sendToolCardTest(t, b, v, to, f.deps)) as never,
    });
    expect(f.calls).toEqual([{ url: "https://api.sendgrid.com/v3/mail/send", auth: `Bearer ${FOUNDER_KEY}` }]);
    expect(r).toEqual({ ok: false, code: "provider_refused", message: KEY_REJECTED_SENTENCE });
    expectNoCode((r as { message: string }).message);
    expect(rpc.mock.calls.map((c) => c[1])).toEqual(["email_card_for_test"]);
  });

  it("403: the same key-rejected sentence", async () => {
    const f = founderDeps(403);
    const err = await sendToolCardTest(T, sgBody as never, sealed(UNSUBSCRIBE_HREF.sendgrid) as never, "founder@yopmail.com", f.deps).catch((e) => e);
    expect(err).toMatchObject({ code: "provider_refused", status: 403, message: KEY_REJECTED_SENTENCE });
    expectNoCode(err.message);
  });

  it("another 4xx: a plain sentence that does not blame the key and carries no status code", async () => {
    const f = founderDeps(400);
    const err = await sendToolCardTest(T, sgBody as never, sealed(UNSUBSCRIBE_HREF.sendgrid) as never, "founder@yopmail.com", f.deps).catch((e) => e);
    expect(err).toMatchObject({ code: "provider_refused", status: 400, message: OTHER_4XX_SENTENCE });
    expectNoCode(err.message);
  });
});

describe("the login email could not be read when the founder sends a test", () => {
  const READ_FAILED = "Zavi could not check your login email right now, so nothing was sent. Try the test again in a minute.";
  const UNCONFIRMED = "Confirm your login email address first, then send the test again.";

  it("a failed read is a try-again refusal, never 'confirm your login email', and nothing is sent or recorded", async () => {
    const read = vi.fn(async () => null);
    const sendListTest = vi.fn();
    const rpc = cardRpc("bulk_outbound.send", listBody);
    const r = await sendEmailCardTest(T, "decisions" as never, "id", 1, "u", {
      rpc: rpc as never,
      confirmedEmail: (id: string) => confirmedEmailOf(id, read),
      sendListTest: sendListTest as never,
    });
    expect(read).toHaveBeenCalledWith("u");
    expect(r).toEqual({ ok: false, code: "provider_unavailable", message: READ_FAILED });
    expect((r as { message: string }).message).not.toMatch(/confirm/i);
    expect(sendListTest).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map((c) => c[1])).toEqual(["email_card_for_test"]);
  });

  it("controls: an unconfirmed or missing address still asks the founder to confirm it", async () => {
    for (const u of [{ email: "founder@yopmail.com", confirmed: false }, { email: null, confirmed: true }]) {
      const err = await confirmedEmailOf("u", async () => u).catch((e) => e);
      expect(err).toBeInstanceOf(TestSendError);
      expect(err).toMatchObject({ code: "email_unverified", message: UNCONFIRMED });
    }
    expect(await confirmedEmailOf("u", async () => ({ email: "founder@yopmail.com", confirmed: true }))).toBe("founder@yopmail.com");
  });
});
