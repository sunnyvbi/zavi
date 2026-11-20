import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { executeEmailCampaignSend, type EmailSendDeps, type EmailSendRow } from "../execute-send";
import { reconcileEmailSend, type ReconcileDeps } from "../reconcile";
import { accountHeldReason, EmailToolError, isKeyRejected, keyRejectedText } from "../provider-errors";
import type { ExecProgress } from "@/services/channels/exec-progress";
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { founderSendError } from "@/services/email-cards/cards";
import { fakeMailchimp, type FakeTool } from "./fake-tools";

const TENANT = "tenant-a";
const ACTION = "22222222-2222-4222-8222-222222222222";

const body = {
  tool: "mailchimp",
  connected_account_id: "ca-mailchimp",
  auth_config_id: "ac-mailchimp",
  audience_id: "L1",
  audience_name: "Newsletter",
  audience_count: 412,
  subject: "Spring offer",
  preview_text: "Two weeks only",
  body_text: "Hello",
  from_name: "Acme",
  from_email: "hi@acme.test",
  reply_to: null,
};

type Call = Parameters<FakeTool["exec"]>[0];
type Wrap = (c: Call, real: () => Promise<ComposioExecResult>) => Promise<ComposioExecResult>;

const RAW = ["HTTP 500", "Error: connect ECONNREFUSED 10.0.12.4:443", "Invalid API key 3f9a…7c-us21", "Request failed with status code 500"];

let mc: FakeTool;
let warn: MockInstance<Parameters<typeof console.warn>, void>;
beforeEach(() => {
  mc = fakeMailchimp();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

function harness(wrap: Wrap = (_c, real) => real()) {
  const progress: { value: ExecProgress | null; writes: ExecProgress[] } = { value: null, writes: [] };
  const reconciles: string[] = [];
  const notified: unknown[] = [];
  const deps: EmailSendDeps = {
    resolveAccount: (async (_t: string, tool: string) => ({ tenant_id: TENANT, toolkit: tool, connected_account_id: `ca-${tool}`, auth_config_id: `ac-${tool}` })) as unknown as EmailSendDeps["resolveAccount"],
    exec: (async (c: Call) => wrap(c, () => mc.exec(c))) as unknown as EmailSendDeps["exec"],
    readProgress: async () => progress.value,
    recordProgress: async (_t, _a, _c, p) => {
      progress.value = p;
      progress.writes.push(p);
      return true;
    },
    scheduleReconcile: async (id) => {
      reconciles.push(id);
    },
    authorizeCgo: async () => ({ verdict: "allow", reasons: [] }),
    notifyAutopilotSend: (async (_t: string, s: unknown) => {
      notified.push(s);
      return true;
    }) as unknown as EmailSendDeps["notifyAutopilotSend"],
    sleep: async () => undefined,
    recordSendRef: async () => true,
    paused: async () => false,
  };
  return { deps, progress, reconciles, notified };
}

const decisionsRow = (): EmailSendRow => ({ id: ACTION, tenant_id: TENANT, body, approved_by_source: null });
const channelRow = (): EmailSendRow => ({ id: ACTION, tenant_id: TENANT, body, approved_by_source: null, exec_source: "channel_actions", claim_id: "claim-1" });

const onSend = (fn: (c: Call, real: () => Promise<ComposioExecResult>) => Promise<ComposioExecResult>): Wrap => (c, real) =>
  c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN" ? fn(c, real) : real();

const holdAs = (status: string, sent = 0): Wrap =>
  onSend(async (c) => {
    mc.calls.push(c);
    const camp = mc.campaigns.find((x) => x.id === c.arguments.campaign_id)!;
    camp.status = status;
    camp.sent = sent;
    return { ok: true, status: 200, data: {}, error: null, outcome_unknown: false };
  });

function expectNotSent(r: Awaited<ReturnType<typeof executeEmailCampaignSend>>, h: ReturnType<typeof harness>) {
  expect(r.ok).toBe(false);
  expect(r.receipt).toBeUndefined();
  expect(r.sent_to).toBeUndefined();
  expect(r.notice).toBeUndefined();
  expect(h.progress.writes.map((p) => p.stage)).not.toContain("sent");
  expect(h.notified).toEqual([]);
  expect(String(r.error)).not.toMatch(/^Sent to/);
  expect(founderSendError(r.error)).toBe(r.error);
}

describe("a Mailchimp send is reported Sent only when Mailchimp shows it going out", () => {
  it("send accepted but the campaign stays in save (decisions rail): not Sent, the founder is told to check the account", async () => {
    const h = harness(holdAs("save"));
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expectNotSent(r, h);
    expect(r.outcome_unknown).toBe(true);
    expect(r.error).toContain("It is still a draft");
    expect(r.error).toContain("compliance review");
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
    expect(mc.count("MAILCHIMP_GET_CAMPAIGN_INFO")).toBeGreaterThanOrEqual(3);
  });

  it("send accepted but Mailchimp paused it: not Sent, and the card names the state", async () => {
    const h = harness(holdAs("paused"));
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expectNotSent(r, h);
    expect(r.error).toContain("It is paused");
  });

  it("campaign marked sent with 0 emails sent: not Sent", async () => {
    const h = harness(holdAs("sent", 0));
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expectNotSent(r, h);
    expect(r.error).toContain("0 emails sent");
  });

  it("channel rail, campaign stays in save: an unknown outcome handed to reconcile, never Sent", async () => {
    const h = harness(holdAs("save"));
    const r = await executeEmailCampaignSend(channelRow(), h.deps);
    expectNotSent(r, h);
    expect(r).toMatchObject({ code: "exec_outcome_unknown", outcome_unknown: true });
    expect(h.reconciles).toContain(ACTION);
  });

  it("a real send with emails going out is still Sent", async () => {
    const h = harness();
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expect(r.ok).toBe(true);
    expect(r.receipt?.line).toBe("Mailchimp accepted this send for a list of 412 people. Delivery is not confirmed yet");
  });
});

describe("Mailchimp refusing inside a successful Composio answer, or holding the account", () => {
  it("a problem document in data around ok:true (compliance review) is a refusal, not a send", async () => {
    const h = harness(
      onSend(async (c) => {
        mc.calls.push(c);
        return {
          ok: true,
          status: 200,
          data: { type: "https://mailchimp.com/developer/marketing/docs/errors/", title: "Compliance Review", status: 403, detail: "Your account is under compliance review and cannot send.", instance: "x" },
          error: null,
          outcome_unknown: false,
        };
      }),
    );
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expectNotSent(r, h);
    expect(r.outcome_unknown).toBeFalsy();
    expect(r.error).toBe(
      "Mailchimp refused to send this: your Mailchimp account is on hold, suspended or under a compliance review; check your account status and any message from Mailchimp, then approve it again. Nothing was sent. The draft is in Mailchimp; send it from there, or ask Zavi for a new one.",
    );
    expect(r.not_sent).toBe(true);
    expect(mc.campaigns[0].status).toBe("save");
  });

  it("a nested successful:false in data is a refusal", async () => {
    const h = harness(
      onSend(async (c) => {
        mc.calls.push(c);
        return { ok: true, status: 200, data: { data: { successful: false, error: "Your Campaign is not ready to send." } }, error: null, outcome_unknown: false };
      }),
    );
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expectNotSent(r, h);
    expect(r.error).toMatch(/^Mailchimp refused to send this: Your Campaign is not ready to send\. Nothing was sent\./);
  });

  it("a suspended account on a pre-send step gets the plain account sentence", async () => {
    mc.refuse.set("MAILCHIMP_ADD_CAMPAIGN", "This account has been suspended. Contact Mailchimp support.");
    const h = harness();
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expectNotSent(r, h);
    expect(r.error).toBe(
      "Mailchimp did not accept this: your Mailchimp account is on hold, suspended or under a compliance review; check your account status and any message from Mailchimp, then approve it again. Nothing was sent.",
    );
    expect(r.error).not.toContain("support");
  });
});

describe("a 401, or a 403 about the key or its permissions, reads as a rejected key; an account hold never does", () => {
  const answering = (status: number, error: string): Wrap => async (c) => {
    mc.calls.push(c);
    return { ok: false, status, data: null, error, outcome_unknown: false };
  };

  for (const msg of ["User does not have access to the requested operation", "You do not have permission to access this resource"]) {
    it(`403 "${msg}" is a rejected key`, async () => {
      const h = harness(answering(403, msg));
      const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
      expect(r.ok).toBe(false);
      expect(r.error).toBe(keyRejectedText("Mailchimp"));
      expect(r.code).toBe("email_tool_refused");
      expect(founderSendError(r.error)).toBe(r.error);
    });
  }

  for (const msg of ["This account is under compliance review", "Forbidden: your account has been suspended"]) {
    it(`403 "${msg}" is not a rejected key`, async () => {
      const h = harness(answering(403, msg));
      const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
      expect(r.ok).toBe(false);
      expect(r.error).not.toBe(keyRejectedText("Mailchimp"));
      expect(r.error).not.toMatch(/rejected the key|disconnect Mailchimp/);
      expect(r.code).toBe("email_tool_refused");
      expect(founderSendError(r.error)).toBe(r.error);
    });
  }

  for (const msg of ["Forbidden", "403 Client Error: Forbidden for url: https://us21.api.mailchimp.com/3.0/campaigns", "Unauthorized action", "Not allowed"]) {
    it(`a bare 403 "${msg}" is not a rejected key`, async () => {
      const h = harness(answering(403, msg));
      const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
      expect(r.ok).toBe(false);
      expect(r.error).not.toMatch(/rejected the key|disconnect Mailchimp/);
      expect(r.code).toBe("email_tool_refused");
      expect(founderSendError(r.error)).toBe(r.error);
    });
  }

  it("a compliance-review 403 that Composio wraps as HTTP 200 says the account is held, never a rejected key", async () => {
    const h = harness(async (c) => {
      mc.calls.push(c);
      return {
        ok: false,
        status: 200,
        data: { status_code: 403, title: "Forbidden", detail: "This account is currently under compliance review." },
        error: "403 Client Error: Forbidden for url: https://us21.api.mailchimp.com/3.0/lists/L1",
        outcome_unknown: false,
      };
    });
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(accountHeldReason("Mailchimp"));
    expect(r.error).not.toMatch(/rejected the key|disconnect Mailchimp|Reconnect/);
    expect(founderSendError(r.error)).toBe(r.error);
  });

  it("a compliance-review 403 on the send itself, wrapped as HTTP 200, says the account is held", async () => {
    const h = harness(
      onSend(async (c) => {
        mc.calls.push(c);
        return {
          ok: false,
          status: 200,
          data: { status_code: 403, title: "Forbidden", detail: "This account is currently under compliance review." },
          error: "403 Client Error: Forbidden for url: https://us21.api.mailchimp.com/3.0/campaigns/x/actions/send",
          outcome_unknown: false,
        };
      }),
    );
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(accountHeldReason("Mailchimp"));
    expect(r.error).not.toMatch(/rejected the key|disconnect Mailchimp/);
  });

  it("401 with any body is a rejected key", async () => {
    const h = harness(answering(401, "Unauthorized"));
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expect(r.error).toBe(keyRejectedText("Mailchimp"));
  });

  it("403 that says the API key is invalid is a rejected key", async () => {
    const h = harness(answering(403, '{"title":"API Key Invalid","status":403,"detail":"Your API key may be invalid, or you have attempted to access the wrong datacenter."}'));
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expect(r.error).toBe(keyRejectedText("Mailchimp"));
  });

  it("isKeyRejected at the unit: a 403 needs key or permission words and no account hold; 401 is always true", () => {
    expect(isKeyRejected(new EmailToolError("Forbidden", false, 403))).toBe(false);
    expect(isKeyRejected(new EmailToolError("403 Client Error: Forbidden for url: https://x", false, 403))).toBe(false);
    expect(isKeyRejected(new EmailToolError("Unauthorized", false, 403))).toBe(false);
    expect(isKeyRejected(new EmailToolError("Missing scope campaigns:write", false, 403))).toBe(true);
    expect(isKeyRejected(new EmailToolError("access forbidden", false, 403))).toBe(false);
    expect(isKeyRejected(new EmailToolError("403 Client Error: Forbidden", false, 403, null, "You do not have permission to access this resource."))).toBe(true);
    expect(isKeyRejected(new EmailToolError("403 Client Error: Forbidden", false, 403, null, "This account is currently under compliance review."))).toBe(false);
    expect(isKeyRejected(new EmailToolError("You do not have permission", false, 403, null, "Your account has been suspended."))).toBe(false);
    expect(isKeyRejected(new EmailToolError("Client Error", false, 403))).toBe(false);
    expect(isKeyRejected(new EmailToolError("Forbidden: account under compliance review", false, 403))).toBe(false);
    expect(isKeyRejected(new EmailToolError("You do not have permission", false, 400))).toBe(false);
    expect(isKeyRejected(new EmailToolError("Your account has been suspended", false, 403))).toBe(false);
    expect(isKeyRejected(new EmailToolError("Forbidden", false, 401))).toBe(true);
    expect(isKeyRejected(new EmailToolError("The API key provided is invalid", false, 403))).toBe(true);
  });
});

describe("raw provider text never reaches the founder", () => {
  for (const raw of RAW) {
    it(`send refused with "${raw}"`, async () => {
      const h = harness(
        onSend(async (c) => {
          mc.calls.push(c);
          return { ok: false, status: 400, data: null, error: raw, outcome_unknown: false };
        }),
      );
      const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
      expect(r.ok).toBe(false);
      for (const bad of RAW) expect(String(r.error)).not.toContain(bad);
      expect(String(r.error)).not.toMatch(/HTTP|ECONNREFUSED|status code|3f9a/);
      expect(r.error).toBe("Mailchimp refused to send this. Nothing was sent. The draft is in Mailchimp; send it from there, or ask Zavi for a new one.");
      expect(founderSendError(r.error)).toBe(r.error);
      expect(warn.mock.calls.flat().join(" ")).toContain(raw.slice(0, 8));
    });

    it(`pre-send step refused with "${raw}."`, async () => {
      mc.refuse.set("MAILCHIMP_SET_CAMPAIGN_CONTENT", `${raw}.`);
      const h = harness();
      const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
      expect(r.ok).toBe(false);
      for (const bad of RAW) expect(String(r.error)).not.toContain(bad);
      expect(r.error).toBe("Mailchimp did not accept this email. Nothing was sent.");
      expect(founderSendError(r.error)).toBe(r.error);
    });
  }

  it("a 500 with no body text does not say HTTP 500", async () => {
    const h = harness(
      onSend(async (c) => {
        mc.calls.push(c);
        return { ok: false, status: 500, data: null, error: null, outcome_unknown: false };
      }),
    );
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expect(String(r.error)).not.toContain("HTTP 500");
  });
});

describe("reconcile never settles a sent-with-zero-emails campaign as Sent", () => {
  const target = () => ({
    tenant_id: TENANT,
    exec_class: "email_campaign.create_and_send",
    exec_status: "failed",
    exec_payload: body,
    exec_result: { code: "exec_outcome_unknown" },
    exec_progress: { campaign_id: "mc1", stage: "send_requested" },
    approved_by_source: null,
    lease_expired: false,
  });

  function rdeps() {
    const settled: Array<{ ok: boolean; result: Record<string, unknown>; error?: string | null }> = [];
    const told: unknown[] = [];
    const deps: ReconcileDeps = {
      resolveAccount: (async (tenant: string, tool: string) => ({ tenant_id: tenant, toolkit: tool, connected_account_id: `ca-${tool}`, auth_config_id: `ac-${tool}` })) as unknown as ReconcileDeps["resolveAccount"],
      exec: ((c: Call) => mc.exec(c)) as unknown as ReconcileDeps["exec"],
      settle: (async (_t: string, a: { ok: boolean; result: Record<string, unknown>; error?: string | null }) => {
        settled.push({ ok: a.ok, result: a.result, error: a.error });
        return { ok: true, replayed: false };
      }) as unknown as ReconcileDeps["settle"],
      notifyAutopilotSend: (async () => true) as unknown as ReconcileDeps["notifyAutopilotSend"],
      tell: async (o) => {
        told.push(o);
      },
    };
    return { deps, settled, told };
  }

  it("not the final pass: left for later, nothing settled", async () => {
    mc.campaigns.push({ id: "mc1", title: `Zavi ${ACTION}`, list: "L1", status: "sent", html: "x", sent: 0 });
    const d = rdeps();
    const r = await reconcileEmailSend(ACTION, target() as never, { finalPass: false }, d.deps);
    expect(r).toEqual({ done: false, outcome: "too_early" });
    expect(d.settled).toEqual([]);
  });

  it("final pass: settled not ok with the plain sentence, never a receipt", async () => {
    mc.campaigns.push({ id: "mc1", title: `Zavi ${ACTION}`, list: "L1", status: "sent", html: "x", sent: 0 });
    const d = rdeps();
    const r = await reconcileEmailSend(ACTION, target() as never, { finalPass: true }, d.deps);
    expect(r.outcome).toBe("not_sent");
    expect(d.settled).toHaveLength(1);
    expect(d.settled[0].ok).toBe(false);
    expect(d.settled[0].result.receipt).toBeUndefined();
    expect(d.settled[0].error).toContain("0 emails sent");
    expect(founderSendError(d.settled[0].error)).toBe(d.settled[0].error);
  });
});

describe("a key revoked between the pre-send reads and the send itself", () => {
  const refuseSend = (r: ComposioExecResult): Wrap =>
    onSend(async (c) => {
      mc.calls.push(c);
      return r;
    });

  it.each<[string, ComposioExecResult]>([
    ["a plain 401", { ok: false, status: 401, data: null, error: "Unauthorized", outcome_unknown: false }],
    ["a wrapped 401 (HTTP 200, vendor code in data)", { ok: false, status: 200, data: { status_code: 401, message: "401 Client Error: Unauthorized" }, error: "401 Client Error: Unauthorized", outcome_unknown: false }],
    ["a 403 for a missing permission", { ok: false, status: 403, data: null, error: "You do not have permission to send campaigns", outcome_unknown: false }],
  ])("%s on the send gets the reconnect sentence, and the draft is still freed", async (_n, answer) => {
    const h = harness(refuseSend(answer));
    const r = await executeEmailCampaignSend(channelRow(), h.deps);
    expectNotSent(r, h);
    expect(r.error).toBe(keyRejectedText("Mailchimp"));
    expect(r).toMatchObject({ code: "exec_partial", not_sent: true });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
  });

  it("a 403 account hold on the send is not called a rejected key", async () => {
    const h = harness(refuseSend({ ok: false, status: 403, data: null, error: "Your account has been suspended", outcome_unknown: false }));
    const r = await executeEmailCampaignSend(channelRow(), h.deps);
    expect(r.error).not.toMatch(/rejected the key/);
    expect(r.error).toMatch(/on hold, suspended or under a compliance review/);
  });
});

describe("the confirm reads keep going while Mailchimp still reports 0 emails sent", () => {
  it("sent with 0 on the first read, then the count arrives: Sent, from the later read", async () => {
    let sendDone = false;
    let readsAfter = 0;
    const h = harness(async (c, real) => {
      if (c.tool_slug === "MAILCHIMP_SEND_CAMPAIGN") {
        mc.calls.push(c);
        const camp = mc.campaigns.find((x) => x.id === c.arguments.campaign_id)!;
        camp.status = "sent";
        camp.sent = 0;
        sendDone = true;
        return { ok: true, status: 200, data: {}, error: null, outcome_unknown: false };
      }
      const r = await real();
      if (sendDone && c.tool_slug === "MAILCHIMP_GET_CAMPAIGN_INFO" && ++readsAfter === 1) mc.campaigns.find((x) => x.id === c.arguments.campaign_id)!.sent = 412;
      return r;
    });
    const r = await executeEmailCampaignSend(decisionsRow(), h.deps);
    expect(r.ok).toBe(true);
    expect(r.receipt?.line).toBe("Mailchimp accepted this send for a list of 412 people. Delivery is not confirmed yet");
    expect(readsAfter).toBe(2);
  });
});

describe("a campaign found by title, marked sent with 0 emails, before any progress row exists", () => {
  it("records the campaign as send_requested so reconcile can settle it, never nothing_to_do", async () => {
    const h = harness();
    const r0 = await executeEmailCampaignSend(channelRow(), harness().deps);
    expect(r0.ok).toBe(true);
    const title = mc.campaigns[0].title;
    mc = fakeMailchimp();
    mc.campaigns.push({ id: "mc9", title, list: "L1", status: "sent", html: "x", sent: 0 });
    const r = await executeEmailCampaignSend(channelRow(), h.deps);
    expectNotSent(r, h);
    expect(r).toMatchObject({ code: "exec_outcome_unknown", outcome_unknown: true });
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(h.progress.value).toEqual({ campaign_id: "mc9", stage: "send_requested" });
    expect(h.reconciles).toContain(ACTION);
    const settled: Array<{ ok: boolean }> = [];
    const target = { tenant_id: TENANT, exec_class: "email_campaign.create_and_send", exec_status: "failed", exec_payload: body, exec_result: { code: "exec_outcome_unknown" }, exec_progress: h.progress.value, approved_by_source: null, lease_expired: false };
    const deps = {
      resolveAccount: (async (tenant: string, tool: string) => ({ tenant_id: tenant, toolkit: tool, connected_account_id: `ca-${tool}`, auth_config_id: `ac-${tool}` })) as unknown as ReconcileDeps["resolveAccount"],
      exec: ((c: Call) => mc.exec(c)) as unknown as ReconcileDeps["exec"],
      settle: (async (_t: string, a: { ok: boolean }) => {
        settled.push({ ok: a.ok });
        return { ok: true, replayed: false };
      }) as unknown as ReconcileDeps["settle"],
      notifyAutopilotSend: (async () => true) as unknown as ReconcileDeps["notifyAutopilotSend"],
      tell: async () => undefined,
    } satisfies ReconcileDeps;
    expect(await reconcileEmailSend(ACTION, target as never, { finalPass: false }, deps)).toEqual({ done: false, outcome: "too_early" });
    expect(await reconcileEmailSend(ACTION, target as never, { finalPass: true }, deps)).toEqual({ done: true, outcome: "not_sent" });
    expect(settled).toEqual([{ ok: false }]);
  });
});

describe("a campaign found by title, marked sent with 0 emails, on another list", () => {
  it("is an audience mismatch at once, and reconcile never settles it as Sent once its count goes up", async () => {
    const r0 = await executeEmailCampaignSend(channelRow(), harness().deps);
    expect(r0.ok).toBe(true);
    const title = mc.campaigns[0].title;
    mc = fakeMailchimp();
    mc.campaigns.push({ id: "mc9", title, list: "L2", status: "sent", html: "x", sent: 0 });
    const h = harness();
    const reported: string[] = [];
    h.deps.reportAudience = async (_t, id) => {
      reported.push(id);
    };
    const r = await executeEmailCampaignSend(channelRow(), h.deps);
    expect(r).toMatchObject({ ok: false, code: "exec_partial", audience_mismatch: true });
    expect(r.receipt).toBeUndefined();
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
    expect(reported).toEqual([ACTION]);
    expect(h.progress.writes.some((p) => p.stage === "send_requested" || p.stage === "sent")).toBe(false);

    mc.campaigns[0].sent = 412;
    const settled: Array<{ ok: boolean; result: Record<string, unknown> }> = [];
    const told: Array<{ outcome?: string; kind?: string }> = [];
    const deps = {
      resolveAccount: (async (tenant: string, tool: string) => ({ tenant_id: tenant, toolkit: tool, connected_account_id: `ca-${tool}`, auth_config_id: `ac-${tool}` })) as unknown as ReconcileDeps["resolveAccount"],
      exec: ((c: Call) => mc.exec(c)) as unknown as ReconcileDeps["exec"],
      settle: (async (_t: string, a: { ok: boolean; result: Record<string, unknown> }) => {
        settled.push({ ok: a.ok, result: a.result });
        return { ok: true, replayed: false };
      }) as unknown as ReconcileDeps["settle"],
      notifyAutopilotSend: (async () => true) as unknown as ReconcileDeps["notifyAutopilotSend"],
      tell: async (o: { outcome?: string; kind?: string }) => {
        told.push(o);
      },
      reportAudience: async () => undefined,
    } satisfies ReconcileDeps;
    const unsettled = {
      tenant_id: TENANT,
      exec_class: "email_campaign.create_and_send",
      exec_status: "failed",
      exec_payload: body,
      exec_result: { code: "exec_outcome_unknown" },
      exec_progress: h.progress.value ?? { campaign_id: "mc9", stage: "content_set" },
      approved_by_source: null,
      lease_expired: false,
    };
    const out = await reconcileEmailSend(ACTION, unsettled as never, { finalPass: true }, deps);
    expect(out).toEqual({ done: true, outcome: "audience_mismatch" });
    expect(settled.every((s) => !s.ok && !s.result.receipt)).toBe(true);
    expect(told.some((t) => t.outcome === "sent")).toBe(false);
  });
});

describe("Zavi's own campaign, found by its stored id, read back sent with 0 emails and no list", () => {
  for (const [name, camp] of [
    ["no list in the read-back", { list: "" }],
    ["a narrowed read-back of the card's own list", { list: "L1", narrowedBy: "7" }],
  ] as const) {
    it(`${name}: an unknown outcome left to reconcile, never an audience mismatch`, async () => {
      mc.campaigns.push({ id: "mc1", title: `Zavi ${ACTION}`, status: "sent", html: "x", sent: 0, ...camp } as never);
      const h = harness();
      h.progress.value = { campaign_id: "mc1", stage: "content_set" };
      const reported: string[] = [];
      h.deps.reportAudience = async (_t, id) => {
        reported.push(id);
      };
      const r = await executeEmailCampaignSend(channelRow(), h.deps);
      expect(r).toMatchObject({ code: "exec_outcome_unknown", outcome_unknown: true });
      expect((r as { audience_mismatch?: boolean }).audience_mismatch).toBeUndefined();
      expect(r.error).not.toMatch(/different list/);
      expect(reported).toEqual([]);
      expect(mc.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
      expect(h.progress.value).toEqual({ campaign_id: "mc1", stage: "send_requested" });
      expect(h.reconciles).toContain(ACTION);
    });
  }
});
