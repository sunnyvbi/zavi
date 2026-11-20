import { beforeEach, describe, expect, it, vi } from "vitest";
import { autopilotSenderMatches, campaignTitleFor, executeEmailCampaignSend, executeEmailCampaignSendAndTell, type EmailSendDeps, type EmailSendRow } from "../execute-send";
import type { ExecProgress } from "@/services/channels/exec-progress";
import { fakeKlaviyo, fakeMailchimp, type FakeTool } from "./fake-tools";
import { renderEmailHtml } from "../render-html";
import { shaOf } from "@/services/email-cards/variants";
import { UNSUBSCRIBE_HREF } from "@/services/email-templates/render";
import skippedSend from "./__fixtures__/klaviyo-skipped-send-template.json";

const TENANT = "tenant-a";
const ACTION = "11111111-1111-4111-8111-111111111111";
const account = (tool: string, id = `ca-${tool}`) => ({ tenant_id: TENANT, toolkit: tool, connected_account_id: id, auth_config_id: `ac-${tool}` });

const body = (tool: "mailchimp" | "klaviyo", over: Record<string, unknown> = {}) => ({
  tool,
  connected_account_id: `ca-${tool}`,
  auth_config_id: `ac-${tool}`,
  audience_id: "L1",
  audience_name: tool === "mailchimp" ? "Newsletter" : "Customers",
  audience_count: 412,
  subject: "Spring offer",
  preview_text: "Two weeks only",
  body_text: "Hello",
  from_name: tool === "mailchimp" ? "Acme" : "Acme Shop",
  from_email: tool === "mailchimp" ? "hi@acme.test" : "hello@acme.test",
  reply_to: null,
  ...over,
});

const sealedBody = () => {
  const { subject: _s, preview_text: _p, body_text: _b, ...rest } = body("mailchimp");
  const html = `<p>Hello</p><a href="${UNSUBSCRIBE_HREF.mailchimp}">Unsubscribe</a>`;
  const text = `Hello Unsubscribe: ${UNSUBSCRIBE_HREF.mailchimp}`;
  return {
    ...rest,
    variants: [{ content: { subject: "Spring offer", preview_text: "Two weeks only", title: "t", paragraphs: ["p"], button: { label: "Go", url: "https://acme.test" } }, html, text, render_sha: shaOf("email-r1", html, text) }],
    chosen_variant: 1,
    template_snapshot: { logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: "", postal_address: "1 St", show_cards: false, company_name: null, own_host: null, campaign_slug: "s-20261011" },
    renderer_version: "email-r1",
  };
};

const toolFields = (tool: "mailchimp" | "klaviyo") => {
  const { subject: _s, preview_text: _p, body_text: _b, ...fields } = body(tool);
  if (tool === "mailchimp") return fields;
  const html = `<p>Hello</p><a href="${UNSUBSCRIBE_HREF.klaviyo}">Unsubscribe</a>`;
  const text = `Hello Unsubscribe: ${UNSUBSCRIBE_HREF.klaviyo}`;
  return { ...fields, variants: [{ content: sealedBody().variants[0].content, html, text, render_sha: shaOf("email-r1", html, text) }] };
};

type Harness = {
  deps: EmailSendDeps;
  progress: { value: ExecProgress | null; writes: ExecProgress[] };
  reconciles: string[];
  notified: Array<Record<string, unknown>>;
  authorize: ReturnType<typeof vi.fn<Parameters<EmailSendDeps["authorizeCgo"]>, ReturnType<EmailSendDeps["authorizeCgo"]>>>;
  refs: string[];
};

function harness(tools: Partial<Record<"mailchimp" | "klaviyo", FakeTool>>, accounts: Record<string, ReturnType<typeof account> | null> = {}): Harness {
  const progress: Harness["progress"] = { value: null, writes: [] };
  const reconciles: string[] = [];
  const refs: string[] = [];
  const notified: Harness["notified"] = [];
  const authorize = vi.fn<Parameters<EmailSendDeps["authorizeCgo"]>, ReturnType<EmailSendDeps["authorizeCgo"]>>(async () => ({ verdict: "allow", reasons: [] }));
  const deps: EmailSendDeps = {
    resolveAccount: (async (_tenant: string, tool: string) => (tool in accounts ? accounts[tool] : account(tool))) as unknown as EmailSendDeps["resolveAccount"],
    exec: (async (c: Parameters<FakeTool["exec"]>[0]) => {
      const tool = c.tool_slug.startsWith("MAILCHIMP_") ? tools.mailchimp : tools.klaviyo;
      if (!tool) throw new Error(`no fake for ${c.tool_slug}`);
      return tool.exec(c);
    }) as unknown as EmailSendDeps["exec"],
    readProgress: async () => progress.value,
    recordProgress: async (_t, _a, _c, p) => {
      progress.value = p;
      progress.writes.push(p);
      return true;
    },
    scheduleReconcile: async (id) => {
      reconciles.push(id);
    },
    authorizeCgo: authorize,
    notifyAutopilotSend: (async (_t: string, s: Record<string, unknown>) => {
      notified.push(s);
      return true;
    }) as unknown as EmailSendDeps["notifyAutopilotSend"],
    sleep: async () => undefined,
    recordSendRef: async (_t, _id, _tool, campaignId) => {
      refs.push(campaignId);
      return true;
    },
    paused: async () => false,
  };
  return { deps, progress, reconciles, notified, authorize, refs };
}

const row = (b: unknown, over: Partial<EmailSendRow> = {}): EmailSendRow => ({
  id: ACTION,
  tenant_id: TENANT,
  body: b,
  approved_by_source: null,
  exec_source: "channel_actions",
  claim_id: "claim-1",
  ...over,
});

let mc: FakeTool;
let kv: FakeTool;
beforeEach(() => {
  mc = fakeMailchimp();
  kv = fakeKlaviyo();
});

const klaviyoCard = (html: string, text: string) => {
  const { subject: _s, preview_text: _p, body_text: _b, ...rest } = body("klaviyo");
  return {
    ...sealedBody(),
    ...rest,
    variants: [{ content: { subject: "Zavi now works with Klaviyo", preview_text: "Klaviyo is now supported.", title: "t", paragraphs: ["p"], button: { label: "Go", url: "https://acme.test" } }, html, text, render_sha: shaOf("email-r1", html, text) }],
  };
};
const fixed = (s: string) => s.split("{% unsubscribe_url %}").join(UNSUBSCRIBE_HREF.klaviyo);

const sealedDeps = (h: Harness): EmailSendDeps => ({ ...h.deps, testListKeys: async () => new Set<string>() });

describe("a Klaviyo email whose template Klaviyo cannot render never reaches the send job", () => {
  it("refuses the exact template Klaviyo skipped for all 4 recipients, and says so", async () => {
    const h = harness({ klaviyo: kv });
    const r = await executeEmailCampaignSend(row(klaviyoCard(skippedSend.html, skippedSend.text)), sealedDeps(h));
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/would skip everyone on the list/);
    expect(r.error).toMatch(/Nothing was sent/);
    expect(r.receipt).toBeUndefined();
    expect(h.notified).toEqual([]);
  });

  it("renders the campaign's own clone, the template Klaviyo sends, after it is assigned", async () => {
    const h = harness({ klaviyo: kv });
    await executeEmailCampaignSend(row(klaviyoCard(fixed(skippedSend.html), fixed(skippedSend.text))), sealedDeps(h));
    const slugs = kv.calls.map((c) => c.tool_slug);
    const render = kv.calls.find((c) => c.tool_slug === "KLAVIYO_CREATE_TEMPLATE_RENDER");
    expect(render?.arguments.data__id).toBe(`${kv.campaigns[0].id}-msg-tpl`);
    expect(slugs.indexOf("KLAVIYO_ASSIGN_CAMPAIGN_MESSAGE_TEMPLATE")).toBeLessThan(slugs.indexOf("KLAVIYO_CREATE_TEMPLATE_RENDER"));
    expect(slugs.indexOf("KLAVIYO_CREATE_TEMPLATE_RENDER")).toBeLessThan(slugs.indexOf("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB"));
  });

  it("sends the same email once the footer carries Klaviyo's real unsubscribe tag", async () => {
    const h = harness({ klaviyo: kv });
    const r = await executeEmailCampaignSend(row(klaviyoCard(fixed(skippedSend.html), fixed(skippedSend.text))), sealedDeps(h));
    expect(r.ok).toBe(true);
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(1);
  });

  it("does not send when the render check itself cannot answer", async () => {
    kv.refuse.set("KLAVIYO_CREATE_TEMPLATE_RENDER", "Internal server error");
    const h = harness({ klaviyo: kv });
    const r = await executeEmailCampaignSend(row(klaviyoCard(fixed(skippedSend.html), fixed(skippedSend.text))), sealedDeps(h));
    expect(r.ok).toBe(false);
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(0);
  });

  it("a text card with tag-shaped founder words sends, and no part holds a live tag", async () => {
    const words = "Use {% if vip %} and {{ name and {# note #} today";
    const h = harness({ klaviyo: kv });
    const r = await executeEmailCampaignSend(row(body("klaviyo", { subject: "{% sale %} now", preview_text: "{{ soon", body_text: words })), h.deps);
    expect(r.ok).toBe(true);
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(1);
    const c = kv.campaigns[0];
    for (const part of [c.html, c.text]) expect(part).not.toMatch(/\{[{%#]/);
    expect(JSON.stringify(kv.calls.find((x) => x.tool_slug === "KLAVIYO_CREATE_CAMPAIGN")?.arguments)).not.toMatch(/\{%|\{\{/);
  });
});

describe("approving a bulk email sends it (it used to send nothing)", () => {
  it("Mailchimp: creates the campaign, sets its content and sends it, each exactly once", async () => {
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(r.receipt?.line).toBe("Mailchimp accepted this send for a list of 412 people. Delivery is not confirmed yet");
    expect(r.receipt?.url).toMatch(/^https:\/\/admin\.mailchimp\.com\//);
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(1);
    expect(mc.count("MAILCHIMP_SET_CAMPAIGN_CONTENT")).toBe(1);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
    expect(mc.campaigns).toMatchObject([{ title: campaignTitleFor(ACTION, "Spring offer"), list: "L1", status: "sent", html: renderEmailHtml("Hello") }]);
    expect(h.progress.writes.map((p) => p.stage)).toEqual(["created", "content_set", "send_requested", "sent"]);
    const sendAt = mc.calls.findIndex((c) => c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN");
    expect(h.reconciles).toEqual([ACTION]);
    expect(sendAt).toBeGreaterThan(-1);
  });

  it("Klaviyo: creates the campaign, assigns its content and starts one send job", async () => {
    const h = harness({ klaviyo: kv });
    const r = await executeEmailCampaignSend(row(body("klaviyo")), h.deps);
    expect(r.ok).toBe(true);
    expect(r.receipt?.line).toBe("Klaviyo accepted this send for a list of 412 people. Delivery is not confirmed yet");
    expect(r.receipt?.url).toMatch(/^https:\/\/www\.klaviyo\.com\//);
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN")).toBe(1);
    expect(kv.count("KLAVIYO_ASSIGN_CAMPAIGN_MESSAGE_TEMPLATE")).toBe(1);
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(1);
    expect(kv.campaigns).toMatchObject([{ title: campaignTitleFor(ACTION, "Spring offer"), list: "L1", status: "Sending" }]);
  });

  it("the receipt shows the number the tool reports, not the number on the card", async () => {
    mc.lists[0].members = 430;
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.receipt?.line).toBe("Mailchimp accepted this send for a list of 430 people. Delivery is not confirmed yet");
  });

  it.each(["mailchimp", "klaviyo"] as const)("%s: a list cut from 4 to 1 after approval sends to the real list, and the record carries 1", async (tool) => {
    const fake = tool === "mailchimp" ? mc : kv;
    fake.lists[0].members = 1;
    const h = harness({ [tool]: fake });
    const r = await executeEmailCampaignSend(row({ ...sealedBody(), ...toolFields(tool), audience_count: 4, approved_count: 4 }), sealedDeps(h));
    expect(r.ok).toBe(true);
    expect(r.receipt?.line).toBe(`${tool === "mailchimp" ? "Mailchimp" : "Klaviyo"} accepted this send for a list of 1 person. Delivery is not confirmed yet`);
    expect(fake.campaigns).toMatchObject([{ list: "L1" }]);
  });

  it.each(["mailchimp", "klaviyo"] as const)("%s: a list grown from 4 to 5 after approval is held: no campaign goes out", async (tool) => {
    const fake = tool === "mailchimp" ? mc : kv;
    fake.lists[0].members = 5;
    const h = harness({ [tool]: fake });
    const r = await executeEmailCampaignSend(row({ ...sealedBody(), ...toolFields(tool), audience_count: 4, approved_count: 4 }), sealedDeps(h));
    expect(r).toMatchObject({ ok: false, code: "email_list_grew", error: expect.stringMatching(/grew from 4 to 5 people.*Nothing was sent/) });
    expect(fake.count(tool === "mailchimp" ? "MAILCHIMP_SEND_CAMPAIGN" : "KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(0);
  });

  it("a list that grows between the dialog stamp and the send is measured from the stamp, not from the drafted number", async () => {
    mc.lists[0].members = 111;
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row({ ...sealedBody(), audience_count: 412, approved_count: 100 }), sealedDeps(h));
    expect(r).toMatchObject({ ok: false, code: "email_list_grew" });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("a read that fails right before the send sends nothing, whatever the card last showed", async () => {
    const h = harness({ mailchimp: mc });
    const exec = h.deps.exec;
    h.deps.exec = (async (c: { tool_slug: string }) => (c.tool_slug.includes("LIST") ? { ok: false, status: 500, data: null, error: "down", outcome_unknown: false } : exec(c as never))) as never;
    const r = await executeEmailCampaignSend(row({ ...sealedBody(), audience_count: 4, approved_count: 4 }), sealedDeps(h));
    expect(r.ok).toBe(false);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("a chat-approved send (no channel card) runs the same way, without stored progress", async () => {
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { exec_source: undefined, claim_id: undefined }), h.deps);
    expect(r.ok).toBe(true);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
    expect(h.progress.writes).toEqual([]);
    expect(h.reconciles).toEqual([]);
    expect(h.refs).toHaveLength(1);
  });

  it("a chat-approved send whose campaign could not be recorded sends nothing", async () => {
    const h = harness({ mailchimp: mc });
    h.deps.recordSendRef = async () => false;
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { exec_source: undefined, claim_id: undefined }), h.deps);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Nothing was sent") });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("a channel card records no ref: its progress row already holds the campaign", async () => {
    const h = harness({ mailchimp: mc });
    await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(h.refs).toEqual([]);
  });
});

describe("the campaign's name in the founder's tool", () => {
  it("is the subject and the first 8 of the card id", () => {
    expect(campaignTitleFor(ACTION, "Spring offer")).toBe("Zavi: Spring offer (11111111)");
  });

  it("a long subject is cut to 60 characters, whitespace flattened", () => {
    const t = campaignTitleFor("abcdef12-3456-4789-8abc-def012345678", `Our ${"very ".repeat(20)}long\nsubject`);
    expect(t).toMatch(/^Zavi: Our very very .*… \(abcdef12\)$/);
    expect(t.slice("Zavi: ".length, t.lastIndexOf(" (")).length).toBeLessThanOrEqual(60);
  });

  it("a campaign with the same subject made by ANOTHER card is not reused", async () => {
    mc.campaigns.push({ id: "other", title: campaignTitleFor("99999999-0000-4000-8000-000000000000", "Spring offer"), list: "L1", status: "save", html: null, sent: 0 });
    const h = harness({ mailchimp: mc });
    expect((await executeEmailCampaignSend(row(body("mailchimp")), h.deps)).ok).toBe(true);
    expect(mc.campaigns.find((c) => c.id === "other")?.status).toBe("save");
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(1);
  });
});

describe("what is sent is what the card showed", () => {
  const TEXT = "Hi there,\n\nThe spring offer is open: https://example.com/offer?x=1&y=2.\nTwo weeks only.";

  it("the HTML handed to the tool is built from the approved text, and its only link is the address written in that text", async () => {
    const h = harness({ mailchimp: mc });
    await executeEmailCampaignSend(row(body("mailchimp", { body_text: TEXT })), h.deps);
    const content = mc.calls.find((c) => c.tool_slug === "MAILCHIMP_SET_CAMPAIGN_CONTENT")?.arguments as { html: string; plain_text: string };
    expect(content.plain_text).toBe(TEXT);
    expect(content.html).toBe(renderEmailHtml(TEXT));
    expect([...content.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["https://example.com/offer?x=1&amp;y=2"]);
  });

  it("HTML smuggled into the sealed body is never sent: there is no HTML field to read", async () => {
    const h = harness({ mailchimp: mc });
    await executeEmailCampaignSend(row({ ...body("mailchimp"), body_html: '<a href="https://evil.example">Claim your prize</a>' }), h.deps);
    const sent = JSON.stringify(mc.calls.map((c) => c.arguments));
    expect(sent).not.toContain("evil.example");
    expect(sent).not.toContain("Claim your prize");
  });

  it("markup typed into the text is shown as text, not run as markup", async () => {
    const h = harness({ mailchimp: mc });
    await executeEmailCampaignSend(row(body("mailchimp", { body_text: 'Hello <a href="https://evil.example">here</a> <script>x</script>' })), h.deps);
    expect(mc.campaigns[0].html).not.toMatch(/<a href="https:\/\/evil\.example">here|<script>/);
    expect(mc.campaigns[0].html).toContain("&lt;script&gt;");
  });

  it("the sender name and reply-to are the sealed ones the card showed, not re-read at send time", async () => {
    const h = harness({ mailchimp: mc });
    await executeEmailCampaignSend(row(body("mailchimp", { from_name: "Sealed Sender", reply_to: "sealed@example.com" })), h.deps);
    const create = mc.calls.find((c) => c.tool_slug === "MAILCHIMP_ADD_CAMPAIGN")?.arguments as Record<string, unknown>;
    expect(create).toMatchObject({ settings__from__name: "Sealed Sender", settings__reply__to: "sealed@example.com", settings__subject__line: "Spring offer", settings__preview__text: "Two weeks only", recipients__list__id: "L1", settings__auto__footer: false });
    h.progress.value = null;
    await executeEmailCampaignSend(row(body("mailchimp", { from_email: "sender@example.com", reply_to: null }), { id: "22222222-2222-4222-8222-222222222222" }), h.deps);
    const second = mc.calls.filter((c) => c.tool_slug === "MAILCHIMP_ADD_CAMPAIGN")[1]?.arguments as Record<string, unknown>;
    expect(second.settings__reply__to).toBe("sender@example.com");
    expect(Object.keys(create).sort()).toEqual(["recipients__list__id", "settings__auto__footer", "settings__from__name", "settings__preview__text", "settings__reply__to", "settings__subject__line", "settings__title", "type"]);
  });

  it("Klaviyo: the sealed sender name and address go in the message content, so Klaviyo can send it", async () => {
    const h = harness({ klaviyo: kv });
    await executeEmailCampaignSend(row(body("klaviyo", { from_name: "Acme Shop", from_email: "hello@acme.test", reply_to: "help@acme.test" })), h.deps);
    const create = kv.calls.find((c) => c.tool_slug === "KLAVIYO_CREATE_CAMPAIGN")?.arguments as { data__attributes__campaign__messages__data: Array<{ attributes: { content: Record<string, unknown> } }> };
    expect(create.data__attributes__campaign__messages__data[0].attributes.content).toEqual({
      subject: "Spring offer", preview_text: "Two weeks only", from_label: "Acme Shop", from_email: "hello@acme.test", reply_to_email: "help@acme.test",
    });
  });

  it("a card with no sealed sender address is not the sealed shape, and sends nothing", async () => {
    const h = harness({ klaviyo: kv });
    const r = await executeEmailCampaignSend(row({ ...body("klaviyo"), from_email: null }), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_campaign_body_invalid" });
    expect(kv.calls).toEqual([]);
  });

  it("a tool error that quotes an address never reaches the card, raw or masked", async () => {
    mc.refuse.set("MAILCHIMP_SET_CAMPAIGN_CONTENT", "jane.doe@example.com has bounced too often");
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.error).toBe("Mailchimp did not accept this email. Nothing was sent.");
  });
});

describe("the card only ever sends through the tool and connection it was approved for", () => {
  it("both tools connected, the same list id in each: a Mailchimp card never touches Klaviyo", async () => {
    const h = harness({ mailchimp: mc, klaviyo: kv });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(kv.calls).toEqual([]);
    expect(mc.calls.every((c) => c.connected_account_id === "ca-mailchimp" && c.user_id === TENANT)).toBe(true);
  });

  it("the tool was disconnected after approval: nothing is sent and the founder is told to reconnect it by name", async () => {
    const h = harness({ mailchimp: mc }, { mailchimp: null });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_not_connected" });
    expect(r.error).toContain("Reconnect Mailchimp");
    expect(r.error).toContain("Nothing was sent");
    expect(mc.calls).toEqual([]);
  });

  it.each(["mailchimp", "klaviyo"] as const)("%s: a new account connected after the card was made holds the list: every call goes through the new connection", async (tool) => {
    const fake = tool === "mailchimp" ? mc : kv;
    const h = harness({ [tool]: fake }, { [tool]: account(tool, "ca-new-connection") });
    const r = await executeEmailCampaignSend(row(body(tool)), h.deps);
    expect(r.ok).toBe(true);
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((c) => c.connected_account_id === "ca-new-connection" && c.user_id === TENANT)).toBe(true);
  });

  it("an approved card: another account answering the same list id under another name is refused before any campaign is made", async () => {
    const other = fakeMailchimp([{ id: "L1", name: "Their customers", members: 300 }]);
    const h = harness({ mailchimp: other }, { mailchimp: account("mailchimp", "ca-other") });
    const r = await executeEmailCampaignSend(row(body("mailchimp", { audience_count: 300 })), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_list_renamed" });
    expect(r.held_for_founder).toBeUndefined();
    expect(r.error).toContain('now named "Their customers", not "Newsletter"');
    expect(r.error).toContain("Nothing was sent");
    expect(other.campaigns).toEqual([]);
    expect(other.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(0);
    expect(other.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.notified).toEqual([]);
  });

  it("the same account under a new auth config sends through that connection", async () => {
    const h = harness({ mailchimp: mc }, { mailchimp: { ...account("mailchimp"), auth_config_id: "ac-other" } });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(mc.calls.length).toBeGreaterThan(0);
  });

  it("a row only ever reaches its own tenant's connection, never the sealed account named in the body", async () => {
    const h = harness({ mailchimp: mc });
    const seen: string[] = [];
    h.deps.resolveAccount = (async (tenant: string, tool: string) => {
      seen.push(tenant);
      return tenant === TENANT ? account(tool) : { ...account(tool, "ca-tenant-b"), tenant_id: tenant };
    }) as unknown as EmailSendDeps["resolveAccount"];
    await executeEmailCampaignSend(row(body("mailchimp"), { tenant_id: "tenant-b" }), h.deps);
    expect(new Set(seen)).toEqual(new Set(["tenant-b"]));
    expect(mc.calls.every((c) => c.connected_account_id === "ca-tenant-b" && c.user_id === "tenant-b")).toBe(true);
  });

  it("the connection is proven again before every single call to the tool", async () => {
    const h = harness({ mailchimp: mc });
    const resolve = vi.fn(h.deps.resolveAccount);
    await executeEmailCampaignSend(row(body("mailchimp")), { ...h.deps, resolveAccount: resolve as unknown as EmailSendDeps["resolveAccount"] });
    expect(resolve.mock.calls.length).toBe(mc.calls.length);
    expect(resolve.mock.calls.every(([tenant, tool]) => tenant === TENANT && tool === "mailchimp")).toBe(true);
  });

  it("the list was deleted after approval: nothing is created or sent", async () => {
    mc.lists.length = 0;
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_audience_missing" });
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(0);
  });

  it("the tool's own pre-send check fails: nothing is sent and the tool's reason is shown", async () => {
    mc.checklistReady = false;
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(r.error).toContain("Verify your sending domain");
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("a body that is not the sealed shape is refused before any call", async () => {
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row({ ...body("mailchimp"), tool: "sendgrid" }), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_campaign_body_invalid" });
    expect(mc.calls).toEqual([]);
  });
});

describe("a lost answer never becomes a second campaign or a second send", () => {
  it("lost answer on CREATE: the campaign is found by its name and nothing new is created", async () => {
    mc.loseResponseOf.add("MAILCHIMP_ADD_CAMPAIGN");
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(mc.campaigns).toHaveLength(1);
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(1);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
  });

  it("a retry after a failure that stopped before the send reuses the campaign the first try made", async () => {
    mc.checklistReady = false;
    const h = harness({ mailchimp: mc });
    expect((await executeEmailCampaignSend(row(body("mailchimp")), h.deps)).ok).toBe(false);
    mc.checklistReady = true;
    const again = await executeEmailCampaignSend(row(body("mailchimp"), { claim_id: "claim-2" }), h.deps);
    expect(again.ok).toBe(true);
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(1);
    expect(mc.campaigns).toHaveLength(1);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
  });

  it("a retry with NO stored progress still finds the first try's campaign by name", async () => {
    mc.checklistReady = false;
    const h = harness({ mailchimp: mc });
    await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    h.progress.value = null;
    mc.checklistReady = true;
    const again = await executeEmailCampaignSend(row(body("mailchimp"), { claim_id: "claim-2" }), h.deps);
    expect(again.ok).toBe(true);
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(1);
  });

  it("lost answer on SEND, and the tool shows it going out: reported sent, sent once", async () => {
    mc.loseResponseOf.add("MAILCHIMP_SEND_CAMPAIGN");
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
  });

  it("lost answer on SEND and no way to confirm: outcome unknown, never retryable", async () => {
    const h = harness({ mailchimp: mc });
    const realExec = h.deps.exec;
    let sent = false;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      if (c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN") {
        sent = true;
        return { ok: false, status: 0, data: null, error: "composio_transport_error", outcome_unknown: true };
      }
      if (sent) return { ok: false, status: 503, data: null, error: "down", outcome_unknown: true };
      return realExec(c);
    }) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(r.error).toContain("will not send it again");
    expect(h.progress.value?.stage).toBe("send_requested");
  });

  it("once a send was requested, a re-run never calls the tool at all", async () => {
    const h = harness({ mailchimp: mc });
    h.progress.value = { campaign_id: "mc1", stage: "send_requested" };
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { claim_id: "claim-2" }), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    expect(mc.calls).toEqual([]);
    expect(h.reconciles).toEqual([ACTION]);
  });

  it("the tool refuses the send outright: terminal, the draft is named, and it is not offered again", async () => {
    mc.refuse.set("MAILCHIMP_SEND_CAMPAIGN", "Your account is under review");
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_partial", not_sent: true });
    expect(r.error).toContain("Nothing was sent");
  });

  for (const [tool, sendSlug] of [
    ["mailchimp", "MAILCHIMP_SEND_CAMPAIGN"],
    ["klaviyo", "KLAVIYO_CREATE_CAMPAIGN_SEND_JOB"],
  ] as const) {
    it(`${tool} rate-limits the send once: the draft is read back, the send is asked once more, and the card is sent, not exec_partial`, async () => {
      const h = harness({ mailchimp: mc, klaviyo: kv });
      const realExec = h.deps.exec;
      let busy = 1;
      let busyCalls = 0;
      const after: string[] = [];
      h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
        if (busyCalls > 0) after.push(c.tool_slug);
        if (c.tool_slug === sendSlug && busy > 0) {
          busy -= 1;
          busyCalls += 1;
          return { ok: false, status: 429, data: null, error: "Too Many Requests", outcome_unknown: false };
        }
        return realExec(c);
      }) as unknown as EmailSendDeps["exec"];
      const r = await executeEmailCampaignSend(row(body(tool)), h.deps);
      expect(r.ok).toBe(true);
      expect(r.code).toBeUndefined();
      const fake = tool === "mailchimp" ? mc : kv;
      expect(fake.count(sendSlug)).toBe(1);
      expect(after.indexOf(sendSlug)).toBeGreaterThan(0);
      expect(h.progress.writes.map((p) => p.stage)).toEqual(["created", "content_set", "send_requested", "sent"]);
    });
  }

  for (const [tool, sendSlug, wrapped] of [
    ["mailchimp", "MAILCHIMP_SEND_CAMPAIGN", { status_code: 429, message: "You have exceeded the limit of 10 simultaneous connections." }],
    ["klaviyo", "KLAVIYO_CREATE_CAMPAIGN_SEND_JOB", { data: { status_code: 429, errors: [{ code: "throttled", detail: "Request was throttled. Expected available in 3 seconds." }] } }],
  ] as const) {
    it(`${tool} rate limit returned inside a Composio 200 is retried once and the card is sent`, async () => {
      const h = harness({ mailchimp: mc, klaviyo: kv });
      const realExec = h.deps.exec;
      let busy = 1;
      h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
        if (c.tool_slug === sendSlug && busy > 0) {
          busy -= 1;
          return { ok: false, status: 200, data: wrapped, error: "Too many requests, vendor raw text", outcome_unknown: false };
        }
        return realExec(c);
      }) as unknown as EmailSendDeps["exec"];
      const r = await executeEmailCampaignSend(row(body(tool)), h.deps);
      expect(r.ok).toBe(true);
      const fake = tool === "mailchimp" ? mc : kv;
      expect(fake.count(sendSlug)).toBe(1);
      expect(h.progress.writes.map((p) => p.stage)).toEqual(["created", "content_set", "send_requested", "sent"]);
    });

    it(`${tool} rate limit inside a Composio 200 that never clears says the tool was busy, not the vendor's raw text`, async () => {
      const h = harness({ mailchimp: mc, klaviyo: kv });
      const realExec = h.deps.exec;
      let sends = 0;
      h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
        if (c.tool_slug === sendSlug) {
          sends += 1;
          return { ok: false, status: 200, data: wrapped, error: "Too many requests, vendor raw text", outcome_unknown: false };
        }
        return realExec(c);
      }) as unknown as EmailSendDeps["exec"];
      const r = await executeEmailCampaignSend(row(body(tool)), h.deps);
      expect(r).toMatchObject({ ok: false, code: "exec_partial", not_sent: true });
      expect(sends).toBeGreaterThan(1);
      expect(r.error).toContain("was busy (rate limit)");
      expect(r.error).not.toContain("vendor raw text");
    });
  }

  it("a pause during a rate-limit wait stops the retry before a second provider send", async () => {
    const h = harness({ mailchimp: mc });
    const realExec = h.deps.exec;
    let sends = 0;
    let pauseReads = 0;
    h.deps.paused = async () => (pauseReads += 1) > 2;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      if (c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN") {
        sends += 1;
        return { ok: false, status: 429, data: null, error: "Too Many Requests", outcome_unknown: false };
      }
      return realExec(c);
    }) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_partial", not_sent: true });
    expect(sends).toBe(1);
    expect(pauseReads).toBe(3);
  });

  it("a campaign retargeted during a rate-limit wait is not sent on the retry", async () => {
    const h = harness({ mailchimp: mc });
    const realExec = h.deps.exec;
    let sends = 0;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      if (c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN") {
        sends += 1;
        if (sends === 1) {
          mc.campaigns[0].list = "L2";
          return { ok: false, status: 429, data: null, error: "Too Many Requests", outcome_unknown: false };
        }
      }
      return realExec(c);
    }) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_partial", not_sent: true });
    expect(r.error).toContain("no longer goes to the approved list");
    expect(sends).toBe(1);
  });

  it.each([
    ["mailchimp", "MAILCHIMP_SEND_CAMPAIGN"],
    ["klaviyo", "KLAVIYO_CREATE_CAMPAIGN_SEND_JOB"],
  ] as const)("%s: a list nobody on it can receive is never sent, and never reported as sent", async (tool, sendSlug) => {
    const fake = tool === "mailchimp" ? mc : fakeKlaviyo();
    fake.lists[0].members = 0;
    const h = harness({ [tool]: fake });
    const r = await executeEmailCampaignSend(row(body(tool)), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_list_empty" });
    expect(r.error).toContain("Nothing was sent");
    expect(r).not.toHaveProperty("sent_to");
    expect(fake.count(sendSlug)).toBe(0);
    expect(h.notified).toEqual([]);
  });

  it("autopilot holds an empty list for the founder instead of sending", async () => {
    mc.lists[0].members = 0;
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { approved_by_source: "cgo" }), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_list_empty", held_for_founder: true });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("a list that empties between a refused send and its retry stops the retry, with not_sent proof", async () => {
    const h = harness({ mailchimp: mc });
    const realExec = h.deps.exec;
    let sends = 0;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      if (c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN") {
        sends += 1;
        mc.lists[0].members = 0;
        return { ok: false, status: 429, data: { status_code: 429, message: "You have exceeded the limit of 10 simultaneous connections." }, error: "429" };
      }
      return realExec(c);
    }) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, not_sent: true });
    expect(r.error).toContain("Nobody on");
    expect(sends).toBe(1);
  });

  it("a chat-rail send proven not sent records the proof the list is freed on, once", async () => {
    mc.refuse.set("MAILCHIMP_SEND_CAMPAIGN", "Your account is under review");
    const h = harness({ mailchimp: mc });
    const marks: string[] = [];
    const r = await executeEmailCampaignSendAndTell(row(sealedBody(), { claim_id: undefined, exec_source: undefined }), { ...h.deps, testListKeys: async () => new Set<string>(), markSendRefNotSent: async (_t, id) => (marks.push(id), true) }, async () => undefined);
    expect(r).toMatchObject({ ok: false, not_sent: true });
    expect(marks).toHaveLength(1);
  });

  it("a send with no proof marks nothing, so the list stays held", async () => {
    let tried = false;
    const get = mc.refuse.get.bind(mc.refuse);
    mc.refuse.get = (slug: string) => {
      if (slug === "MAILCHIMP_SEND_CAMPAIGN") {
        tried = true;
        return "Your account is under review";
      }
      return tried && slug === "MAILCHIMP_GET_CAMPAIGN_INFO" ? "Resource Not Found" : get(slug);
    };
    const h = harness({ mailchimp: mc });
    const marks: string[] = [];
    const r = await executeEmailCampaignSendAndTell(row(sealedBody(), { claim_id: undefined, exec_source: undefined }), { ...h.deps, testListKeys: async () => new Set<string>(), markSendRefNotSent: async (_t, id) => (marks.push(id), true) }, async () => undefined);
    expect(r.code).not.toBe("email_redraft_required");
    expect(r).not.toHaveProperty("not_sent");
    expect(marks).toEqual([]);
  });

  it("a 429 whose campaign is no longer a draft on read-back is never sent again: exec_partial, no not_sent proof", async () => {
    const h = harness({ mailchimp: mc });
    const realExec = h.deps.exec;
    let sends = 0;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      if (c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN") {
        sends += 1;
        mc.campaigns[0].status = "paused";
        return { ok: false, status: 429, data: null, error: "Too Many Requests", outcome_unknown: false };
      }
      return realExec(c);
    }) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(r).not.toHaveProperty("not_sent");
    expect(sends).toBe(1);
    expect(r.error).not.toContain("Nothing was sent");
  });

  it("a send whose answer is unclear is never asked again, even if a 429 was the status", async () => {
    const h = harness({ mailchimp: mc });
    const realExec = h.deps.exec;
    let sends = 0;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      if (c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN") {
        sends += 1;
        return { ok: false, status: 429, data: null, error: "gateway", outcome_unknown: true };
      }
      return realExec(c);
    }) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(sends).toBe(1);
  });

  it("must catch J3 (fail closed): a refused send whose campaign cannot be read back carries no not_sent proof", async () => {
    let tried = false;
    const get = mc.refuse.get.bind(mc.refuse);
    mc.refuse.get = (slug: string) => {
      if (slug === "MAILCHIMP_SEND_CAMPAIGN") {
        tried = true;
        return "Your account is under review";
      }
      return tried && slug === "MAILCHIMP_GET_CAMPAIGN_INFO" ? "Resource Not Found" : get(slug);
    };
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(r).not.toHaveProperty("not_sent");
    expect(r.error).not.toContain("Nothing was sent");
    expect(r.error).toContain("Zavi could not read the campaign back to confirm nothing went out.");
  });

  it("two campaigns already carry this card's name: nothing is sent", async () => {
    const title = campaignTitleFor(ACTION, "Spring offer");
    mc.campaigns.push({ id: "x1", title, list: "L1", status: "save", html: null, sent: 0 }, { id: "x2", title, list: "L1", status: "save", html: null, sent: 0 });
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(0);
  });

  it("a campaign with this card's name goes to ANOTHER list: nothing is sent", async () => {
    mc.lists.push({ id: "L2", name: "Everyone", members: 90_000 });
    mc.campaigns.push({ id: "x1", title: campaignTitleFor(ACTION, "Spring offer"), list: "L2", status: "save", html: null, sent: 0 });
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("the campaign's list was changed in the tool between create and send: nothing is sent", async () => {
    mc.lists.push({ id: "L2", name: "Everyone", members: 90_000 });
    const h = harness({ mailchimp: mc });
    const realExec = h.deps.exec;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      if (c.tool_slug === "MAILCHIMP_GET_CAMPAIGN_SEND_CHECKLIST") mc.campaigns[0].list = "L2";
      return realExec(c);
    }) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("the worker lost its claim mid-run: it stops before sending", async () => {
    const h = harness({ mailchimp: mc });
    h.deps.recordProgress = async (_t, _a, _c, p) => p.stage !== "send_requested";
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(false);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("the follow-up check could not be queued: it does not send", async () => {
    const h = harness({ mailchimp: mc });
    h.deps.scheduleReconcile = async () => {
      throw new Error("queue down");
    };
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(false);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });
});

describe("a reused draft goes out exactly as the card showed it", () => {
  const leaveDraft = async (tool: FakeTool, h: Harness, b: ReturnType<typeof body>) => {
    if (tool === mc) mc.checklistReady = false;
    else kv.refuse.set("KLAVIYO_ASSIGN_CAMPAIGN_MESSAGE_TEMPLATE", "x");
    await executeEmailCampaignSend(row(b), h.deps);
    mc.checklistReady = true;
    kv.refuse.clear();
  };

  it("Mailchimp: the founder changed the subject and sender in the tool; Try again writes the card's back, then sends", async () => {
    const h = harness({ mailchimp: mc });
    await leaveDraft(mc, h, body("mailchimp"));
    mc.campaigns[0].env = { subject: "EDITED", from_name: "Someone else", reply_to: "other@example.com" };
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { claim_id: "claim-2" }), h.deps);
    expect(r.ok).toBe(true);
    expect(mc.count("MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS")).toBe(1);
    expect(mc.campaigns[0].env).toMatchObject({ subject: "Spring offer", from_name: "Acme", reply_to: "hi@acme.test" });
    expect(mc.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(1);
  });

  it("Klaviyo: the same, through the campaign message", async () => {
    const h = harness({ klaviyo: kv });
    await leaveDraft(kv, h, body("klaviyo"));
    kv.campaigns[0].env = { subject: "EDITED", from_name: "X", from_email: "x@example.com" };
    const r = await executeEmailCampaignSend(row(body("klaviyo"), { claim_id: "claim-2" }), h.deps);
    expect(r.ok).toBe(true);
    expect(kv.count("KLAVIYO_UPDATE_CAMPAIGN_MESSAGE")).toBe(1);
    expect(kv.campaigns[0].env).toMatchObject({ subject: "Spring offer", from_name: "Acme Shop", from_email: "hello@acme.test" });
  });

  it("if the tool does not take the card's values back, nothing is sent", async () => {
    const h = harness({ mailchimp: mc });
    await leaveDraft(mc, h, body("mailchimp"));
    mc.campaigns[0].env = { subject: "EDITED", from_name: "Acme", reply_to: "hi@acme.test" };
    const realExec = h.deps.exec;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) =>
      c.tool_slug === "MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS" ? { ok: true, status: 200, data: {}, error: null, outcome_unknown: false } : realExec(c)) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { claim_id: "claim-2" }), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(r.error).toContain("the subject in Mailchimp changed since the card was made");
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("a campaign whose subject or sender the tool did not report is not sent", async () => {
    const h = harness({ mailchimp: mc });
    const realExec = h.deps.exec;
    h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      const r = await realExec(c);
      if (c.tool_slug !== "MAILCHIMP_GET_CAMPAIGN_INFO" || !r.ok) return r;
      const d = r.data as { settings: Record<string, unknown> };
      return { ...r, data: { ...d, settings: { title: d.settings.title } } };
    }) as unknown as EmailSendDeps["exec"];
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("Mailchimp: a segment added to the draft means part of the list, so nothing is sent", async () => {
    const h = harness({ mailchimp: mc });
    await leaveDraft(mc, h, body("mailchimp"));
    mc.campaigns[0].narrowedBy = "42";
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { claim_id: "claim-2" }), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(r.error).toContain("only part of the list");
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("Klaviyo: an excluded list added to the draft is refused the same way", async () => {
    const h = harness({ klaviyo: kv });
    await leaveDraft(kv, h, body("klaviyo"));
    kv.campaigns[0].narrowedBy = "VIP";
    const r = await executeEmailCampaignSend(row(body("klaviyo"), { claim_id: "claim-2" }), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(0);
  });

  it("a fresh campaign is never narrowed and needs no rewrite", async () => {
    const h = harness({ mailchimp: mc });
    expect((await executeEmailCampaignSend(row(body("mailchimp")), h.deps)).ok).toBe(true);
    expect(mc.count("MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS")).toBe(0);
    const create = mc.calls.find((c) => c.tool_slug === "MAILCHIMP_ADD_CAMPAIGN")?.arguments as Record<string, unknown>;
    expect(Object.keys(create).some((k) => k.includes("segment"))).toBe(false);
  });
});

describe("Autopilot sends only under the tool's own default sender", () => {
  const cgo = { approved_by_source: "cgo" };

  it("a sender name the agent chose is held for the founder, nothing sent", async () => {
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp", { from_name: "The Growth Team" }), cgo), h.deps);
    expect(r).toMatchObject({ ok: false, held_for_founder: true });
    expect(r.error).toContain("or your default sender in Mailchimp");
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("a sender address the agent chose is held too", async () => {
    const h = harness({ klaviyo: kv });
    const r = await executeEmailCampaignSend(row(body("klaviyo", { from_email: "ceo@acme.test" }), cgo), h.deps);
    expect(r.held_for_founder).toBe(true);
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(0);
  });

  it("no default sender readable: held", async () => {
    kv.noDefaultSender = true;
    const h = harness({ klaviyo: kv });
    expect((await executeEmailCampaignSend(row(body("klaviyo"), cgo), h.deps)).held_for_founder).toBe(true);
  });

  it("a failed SendGrid sender-setting read is held instead of falling back to a provider default", async () => {
    const sendgrid = body("mailchimp", {
      tool: "sendgrid",
      credential: { kind: "sendgrid_key", key_digest: "a".repeat(64) },
      connected_account_id: undefined,
      auth_config_id: undefined,
      sendgrid_sender_id: "12",
      sendgrid_suppression_group_id: "34",
    });
    const matches = await autopilotSenderMatches(TENANT, sendgrid as never, async () => ({ ok: true }) as never, { id: "L1", name: "List", member_count: 10 }, {
      setting: async () => {
        throw new Error("settings unavailable");
      },
    });
    expect(matches).toBe(false);
  });

  it("the founder tapped it: the sender on the card goes out as shown", async () => {
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp", { from_name: "The Growth Team" })), h.deps);
    expect(r.ok).toBe(true);
    expect(mc.campaigns[0].env?.from_name).toBe("The Growth Team");
  });
});

describe("Autopilot's limits are checked at the moment of sending", () => {
  const cgo = { approved_by_source: "cgo" };

  it("a reconnect of the same account (new connection id, same list): Autopilot sends through the new connection", async () => {
    mc.lists[0].members = 800;
    const h = harness({ mailchimp: mc }, { mailchimp: account("mailchimp", "ca-new-connection") });
    const r = await executeEmailCampaignSend(row(body("mailchimp", { audience_count: 800 }), cgo), h.deps);
    expect(r.ok).toBe(true);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
    expect(mc.calls.every((c) => c.connected_account_id === "ca-new-connection")).toBe(true);
  });

  it("another account that does not hold the list: nothing is created or sent, and the founder is not told it went out", async () => {
    const other = fakeMailchimp([{ id: "L9", name: "Their customers", members: 300 }]);
    const h = harness({ mailchimp: other }, { mailchimp: account("mailchimp", "ca-other") });
    const r = await executeEmailCampaignSend(row(body("mailchimp", { audience_count: 412 }), cgo), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_audience_missing" });
    expect(other.campaigns).toEqual([]);
    expect(other.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.notified).toEqual([]);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("another account answering the same list id under another name: held for the founder before any campaign is made", async () => {
    const other = fakeMailchimp([{ id: "L1", name: "Their customers", members: 300 }]);
    const h = harness({ mailchimp: other }, { mailchimp: account("mailchimp", "ca-other") });
    const r = await executeEmailCampaignSend(row(body("mailchimp", { audience_count: 300 }), cgo), h.deps);
    expect(r).toMatchObject({ ok: false, held_for_founder: true });
    expect(r.error).toContain("Nothing was sent");
    expect(other.campaigns).toEqual([]);
    expect(other.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.notified).toEqual([]);
  });

  it("allowed: it sends, and the founder is told once what went out and to whom", async () => {
    mc.lists[0].members = 800;
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp", { audience_count: 800 }), cgo), h.deps);
    expect(r.ok).toBe(true);
    expect(h.notified).toEqual([expect.objectContaining({ action_id: ACTION, tool: "mailchimp", subject: "Spring offer", audience_name: "Newsletter", sent_to: 800 })]);
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(h.authorize.mock.calls[0][1]).toMatchObject({ action_id: ACTION, audience_count: 800 });
    expect(h.authorize.mock.calls[0][2]).toEqual({ where: "executor" });
  });

  it("the gate is handed the list size the tool reports NOW, not the size on the card", async () => {
    mc.lists[0].members = 1001;
    const h = harness({ mailchimp: mc });
    h.authorize.mockImplementation(async (_t, a) =>
      (a.audience_count ?? Infinity) > 1000 ? { verdict: "ask_founder", reasons: ["audience_over_limit"] } : { verdict: "allow", reasons: [] },
    );
    const r = await executeEmailCampaignSend(row(body("mailchimp", { audience_count: 900 }), cgo), h.deps);
    expect(r).toMatchObject({ ok: false, held_for_founder: true });
    expect(r.error).toContain("more than 1,000 people");
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.progress.value?.stage).toBe("content_set");
    expect(h.notified).toEqual([]);
  });

  it("Klaviyo: the live size comes from the campaign's own recipient estimate", async () => {
    kv.lists[0].members = 1500;
    const h = harness({ klaviyo: kv });
    h.authorize.mockResolvedValue({ verdict: "ask_founder", reasons: ["audience_over_limit"] });
    const r = await executeEmailCampaignSend(row(body("klaviyo"), cgo), h.deps);
    expect(r.held_for_founder).toBe(true);
    expect(h.authorize.mock.calls[0][1]).toMatchObject({ audience_count: 1500 });
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(0);
  });

  it("a send the founder tapped is never judged by Autopilot's limits", async () => {
    mc.lists[0].members = 25_000;
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.notified).toEqual([]);
  });

  it("a cgo approval that did not come from the channel card is never sent", async () => {
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { ...cgo, exec_source: undefined, claim_id: undefined }), h.deps);
    expect(r).toMatchObject({ ok: false, held_for_founder: true });
    expect(mc.calls).toEqual([]);
  });
});

describe("the workspace pause is checked at the irreversible boundary", () => {
  it("does not call the provider when email is paused after campaign preparation", async () => {
    const h = harness({ mailchimp: mc });
    h.deps.paused = async () => true;
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_paused" });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.progress.writes.map((p) => p.stage)).not.toContain("send_requested");
  });

  it("fails closed when the pause state cannot be read", async () => {
    const h = harness({ mailchimp: mc });
    h.deps.paused = async () => {
      throw new Error("db unavailable");
    };
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_paused" });
    expect(r.error).toContain("could not verify");
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });
});

describe("the email the tool holds is read back last, right before the send", () => {
  const cgo = { approved_by_source: "cgo" };
  const editAfterWrite = (tool: FakeTool) => {
    const exec = tool.exec;
    tool.exec = async (c) => {
      if (c.tool_slug === "MAILCHIMP_GET_CAMPAIGN_CONTENT") tool.campaigns[0].html = `${tool.campaigns[0].html}<p>Edited in Mailchimp</p>`;
      return exec(c);
    };
  };
  const stubs = (h: ReturnType<typeof harness>, mode: "shadow" | "enforce") => {
    const reports: Array<{ stage: string; status: string; mode: string }> = [];
    h.deps.verifyMode = async () => mode;
    h.deps.reportContent = async (_t, _tool, stage, v, m) => {
      reports.push({ stage, status: v.status, mode: m });
    };
    return reports;
  };

  it("unchanged: it sends; the read is after the live count and the last thing before the send call", async () => {
    const h = harness({ mailchimp: mc });
    const reports = stubs(h, "enforce");
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(reports).toEqual([]);
    const slugs = mc.calls.map((c) => c.tool_slug);
    const read = slugs.indexOf("MAILCHIMP_GET_CAMPAIGN_CONTENT");
    const send = slugs.indexOf("MAILCHIMP_SEND_CAMPAIGN");
    expect(read).toBeGreaterThan(slugs.lastIndexOf("MAILCHIMP_GET_LIST_INFO"));
    expect(slugs.slice(read + 1, send)).toEqual(["MAILCHIMP_GET_CAMPAIGN_INFO"]);
  });

  it("shadow: an edit in the tool is logged and the send goes ahead (today's behaviour)", async () => {
    editAfterWrite(mc);
    const h = harness({ mailchimp: mc });
    const reports = stubs(h, "shadow");
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(reports).toEqual([{ stage: "before_send", status: "changed", mode: "shadow" }]);
  });

  it("enforce: an edit in the tool refuses the send; nothing sent, no second write, retryable", async () => {
    editAfterWrite(mc);
    const h = harness({ mailchimp: mc });
    stubs(h, "enforce");
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_content_changed" });
    expect(r.outcome_unknown).toBeUndefined();
    expect(r.held_for_founder).toBeUndefined();
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(mc.count("MAILCHIMP_SET_CAMPAIGN_CONTENT")).toBe(1);
    expect(h.progress.writes.map((p) => p.stage)).not.toContain("send_requested");
  });

  it("enforce: the tool cannot show the email (the read fails): refused as unverifiable, nothing sent", async () => {
    mc.refuse.set("MAILCHIMP_GET_CAMPAIGN_CONTENT", "temporarily unavailable");
    const h = harness({ mailchimp: mc });
    stubs(h, "enforce");
    h.deps.verifyContent = undefined;
    const fast = await import("../content-verify");
    h.deps.verifyContent = (tool, call, id, sealed) => fast.readAndCompare(tool, call, id, sealed, { sleep: async () => undefined });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_content_unverifiable" });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("enforce under Autopilot: a changed email is refused and alerted, not held for the founder to approve again", async () => {
    editAfterWrite(mc);
    const h = harness({ mailchimp: mc });
    const reports = stubs(h, "enforce");
    const r = await executeEmailCampaignSend(row(body("mailchimp"), cgo), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_content_changed" });
    expect(r.held_for_founder).toBeUndefined();
    expect(reports).toEqual([{ stage: "before_send", status: "changed", mode: "enforce" }]);
  });

  it("Klaviyo: the message's own template clone is what is compared, and it matches", async () => {
    const h = harness({ klaviyo: kv });
    const reports = stubs(h, "enforce");
    const r = await executeEmailCampaignSend(row(body("klaviyo")), h.deps);
    expect(r.ok).toBe(true);
    expect(reports).toEqual([]);
    expect(kv.count("KLAVIYO_GET_CAMPAIGN_MESSAGE_TEMPLATE")).toBe(2);
  });

  it("a send already going when Zavi looked is read back after the fact and logged, never sent again", async () => {
    const h = harness({ mailchimp: mc });
    const reports = stubs(h, "enforce");
    mc.campaigns.push({ id: "mc9", title: campaignTitleFor(ACTION, "Spring offer"), list: "L1", status: "sending", html: "<p>other</p>", text: "other", sent: 0 });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.progress.writes.at(-1)?.stage).toBe("sent");
    await vi.waitFor(() => expect(reports).toEqual([{ stage: "after_send", status: "changed", mode: "shadow" }]));
  });

  it("enforce, but the campaign is already going when the mismatch is found: reported as sent, never 'nothing was sent'", async () => {
    const h = harness({ mailchimp: mc });
    stubs(h, "enforce");
    h.deps.verifyContent = async () => {
      mc.campaigns[0].status = "sending";
      return { status: "changed", parts: ["html"], canonicalized: [] };
    };
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: true });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("enforce, and the status read fails twice: an unknown outcome the reconcile worker settles, never 'nothing was sent'; the retry reads the status first and reports the send", async () => {
    const h = harness({ mailchimp: mc });
    stubs(h, "enforce");
    let sleeps = 0;
    h.deps.sleep = async () => {
      sleeps += 1;
    };
    h.deps.verifyContent = async () => {
      mc.campaigns[0].status = "sending";
      mc.refuse.set("MAILCHIMP_GET_CAMPAIGN_INFO", "temporarily unavailable");
      return { status: "changed", parts: ["html"], canonicalized: [] };
    };
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(r.error).not.toMatch(/Nothing was sent/);
    expect(sleeps).toBe(1);
    expect(h.reconciles.length).toBeGreaterThan(0);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);

    mc.refuse.delete("MAILCHIMP_GET_CAMPAIGN_INFO");
    h.deps.verifyContent = async () => {
      throw new Error("the retry must not reach the content check");
    };
    const again = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(again.ok).toBe(true);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(mc.count("MAILCHIMP_SET_CAMPAIGN_CONTENT")).toBe(1);
    expect(mc.count("MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS")).toBe(0);
    expect(h.progress.writes.at(-1)?.stage).toBe("sent");
  });

  it("the decision rail (no reconcile worker): an unreadable status after a refusal is settled honestly, nothing sent by Zavi", async () => {
    const h = harness({ mailchimp: mc });
    stubs(h, "enforce");
    h.deps.verifyContent = async () => {
      mc.refuse.set("MAILCHIMP_GET_CAMPAIGN_INFO", "temporarily unavailable");
      return { status: "changed", parts: ["html"], canonicalized: [] };
    };
    const r = await executeEmailCampaignSend(row(body("mailchimp"), { exec_source: undefined, claim_id: undefined }), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_content_changed" });
    expect(r.outcome_unknown).toBeUndefined();
    expect(r.error).toMatch(/could not confirm the campaign's state in Mailchimp\. Nothing was sent by Zavi\./);
    expect(h.reconciles).toEqual([]);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("a retry whose earlier campaign is no longer a draft (paused) is refused before anything is written to it", async () => {
    const h = harness({ mailchimp: mc });
    h.progress.value = { campaign_id: "mc9", stage: "content_set" } as ExecProgress;
    mc.campaigns.push({ id: "mc9", title: campaignTitleFor(ACTION, "Spring offer"), list: "L1", status: "paused", html: "<p>x</p>", text: "x", sent: 0 });
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(mc.count("MAILCHIMP_SET_CAMPAIGN_CONTENT")).toBe(0);
    expect(mc.count("MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS")).toBe(0);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("a campaign retargeted to another list after the step-4 read and already going: an audience mismatch at either later read, never 'sent'", async () => {
    for (const mode of ["enforce", "shadow"] as const) {
      mc = fakeMailchimp();
      const h = harness({ mailchimp: mc });
      stubs(h, mode);
      const alerts: string[] = [];
      h.deps.reportAudience = async (_t, id) => {
        alerts.push(id);
      };
      h.deps.verifyContent = async () => {
        mc.campaigns[0].status = "sending";
        mc.campaigns[0].list = "L2";
        return { status: "changed", parts: ["html"], canonicalized: [] };
      };
      const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
      expect(r, mode).toMatchObject({ ok: false, code: "exec_partial", audience_mismatch: true });
      expect(alerts, mode).toEqual([ACTION]);
      expect(mc.count("MAILCHIMP_SEND_CAMPAIGN"), mode).toBe(0);
      expect(h.progress.writes.map((p) => p.stage), mode).not.toContain("sent");
    }
  });

  it("telemetry never holds a send: a hanging report does not delay it", async () => {
    editAfterWrite(mc);
    const h = harness({ mailchimp: mc });
    h.deps.verifyMode = async () => "shadow";
    h.deps.reportContent = () => new Promise(() => undefined);
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
  });
});

describe("a retry reads its earlier campaign's status first", () => {
  const earlier = (status: string, list = "L1") => {
    mc.campaigns.push({ id: "mc9", title: campaignTitleFor(ACTION, "Spring offer"), list, status, html: "<p>x</p>", text: "x", sent: 0 });
    return { campaign_id: "mc9", stage: "content_set" } as ExecProgress;
  };

  it("already going out: reported as sent before any refusal (the list was marked a test list since)", async () => {
    const h = harness({ mailchimp: mc });
    h.progress.value = earlier("sending");
    let testListReads = 0;
    h.deps.testListKeys = async () => {
      testListReads += 1;
      return new Set(["mailchimp:L1"]);
    };
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r.ok).toBe(true);
    expect(testListReads).toBe(0);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(mc.calls[0].tool_slug).toBe("MAILCHIMP_GET_CAMPAIGN_INFO");
    expect(mc.calls.map((c) => c.tool_slug).filter((x) => x !== "MAILCHIMP_GET_CAMPAIGN_CONTENT")).toEqual(["MAILCHIMP_GET_CAMPAIGN_INFO"]);
  });

  it("the status cannot be read: an unknown outcome for the reconcile worker, nothing else read or written", async () => {
    const h = harness({ mailchimp: mc });
    h.progress.value = earlier("sending");
    mc.refuse.set("MAILCHIMP_GET_CAMPAIGN_INFO", "temporarily unavailable");
    h.deps.testListKeys = async () => {
      throw new Error("must not be reached");
    };
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(r.error).not.toMatch(/Nothing was sent/);
    expect(h.reconciles).toEqual([ACTION]);
    expect(mc.calls.map((c) => c.tool_slug)).toEqual(["MAILCHIMP_GET_CAMPAIGN_INFO"]);
  });

  it("going out to a different list: never reported as sent; exec_partial, alerted, no outcome email", async () => {
    const h = harness({ mailchimp: mc });
    h.progress.value = earlier("sending", "L2");
    const alerts: string[] = [];
    h.deps.reportAudience = async (_t, id) => {
      alerts.push(id);
    };
    const r = await executeEmailCampaignSend(row(body("mailchimp")), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_partial", audience_mismatch: true });
    expect(r.error).toMatch(/different list/);
    expect(alerts).toEqual([ACTION]);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.progress.writes.map((p) => p.stage)).not.toContain("sent");
  });
});

describe("a tool that rejects the saved key says so, in words that survive the stored 500-character cut", () => {
  for (const [tool, label] of [
    ["mailchimp", "Mailchimp"],
    ["klaviyo", "Klaviyo"],
  ] as const) {
    for (const status of [401, 403]) {
      it(`${label} answering ${status} tells the founder to reconnect, sends nothing, and the card shows the whole sentence`, async () => {
        const { keyRejectedText } = await import("../provider-errors");
        const { founderSendError } = await import("@/services/email-cards/cards");
        const h = harness({ mailchimp: mc, klaviyo: kv });
        const calls: string[] = [];
        h.deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
          calls.push(c.tool_slug);
          return { ok: false, status, data: null, error: '{"status":401,"detail":"API Key Invalid","instance":"/3.0/campaigns"}', outcome_unknown: false };
        }) as unknown as EmailSendDeps["exec"];
        const r = await executeEmailCampaignSend(row(body(tool)), h.deps);
        expect(r.ok).toBe(false);
        expect(r.error).toBe(keyRejectedText(label));
        expect(r.error).not.toContain("API Key Invalid");
        expect(calls.some((s) => /SEND_CAMPAIGN|SEND_JOB/.test(s))).toBe(false);
        expect(h.progress.writes.map((p) => p.stage)).not.toContain("send_requested");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          expect(founderSendError(r.error)).toBe(keyRejectedText(label));
          expect(founderSendError(String(r.error).slice(0, 500).trim())).toBe(keyRejectedText(label));
        } finally {
          warn.mockRestore();
        }
      });
    }
  }
});

describe("a list size the tool will not report is never guessed at the send", () => {
  const deps = (h: ReturnType<typeof harness>) => ({ ...h.deps, testListKeys: async () => new Set<string>() });

  it("the live count unreadable on a sealed card: the founder reads nothing was sent, and the tool is never asked to send", async () => {
    mc.lists[0].members = undefined as unknown as number;
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(sealedBody()), deps(h));
    expect(r).toMatchObject({ ok: false, code: "email_count_unreadable" });
    expect(r.error).toContain("did not say how many people are on");
    expect(r.error).toContain("Nothing was sent");
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.progress.writes.map((p) => p.stage)).not.toContain("send_requested");
  });

  it("control: the same card with a readable count does send", async () => {
    const h = harness({ mailchimp: mc });
    const r = await executeEmailCampaignSend(row(sealedBody()), deps(h));
    expect(r.ok).toBe(true);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
  });
});
