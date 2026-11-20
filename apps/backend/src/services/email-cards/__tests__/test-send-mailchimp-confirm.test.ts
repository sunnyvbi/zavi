import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { keyRejectedText } from "@/services/connectors/email-campaign/provider-errors";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";

import { sendToolCardTest, TestSendError, type TestSendDeps } from "../test-send";
import { sendEmailCardTest } from "../cards";
import { shaOf, type ChosenVersion } from "../variants";

const T = "7c70da58-091e-4ff5-8f77-343034d448d9";
const TO = "mohit2703+oct16@yopmail.com";
const v: ChosenVersion = { n: 1, subject: "The new chocolate cake box", preview_text: null, html: "<p>cake</p>", text: "cake", render_sha: "a".repeat(64) } as ChosenVersion;
const mcBody = {
  tool: "mailchimp",
  audience_id: "81ac1df0cc",
  audience_name: "upcar.ai",
  audience_count: 2,
  from_name: "upcar.ai",
  from_email: "mohit.dudhat@team.upcar.ai",
  reply_to: null,
  credential: { kind: "composio", connected_account_id: "ca_pRJWHlqePClG", auth_config_id: "ac_1Q3ugScGWQyi" },
};

const cardVersion = {
  content: { subject: "The new chocolate cake box", preview_text: "", title: "t", paragraphs: ["p"], button: { label: "Order", url: "https://cakely.test" } },
  html: "<p>cake</p>",
  text: "cake",
};
const sealedCard = {
  ...mcBody,
  variants: [{ ...cardVersion, render_sha: shaOf("email-r1", cardVersion.html, cardVersion.text) }],
  template_snapshot: {
    logo_url: null, brand_color: "#111827", button_color: "#111827", font_key: "system", sign_off: "", postal_address: "221 Baker Ave",
    show_cards: false, company_name: "Cakely", own_host: null, campaign_slug: "s-20261027",
  },
  renderer_version: "email-r1",
};

const problem = {
  type: "https://mailchimp.com/developer/marketing/docs/errors/",
  title: "Invalid Resource",
  status: 400,
  detail: "Your Campaign is not ready to send.",
  instance: "4c4b1b6e-2a0f-4f0a-9d0b-6b1f1d6e2c11",
};

type Wire = { status: number; json: unknown };
const wire = (json: unknown, status = 200): Wire => ({ status, json });

let calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
let sendTestWire: Wire = wire({ successful: true, error: null, data: {} });

function stubComposio() {
  let stored = { html: "", plain_text: "" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const slug = decodeURIComponent(String(url).split("/tools/execute/")[1] ?? "");
      const args = (JSON.parse(init.body) as { arguments: Record<string, unknown> }).arguments;
      calls.push({ slug, args });
      let w: Wire = wire({ successful: true, error: null, data: {} });
      if (slug === "MAILCHIMP_ADD_CAMPAIGN") w = wire({ successful: true, error: null, data: { id: "c-test" } });
      if (slug === "MAILCHIMP_SET_CAMPAIGN_CONTENT") stored = { html: String(args.html), plain_text: String(args.plain_text) };
      if (slug === "MAILCHIMP_GET_CAMPAIGN_CONTENT") w = wire({ successful: true, error: null, data: { data: stored } });
      if (slug === "MAILCHIMP_SEND_TEST_EMAIL") w = sendTestWire;
      return new Response(JSON.stringify(w.json), { status: w.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const deps: Partial<TestSendDeps> = {
  resolveAccount: (async () => ({ tenant_id: T, toolkit: "mailchimp", connected_account_id: "ca_pRJWHlqePClG", auth_config_id: "ac_1Q3ugScGWQyi" })) as never,
  reportLeftDraft: async () => undefined,
  cleanupTimeoutMs: 50,
  cleanupBackoffMs: 1,
  draftMarker: () => "A1B2C3D4",
};

let warn: MockInstance<Parameters<typeof console.warn>, void>;
beforeEach(() => {
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  calls = [];
  stubComposio();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
  sendTestWire = wire({ successful: true, error: null, data: {} });
});

const RAW = ["HTTP 500", "Error: connect ECONNREFUSED 10.0.12.4:443", "Invalid API key 3f9a\u20267c-us21", "Request failed with status code 500"];

const ACCOUNT_HELD = /account is on hold, suspended or under a compliance review/;

async function refusal(json: unknown, status = 200) {
  sendTestWire = wire(json, status);
  const err = await sendToolCardTest(T, mcBody as never, v, TO, deps).catch((e) => e);
  expect(err).toBeInstanceOf(TestSendError);
  expect(err.code).toBe("provider_refused");
  expect(err.message).not.toMatch(/^Sent|Done/);
  expect(calls.filter((c) => c.slug === "MAILCHIMP_SEND_TEST_EMAIL")).toHaveLength(1);
  return err as TestSendError;
}

async function cardResult(json: unknown, status = 200) {
  sendTestWire = wire(json, status);
  const rpc = vi.fn(async (_t: string, name: string) =>
    name === "email_card_for_test" ? { ok: true, class: "email_campaign.create_and_send", body: sealedCard, test_sha: "s" } : { ok: true },
  );
  const r = await sendEmailCardTest(T, "channel_actions" as never, "76bcf801-96f0-4205-931c-c0e370ede766", 1, "u", {
    rpc: rpc as never,
    confirmedEmail: async () => TO,
    sendToolTest: ((t: string, b: never, ver: ChosenVersion, to: string) => sendToolCardTest(t, b, ver, to, deps)) as never,
  });
  return { r, rpcNames: rpc.mock.calls.map((c) => c[1]) };
}

describe("a Mailchimp test shows Done only when Mailchimp confirms it took the test", () => {
  const notConfirmed: Array<[string, unknown, number?]> = [
    ["Composio successful:false around an empty body", { successful: false, error: "Mailchimp did not take it", data: {} }],
    ["a lone error string next to other fields", { successful: true, error: null, data: { error: "Campaign could not be found", request_id: "r1" } }],
    ["an error object", { successful: true, error: null, data: { error: { code: "bad", message: "Test emails are limited for this account." } } }],
    ["a nested successful:false", { successful: true, error: null, data: { data: { successful: false } } }],
    ["a response_data problem body", { successful: true, error: null, data: { response_data: { title: "Invalid Resource", status: 400, detail: "The test address is invalid." } } }],
    ["successful:true with an error string beside it", { successful: true, error: "Timed out waiting for Mailchimp", data: {} }],
  ];

  it.each(notConfirmed)("%s is not Done, and the card records no test", async (_n, json) => {
    const err = await refusal(json);
    expect(err.message).toMatch(/Nothing was sent to your list/);
    expect(err.message).toMatch(/^Mailchimp did not (send|accept|confirm) the test email/);
    const { r, rpcNames } = await cardResult(json);
    expect(r).toMatchObject({ ok: false, code: "provider_refused" });
    expect(rpcNames).toEqual(["email_card_for_test"]);
  });

  it("an unconfirmed answer tells the founder what to check", async () => {
    const err = await refusal({ successful: true, error: "Timed out waiting for Mailchimp", data: {} });
    expect(err.message).toBe(
      "Mailchimp did not confirm the test email, so it may not arrive. Nothing was sent to your list. Check your inbox and spam folder in a few minutes, and check your account status in Mailchimp; if nothing arrives, send the test again.",
    );
  });

  it("an account under compliance review gets the plain account sentence", async () => {
    const err = await refusal({ successful: true, error: null, data: { type: "x", title: "Compliance Review", status: 403, detail: "This account is currently under compliance review." } });
    expect(err.message).toMatch(ACCOUNT_HELD);
    expect(err.message).not.toMatch(/rejected the key/);
  });

  it("a suspended account (Composio successful:false) gets the plain account sentence", async () => {
    const err = await refusal({ successful: false, error: "403 Client Error: Forbidden: Your account has been suspended", data: {} });
    expect(err.message).toMatch(ACCOUNT_HELD);
  });

  it("a 403 about permissions or a 401 is a rejected key; a 403 account hold is not", async () => {
    const forbidden = await refusal({ successful: true, error: null, data: { title: "Forbidden", status: 403, detail: "You do not have permission to access this resource." } });
    expect(forbidden.message).toBe(keyRejectedText("Mailchimp"));
    calls = [];
    const held = await refusal({ successful: true, error: null, data: { title: "Forbidden", status: 403, detail: "This account is under compliance review." } });
    expect(held.message).not.toMatch(/rejected the key/);
    calls = [];
    const unauthorized = await refusal({ successful: true, error: null, data: { title: "Unauthorized", status: 401, detail: "Your request did not include an API key." } });
    expect(unauthorized.message).toBe(keyRejectedText("Mailchimp"));
  });

  it.each(RAW)("raw text %s is never quoted to the founder", async (raw) => {
    const err = await refusal({ successful: true, error: null, data: { title: "Internal Server Error", status: 500, detail: raw.endsWith(".") ? raw : `${raw}.` } });
    for (const bad of RAW) expect(err.message).not.toContain(bad);
    expect(err.message).not.toMatch(/HTTP|ECONNREFUSED|status code|3f9a/);
    expect(err.message).toBe("Mailchimp did not send the test email. Nothing was sent to your list. Fix this in Mailchimp, then send the test again.");
  });

  it.each(RAW)("raw text %s around successful:false is never quoted to the founder", async (raw) => {
    const err = await refusal({ successful: false, error: raw, data: {} });
    for (const bad of RAW) expect(err.message).not.toContain(bad);
  });
});

describe("a revoked Mailchimp token on the test send, as Composio wraps it", () => {
  it("HTTP 200 with the vendor 401 in data.status_code gets the reconnect sentence", async () => {
    const err = await refusal({ successful: false, error: "401 Client Error: Unauthorized for url: https://us21.api.mailchimp.com/3.0/campaigns/x/actions/test", data: { status_code: 401 } });
    expect(err.message).toBe(keyRejectedText("Mailchimp"));
  });

  it("HTTP 200 with a vendor 403 whose detail is about permissions gets the reconnect sentence", async () => {
    const err = await refusal({ successful: false, error: "403 Client Error: Forbidden", data: { status_code: 403, title: "Forbidden", detail: "You do not have permission to access this resource." } });
    expect(err.message).toBe(keyRejectedText("Mailchimp"));
  });

  it("a bare HTTP 200 wrapped 403 Forbidden with no detail is not a rejected key", async () => {
    const err = await refusal({ successful: false, error: "403 Client Error: Forbidden for url: https://us21.api.mailchimp.com/3.0/campaigns/x/actions/test", data: { status_code: 403 } });
    expect(err.message).not.toMatch(/rejected the key|disconnect Mailchimp/);
  });

  it("a compliance-review 403 wrapped as HTTP 200 says the account is held, never a rejected key", async () => {
    const err = await refusal({
      successful: false,
      error: "403 Client Error: Forbidden for url: https://us21.api.mailchimp.com/3.0/campaigns/x/actions/test",
      data: { status_code: 403, title: "Forbidden", detail: "This account is currently under compliance review." },
    });
    expect(err.message).toMatch(ACCOUNT_HELD);
    expect(err.message).not.toMatch(/rejected the key|disconnect Mailchimp/);
  });
});
