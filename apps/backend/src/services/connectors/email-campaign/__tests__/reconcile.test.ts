import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileEmailSend, type ReconcileDeps, type ReconcileTarget } from "../reconcile";
import { fakeKlaviyo, fakeMailchimp, type FakeTool } from "./fake-tools";

const ACTION = "33333333-3333-4333-8333-333333333333";
const payload = (tool: "mailchimp" | "klaviyo" = "mailchimp") => ({
  tool, connected_account_id: `ca-${tool}`, auth_config_id: `ac-${tool}`, audience_id: "L1", audience_name: "Newsletter", audience_count: 412,
  subject: "Spring offer", preview_text: null, body_text: "x", from_name: "Acme", from_email: "hi@acme.test", reply_to: null,
});
const target = (over: Partial<ReconcileTarget> = {}): ReconcileTarget => ({
  tenant_id: "t1",
  exec_class: "email_campaign.create_and_send",
  exec_status: "failed",
  exec_result: { code: "exec_outcome_unknown" },
  exec_payload: payload(),
  exec_progress: { campaign_id: "mc1", stage: "send_requested" },
  approved_by_source: null,
  lease_expired: false,
  ...over,
});

let mc: FakeTool;
let settled: Array<{ ok: boolean; result: Record<string, unknown>; error?: string | null }>;
let notified: unknown[];
let deps: ReconcileDeps;
const WRITES = ["MAILCHIMP_ADD_CAMPAIGN", "MAILCHIMP_SET_CAMPAIGN_CONTENT", "MAILCHIMP_SEND_CAMPAIGN", "KLAVIYO_CREATE_CAMPAIGN", "KLAVIYO_CREATE_CAMPAIGN_SEND_JOB"];

beforeEach(() => {
  mc = fakeMailchimp();
  mc.campaigns.push({ id: "mc1", title: `Zavi ${ACTION}`, list: "L1", status: "save", html: "x", sent: 0 });
  settled = [];
  notified = [];
  deps = {
    resolveAccount: (async (tenant: string, tool: string) => ({ tenant_id: tenant, toolkit: tool, connected_account_id: `ca-${tool}`, auth_config_id: `ac-${tool}` })) as unknown as ReconcileDeps["resolveAccount"],
    exec: ((c: Parameters<FakeTool["exec"]>[0]) => mc.exec(c)) as unknown as ReconcileDeps["exec"],
    settle: (async (_t: string, a: { ok: boolean; result: Record<string, unknown>; error?: string | null }) => {
      settled.push({ ok: a.ok, result: a.result, error: a.error });
      return { ok: true, replayed: false };
    }) as unknown as ReconcileDeps["settle"],
    notifyAutopilotSend: (async (_t: string, s: unknown) => {
      notified.push(s);
      return true;
    }) as unknown as ReconcileDeps["notifyAutopilotSend"],
  };
});

const never = () => expect(mc.calls.filter((c) => WRITES.includes(c.tool_slug))).toEqual([]);

describe("reconcileEmailSend", () => {
  it("lost answer after SEND and the tool shows it sent: settles executed with the receipt, sends nothing", async () => {
    mc.campaigns[0].status = "sent";
    mc.campaigns[0].sent = 412;
    const r = await reconcileEmailSend(ACTION, target(), { finalPass: false }, deps);
    expect(r).toEqual({ done: true, outcome: "sent" });
    expect(settled).toEqual([{ ok: true, result: expect.objectContaining({ receipt: expect.objectContaining({ line: "Mailchimp accepted this send for a list of 412 people. Delivery is not confirmed yet" }), reconciled: true }), error: "Mailchimp accepted this send for a list of 412 people. Delivery is not confirmed yet." }]);
    never();
  });

  it("settles first; what went out is read back after, off the path, and never sent again", async () => {
    mc.campaigns[0].status = "sent";
    mc.campaigns[0].sent = 300;
    const order: string[] = [];
    const exec = deps.exec;
    deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) => {
      order.push(c.tool_slug);
      return (exec as unknown as (c: Parameters<FakeTool["exec"]>[0]) => ReturnType<FakeTool["exec"]>)(c);
    }) as unknown as ReconcileDeps["exec"];
    const settle = deps.settle;
    deps.settle = (async (...a: Parameters<ReconcileDeps["settle"]>) => {
      order.push("settle");
      return settle(...a);
    }) as ReconcileDeps["settle"];
    await reconcileEmailSend(ACTION, target(), { finalPass: false }, deps);
    await vi.waitFor(() => expect(order).toContain("MAILCHIMP_GET_CAMPAIGN_CONTENT"));
    expect(order.indexOf("settle")).toBeLessThan(order.indexOf("MAILCHIMP_GET_CAMPAIGN_CONTENT"));
    never();
  });

  it("a worker that died mid-send (row abandoned in dispatching): the same read settles it", async () => {
    mc.campaigns[0].status = "sending";
    const r = await reconcileEmailSend(ACTION, target({ exec_status: "dispatching", exec_result: null, lease_expired: true }), { finalPass: false }, deps);
    expect(r.outcome).toBe("sent");
    expect(settled[0].ok).toBe(true);
    never();
  });

  it("a send cgo approved, confirmed here: the founder is told", async () => {
    mc.campaigns[0].status = "sent";
    mc.campaigns[0].sent = 800;
    await reconcileEmailSend(ACTION, target({ approved_by_source: "cgo" }), { finalPass: false }, deps);
    expect(notified).toEqual([expect.objectContaining({ action_id: ACTION, sent_to: 800, tool: "mailchimp" })]);
  });

  it("an Autopilot send that already settled: the founder is told (again, harmlessly), nothing is written or sent", async () => {
    mc.campaigns[0].status = "sent";
    mc.campaigns[0].sent = 640;
    const r = await reconcileEmailSend(ACTION, target({ exec_status: "executed", exec_result: {}, approved_by_source: "cgo" }), { finalPass: false }, deps);
    expect(r).toEqual({ done: true, outcome: "founder_told" });
    expect(notified).toEqual([expect.objectContaining({ action_id: ACTION, sent_to: 640 })]);
    expect(settled).toEqual([]);
    never();
  });

  it("telling the founder failed: the pass is not done, so a later pass tries again; the card stays executed", async () => {
    deps.notifyAutopilotSend = (async () => {
      throw new Error("queue down");
    }) as unknown as ReconcileDeps["notifyAutopilotSend"];
    expect(await reconcileEmailSend(ACTION, target({ exec_status: "executed", exec_result: {}, approved_by_source: "cgo" }), { finalPass: true }, deps)).toEqual({ done: false, outcome: "notify_failed" });
    mc.campaigns[0].status = "sent";
    mc.campaigns[0].sent = 300;
    expect(await reconcileEmailSend(ACTION, target({ approved_by_source: "cgo" }), { finalPass: false }, deps)).toEqual({ done: false, outcome: "notify_failed" });
    expect(settled).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("send requested, still a draft on the first look: waits, writes nothing", async () => {
    const r = await reconcileEmailSend(ACTION, target(), { finalPass: false }, deps);
    expect(r).toEqual({ done: false, outcome: "too_early" });
    expect(settled).toEqual([]);
  });

  it("send requested, still a draft on a later look: settled NOT sent, and never offered again", async () => {
    const r = await reconcileEmailSend(ACTION, target(), { finalPass: true }, deps);
    expect(r).toEqual({ done: true, outcome: "not_sent" });
    expect(settled[0]).toMatchObject({ ok: false, result: { code: "exec_partial", reconciled: true, not_sent: true } });
    expect(settled[0].error).toContain("was not sent");
    never();
  });

  it("must catch J3 (fail closed): a campaign no longer in the tool is not proof it never went, so no not_sent", async () => {
    mc.campaigns.length = 0;
    const r = await reconcileEmailSend(ACTION, target(), { finalPass: true }, deps);
    expect(r).toEqual({ done: true, outcome: "not_sent" });
    expect(settled[0].result).toMatchObject({ code: "exec_partial" });
    expect(settled[0].result).not.toHaveProperty("not_sent");
    expect(settled[0].error).not.toContain("was not sent");
    expect(settled[0].error).toContain("Zavi could not confirm whether this email went out.");
  });

  it("a campaign whose status the tool does not report never reads as not sent in the same breath as could not confirm", async () => {
    mc.campaigns[0].status = "";
    const r = await reconcileEmailSend(ACTION, target(), { finalPass: true }, deps);
    expect(r).toEqual({ done: true, outcome: "not_sent" });
    expect(settled[0].result).not.toHaveProperty("not_sent");
    expect(settled[0].error).toContain("Zavi could not confirm whether this email went out. It is in an unknown state in Mailchimp.");
    expect(settled[0].error).not.toMatch(/not sent/);
  });

  it("the worker died BEFORE the send was requested: nothing went out, and approving again is allowed", async () => {
    const r = await reconcileEmailSend(ACTION, target({ exec_status: "dispatching", exec_result: null, lease_expired: true, exec_progress: { campaign_id: "mc1", stage: "content_set" } }), { finalPass: false }, deps);
    expect(r).toEqual({ done: true, outcome: "interrupted" });
    expect(settled[0]).toMatchObject({ ok: false, result: { interrupted: true } });
    expect(settled[0].result).not.toHaveProperty("code");
    never();
  });

  it("a worker still holds the row: nothing is written under it", async () => {
    const r = await reconcileEmailSend(ACTION, target({ exec_status: "dispatching", exec_result: null, lease_expired: false }), { finalPass: true }, deps);
    expect(r).toEqual({ done: false, outcome: "in_flight" });
    expect(settled).toEqual([]);
    expect(mc.calls).toEqual([]);
  });

  const nothing: Array<[string, Partial<ReconcileTarget>]> = [
    ["already executed, sent by the founder", { exec_status: "executed", exec_result: {} }],
    ["a definite failure", { exec_status: "failed", exec_result: { code: "email_tool_refused" } }],
    ["never approved", { exec_status: null, exec_result: null }],
    ["another class", { exec_class: "meta_ads.set_status" }],
    ["no stored progress", { exec_progress: null }],
  ];
  for (const [name, over] of nothing) {
    it(`${name}: nothing to do, the tool is not even read`, async () => {
      const r = await reconcileEmailSend(ACTION, target(over), { finalPass: true }, deps);
      expect(r).toEqual({ done: true, outcome: "nothing_to_do" });
      expect(settled).toEqual([]);
      expect(mc.calls).toEqual([]);
    });
  }

  it("the tool cannot be read, or the connection changed: says nothing yet", async () => {
    deps.resolveAccount = (async () => null) as unknown as ReconcileDeps["resolveAccount"];
    expect(await reconcileEmailSend(ACTION, target(), { finalPass: true }, deps)).toEqual({ done: false, outcome: "could_not_read" });
    expect(settled).toEqual([]);
  });

  it("the last look still cannot read the tool (disconnected): ends with a plain 'could not check', never silence", async () => {
    deps.resolveAccount = (async () => null) as unknown as ReconcileDeps["resolveAccount"];
    const told: unknown[] = [];
    deps.tell = async (o) => void told.push(o);
    expect(await reconcileEmailSend(ACTION, target(), { finalPass: true, lastPass: false }, deps)).toEqual({ done: false, outcome: "could_not_read" });
    expect(settled).toEqual([]);
    const r = await reconcileEmailSend(ACTION, target(), { finalPass: true, lastPass: true }, deps);
    expect(r).toEqual({ done: true, outcome: "could_not_check" });
    expect(settled).toHaveLength(1);
    expect(settled[0].ok).toBe(false);
    expect(settled[0].result).toMatchObject({ code: "exec_partial", reconciled: true });
    expect(settled[0].result).not.toHaveProperty("not_sent");
    expect(settled[0].error).toBe("Zavi could not check Mailchimp to see whether this email went out: Mailchimp is no longer connected the way it was when this email was approved, or it did not answer. Zavi will not send this email again, so nobody gets it twice. Check it in Mailchimp.");
    expect(mc.calls).toEqual([]);
  });

  it("Klaviyo: an accepted send job behind a campaign still marked Draft counts as sent", async () => {
    const kv = fakeKlaviyo();
    kv.campaigns.push({ id: "KV1", title: `Zavi ${ACTION}`, list: "L1", status: "Draft", html: "x", sent: 0 });
    const realExec = kv.exec;
    deps.exec = (async (c: Parameters<FakeTool["exec"]>[0]) =>
      c.tool_slug === "KLAVIYO_GET_CAMPAIGN_SEND_JOB"
        ? { ok: true, status: 200, data: { data: { type: "campaign-send-job", id: "KV1", attributes: { status: "processing" } } }, error: null, outcome_unknown: false }
        : realExec(c)) as unknown as ReconcileDeps["exec"];
    const r = await reconcileEmailSend(ACTION, target({ exec_payload: payload("klaviyo"), exec_progress: { campaign_id: "KV1", stage: "send_requested" } }), { finalPass: false }, deps);
    expect(r.outcome).toBe("sent");
    expect(settled[0].result.receipt).toMatchObject({ line: "Klaviyo accepted this send for a list of 412 people. Delivery is not confirmed yet" });
    expect(kv.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(0);
  });

  it("an unknown outcome from before the send was requested (a status read that failed): sending to the sealed list settles sent", async () => {
    mc.campaigns[0].status = "sending";
    const r = await reconcileEmailSend(ACTION, target({ exec_progress: { campaign_id: "mc1", stage: "content_set" } }), { finalPass: false }, deps);
    expect(r).toEqual({ done: true, outcome: "sent" });
    never();
  });

  it("the same, but the campaign is going to another list: exec_partial, alerted, no outcome email, never 'sent'", async () => {
    mc.campaigns[0].status = "sending";
    mc.campaigns[0].list = "L2";
    const alerts: string[] = [];
    const told: unknown[] = [];
    const r = await reconcileEmailSend(ACTION, target({ exec_progress: { campaign_id: "mc1", stage: "content_set" } }), { finalPass: false }, {
      ...deps,
      reportAudience: async (_t, id) => {
        alerts.push(id);
      },
      tell: async (o) => told.push(o),
    });
    expect(r).toEqual({ done: true, outcome: "audience_mismatch" });
    expect(settled).toEqual([{ ok: false, result: expect.objectContaining({ code: "exec_partial", audience_mismatch: true, reconciled: true }), error: expect.stringMatching(/different list/) }]);
    expect(alerts).toEqual([ACTION]);
    expect(told).toEqual([]);
    never();
  });

});
