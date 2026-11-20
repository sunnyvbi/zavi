import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  calls = [];
  stubComposio();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sendTestWire = wire({ successful: true, error: null, data: {} });
});

const refusedShapes: Array<[string, unknown]> = [
  ["Mailchimp's problem body as Composio data", { successful: true, error: null, data: problem }],
  ["Mailchimp's problem body one data level down", { successful: true, error: null, data: { data: problem } }],
  ["a vendor status_code 400 with a message", { successful: true, error: null, data: { status_code: 400, message: "Your Campaign is not ready to send." } }],
  ["Mailchimp field errors", { successful: true, error: null, data: { data: { title: "Invalid Resource", errors: [{ field: "test_emails", message: "This email address looks fake or invalid." }] } } }],
];

describe("a Mailchimp test only shows sent when Mailchimp's answer proves it", () => {
  it.each(refusedShapes)("%s is refused in plain words and the draft is still deleted", async (_name, json) => {
    sendTestWire = wire(json);
    const err = await sendToolCardTest(T, mcBody as never, v, TO, deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(err.code).toBe("provider_refused");
    expect(err.message).toMatch(/^Mailchimp did not send the test email/);
    expect(err.message).toMatch(/Nothing was sent to your list/);
    expect(calls.filter((c) => c.slug === "MAILCHIMP_SEND_TEST_EMAIL")).toHaveLength(1);
    expect(calls.filter((c) => c.slug === "MAILCHIMP_DELETE_CAMPAIGN").map((c) => c.args.campaign_id)).toEqual(["c-test"]);
  });

  it("quotes Mailchimp's own reason so the founder knows what to fix", async () => {
    sendTestWire = wire({ successful: true, error: null, data: problem });
    const err = await sendToolCardTest(T, mcBody as never, v, TO, deps).catch((e) => e);
    expect(err.message).toContain('Mailchimp said: "Your Campaign is not ready to send."');
  });

  it("the card records no test and does not show Done when Mailchimp's answer is a refusal", async () => {
    sendTestWire = wire({ successful: true, error: null, data: { data: problem } });
    const rpc = vi.fn(async (_t: string, name: string) =>
      name === "email_card_for_test" ? { ok: true, class: "email_campaign.create_and_send", body: sealedCard, test_sha: "s" } : { ok: true },
    );
    const r = await sendEmailCardTest(T, "channel_actions" as never, "76bcf801-96f0-4205-931c-c0e370ede766", 1, "u", {
      rpc: rpc as never,
      confirmedEmail: async () => TO,
      sendToolTest: ((t: string, b: never, ver: ChosenVersion, to: string) => sendToolCardTest(t, b, ver, to, deps)) as never,
    });
    expect(calls.filter((c) => c.slug === "MAILCHIMP_SEND_TEST_EMAIL").map((c) => c.args.test_emails)).toEqual([[TO]]);
    expect(rpc.mock.calls.map((c) => c[1])).toEqual(["email_card_for_test"]);
    expect(r).toMatchObject({ ok: false, code: "provider_refused" });
  });

  it("the address is the confirmed login address and goes to Mailchimp unchanged", async () => {
    await sendToolCardTest(T, mcBody as never, v, TO, deps);
    const test = calls.find((c) => c.slug === "MAILCHIMP_SEND_TEST_EMAIL")!;
    expect(test.args).toEqual({ campaign_id: "c-test", test_emails: [TO], send_type: "html" });
  });

  it("Mailchimp's empty 204 answer still counts as sent, and the queued test's draft is not deleted in the same call", async () => {
    sendTestWire = wire({ successful: true, error: null, data: {} });
    await expect(sendToolCardTest(T, mcBody as never, v, TO, deps)).resolves.toEqual({ via: "Mailchimp" });
    expect(calls.map((c) => c.slug)).not.toContain("MAILCHIMP_DELETE_CAMPAIGN");
  });

  it("Composio successful:false is still refused", async () => {
    sendTestWire = wire({ successful: false, error: "400 Client Error: Bad Request", data: problem });
    const err = await sendToolCardTest(T, mcBody as never, v, TO, deps).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(err.code).toBe("provider_refused");
  });
});
