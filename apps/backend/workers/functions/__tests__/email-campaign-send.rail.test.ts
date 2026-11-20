
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient must not be reached: every door is injected");
  },
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({ id: "fn" }), send: vi.fn() } }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: vi.fn(async () => null), planIncludesChannel: vi.fn(async () => true) }));

import { executeChannelAction, type ExecHandler } from "../dispatch-channel-action";
import { runExecReconcilePass } from "../reconcile-channel-action-exec";
import { executeEmailCampaignSend, type EmailSendDeps } from "@/services/connectors/email-campaign/execute-send";
import { reconcileEmailSend, type ReconcileDeps } from "@/services/connectors/email-campaign/reconcile";
import { fakeKlaviyo, fakeMailchimp, type FakeTool } from "@/services/connectors/email-campaign/__tests__/fake-tools";
import { toActionView } from "@/services/channels/channel-actions";
import { verdictFor } from "@/services/channels/exec-failure";
import { isPartialRiskExecCode } from "@zavi/shared";
import type { ExecProgress } from "@/services/channels/exec-progress";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTION = "99999999-9999-4999-8999-999999999999";
const LEASE_MS = 10 * 60_000;
let nowMs = 1_700_000_000_000;

type Row = {
  tenant_id: string;
  status: "pending" | "acted";
  exec_class: string;
  exec_payload: Record<string, unknown>;
  exec_status: null | "queued" | "dispatching" | "executed" | "failed";
  exec_result: Record<string, unknown> | null;
  exec_progress: ExecProgress | null;
  exec_claim_id: string | null;
  exec_claimed_at: number | null;
  approved_by_source: string | null;
  note: string | null;
};

const payload = (tool: "mailchimp" | "klaviyo") => ({
  tool, connected_account_id: `ca-${tool}`, auth_config_id: `ac-${tool}`, audience_id: "L1", audience_name: "Newsletter", audience_count: 412,
  subject: "Spring offer", preview_text: null, body_text: "Hello", from_name: "Acme", from_email: "hi@acme.test", reply_to: null,
});

function newRow(tool: "mailchimp" | "klaviyo", over: Partial<Row> = {}): Row {
  return {
    tenant_id: TENANT, status: "pending", exec_class: "email_campaign.create_and_send", exec_payload: payload(tool),
    exec_status: null, exec_result: null, exec_progress: null, exec_claim_id: null, exec_claimed_at: null, approved_by_source: null, note: null, ...over,
  };
}

function approve(row: Row): { ok: boolean; code?: string } {
  if (row.exec_status === "queued" || row.exec_status === "dispatching") return { ok: true };
  if (row.exec_status === "executed") return { ok: false, code: "already_executed" };
  if (row.exec_status === "failed" && (isPartialRiskExecCode(row.exec_result?.code) || row.exec_result?.bucket === "partial_risk")) {
    return { ok: false, code: "exec_partial_no_retry" };
  }
  row.exec_status = "queued";
  row.exec_result = null;
  row.exec_claim_id = null;
  row.exec_claimed_at = null;
  return { ok: true };
}

let claimSeq = 0;
let tool: FakeTool;

function rail(row: Row, over: Partial<EmailSendDeps> = {}) {
  const sendDeps: EmailSendDeps = {
    resolveAccount: (async (tenant: string, kit: string) => ({ tenant_id: tenant, toolkit: kit, connected_account_id: `ca-${kit}`, auth_config_id: `ac-${kit}` })) as unknown as EmailSendDeps["resolveAccount"],
    exec: ((c: Parameters<FakeTool["exec"]>[0]) => tool.exec(c)) as unknown as EmailSendDeps["exec"],
    readProgress: async () => row.exec_progress,
    recordProgress: async (_t, _a, claim, p) => {
      if (row.exec_status !== "dispatching" || row.exec_claim_id !== claim) return false;
      row.exec_progress = p;
      return true;
    },
    scheduleReconcile: async () => undefined,
    authorizeCgo: async () => ({ verdict: "allow", reasons: [] }),
    notifyAutopilotSend: async () => true,
    sleep: async () => undefined,
    paused: async () => false,
    ...over,
  };
  const handler: ExecHandler = (d) => executeEmailCampaignSend(d, sendDeps);
  const deps = {
    claim: async () => {
      if (row.exec_status === "queued") {
        row.exec_status = "dispatching";
        row.exec_claim_id = `claim-${++claimSeq}`;
        row.exec_claimed_at = nowMs;
        return {
          ok: true as const,
          row: {
            claim_id: row.exec_claim_id, tenant_id: row.tenant_id, channel_slug: "email_marketing", exec_class: row.exec_class,
            exec_payload: row.exec_payload, approved_by: "founder-1", approved_by_source: row.approved_by_source, agent_run_id: "run-1",
          },
        };
      }
      return {
        ok: false as const, code: "not_queued" as const, tenant_id: row.tenant_id, exec_status: row.exec_status,
        lease_expired: row.exec_status === "dispatching" && (row.exec_claimed_at === null || row.exec_claimed_at < nowMs - LEASE_MS),
      };
    },
    settle: async (_t: string, a: { ok: boolean; error?: string | null; result?: Record<string, unknown>; claimId?: string | null; execClass: string }) => {
      const owner = !!a.claimId && row.exec_claim_id === a.claimId;
      if (row.exec_status !== "dispatching") return { ok: false, code: "not_dispatching", replayed: false };
      if (!owner && (a.ok || (row.exec_claimed_at ?? 0) >= nowMs - LEASE_MS)) return { ok: false, code: a.ok ? "not_owner" : "lease_held", replayed: false };
      const verdict = a.ok ? null : verdictFor(a.result ?? {}, a.execClass);
      row.exec_status = a.ok ? "executed" : "failed";
      row.exec_result = { ...(a.result ?? {}), ...(verdict ? { bucket: verdict.bucket, fix: verdict.fix } : {}) };
      if (a.ok) row.status = "acted";
      row.note = a.error ?? null;
      return { ok: true, code: undefined, replayed: false };
    },
    loadHandler: async () => handler,
    writeEnabled: async () => true,
    channelLock: async () => null,
    execClassOf: async () => row.exec_class,
    releaseClaim: async () => false,
    tenantDisabled: async () => false,
  };
  const reconcileDeps: ReconcileDeps = {
    resolveAccount: sendDeps.resolveAccount,
    exec: sendDeps.exec,
    settle: (async (_t: string, a: { ok: boolean; result: Record<string, unknown>; error?: string | null }) => {
      const unknown = row.exec_status === "failed" && row.exec_result?.code === "exec_outcome_unknown";
      const dead = row.exec_status === "dispatching" && (row.exec_claimed_at === null || row.exec_claimed_at < nowMs - LEASE_MS);
      if (!row.exec_progress || !(unknown || dead)) return { ok: false, code: "not_unknown", replayed: false };
      const verdict = a.ok ? null : verdictFor(a.result, row.exec_class);
      row.exec_status = a.ok ? "executed" : "failed";
      row.exec_result = { ...a.result, ...(verdict ? { bucket: verdict.bucket, fix: verdict.fix } : {}) };
      if (a.ok) row.status = "acted";
      row.note = a.error ?? null;
      return { ok: true, replayed: false };
    }) as unknown as ReconcileDeps["settle"],
    notifyAutopilotSend: (async () => true) as unknown as ReconcileDeps["notifyAutopilotSend"],
  };
  const reconcile = (pass: number) =>
    runExecReconcilePass(ACTION, pass, {
      readRow: async () => ({
        tenant_id: row.tenant_id, exec_class: row.exec_class, exec_status: row.exec_status, exec_result: row.exec_result, exec_payload: row.exec_payload,
        exec_progress: row.exec_progress, approved_by_source: row.approved_by_source,
        lease_expired: row.exec_status === "dispatching" && (row.exec_claimed_at === null || row.exec_claimed_at < nowMs - LEASE_MS),
      }),
      reconcile: (id, t, opts) => reconcileEmailSend(id, t, opts, reconcileDeps),
    });
  return { run: () => executeChannelAction(ACTION, deps as never), reconcile, sendDeps };
}

const wire = (row: Row) =>
  toActionView(
    {
      id: ACTION, channel_slug: "email_marketing", run_id: "run-1", position: 1, run_of: 1, blocking: false, action_type: "send_message",
      title: 'Send "Spring offer" to Newsletter', body: {}, status: row.status, note: row.note, snoozed_until: null, impact: null, impact_reason: null,
      proposed_at: "2026-10-07T00:00:00Z", repeat_of: null, redo_of: null,
      exec_class: row.exec_class, exec_payload: row.exec_payload, exec_status: row.exec_status, exec_result: row.exec_result,
    } as never,
    1,
    {},
  );

beforeEach(() => {
  nowMs = 1_700_000_000_000;
  claimSeq = 0;
});

describe("approving the card sends the email, and the card says so", () => {
  it("Mailchimp: one campaign created, filled and sent; the wire serves the receipt line and link", async () => {
    tool = fakeMailchimp();
    const row = newRow("mailchimp");
    approve(row);
    const out = await rail(row).run();
    expect(out.ok).toBe(true);
    expect(tool.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(1);
    expect(tool.count("MAILCHIMP_SET_CAMPAIGN_CONTENT")).toBe(1);
    expect(tool.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
    const card = wire(row);
    expect(card.exec_status).toBe("executed");
    expect(card.exec_receipt?.line).toBe("Mailchimp accepted this send for a list of 412 people. Delivery is not confirmed yet");
    expect(card.exec_receipt?.url).toMatch(/^https:\/\/admin\.mailchimp\.com\//);
  });

  it("Klaviyo: the same, through its send job", async () => {
    tool = fakeKlaviyo([{ id: "L1", name: "Newsletter", members: 412 }]);
    const row = newRow("klaviyo");
    approve(row);
    expect((await rail(row).run()).ok).toBe(true);
    expect(tool.count("KLAVIYO_CREATE_CAMPAIGN")).toBe(1);
    expect(tool.count("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB")).toBe(1);
    expect(wire(row).exec_receipt?.line).toBe("Klaviyo accepted this send for a list of 412 people. Delivery is not confirmed yet");
  });

  it("a second delivery of the same approval sends nothing more", async () => {
    tool = fakeMailchimp();
    const row = newRow("mailchimp");
    approve(row);
    const r = rail(row);
    await r.run();
    await r.run();
    expect(tool.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
    expect(tool.campaigns).toHaveLength(1);
  });
});

describe("a failure before the send: nothing sent, plain words, and the fix", () => {
  it("the tool was disconnected: the card names the tool and offers a reconnect", async () => {
    tool = fakeMailchimp();
    const row = newRow("mailchimp");
    approve(row);
    await rail(row, { resolveAccount: (async () => null) as unknown as EmailSendDeps["resolveAccount"] }).run();
    const card = wire(row);
    expect(card).toMatchObject({ exec_status: "failed", exec_code: "email_tool_not_connected", exec_bucket: "needs_founder", exec_fix_text: "reconnect Mailchimp, Klaviyo or SendGrid in Settings", exec_receipt: null });
    expect(card.note).toContain("Reconnect Mailchimp");
    expect(card.note).toContain("Nothing was sent");
    expect(tool.calls).toEqual([]);
    expect(approve(row).ok).toBe(true);
    expect((await rail(row).run()).ok).toBe(true);
    expect(tool.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
  });
});

describe("a lost answer on the send: one send, and the card ends on the truth", () => {
  const loseSendThenGoDark = (row: Row) => {
    let sent = false;
    return rail(row, {
      exec: (async (c: Parameters<FakeTool["exec"]>[0]) => {
        if (sent) return { ok: false, status: 503, data: null, error: "down", outcome_unknown: true };
        const r = await tool.exec(c);
        if (c.tool_slug !== "MAILCHIMP_SEND_CAMPAIGN") return r;
        sent = true;
        return { ok: false, status: 0, data: null, error: "composio_transport_error", outcome_unknown: true };
      }) as unknown as EmailSendDeps["exec"],
    });
  };

  it("the card reads outcome unknown, Approve refuses to run it again, and the reconcile settles it sent by reading", async () => {
    tool = fakeMailchimp();
    const row = newRow("mailchimp");
    approve(row);
    await loseSendThenGoDark(row).run();
    expect(wire(row)).toMatchObject({ exec_status: "failed", exec_code: "exec_outcome_unknown", exec_bucket: "partial_risk", exec_receipt: null });
    expect(approve(row)).toEqual({ ok: false, code: "exec_partial_no_retry" });

    const r = await rail(row).reconcile(0);
    expect(r).toEqual({ done: true, outcome: "sent" });
    expect(wire(row)).toMatchObject({ exec_status: "executed", exec_receipt: { line: "Mailchimp accepted this send for a list of 412 people. Delivery is not confirmed yet" } });
    expect(tool.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(1);
    expect(tool.count("MAILCHIMP_ADD_CAMPAIGN")).toBe(1);
  });

  it("a worker that died after requesting the send: the reconcile settles the abandoned row, and never sends", async () => {
    tool = fakeMailchimp();
    tool.campaigns.push({ id: "mc1", title: `Zavi ${ACTION}`, list: "L1", status: "sent", html: "x", sent: 412 });
    const row = newRow("mailchimp", { exec_status: "dispatching", exec_claim_id: "claim-dead", exec_claimed_at: nowMs, exec_progress: { campaign_id: "mc1", stage: "send_requested" } });
    const r = rail(row);
    expect(await r.reconcile(0)).toEqual({ done: false, outcome: "in_flight" });
    nowMs += LEASE_MS + 1;
    expect(await r.reconcile(1)).toEqual({ done: true, outcome: "sent" });
    expect(wire(row).exec_receipt?.line).toBe("Mailchimp accepted this send for a list of 412 people. Delivery is not confirmed yet");
    expect(tool.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });

  it("the send never landed: the card ends NOT sent, and is still never run again", async () => {
    tool = fakeMailchimp();
    tool.campaigns.push({ id: "mc1", title: `Zavi ${ACTION}`, list: "L1", status: "save", html: "x", sent: 0 });
    const row = newRow("mailchimp", { exec_status: "failed", exec_result: { code: "exec_outcome_unknown", bucket: "partial_risk" }, exec_progress: { campaign_id: "mc1", stage: "send_requested" } });
    const r = rail(row);
    expect(await r.reconcile(0)).toEqual({ done: false, outcome: "too_early" });
    expect(await r.reconcile(1)).toEqual({ done: true, outcome: "not_sent" });
    const card = wire(row);
    expect(card).toMatchObject({ exec_status: "failed", exec_code: "exec_partial", exec_bucket: "partial_risk" });
    expect(card.note).toContain("was not sent");
    expect(approve(row).ok).toBe(false);
    expect(tool.count("MAILCHIMP_SEND_CAMPAIGN")).toBe(0);
  });
});
