import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({ id: "fn" }) } }));
vi.mock("../dispatch-channel-action", () => ({ readExecRow: vi.fn() }));

import { runExecReconcilePass, runReconcileLoop, type ReconcileSteps } from "../reconcile-channel-action-exec";
import { reconcileEmailSend, type ReconcileDeps, type ReconcileResult, type ReconcileTarget } from "@/services/connectors/email-campaign/reconcile";
import { cardSendState } from "@/services/email-cards/cards";

function steps() {
  const sleeps: string[] = [];
  const s: ReconcileSteps = {
    sleep: async (_id, wait) => {
      sleeps.push(wait);
    },
    run: (_id, fn) => fn(),
  };
  return { s, sleeps };
}
const r = (done: boolean, outcome: ReconcileResult["outcome"]): ReconcileResult => ({ done, outcome });

describe("runReconcileLoop", () => {
  it("stops at the first pass that is done", async () => {
    const { s, sleeps } = steps();
    const out = await runReconcileLoop("a1", s, async (n) => (n === 1 ? r(true, "sent") : r(false, "too_early")));
    expect(out).toEqual({ ok: true, outcome: "sent", passes: 2 });
    expect(sleeps).toEqual(["6m", "6m"]);
  });

  it("an unreadable tool after five looks gives up, as before", async () => {
    const { s, sleeps } = steps();
    expect((await runReconcileLoop("a1", s, async () => r(false, "could_not_read"))).outcome).toBe("gave_up");
    expect(sleeps).toHaveLength(5);
  });

  it("a founder notice that keeps failing is retried hourly, not dropped after five looks", async () => {
    const { s, sleeps } = steps();
    const pass = vi.fn(async (n: number) => (n === 9 ? r(true, "founder_told") : r(false, "notify_failed")));
    const out = await runReconcileLoop("a1", s, pass);
    expect(out).toEqual({ ok: true, outcome: "founder_told", passes: 10 });
    expect(sleeps).toEqual(["6m", "6m", "6m", "6m", "6m", "1h", "1h", "1h", "1h", "1h"]);
  });

  it("stops after a day of hourly retries and says so", async () => {
    const { s, sleeps } = steps();
    const out = await runReconcileLoop("a1", s, async () => r(false, "notify_failed"));
    expect(out.outcome).toBe("notice_gave_up");
    expect(sleeps.filter((w) => w === "1h")).toHaveLength(23);
  });
});

describe("runExecReconcilePass", () => {
  it("logs a failed founder notice with a code and the action id only", async () => {
    const log = vi.fn(async () => undefined);
    const row = { tenant_id: "t1", exec_class: "email_campaign.create_and_send", exec_status: "executed", exec_result: {}, exec_payload: { subject: "Secret subject" }, exec_progress: null, approved_by_source: "cgo", lease_expired: false };
    await runExecReconcilePass("a1", 3, { readRow: async () => row, reconcile: async () => r(false, "notify_failed"), log });
    expect(log).toHaveBeenCalledWith({ code: "email_send.founder_notice_failed", message: "action a1 pass 3", tenant_id: "t1" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("Secret subject");
  });

  it("logs nothing for any other outcome", async () => {
    const log = vi.fn(async () => undefined);
    const row = { tenant_id: "t1", exec_class: "x", exec_status: "executed", exec_result: {}, exec_payload: {}, exec_progress: null, approved_by_source: null, lease_expired: false };
    await runExecReconcilePass("a1", 0, { readRow: async () => row, reconcile: async () => r(true, "sent"), log });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("an unknown tool send whose connection changed before Zavi could check", () => {
  it("ends on the last look with a final 'may have gone out' card instead of 'This card updates once Zavi knows' forever", async () => {
    const row: ReconcileTarget = {
      tenant_id: "t1",
      exec_class: "email_campaign.create_and_send",
      exec_status: "failed",
      exec_result: { code: "exec_outcome_unknown" },
      exec_payload: { tool: "mailchimp", connected_account_id: "ca-mailchimp", auth_config_id: "ac-mailchimp", audience_id: "L1", audience_name: "Newsletter", audience_count: 412, subject: "Spring offer", preview_text: null, body_text: "x", from_name: "Acme", from_email: "hi@acme.test", reply_to: null },
      exec_progress: { campaign_id: "mc1", stage: "send_requested" },
      approved_by_source: null,
      lease_expired: false,
    };
    const settles: Array<{ ok: boolean; result: Record<string, unknown>; error?: string | null }> = [];
    const exec = vi.fn(async () => ({ ok: true, data: {} }));
    const deps: Partial<ReconcileDeps> = {
      resolveAccount: (async () => null) as unknown as ReconcileDeps["resolveAccount"],
      exec: exec as unknown as ReconcileDeps["exec"],
      settle: (async (_t: string, a: { ok: boolean; result: Record<string, unknown>; error?: string | null }) => {
        settles.push(a);
        row.exec_result = { ...a.result, code: a.result.code };
        return { ok: true, replayed: false };
      }) as unknown as ReconcileDeps["settle"],
    };
    const outcomes: string[] = [];
    const { s } = steps();
    const out = await runReconcileLoop("a1", s, async (n) => {
      const res = await runExecReconcilePass("a1", n, { readRow: async () => row, reconcile: (id, t, opts) => reconcileEmailSend(id, t, opts, deps), log: async () => undefined });
      outcomes.push(res.outcome);
      return res;
    });
    expect(out).toEqual({ ok: true, outcome: "could_not_check", passes: 5 });
    expect(outcomes).toEqual(["could_not_read", "could_not_read", "could_not_read", "could_not_read", "could_not_check"]);
    expect(settles).toHaveLength(1);
    expect(exec).not.toHaveBeenCalled();
    const card = cardSendState("channel_actions", { status: "failed", retryable: false, failure_reason: null } as never, {
      card: { exec_status: "failed", code: String(row.exec_result?.code), error: settles[0].error ?? null },
      bulk: null,
      results: null,
    } as never);
    expect(card).toMatchObject({ status: "failed", may_have_sent: true, reconciliation_pending: false });
    expect(card.failure_reason).toMatch(/^Zavi could not check Mailchimp/);
  });
});
