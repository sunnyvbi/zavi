import { describe, expect, it, vi } from "vitest";
import { SENDGRID_ENDPOINTS, sendgrid, sendgridHttpCall } from "../providers-sendgrid";
import { sendgridKeyDigest } from "../credential";
import { executeEmailCampaignSend, parseEmailSendBody, campaignTitleFor, type EmailSendDeps, type EmailSendRow } from "../execute-send";
import { reconcileEmailSend, type ReconcileDeps } from "../reconcile";
import { BRIGHTLOOP_KEY, fakeSendgrid, type FakeSendgrid } from "./fake-sendgrid";

const SECRET = "test-digest-secret-0123456789abcdef";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SECRET;
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const ACTION = "22222222-2222-4222-8222-222222222222";

describe("SendGrid endpoints (contract)", () => {
  it("every operation is the documented method + path", () => {
    expect(SENDGRID_ENDPOINTS).toEqual({
      SENDGRID_LISTS: { method: "GET", path: "/v3/marketing/lists" },
      SENDGRID_LIST: { method: "GET", path: "/v3/marketing/lists/{id}" },
      SENDGRID_LIST_CONTACT_COUNT: { method: "GET", path: "/v3/marketing/lists/{id}/contacts/count" },
      SENDGRID_VERIFIED_SENDERS: { method: "GET", path: "/v3/verified_senders" },
      SENDGRID_SUPPRESSION_GROUPS: { method: "GET", path: "/v3/asm/groups" },
      SENDGRID_GROUP_SUPPRESSIONS: { method: "GET", path: "/v3/asm/groups/{id}/suppressions" },
      SENDGRID_GLOBAL_UNSUBSCRIBES: { method: "GET", path: "/v3/suppression/unsubscribes" },
      SENDGRID_CONTACTS_BY_EMAIL: { method: "POST", path: "/v3/marketing/contacts/search/emails" },
      SENDGRID_SINGLE_SEND_SEARCH: { method: "POST", path: "/v3/marketing/singlesends/search" },
      SENDGRID_SINGLE_SEND: { method: "GET", path: "/v3/marketing/singlesends/{id}" },
      SENDGRID_SINGLE_SENDS: { method: "GET", path: "/v3/marketing/singlesends" },
      SENDGRID_CREATE_SINGLE_SEND: { method: "POST", path: "/v3/marketing/singlesends" },
      SENDGRID_UPDATE_SINGLE_SEND: { method: "PATCH", path: "/v3/marketing/singlesends/{id}" },
      SENDGRID_SCHEDULE_SINGLE_SEND: { method: "PUT", path: "/v3/marketing/singlesends/{id}/schedule" },
      SENDGRID_SINGLE_SEND_STATS: { method: "GET", path: "/v3/marketing/stats/singlesends/{id}" },
      SENDGRID_DELETE_SINGLE_SEND: { method: "DELETE", path: "/v3/marketing/singlesends/{id}" },
    });
  });
});

describe("SendGrid provider methods over HTTPS", () => {
  const setup = () => {
    const sg = fakeSendgrid();
    return { sg, call: sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch) };
  };

  it("listAudiences / getAudience / liveRecipientCount read the marketing lists", async () => {
    const { sg, call } = setup();
    sg.lists.push({ id: "6a1f0c2e-0000-4000-8000-00000000b002", name: "Weekly digest", contact_count: 4100 });
    expect(await sendgrid.listAudiences(call)).toEqual([
      { id: LIST, name: "Brightloop members", member_count: 238 },
      { id: "6a1f0c2e-0000-4000-8000-00000000b002", name: "Weekly digest", member_count: 4100 },
    ]);
    expect(sg.requests[0].url.search).toBe("?page_size=1000");
    expect(await sendgrid.getAudience(call, LIST)).toEqual({ id: LIST, name: "Brightloop members", member_count: 238 });
    expect(await sendgrid.getAudience(call, "6a1f0c2e-0000-4000-8000-00000000ffff")).toBeNull();
    expect(await sendgrid.liveRecipientCount(call, "x", LIST, async () => {})).toBe(238);
    for (const r of sg.requests) expect(r.auth).toBe(`Bearer ${BRIGHTLOOP_KEY}`);
  });

  it("defaultSender is the one verified sender; two senders is the founder's pick", async () => {
    const { sg, call } = setup();
    expect(await sendgrid.defaultSender(call, { id: LIST, name: "x", member_count: 1 })).toEqual({ name: "Brightloop", email: "hello@brightloop.test" });
    sg.senders.push({ id: 42, from_email: "news@brightloop.test", from_name: "Brightloop News", verified: true });
    expect(await sendgrid.defaultSender(call, { id: LIST, name: "x", member_count: 1 })).toEqual({ name: null, email: null });
  });

  it("resolveSendIds: the verified sender for the address and the single default unsubscribe group", async () => {
    const { sg, call } = setup();
    expect(await sendgrid.resolveSendIds!(call, "HELLO@brightloop.test")).toEqual({ sender_id: "41", suppression_group_id: "7", sender_name: "Brightloop" });
    await expect(sendgrid.resolveSendIds!(call, "other@brightloop.test")).rejects.toThrow(/not a verified sender/);
    sg.groups[0].is_default = false;
    await expect(sendgrid.resolveSendIds!(call, "hello@brightloop.test")).rejects.toThrow(/no unsubscribe group/);
  });

  it("create -> content -> envelope -> readiness -> send, with the documented bodies", async () => {
    const { sg, call } = setup();
    const id = await sendgrid.createCampaign(call, {
      title: "Zavi: Spring (abc)",
      audience_id: LIST,
      subject: "Spring",
      preview_text: null,
      from_name: "Brightloop",
      from_email: "hello@brightloop.test",
      reply_to: null,
      sender_id: "41",
      suppression_group_id: "7",
    });
    const create = sg.requests.find((r) => r.method === "POST" && r.url.pathname === "/v3/marketing/singlesends")!;
    expect(create.body).toEqual({
      name: "Zavi: Spring (abc)",
      send_to: { list_ids: [LIST] },
      email_config: { subject: "Spring", editor: "code", sender_id: 41, suppression_group_id: 7 },
    });
    expect(await sendgrid.readiness(call, id)).toEqual({ ready: false, reason: "it has no content" });
    await sendgrid.setContent(call, id, { title: "Zavi: Spring (abc)", html: "<p>Hi</p>", text: "Hi" });
    await sendgrid.setEnvelope(call, id, { subject: "Spring!", preview_text: null, from_name: "Brightloop", from_email: "hello@brightloop.test", reply_to: null, sender_id: "41", suppression_group_id: "8" });
    const state = await sendgrid.getCampaign(call, id);
    expect(state).toMatchObject({ phase: "draft", audience_ids: [LIST], narrowed: false, envelope: { subject: "Spring!", sender_id: "41", suppression_group_id: "8" } });
    expect(await sendgrid.readiness(call, id)).toEqual({ ready: true, reason: null });
    const sent = await sendgrid.send(call, id);
    expect(sent.ok).toBe(true);
    const sched = sg.requests.find((r) => r.method === "PUT")!;
    expect(sched.url.pathname).toBe(`/v3/marketing/singlesends/${id}/schedule`);
    expect(sched.body).toEqual({ send_at: "now" });
    expect((await sendgrid.getCampaign(call, id))?.phase).toBe("sending");
  });

  it("a segment or send-to-all is never the sealed list", async () => {
    const { sg, call } = setup();
    sg.sends.push({ id: "ss-90", name: "n", status: "draft", list_ids: [LIST], segment_ids: ["seg-1"], subject: "s", html: null, plain: null, sender_id: 41, suppression_group_id: 7, created_at: "t" });
    sg.sends.push({ id: "ss-91", name: "n", status: "draft", list_ids: [LIST], segment_ids: [], all: true, subject: "s", html: null, plain: null, sender_id: 41, suppression_group_id: 7, created_at: "t" });
    expect((await sendgrid.getCampaign(call, "ss-90"))?.narrowed).toBe(true);
    expect((await sendgrid.getCampaign(call, "ss-91"))?.audience_ids).toEqual([]);
  });

  it("findCampaignsByTitle keeps only exact names (the search is a wildcard), newest first", async () => {
    const { sg, call } = setup();
    const base = { status: "draft" as const, list_ids: [LIST], segment_ids: [], subject: "s", html: null, plain: null, sender_id: 41, suppression_group_id: 7 };
    sg.sends.push({ ...base, id: "ss-1", name: "Zavi: Spring (abc)", created_at: "2026-10-01T00:00:00Z" });
    sg.sends.push({ ...base, id: "ss-2", name: "Zavi: Spring (abc) copy", created_at: "2026-10-02T00:00:00Z" });
    sg.sends.push({ ...base, id: "ss-3", name: "Zavi: Spring (abc)", created_at: "2026-10-03T00:00:00Z" });
    const found = await sendgrid.findCampaignsByTitle(call, "Zavi: Spring (abc)");
    expect(found.map((c) => c.id)).toEqual(["ss-3", "ss-1"]);
    expect(sg.requests.find((r) => r.url.pathname.endsWith("/search"))?.body).toEqual({ name: "Zavi: Spring (abc)" });
  });

  it("results read the single send stats with a named window", async () => {
    const { sg, call } = setup();
    sg.stats["ss-5"] = { requests: 238, delivered: 200, unique_opens: 50, unique_clicks: 10, unsubscribes: 2 };
    expect(await sendgrid.results(call, "ss-5")).toEqual({ recipients: 238, delivered: 200, bounces: null, opens: 50, clicks: 10, unsubscribes: 2, open_rate: 0.25, click_rate: 0.05 });
    const q = sg.requests.at(-1)!.url.searchParams;
    expect(q.get("aggregated_by")).toBe("total");
    expect(q.get("start_date")).toBe("2020-01-01");
    expect(q.get("end_date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("401 and 429 are readable, never carry the key, and are not 'outcome unknown'", async () => {
    const sg = fakeSendgrid();
    const wrong = sendgridHttpCall("SG.wrong.key_brightloopSecret", sg.fetch);
    const r401 = await wrong("SENDGRID_LISTS", {});
    expect(r401).toMatchObject({ ok: false, status: 401, outcome_unknown: false });
    expect(String(r401.error)).toMatch(/refused the key/);
    expect(JSON.stringify(r401)).not.toContain("brightloopSecret");
    sg.failOnce.set("POST /v3/marketing/singlesends", 429);
    const r429 = await sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch)("SENDGRID_CREATE_SINGLE_SEND", { body: {} });
    expect(r429).toMatchObject({ ok: false, status: 429, outcome_unknown: false });
    expect(String(r429.error)).toMatch(/rate limit/);
    await expect(sendgrid.listAudiences(wrong)).rejects.toThrow(/refused the key/);
  });

  it("a lost answer or a 5xx on a write may have run (outcome unknown); on a read it did not", async () => {
    const sg = fakeSendgrid();
    const call = sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch);
    sg.dropAnswerOf.add("PUT /v3/marketing/singlesends/{id}/schedule");
    expect((await call("SENDGRID_SCHEDULE_SINGLE_SEND", { id: "ss-1", body: { send_at: "now" } })).outcome_unknown).toBe(true);
    sg.failOnce.set("POST /v3/marketing/singlesends", 503);
    expect((await call("SENDGRID_CREATE_SINGLE_SEND", { body: {} })).outcome_unknown).toBe(true);
    sg.dropAnswerOf.add("GET /v3/marketing/lists");
    expect((await call("SENDGRID_LISTS", {})).outcome_unknown).toBe(false);
  });

  it("refuses a path id that is not an id, without calling SendGrid", async () => {
    const sg = fakeSendgrid();
    const r = await sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch)("SENDGRID_SINGLE_SEND", { id: "../v3/user/account" });
    expect(r.ok).toBe(false);
    expect(sg.requests).toHaveLength(0);
  });
});

const sgBody = (over: Record<string, unknown> = {}) => ({
  tool: "sendgrid",
  credential: { kind: "sendgrid_key", key_digest: DIGEST },
  audience_id: LIST,
  audience_name: "Brightloop members",
  audience_count: 238,
  subject: "New studio hours",
  preview_text: "Open late on Thursdays",
  body_text: "Hello from Brightloop.\n\nSee https://brightloop.test/hours",
  from_name: "Brightloop",
  from_email: "hello@brightloop.test",
  reply_to: null,
  sendgrid_sender_id: "41",
  sendgrid_suppression_group_id: "7",
  ...over,
});

function harness(sg: FakeSendgrid, key: string | null = BRIGHTLOOP_KEY) {
  const progress: { value: unknown } = { value: null };
  const deps: Partial<EmailSendDeps> = {
    resolveAccount: (async () => {
      throw new Error("composio must not be called for SendGrid");
    }) as unknown as EmailSendDeps["resolveAccount"],
    exec: (async () => {
      throw new Error("composio must not be called for SendGrid");
    }) as unknown as EmailSendDeps["exec"],
    resolveSendgrid: async () => (key ? { api_key: key, key_digest: sendgridKeyDigest(key) } : null),
    sendgridFetch: sg.fetch,
    readProgress: async () => progress.value as never,
    recordProgress: async (_t, _a, _c, p) => {
      progress.value = p;
      return true;
    },
    scheduleReconcile: async () => {},
    authorizeCgo: (async () => ({ verdict: "allow", reasons: [] })) as unknown as EmailSendDeps["authorizeCgo"],
    notifyAutopilotSend: (async () => true) as unknown as EmailSendDeps["notifyAutopilotSend"],
    sleep: async () => {},
    paused: async () => false,
  };
  return { deps, progress };
}
const row = (b: unknown): EmailSendRow => ({ id: ACTION, tenant_id: "tenant-brightloop", body: b, approved_by_source: null, exec_source: "channel_actions", claim_id: "claim-1" });

describe("approving a SendGrid card", () => {
  it("creates ONE Single Send on the sealed list, fills it, and sends it once", async () => {
    const sg = fakeSendgrid();
    const { deps } = harness(sg);
    const r = await executeEmailCampaignSend(row(sgBody()), deps);
    expect(r).toMatchObject({ ok: true, notice: "SendGrid accepted this send for 238 people. Delivery is not confirmed yet." });
    expect(sg.sends).toHaveLength(1);
    const s = sg.sends[0];
    expect(s).toMatchObject({ name: campaignTitleFor(ACTION, "New studio hours"), list_ids: [LIST], sender_id: 41, suppression_group_id: 7, status: "scheduled" });
    expect(s.html).toContain("Open late on Thursdays");
    expect(s.html).toContain('<a href="https://brightloop.test/hours">');
    expect(sg.count("PUT", /schedule$/)).toBe(1);
  });

  it("uses the sealed sender and unsubscribe group and never looks them up at send time", async () => {
    const sg = fakeSendgrid();
    const { deps } = harness(sg);
    await executeEmailCampaignSend(row(sgBody({ sendgrid_sender_id: "41", sendgrid_suppression_group_id: "8" })), deps);
    expect(sg.sends[0].suppression_group_id).toBe(8);
    expect(sg.count("GET", /asm\/groups$/)).toBe(0);
    expect(sg.count("GET", /verified_senders/)).toBe(1);
  });

  it("refuses a SendGrid card without a sealed sender or unsubscribe group, and sends nothing", async () => {
    for (const missing of [{ sendgrid_sender_id: undefined }, { sendgrid_suppression_group_id: null }]) {
      const sg = fakeSendgrid();
      const { deps } = harness(sg);
      const r = await executeEmailCampaignSend(row(sgBody(missing)), deps);
      expect(r).toMatchObject({ ok: false, code: "email_campaign_body_invalid" });
      expect(sg.sends).toHaveLength(0);
    }
  });

  it("approving again after a lost create answer finds its own Single Send by name: no second copy, one send", async () => {
    const sg = fakeSendgrid();
    const { deps, progress } = harness(sg);
    sg.dropAnswerOf.add("POST /v3/marketing/singlesends");
    const r = await executeEmailCampaignSend(row(sgBody()), deps);
    expect(r.ok).toBe(true);
    expect(sg.sends).toHaveLength(1);
    expect(sg.count("PUT", /schedule$/)).toBe(1);
    const again = await executeEmailCampaignSend(row(sgBody()), deps);
    expect(again.ok).toBe(false);
    expect(sg.count("PUT", /schedule$/)).toBe(1);
    expect(progress.value).toBeTruthy();
  });

  it("a new key connected after the card was made: every call and the send use the new key, the old key never", async () => {
    const sg = fakeSendgrid();
    const fresh = "SG.newKey0000001.rotated_abcdefghijklmnopqrstu";
    sg.key = fresh;
    const { deps } = harness(sg, fresh);
    const r = await executeEmailCampaignSend(row(sgBody()), deps);
    expect(r.ok).toBe(true);
    expect(sg.sends).toHaveLength(1);
    expect(sg.requests.length).toBeGreaterThan(3);
    expect(sg.requests.every((q) => q.auth === `Bearer ${fresh}`)).toBe(true);
  });

  it("a new key on an account without the card's list: nothing is created or sent", async () => {
    const sg = fakeSendgrid();
    const fresh = "SG.newKey0000002.otherAccount_abcdefghijklmnop";
    sg.key = fresh;
    sg.lists = [{ id: "6a1f0c2e-0000-4000-8000-00000000b999", name: "Someone else's list", contact_count: 900 }];
    const { deps } = harness(sg, fresh);
    const r = await executeEmailCampaignSend(row(sgBody()), deps);
    expect(r).toMatchObject({ ok: false, code: "email_audience_missing" });
    expect(sg.count("POST", /singlesends$/)).toBe(0);
    expect(sg.count("PUT", /schedule$/)).toBe(0);
  });

  it("a new key on an account where the card's sender is not verified: nothing goes out", async () => {
    const sg = fakeSendgrid();
    const fresh = "SG.newKey0000003.noSender_abcdefghijklmnopqrst";
    sg.key = fresh;
    sg.senders = [{ id: 41, from_email: "other@elsewhere.test", from_name: "Elsewhere", verified: true }];
    const { deps } = harness(sg, fresh);
    const r = await executeEmailCampaignSend(row(sgBody()), deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sender");
    expect(sg.count("PUT", /schedule$/)).toBe(0);
  });

  function busySchedule(sg: FakeSendgrid, times: number, resetInS: number | null = null) {
    let left = times;
    const order: string[] = [];
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const isSchedule = method === "PUT" && /\/schedule$/.test(url.pathname);
      if (isSchedule) order.push("send");
      else if (method === "GET" && /^\/v3\/marketing\/singlesends\/[^/]+$/.test(url.pathname)) order.push("read");
      if (isSchedule && left > 0) {
        left -= 1;
        const headers = resetInS === null ? undefined : { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + resetInS) };
        return new Response(JSON.stringify({ errors: [{ message: "too many requests" }] }), { status: 429, headers });
      }
      return sg.fetch(input, init);
    }) as typeof fetch;
    return { wrapped, order };
  }

  it("SendGrid's rate limit on the send step, once: the draft is read back, sent once more after a wait, and the card is sent, not exec_partial", async () => {
    const sg = fakeSendgrid();
    const { deps } = harness(sg);
    const busy = busySchedule(sg, 1);
    const waits: number[] = [];
    const r = await executeEmailCampaignSend(row(sgBody()), { ...deps, sendgridFetch: busy.wrapped, sleep: async (ms: number) => void waits.push(ms) });
    expect(r).toMatchObject({ ok: true, notice: "SendGrid accepted this send for 238 people. Delivery is not confirmed yet." });
    expect(r.code).toBeUndefined();
    expect(sg.sends).toHaveLength(1);
    expect(sg.sends[0].status).toBe("scheduled");
    expect(sg.count("PUT", /schedule$/)).toBe(1);
    expect(busy.order.filter((x) => x === "send")).toHaveLength(2);
    const firstSend = busy.order.indexOf("send");
    expect(busy.order.slice(firstSend + 1, busy.order.indexOf("send", firstSend + 1))).toContain("read");
    expect(waits.some((ms) => ms >= 5_000)).toBe(true);
  });

  it("SendGrid stays rate limited: bounded tries, then exec_partial with not_sent proof, and nothing went out", async () => {
    const sg = fakeSendgrid();
    const { deps } = harness(sg);
    const busy = busySchedule(sg, 99);
    const r = await executeEmailCampaignSend(row(sgBody()), { ...deps, sendgridFetch: busy.wrapped });
    expect(r).toMatchObject({ ok: false, code: "exec_partial", not_sent: true });
    expect(r.error).toContain("busy (rate limit)");
    expect(r.error).toContain("Nothing was sent");
    expect(r.error).not.toContain("Try again in a minute");
    expect(busy.order.filter((x) => x === "send")).toHaveLength(3);
    expect(sg.sends[0].status).toBe("draft");
  });

  it("SendGrid asks for a wait longer than Zavi holds the send: no second send call at all", async () => {
    const sg = fakeSendgrid();
    const { deps } = harness(sg);
    const busy = busySchedule(sg, 1, 600);
    const waits: number[] = [];
    const r = await executeEmailCampaignSend(row(sgBody()), { ...deps, sendgridFetch: busy.wrapped, sleep: async (ms: number) => void waits.push(ms) });
    expect(r).toMatchObject({ ok: false, code: "exec_partial", not_sent: true });
    expect(busy.order.filter((x) => x === "send")).toHaveLength(1);
    expect(waits.every((ms) => ms <= 30_000)).toBe(true);
  });

  it("a 429, and the read-back shows the Single Send already scheduled: reported sent, never sent a second time", async () => {
    const sg = fakeSendgrid();
    const { deps } = harness(sg);
    const busy = busySchedule(sg, 1);
    const r = await executeEmailCampaignSend(row(sgBody()), {
      ...deps,
      sendgridFetch: busy.wrapped,
      sleep: async () => {
        sg.sends[0].status = "scheduled";
      },
    });
    expect(r.ok).toBe(true);
    expect(busy.order.filter((x) => x === "send")).toHaveLength(1);
  });

  it("an unclear answer on the send (5xx) is still outcome unknown and is never sent again", async () => {
    const sg = fakeSendgrid();
    sg.failOnce.set("PUT /v3/marketing/singlesends/{id}/schedule", 503);
    const { deps } = harness(sg);
    const r = await executeEmailCampaignSend(row(sgBody()), deps);
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(sg.requests.filter((q) => q.method === "PUT" && /schedule$/.test(q.url.pathname))).toHaveLength(1);
  });

  it("an unclear send on a chat-proposed card does not promise a check that never runs", async () => {
    const sg = fakeSendgrid();
    sg.failOnce.set("PUT /v3/marketing/singlesends/{id}/schedule", 503);
    const { deps } = harness(sg);
    const chat: EmailSendRow = { ...row(sgBody()), exec_source: undefined, claim_id: undefined };
    const r = await executeEmailCampaignSend(chat, { ...deps, recordSendRef: async () => true });
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
    expect(r.error).not.toContain("in a few minutes");
    expect(r.error).toContain("Open SendGrid to see whether it went out");
  });

  it("no campaign-ready key now: not connected, nothing sent", async () => {
    const sg = fakeSendgrid();
    const { deps } = harness(sg, null);
    expect(await executeEmailCampaignSend(row(sgBody()), deps)).toMatchObject({ ok: false, code: "email_tool_not_connected" });
    expect(sg.requests).toHaveLength(0);
  });

  it("an earlier attempt's Single Send with another sender is re-written to the card's sender before it goes out", async () => {
    const sg = fakeSendgrid();
    sg.senders.push({ id: 43, from_email: "ops@brightloop.test", from_name: "Ops", verified: true });
    const { deps } = harness(sg);
    sg.sends.push({ id: "ss-77", name: campaignTitleFor(ACTION, "New studio hours"), status: "draft", list_ids: [LIST], segment_ids: [], subject: "x", html: null, plain: null, sender_id: 43, suppression_group_id: 7, created_at: "t" });
    const r = await executeEmailCampaignSend(row(sgBody()), deps);
    expect(r.ok).toBe(true);
    expect(sg.sends[0].sender_id).toBe(41);
    expect(sg.sends).toHaveLength(1);
  });

  it("a SendGrid body sealed with a Composio credential (or none) is invalid", async () => {
    const sg = fakeSendgrid();
    const { deps } = harness(sg);
    const wrong = sgBody({ credential: { kind: "composio", connected_account_id: "ca", auth_config_id: "ac" } });
    expect(await executeEmailCampaignSend(row(wrong), deps)).toMatchObject({ code: "email_campaign_body_invalid" });
    const { credential: _c, ...none } = sgBody();
    expect(await executeEmailCampaignSend(row(none), deps)).toMatchObject({ code: "email_campaign_body_invalid" });
    expect(sg.requests).toHaveLength(0);
  });

  it("old Composio-shaped bodies (flat account fields) still parse; the new credential shape does too; mixing both is refused", () => {
    const flat = { ...sgBody({ tool: "mailchimp", audience_id: "L1" }), credential: undefined, connected_account_id: "ca-x", auth_config_id: "ac-x" };
    delete (flat as Record<string, unknown>).credential;
    expect(parseEmailSendBody(flat)).not.toBeNull();
    const fresh = sgBody({ tool: "klaviyo", audience_id: "L1", credential: { kind: "composio", connected_account_id: "ca-x", auth_config_id: "ac-x" } });
    expect(parseEmailSendBody(fresh)).not.toBeNull();
    expect(parseEmailSendBody({ ...fresh, connected_account_id: "ca-y", auth_config_id: "ac-y" })).toBeNull();
  });
});

describe("reconcile a SendGrid send whose outcome was unknown", () => {
  it("reads the Single Send by id: triggered settles sent, and nothing is created or sent", async () => {
    const sg = fakeSendgrid();
    sg.sends.push({ id: "ss-9", name: "n", status: "triggered", list_ids: [LIST], segment_ids: [], subject: "s", html: "h", plain: "t", sender_id: 41, suppression_group_id: 7, created_at: "t" });
    const settled: unknown[] = [];
    const deps: Partial<ReconcileDeps> = {
      resolveAccount: (async () => null) as unknown as ReconcileDeps["resolveAccount"],
      exec: (async () => {
        throw new Error("no composio");
      }) as unknown as ReconcileDeps["exec"],
      resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
      sendgridFetch: sg.fetch,
      settle: (async (_t: string, a: unknown) => {
        settled.push(a);
        return { ok: true, replayed: false };
      }) as unknown as ReconcileDeps["settle"],
      notifyAutopilotSend: vi.fn(async () => true) as unknown as ReconcileDeps["notifyAutopilotSend"],
    };
    const r = await reconcileEmailSend(
      ACTION,
      {
        tenant_id: "tenant-brightloop",
        exec_class: "email_campaign.create_and_send",
        exec_status: "failed",
        exec_result: { code: "exec_outcome_unknown" },
        exec_payload: sgBody(),
        exec_progress: { campaign_id: "ss-9", stage: "send_requested" },
        approved_by_source: null,
        lease_expired: false,
      },
      { finalPass: false },
      deps,
    );
    expect(r).toEqual({ done: true, outcome: "sent" });
    expect(settled).toHaveLength(1);
    expect(sg.requests.every((q) => q.method === "GET")).toBe(true);
  });
});
