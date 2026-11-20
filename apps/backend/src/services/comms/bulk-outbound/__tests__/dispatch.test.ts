import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/tools/email/safety-net", () => ({
  unsubscribeUrl: (t: string) => `https://api.zaviagent.com/api/email/unsubscribe?token=${t}`,
  unsubscribeHeaders: (t: string) => ({
    "List-Unsubscribe": `<https://api.zaviagent.com/api/email/unsubscribe?token=${t}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }),
  effectiveCap: () => 0,
  resolveEnvDailySendCap: () => 0,
  sendingDomain: () => "acme.com",
  warmupAllowance: () => 0,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: vi.fn(),
  globalClient: vi.fn(),
}));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));

import { executeBulkOutboundDispatch, isListSendBody } from "../dispatch";
import { BULK_REFUSAL_SENTENCES, type BulkRefusalCode } from "../readiness";
import { sendBulkEmail } from "../wire";
import { DECISION, FROM, LIST, OTHER_TENANT, POSTAL, TENANT, VERSION, harness, people, sentTo } from "./harness";

const saved = process.env.BULK_SENDGRID_API_KEY;
beforeEach(() => {
  process.env.BULK_SENDGRID_API_KEY = "bulk-key";
});
afterEach(() => {
  if (saved === undefined) delete process.env.BULK_SENDGRID_API_KEY;
  else process.env.BULK_SENDGRID_API_KEY = saved;
});

const run = (h: ReturnType<typeof harness>, over: Partial<Parameters<typeof executeBulkOutboundDispatch>[0]> = {}) =>
  executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps, ...over });

describe("approving a bulk email SENDS it (the motivating case)", () => {
  it("3 consented contacts: three wire calls, one person each, From the founder's domain, with the unsubscribe header and footer", async () => {
    const h = harness();
    const fetch = vi.fn(async (_url: string, _init: { headers: Record<string, string>; body: string }) => ({ status: 202 }));
    h.deps.wire = vi.fn((msg) => sendBulkEmail(msg, { fetch: fetch as never }));

    const r = await run(h, { body: h.body({ template: { subject: "Hi", body_text: "Text body" } }) });

    expect(r).toMatchObject({ ok: true, state: "done", line: "Sent to 3." });
    expect(fetch).toHaveBeenCalledTimes(3);
    const payloads = fetch.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(payloads.map((p) => p.personalizations)).toEqual([
      [{ to: [{ email: "a@x.com" }] }],
      [{ to: [{ email: "b@x.com" }] }],
      [{ to: [{ email: "c@x.com" }] }],
    ]);
    for (const [i, p] of payloads.entries()) {
      const email = ["a@x.com", "b@x.com", "c@x.com"][i];
      const link = `https://api.zaviagent.com/api/email/unsubscribe?token=tok-${email}`;
      expect(p.from.email).toBe(FROM);
      expect(p.reply_to).toEqual({ email: "founder@acme.com" });
      expect(p.headers["List-Unsubscribe"]).toBe(`<${link}>`);
      expect(p.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      for (const part of p.content) {
        expect(part.value).toContain(link);
        expect(part.value).toContain(POSTAL);
      }
      expect(p.custom_args.tenant_id).toBe(TENANT);
      expect(fetch.mock.calls[i][1].headers.Authorization).toBe("Bearer bulk-key");
    }
    expect(h.ledger.statuses(r.ok ? r.send_id : "")).toEqual({ sent: 3 });
  });
});

describe("Zavi's own sender stopped for everyone at dispatch time", () => {
  it("holds instead of refusing, creates no send and emails nobody, then sends once when the stop lifts even if resumed twice", async () => {
    const h = harness();
    h.state.refusal = "bulk_sending_paused";
    for (let i = 0; i < 2; i += 1) {
      expect(await run(h)).toEqual({ ok: false, status: "held", code: "bulk_sending_paused", sentence: BULK_REFUSAL_SENTENCES.bulk_sending_paused });
    }
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.ledger.sends.size).toBe(0);

    h.state.refusal = null;
    const [a, b] = await Promise.all([run(h), run(h)]);
    await run(h);
    expect(a.ok || b.ok).toBe(true);
    expect(h.ledger.sends.size).toBe(1);
    expect(h.wire).toHaveBeenCalledTimes(3);
    expect(sentTo(h.wire).sort()).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });
});

describe("refuses, sending nothing, with the right sentence", () => {
  it.each([
    "bulk_outbound_disabled",
    "bulk_sender_not_configured",
    "sending_domain_not_verified",
    "postal_address_missing",
    "list_not_consented",
    "list_archived",
  ] as BulkRefusalCode[])("%s", async (code) => {
    const h = harness();
    h.state.refusal = code;
    const r = await run(h);
    expect(r).toEqual({ ok: false, status: "refused", code, sentence: BULK_REFUSAL_SENTENCES[code] });
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.ledger.sends.size).toBe(0);
  });

  it("a list archived after approval", async () => {
    const h = harness();
    h.ledger.archivedLists.add(LIST);
    expect(await run(h)).toMatchObject({ ok: false, code: "list_archived" });
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("an empty list", async () => {
    const h = harness({ emails: [] });
    expect(await run(h)).toMatchObject({ ok: false, code: "list_empty", sentence: BULK_REFUSAL_SENTENCES.list_empty });
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("a sending address that changed after approval", async () => {
    const h = harness();
    h.state.from = "hello@other.com";
    expect(await run(h)).toMatchObject({ ok: false, code: "sending_domain_changed" });
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("where replies go changed after approval", async () => {
    const h = harness();
    h.state.replyTo = "someone-else@other.com";
    expect(await run(h)).toMatchObject({ ok: false, code: "reply_to_changed" });
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("an owner lookup that fails at approve time refuses and sends nothing, instead of reading as no reply address", async () => {
    const h = harness();
    h.state.replyTo = null;
    h.deps.replyTo = async () => {
      throw new Error("owner lookup failed");
    };
    expect(await run(h)).toMatchObject({ ok: false, status: "refused", code: "bulk_check_failed", sentence: BULK_REFUSAL_SENTENCES.bulk_check_failed });
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.ledger.sends.size).toBe(0);
  });

  it("a workspace on an abuse hold", async () => {
    const h = harness();
    h.ledger.abuseHolds.add(TENANT);
    expect(await run(h)).toMatchObject({ ok: false, code: "bulk_abuse_hold" });
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("a model-written HTML body in an older draft is ignored: only the approved text goes out", async () => {
    const h = harness();
    const fetch = vi.fn(async (_url: string, _init: { body: string }) => ({ status: 202 }));
    h.deps.wire = vi.fn((msg) => sendBulkEmail(msg, { fetch: fetch as never }));
    const r = await run(h, { body: h.body({ template: { subject: "Hi", body_text: "Plain words", body_html: "<a href='https://evil.example'>Other words</a>" } }) });
    expect(r.ok).toBe(true);
    const sent = JSON.stringify(fetch.mock.calls.map((c) => JSON.parse(c[1].body)));
    expect(sent).not.toContain("evil.example");
    expect(sent).not.toContain("Other words");
    expect(sent).toContain("Plain words");
  });

  it("a draft from before bulk sending existed (no list version in the body)", async () => {
    const h = harness();
    const r = await run(h, { body: { selector: { segment: "stalled" }, template: { subject: "s", body_text: "b" } } });
    expect(r).toMatchObject({ ok: false, status: "legacy" });
    expect(isListSendBody({ selector: { segment: "x" } })).toBe(false);
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("an incomplete draft", async () => {
    const h = harness();
    const r = await run(h, { body: h.body({ template: { subject: "", body_text: "" } }) });
    expect(r).toMatchObject({ ok: false, status: "invalid_body" });
    expect(h.wire).not.toHaveBeenCalled();
  });
});

describe("a forged approval sends nothing", () => {
  it("a row nobody approved is refused before anything is read or frozen", async () => {
    const h = harness();
    const check = vi.spyOn(h.deps, "checkReady");
    for (const approved_by of [null, undefined, ""]) {
      const r = await run(h, { approved_by });
      expect(r).toMatchObject({ ok: false, status: "refused", code: "not_approved" });
    }
    expect(check).not.toHaveBeenCalled();
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.ledger.sends.size).toBe(0);
  });

  it("the ledger also refuses to freeze a decision with no approver, whatever the caller claims", async () => {
    const h = harness();
    h.ledger.decisions.set(DECISION, { tenantId: TENANT, approved_by: null });
    const r = await run(h, { approved_by: "someone-claims" });
    expect(r).toMatchObject({ ok: false, code: "not_approved" });
    expect(h.wire).not.toHaveBeenCalled();
  });
});

describe("must catch: the live freeze's Autopilot refusals reach the founder as themselves", () => {
  it.each([
    ["list_version_changed", "planned_list_version_changed", /imported again after it was drafted/],
    ["audience_over_limit", "planned_audience_over_limit", /more than 1,000 people/],
  ])("%s", async (reason, code, sentence) => {
    const { tenantRpc } = await import("@/services/tenant-client");
    const { supabaseBulkSendStore } = await import("../store");
    vi.mocked(tenantRpc).mockResolvedValueOnce({ data: { ok: false, reason }, error: null } as never);
    const h = harness();
    h.deps.store = { ...h.deps.store, freeze: supabaseBulkSendStore.freeze };
    const r = await run(h);
    expect(r).toMatchObject({ ok: false, code });
    expect(r.ok ? "" : r.sentence).toMatch(sentence);
    expect(r.ok ? "" : r.sentence).not.toBe(BULK_REFUSAL_SENTENCES.bulk_check_failed);
    expect(h.wire).not.toHaveBeenCalled();
  });
});

describe("recipients come only from the approved list version", () => {
  it("a forged recipients array in the body is never read", async () => {
    const h = harness();
    const r = await run(h, { body: h.body({ recipients: ["evil@x.com"], to: "evil@x.com", sample_recipients: ["evil@x.com"] }) });
    expect(r.ok).toBe(true);
    expect(sentTo(h.wire)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("more than 1,000 people: 1,000 are frozen", async () => {
    const h = harness({ emails: people(1005) });
    const r = await run(h);
    expect(r.ok && r.counts.total).toBe(1000);
    expect(h.ledger.rows(r.ok ? r.send_id : "")).toHaveLength(1000);
  });

  it("a later import does not change who an approved send reaches", async () => {
    const h = harness({ emails: ["a@x.com", "b@x.com"] });
    h.ledger.addVersion("99999999-9999-4999-8999-999999999999", { tenantId: TENANT, listId: LIST, emails: ["a@x.com", "b@x.com", "c@x.com"], consented: false });
    const r = await run(h);
    expect(r.ok).toBe(true);
    expect(sentTo(h.wire)).toEqual(["a@x.com", "b@x.com"]);
    const h2 = harness();
    h2.ledger.addVersion("99999999-9999-4999-8999-999999999999", { tenantId: TENANT, listId: LIST, emails: ["c@x.com"], consented: false });
    h2.ledger.decisions.set("44444444-4444-4444-8444-444444444444", { tenantId: TENANT, approved_by: "user-a" });
    const r2 = await run(h2, { decision_id: "44444444-4444-4444-8444-444444444444", body: h2.body({ list_version_id: "99999999-9999-4999-8999-999999999999" }) });
    expect(r2).toMatchObject({ ok: false, code: "list_not_consented" });
    expect(h2.wire).not.toHaveBeenCalled();
  });

  it("a version that belongs to a different list is refused", async () => {
    const h = harness();
    h.ledger.addVersion("88888888-8888-4888-8888-888888888888", { tenantId: TENANT, listId: "77777777-7777-4777-8777-777777777777", emails: ["z@x.com"], consented: true });
    const r = await run(h, { body: h.body({ list_version_id: "88888888-8888-4888-8888-888888888888" }) });
    expect(r).toMatchObject({ ok: false, code: "list_not_found" });
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("another workspace cannot send to this workspace's list", async () => {
    const h = harness();
    h.ledger.decisions.set(DECISION, { tenantId: OTHER_TENANT, approved_by: "user-b" });
    const r = await run(h, { tenant_id: OTHER_TENANT });
    expect(r).toMatchObject({ ok: false, code: "list_not_found" });
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.ledger.sends.size).toBe(0);
  });
});

describe("do-not-email", () => {
  it("someone on either do-not-email record is skipped and counted", async () => {
    const h = harness();
    h.ledger.block(TENANT, "a@x.com", "unsubscribed");
    h.ledger.block(TENANT, "c@x.com", "unsubscribed");
    const r = await run(h);
    expect(r).toMatchObject({ ok: true, line: "Sent to 1. 2 people on this list were left out because they unsubscribed or bounced." });
    expect(sentTo(h.wire)).toEqual(["b@x.com"]);
  });

  it("deleting and re-importing an unsubscribed address does not bring it back", async () => {
    const h = harness({ emails: ["a@x.com", "b@x.com"] });
    h.ledger.block(TENANT, "a@x.com", "unsubscribed");
    const r = await run(h);
    expect(sentTo(h.wire)).toEqual(["b@x.com"]);
    expect(r).toMatchObject({ ok: true, line: "Sent to 1. 1 person on this list was left out because they unsubscribed or bounced." });
  });
});

describe("never twice", () => {
  it("approving twice makes one send and emails nobody again", async () => {
    const h = harness();
    const first = await run(h);
    const second = await run(h);
    expect(h.ledger.sends.size).toBe(1);
    expect(h.wire).toHaveBeenCalledTimes(3);
    expect(second.ok && first.ok && second.send_id === first.send_id).toBe(true);
    expect(second).toMatchObject({ ok: true, state: "done", line: "Sent to 3." });
  });

  it("hands the rest to the worker before the first email goes out", async () => {
    const h = harness();
    const order: string[] = [];
    h.wire.mockImplementation(async () => {
      order.push("wire");
      return { kind: "sent" };
    });
    const enqueueFanout = vi.fn(async () => {
      order.push("enqueue");
    });
    const r = await run(h, { deps: { ...h.deps, enqueueFanout } });
    expect(enqueueFanout).toHaveBeenCalledWith(r.ok ? r.send_id : "");
    expect(order[0]).toBe("enqueue");
  });

  it("a large send returns after the first 100 with real counts", async () => {
    const h = harness({ emails: people(250) });
    const r = await run(h);
    expect(r).toMatchObject({ ok: true, state: "more", line: "Sent 100 of 250 so far. The rest are going out now." });
    expect(h.wire).toHaveBeenCalledTimes(100);
  });

  it("the provider refusing every email is a failure that says nobody was emailed", async () => {
    const h = harness();
    h.wire.mockResolvedValue({ kind: "rejected", status: 400 });
    const r = await run(h);
    expect(r).toMatchObject({ ok: false, status: "failed" });
    expect(!r.ok && r.sentence).toMatch(/nobody was emailed/);
  });
});
