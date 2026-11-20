import { describe, expect, it, vi } from "vitest";
import { sendgridKeyDigest } from "../credential";
import { executeEmailCampaignSend, EMAIL_ALL_SUPPRESSED_ERROR, EMAIL_PAUSED_MID_SEND_ERROR, type EmailSendDeps, type EmailSendRow } from "../execute-send";
import { sendgridHttpCall, sendgridSuppressedOnList } from "../providers-sendgrid";
import { BRIGHTLOOP_KEY, fakeSendgrid, type FakeSendgrid } from "./fake-sendgrid";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const OTHER_LIST = "6a1f0c2e-0000-4000-8000-00000000b002";
const GROUP_PATH = "/v3/asm/groups/7/suppressions";
const GLOBAL_PATH = "/v3/suppression/unsubscribes";
const ACTION = "22222222-2222-4222-8222-222222222222";

const body = (over: Record<string, unknown> = {}) => ({
  tool: "sendgrid", credential: { kind: "sendgrid_key", key_digest: DIGEST }, audience_id: LIST, audience_name: "Brightloop members", audience_count: 5,
  subject: "New studio hours", preview_text: null, body_text: "Hello from Brightloop.", from_name: "Brightloop", from_email: "hello@brightloop.test",
  reply_to: null, sendgrid_sender_id: "41", sendgrid_suppression_group_id: "7", ...over,
});

const deps = (sg: FakeSendgrid, over: Partial<EmailSendDeps> = {}): Partial<EmailSendDeps> => ({
  resolveAccount: (async () => { throw new Error("no composio"); }) as never,
  exec: (async () => { throw new Error("no composio"); }) as never,
  resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
  sendgridFetch: sg.fetch,
  readProgress: async () => null,
  recordProgress: async () => true,
  scheduleReconcile: vi.fn(async () => {}),
  authorizeCgo: (async () => ({ verdict: "allow", reasons: [] })) as never,
  notifyAutopilotSend: (async () => true) as never,
  sleep: async () => {},
  setting: async () => null,
  paused: async () => false,
  ...over,
});
const row = (b: unknown): EmailSendRow => ({ id: ACTION, tenant_id: "tenant-brightloop", body: b, approved_by_source: null, exec_source: "channel_actions", claim_id: "claim-1" });

function fiveOnList(): FakeSendgrid {
  const sg = fakeSendgrid();
  sg.lists[0].contact_count = 5;
  for (let i = 1; i <= 5; i++) sg.contacts[`member${i}@brightloop.test`] = [LIST];
  return sg;
}
const scheduled = (sg: FakeSendgrid) => sg.count("PUT", /schedule$/);

describe("a SendGrid list whose people are unsubscribed", () => {
  it("everyone unsubscribed from the send's group, as in the live card: refused, nothing scheduled, no sent claim", async () => {
    const sg = fiveOnList();
    sg.groupSuppressions["7"] = Object.keys(sg.contacts);
    const r = await executeEmailCampaignSend(row(body()), deps(sg));
    expect(r).toEqual({ ok: false, code: "email_all_suppressed", error: EMAIL_ALL_SUPPRESSED_ERROR });
    expect(scheduled(sg)).toBe(0);
  });

  it("everyone gone across the group and the global list together: refused", async () => {
    const sg = fiveOnList();
    const all = Object.keys(sg.contacts);
    sg.groupSuppressions["7"] = all.slice(0, 2);
    sg.globalUnsubscribes = all.slice(2);
    const r = await executeEmailCampaignSend(row(body()), deps(sg));
    expect(r).toMatchObject({ ok: false, code: "email_all_suppressed" });
    expect(scheduled(sg)).toBe(0);
  });

  it("some unsubscribed: it sends, and the receipt carries the people left, never the list size", async () => {
    const sg = fiveOnList();
    sg.groupSuppressions["7"] = ["member1@brightloop.test", "member2@brightloop.test"];
    sg.globalUnsubscribes = ["MEMBER2@brightloop.test", "member3@brightloop.test"];
    sg.contacts["someone-else@brightloop.test"] = [OTHER_LIST];
    sg.groupSuppressions["7"].push("someone-else@brightloop.test");
    const r = await executeEmailCampaignSend(row(body()), deps(sg));
    expect(r).toMatchObject({ ok: true, sent_to: 2, notice: "SendGrid accepted this send for 2 people. Delivery is not confirmed yet." });
    expect(scheduled(sg)).toBe(1);
  });

  it("a group from another send does not count", async () => {
    const sg = fiveOnList();
    sg.groupSuppressions["8"] = Object.keys(sg.contacts);
    const r = await executeEmailCampaignSend(row(body()), deps(sg));
    expect(r).toMatchObject({ ok: true, sent_to: 5, notice: "SendGrid accepted this send for 5 people. Delivery is not confirmed yet." });
  });

  it("a key that may not read suppressions: it sends, says nothing of delivery, and logs the gap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sg = fiveOnList();
    sg.forbidden.add(GROUP_PATH);
    sg.forbidden.add(GLOBAL_PATH);
    const r = await executeEmailCampaignSend(row(body()), deps(sg));
    expect(r).toMatchObject({ ok: true, notice: "SendGrid accepted this send for a list of 5 people. Delivery is not confirmed yet." });
    expect(r.notice).not.toMatch(/^Sent/);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/unsubscribes not fully read/);
    warn.mockRestore();
  });

  it("the group is unreadable but the global list alone covers everyone: still refused", async () => {
    const sg = fiveOnList();
    sg.forbidden.add(GROUP_PATH);
    sg.globalUnsubscribes = Object.keys(sg.contacts);
    const r = await executeEmailCampaignSend(row(body()), deps(sg));
    expect(r).toMatchObject({ ok: false, code: "email_all_suppressed" });
    expect(scheduled(sg)).toBe(0);
  });

  it("nobody suppressed anywhere: no contact lookup is spent", async () => {
    const sg = fiveOnList();
    await sendgridSuppressedOnList(sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch), LIST, "7");
    expect(sg.requests.every((q) => q.auth === `Bearer ${BRIGHTLOOP_KEY}`)).toBe(true);
    expect(sg.count("POST", /contacts\/search\/emails$/)).toBe(0);
  });
});

describe("sendgridSuppressedOnList", () => {
  const check = (sg: FakeSendgrid) => sendgridSuppressedOnList(sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch), LIST, "7");

  it("reads every page of the global list and looks addresses up in batches SendGrid accepts", async () => {
    const sg = fakeSendgrid();
    const emails = Array.from({ length: 730 }, (_, i) => `gone${i}@brightloop.test`);
    sg.globalUnsubscribes = emails;
    for (const e of emails.slice(0, 650)) sg.contacts[e] = [LIST];
    expect(await check(sg)).toEqual({ suppressed: 650, complete: true });
    expect(sg.count("GET", /suppression\/unsubscribes$/)).toBe(2);
    expect(sg.count("POST", /contacts\/search\/emails$/)).toBe(8);
  });

  it("a batch where nobody is a contact is a 404 from SendGrid: zero, and the read stays complete", async () => {
    const sg = fakeSendgrid();
    sg.groupSuppressions["7"] = ["gone@brightloop.test"];
    expect(await check(sg)).toEqual({ suppressed: 0, complete: true });
  });

  it("an unreadable group alone makes the read partial, even with a readable empty global list", async () => {
    const sg = fakeSendgrid();
    sg.forbidden.add(GROUP_PATH);
    expect(await check(sg)).toEqual({ suppressed: 0, complete: false });
  });

  it("a global list too long to read is reported incomplete, never as nobody suppressed", async () => {
    const sg = fakeSendgrid();
    sg.globalUnsubscribes = Array.from({ length: 5500 }, (_, i) => `gone${i}@brightloop.test`);
    expect(await check(sg)).toEqual({ suppressed: 0, complete: false });
  });

  it("a contact lookup that fails part way keeps what it counted and says the read was partial", async () => {
    const sg = fakeSendgrid();
    sg.groupSuppressions["7"] = ["gone@brightloop.test"];
    sg.contacts["gone@brightloop.test"] = [LIST];
    sg.forbidden.add("/v3/marketing/contacts/search/emails");
    expect(await check(sg)).toEqual({ suppressed: 0, complete: false });
  });

  it("a call that throws never escapes", async () => {
    const r = await sendgridSuppressedOnList(async () => { throw new Error("boom"); }, LIST, "7");
    expect(r).toEqual({ suppressed: 0, complete: false });
  });
});

describe("the send path's other refusals", () => {
  it("a sender renamed in SendGrid since approval stops a person-approved send", async () => {
    const sg = fiveOnList();
    sg.senders[0].from_name = "Brightloop Billing";
    const r = await executeEmailCampaignSend(row(body()), deps(sg));
    expect(r.error).toMatch(/the sender in SendGrid changed/);
    expect(scheduled(sg)).toBe(0);
  });

  it("a pause landing mid-send tells the founder this card cannot be retried", async () => {
    const sg = fiveOnList();
    sg.failOnce.set("PUT /v3/marketing/singlesends/{id}/schedule", 429);
    const r = await executeEmailCampaignSend(row(body()), deps(sg, { paused: async () => sg.count("PUT", /schedule$/) > 0 }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe(EMAIL_PAUSED_MID_SEND_ERROR);
    expect(r.error).not.toMatch(/try again/i);
    expect(sg.sends[0].status).toBe("draft");
  });

  it("the sent line falls back to the approved count, not the draft-time one", async () => {
    const sg = fiveOnList();
    const sealed = body({ approved_count: 5, audience_count: 900 });
    expect((await executeEmailCampaignSend(row(sealed), deps(sg))).ok).toBe(true);
    const again = await executeEmailCampaignSend(row(sealed), deps(sg));
    expect(again).toMatchObject({ ok: true, sent_to: 5 });
  });
});
