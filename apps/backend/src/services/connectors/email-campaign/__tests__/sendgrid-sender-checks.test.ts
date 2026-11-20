import { describe, expect, it, vi } from "vitest";
import { sendgridKeyDigest } from "../credential";
import { executeEmailCampaignSend, notConfirmedSentence, type EmailSendDeps, type EmailSendRow } from "../execute-send";
import { BRIGHTLOOP_KEY, fakeSendgrid, type FakeSendgrid } from "./fake-sendgrid";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const ACTION = "22222222-2222-4222-8222-222222222222";

const body = (over: Record<string, unknown> = {}) => ({
  tool: "sendgrid", credential: { kind: "sendgrid_key", key_digest: DIGEST }, audience_id: LIST, audience_name: "Brightloop members", audience_count: 238,
  subject: "New studio hours", preview_text: null, body_text: "Hello from Brightloop.", from_name: "Brightloop", from_email: "hello@brightloop.test",
  reply_to: null, sendgrid_sender_id: "41", sendgrid_suppression_group_id: "7", ...over,
});

function harness(sg: FakeSendgrid, settings: Record<string, string> = {}) {
  const authorizeCgo = vi.fn(async () => ({ verdict: "allow", reasons: [] }));
  const scheduleReconcile = vi.fn(async () => {});
  const deps: Partial<EmailSendDeps> = {
    resolveAccount: (async () => { throw new Error("no composio"); }) as never,
    exec: (async () => { throw new Error("no composio"); }) as never,
    resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
    sendgridFetch: sg.fetch,
    readProgress: async () => null,
    recordProgress: async () => true,
    scheduleReconcile,
    authorizeCgo: authorizeCgo as never,
    notifyAutopilotSend: (async () => true) as never,
    sleep: async () => {},
    setting: async (_t, f) => settings[f] ?? null,
    paused: async () => false,
  };
  return { deps, authorizeCgo, scheduleReconcile };
}
const row = (b: unknown, source: string | null = null): EmailSendRow => ({ id: ACTION, tenant_id: "tenant-brightloop", body: b, approved_by_source: source, exec_source: "channel_actions", claim_id: "claim-1" });

describe("the verified sender is read again before a SendGrid send", () => {
  it("its address changed in SendGrid since the card was made: Zavi stops, nothing is scheduled", async () => {
    const sg = fakeSendgrid();
    sg.senders[0].from_email = "billing@brightloop.test";
    const r = await executeEmailCampaignSend(row(body()), harness(sg).deps);
    expect(r).toMatchObject({ ok: false, code: "email_tool_refused" });
    expect(r.error).toMatch(/^Zavi stopped this send: the sender in SendGrid changed since the card was made\. Nothing was sent\./);
    expect(sg.count("PUT", /schedule$/)).toBe(0);
  });

  it("the sender is no longer verified: stopped the same way", async () => {
    const sg = fakeSendgrid();
    sg.senders[0].verified = false;
    const r = await executeEmailCampaignSend(row(body()), harness(sg).deps);
    expect(r.error).toMatch(/the sender in SendGrid changed/);
    expect(sg.count("PUT", /schedule$/)).toBe(0);
  });
});

describe("Autopilot's sender check uses the sender picked in Settings", () => {
  it("two verified senders, the card's one is the pinned one: Autopilot sends", async () => {
    const sg = fakeSendgrid();
    sg.senders.push({ id: 42, from_email: "news@brightloop.test", from_name: "Brightloop News", verified: true });
    const h = harness(sg, { sendgrid_sender_id: "41" });
    const r = await executeEmailCampaignSend(row(body(), "cgo"), h.deps);
    expect(r).toMatchObject({ ok: true });
    expect(h.authorizeCgo).toHaveBeenCalledTimes(1);
    expect(sg.count("PUT", /schedule$/)).toBe(1);
  });

  it("the card is sealed with a sender other than the pinned one: held for the founder, nothing sent", async () => {
    const sg = fakeSendgrid();
    sg.senders.push({ id: 42, from_email: "news@brightloop.test", from_name: "Brightloop News", verified: true });
    const h = harness(sg, { sendgrid_sender_id: "42" });
    const r = await executeEmailCampaignSend(row(body(), "cgo"), h.deps);
    expect(r).toMatchObject({ ok: false, held_for_founder: true });
    expect(h.authorizeCgo).not.toHaveBeenCalled();
    expect(sg.count("PUT", /schedule$/)).toBe(0);
  });
});

describe("a send the tool accepted but never shows as going out", () => {
  it("is an unknown outcome handed to the reconcile worker, never reported as sent", async () => {
    const sg = fakeSendgrid();
    const realFetch = sg.fetch;
    sg.fetch = (async (url: string, init?: RequestInit) => {
      const res = await realFetch(url as never, init as never);
      if ((init?.method ?? "GET") === "PUT" && /schedule$/.test(new URL(url).pathname)) for (const s of sg.sends) s.status = "draft";
      return res;
    }) as unknown as typeof fetch;
    const h = harness(sg);
    h.deps.sendgridFetch = sg.fetch;
    h.deps.recordSendRef = async () => true;
    const r = await executeEmailCampaignSend(row(body()), h.deps);
    expect(r).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });
    expect(r.notice).toBeUndefined();
    expect(h.scheduleReconcile).toHaveBeenCalledWith(ACTION, "claim-1");
  });

  it("a decisions-rail send the tool accepted but never shows going out is unknown with the reason, never reported as sent", async () => {
    const sg = fakeSendgrid();
    const realFetch = sg.fetch;
    sg.fetch = (async (url: string, init?: RequestInit) => {
      const res = await realFetch(url as never, init as never);
      if ((init?.method ?? "GET") === "PUT" && /schedule$/.test(new URL(url).pathname)) for (const send of sg.sends) send.status = "draft";
      return res;
    }) as unknown as typeof fetch;
    const h = harness(sg);
    h.deps.sendgridFetch = sg.fetch;
    h.deps.recordSendRef = async () => true;
    const r = await executeEmailCampaignSend({ ...row(body()), exec_source: undefined, claim_id: undefined }, h.deps);
    expect(r).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });
    expect(r.error).toBe(notConfirmedSentence("SendGrid", { ...sg.sends[0], phase: "draft" } as never));
    expect(r.error).toContain("still a draft");
    expect(r).not.toHaveProperty("sent_to");
    expect(h.scheduleReconcile).not.toHaveBeenCalled();
  });
});
