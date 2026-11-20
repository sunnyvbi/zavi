import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ tenants: [] as string[], rows: new Map<string, Record<string, unknown>>() }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn(() => { throw new Error("live database must not be read"); }) }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  return {
    ...real,
    tenantClient: (tid: string) => {
      db.tenants.push(tid);
      return {
        from: (table: string) => {
          const filters: Record<string, unknown> = { tenant_id: tid };
          const q = {
            select: () => q,
            eq: (c: string, v: unknown) => ((filters[c] = v), q),
            order: () => q,
            limit: () => q,
            maybeSingle: async () => {
              const row = db.rows.get(table);
              const hit = row && Object.entries(filters).every(([c, v]) => row[c] === v);
              return { data: hit ? row : null, error: null };
            },
          };
          return q;
        },
      };
    },
  };
});

import { rebuildSendOutcome, type RebuildDeps } from "../outcome-rebuild";
import { tellEmailSendOutcomeOrQueue, type TellOrQueueDeps } from "../outcome-tell";
import { FANOUT_STALLED_REASON, RELEASED_PAUSED_REASON, RELEASED_SENDER_STOPPED_REASON } from "../recovery";
import type { SendOutcome } from "../outcome";
import type { SendCounts } from "@/services/comms/bulk-outbound/store";
import { audienceMismatchResult, EMAIL_PAUSED_CODE, OUTCOME_UNKNOWN_SUFFIX } from "@/services/connectors/email-campaign/execute-send";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const CARD = "22222222-2222-4222-8222-222222222222";
const SEND = "33333333-3333-4333-8333-333333333333";

const counts = (over: Partial<SendCounts> = {}): SendCounts => ({
  status: "done", hold_reason: null, next_run_at: null, total: 3, sent: 3, skipped: 0, failed: 0, unknown: 0, pending: 0, sending: 0, complaints: 0, hard_bounces: 0, ...over,
});

const action = (over: Record<string, unknown>): Partial<RebuildDeps> => ({
  readAction: async () => ({ tenant_id: T, exec_class: "email_campaign.create_and_send", exec_status: "executed", exec_result: null, ...over }) as never,
});
const decision = (row: Record<string, unknown>, bulk: Record<string, unknown> | null, c: SendCounts = counts()): Partial<RebuildDeps> => ({
  readDecision: async () => ({ tenant_id: T, decision_class: "bulk_outbound.send", status: "executed", dispatch_error: null, ...row }) as never,
  readBulkSend: async (tenantId) => (bulk ? ({ id: SEND, tenant_id: tenantId, status: "done", ...bulk } as never) : null),
  counts: async () => c,
});

describe("rebuildSendOutcome reads the outcome from the card's own rows", () => {
  it("a settled list send is rebuilt with the row's tenant and the recounted numbers", async () => {
    const r = await rebuildSendOutcome(T, { rail: "decisions", card_id: CARD, outcome: "sent" }, decision({}, {}));
    expect(r).toEqual({ o: expect.objectContaining({ tenant_id: T, rail: "decisions", card_id: CARD, outcome: "sent", sent: 3, total: 3 }) });
  });

  it("a stalled hold carries the stalled reason; a paused release carries the paused reason", async () => {
    const stalled = await rebuildSendOutcome(T, { rail: "decisions", card_id: CARD, outcome: "failed" }, decision({}, { status: "held" }, counts({ status: "held", hold_reason: "fanout_stalled", sent: 1 })));
    expect(stalled).toEqual({ o: expect.objectContaining({ outcome: "failed", reason: FANOUT_STALLED_REASON }) });
    const paused = await rebuildSendOutcome(T, { rail: "decisions", card_id: CARD, outcome: "failed" }, decision({ status: "dispatch_failed", dispatch_error: `${RELEASED_PAUSED_REASON} (swept)` }, null));
    expect(paused).toEqual({ o: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 0, reason: RELEASED_PAUSED_REASON } });
  });

  it("a release dropped because the Zavi sender stayed stopped is rebuilt with that reason, not the raw sweep text", async () => {
    const stopped = await rebuildSendOutcome(T, { rail: "decisions", card_id: CARD, outcome: "failed" }, decision({ status: "dispatch_failed", dispatch_error: `${RELEASED_SENDER_STOPPED_REASON} Ask Zavi for a new draft.` }, null));
    expect(stopped).toEqual({ o: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 0, reason: RELEASED_SENDER_STOPPED_REASON } });
  });

  it("a card still dispatching is pending; a list send still going is the fanout's to tell, so nothing is rebuilt", async () => {
    expect(await rebuildSendOutcome(T, { rail: "channel_actions", card_id: CARD, outcome: "sent" }, action({ exec_status: "dispatching" }))).toEqual({ pending: true });
    expect(await rebuildSendOutcome(T, { rail: "decisions", card_id: CARD, outcome: "sent" }, decision({}, { status: "sending" }))).toBeNull();
  });

  it("an outcome or kind the row does not hold, another class, a missing row or a send of another tenant rebuilds nothing", async () => {
    expect(await rebuildSendOutcome(T, { rail: "decisions", card_id: CARD, outcome: "failed" }, decision({}, {}))).toBeNull();
    expect(await rebuildSendOutcome(T, { rail: "channel_actions", card_id: CARD, outcome: "failed", kind: "audience_mismatch" }, action({ exec_status: "failed", exec_result: { code: "exec_partial", not_sent: true } }))).toBeNull();
    expect(await rebuildSendOutcome(T, { rail: "channel_actions", card_id: CARD, outcome: "sent" }, action({ exec_class: "google_ads.create_campaign" }))).toBeNull();
    expect(await rebuildSendOutcome(T, { rail: "channel_actions", card_id: CARD, outcome: "sent" }, { readAction: async () => null })).toBeNull();
    const foreign: Partial<RebuildDeps> = { ...decision({}, {}), readBulkSend: async () => ({ id: SEND, tenant_id: OTHER, status: "done" }) };
    expect(await rebuildSendOutcome(T, { rail: "decisions", card_id: CARD, outcome: "sent" }, foreign)).toBeNull();
    expect(await rebuildSendOutcome(T, { rail: "channel_actions", card_id: CARD, outcome: "sent" }, action({ tenant_id: OTHER }))).toBeNull();
    expect(await rebuildSendOutcome(T, { rail: "decisions", card_id: CARD, outcome: "sent" }, decision({ tenant_id: OTHER, decision_class: "email_campaign.create_and_send", status: "acted" }, null))).toBeNull();
  });

  it("the channel_actions rail rebuilds each settled end", async () => {
    const ref = (outcome: SendOutcome["outcome"], kind?: "audience_mismatch") => ({ rail: "channel_actions" as const, card_id: CARD, outcome, ...(kind ? { kind } : {}) });
    expect(await rebuildSendOutcome(T, ref("sent"), action({}))).toEqual({ o: { tenant_id: T, rail: "channel_actions", card_id: CARD, outcome: "sent", sent: null } });
    expect(await rebuildSendOutcome(T, ref("failed", "audience_mismatch"), action({ exec_status: "failed", exec_result: { audience_mismatch: true, error: "other list" } }))).toEqual({
      o: { tenant_id: T, rail: "channel_actions", card_id: CARD, outcome: "failed", sent: null, reason: "other list", kind: "audience_mismatch" },
    });
    expect(await rebuildSendOutcome(T, ref("unknown"), action({ exec_status: "failed", exec_result: { code: "exec_outcome_unknown" } }))).toEqual({ o: expect.objectContaining({ outcome: "unknown", sent: null }) });
    expect(await rebuildSendOutcome(T, ref("failed"), action({ exec_status: "failed", exec_result: { code: "exec_partial", not_sent: true, error: "x" } }))).toEqual({ o: expect.objectContaining({ outcome: "failed", sent: 0 }) });
    expect(await rebuildSendOutcome(T, ref("failed"), action({ exec_status: "failed", exec_result: { held_for_founder: true } }))).toBeNull();
  });
});

describe("rebuildSendOutcome matches what the executor and reconcile told", () => {
  const ref = (outcome: SendOutcome["outcome"], kind?: "audience_mismatch") => ({ rail: "channel_actions" as const, card_id: CARD, outcome, ...(kind ? { kind } : {}) });
  const dref = (outcome: SendOutcome["outcome"], kind?: "audience_mismatch") => ({ rail: "decisions" as const, card_id: CARD, outcome, ...(kind ? { kind } : {}) });

  it("a sent card reads its count from the receipt, as the executor told it", async () => {
    const r = await rebuildSendOutcome(T, ref("sent"), action({ exec_result: { receipt: { line: "Sent to 1,204 people via Mailchimp" }, notice: "Sent to 1,204 people via Mailchimp." } }));
    expect(r).toEqual({ o: { tenant_id: T, rail: "channel_actions", card_id: CARD, outcome: "sent", sent: 1204 } });
    const one = await rebuildSendOutcome(T, ref("sent"), action({ exec_result: { notice: "Sent to 1 person via Klaviyo." } }));
    expect(one).toEqual({ o: expect.objectContaining({ sent: 1 }) });
  });

  it("exec_partial is unknown only when reconcile could not prove it unsent; the executor's own exec_partial is failed with none emailed", async () => {
    expect(await rebuildSendOutcome(T, ref("unknown"), action({ exec_status: "failed", exec_result: { code: "exec_partial", reconciled: true, error: "could not confirm" } }))).toEqual({
      o: { tenant_id: T, rail: "channel_actions", card_id: CARD, outcome: "unknown", sent: null, reason: "could not confirm" },
    });
    expect(await rebuildSendOutcome(T, ref("failed"), action({ exec_status: "failed", exec_result: { code: "exec_partial", reconciled: true, error: "x" } }))).toBeNull();
    expect(await rebuildSendOutcome(T, ref("failed"), action({ exec_status: "failed", exec_result: { code: "exec_partial", error: "draft left" } }))).toEqual({
      o: { tenant_id: T, rail: "channel_actions", card_id: CARD, outcome: "failed", sent: 0, reason: "draft left" },
    });
    expect(await rebuildSendOutcome(T, ref("unknown"), action({ exec_status: "failed", exec_result: { code: "exec_partial", error: "draft left" } }))).toBeNull();
  });

  it("a paused send or one sent back for a redraft was never told, so nothing is rebuilt", async () => {
    for (const code of [EMAIL_PAUSED_CODE, "email_redraft_required"]) {
      expect(await rebuildSendOutcome(T, ref("failed"), action({ exec_status: "failed", exec_result: { code, error: "held" } }))).toBeNull();
    }
  });

  it("a decision with no list send still waiting is pending", async () => {
    for (const status of ["approved", "dispatching"]) {
      expect(await rebuildSendOutcome(T, dref("failed"), decision({ decision_class: "email_campaign.create_and_send", status }, null))).toEqual({ pending: true });
      expect(await rebuildSendOutcome(T, dref("failed"), decision({ status }, null))).toEqual({ pending: true });
    }
  });

  it("a decisions-rail tool send is rebuilt from the decision itself", async () => {
    const tool = (row: Record<string, unknown>) => decision({ decision_class: "email_campaign.create_and_send", ...row }, null);
    expect(await rebuildSendOutcome(T, dref("sent"), tool({ status: "acted" }))).toEqual({ o: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "sent", sent: null } });
    expect(await rebuildSendOutcome(T, dref("unknown"), tool({ status: "dispatch_failed", dispatch_error: `Mailchimp did not answer.${OUTCOME_UNKNOWN_SUFFIX}` }))).toEqual({
      o: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "unknown", sent: null, reason: "Mailchimp did not answer." },
    });
    const mismatch = audienceMismatchResult("Klaviyo").error as string;
    expect(await rebuildSendOutcome(T, dref("failed", "audience_mismatch"), tool({ status: "dispatch_failed", dispatch_error: mismatch }))).toEqual({
      o: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: null, reason: mismatch, kind: "audience_mismatch" },
    });
    expect(await rebuildSendOutcome(T, dref("failed"), tool({ status: "dispatch_failed", dispatch_error: mismatch }))).toBeNull();
    expect(await rebuildSendOutcome(T, dref("failed"), tool({ status: "dispatch_failed", dispatch_error: "Mailchimp refused the send." }))).toEqual({
      o: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 0, reason: "Mailchimp refused the send." },
    });
  });

  it("a list send refused before it started is failed: with no send row nothing can resume it, and only a founder's pause is not an end", async () => {
    expect(await rebuildSendOutcome(T, dref("failed"), decision({ status: "dispatch_failed", dispatch_error: "Zavi did not send this email. (sender_unverified)" }, null))).toEqual({
      o: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 0, reason: "Zavi did not send this email." },
    });
    expect(await rebuildSendOutcome(T, dref("failed"), decision({ status: "dispatch_failed", dispatch_error: "Zavi could not check this send. (bulk_check_failed)" }, null))).toEqual({
      o: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 0, reason: "Zavi could not check this send." },
    });
    expect(await rebuildSendOutcome(T, dref("failed"), decision({ status: "dispatch_failed", dispatch_error: "Zavi paused this send. (email_paused)" }, null))).toBeNull();
  });

  it("the live reads are scoped to the caller's tenant: a card of another tenant rebuilds nothing", async () => {
    db.tenants.length = 0;
    db.rows.clear();
    db.rows.set("channel_actions", { id: CARD, tenant_id: OTHER, exec_class: "email_campaign.create_and_send", exec_status: "executed", exec_result: null });
    expect(await rebuildSendOutcome(T, ref("sent"))).toBeNull();
    expect(db.tenants).toEqual([T]);
    db.rows.set("channel_actions", { id: CARD, tenant_id: T, exec_class: "email_campaign.create_and_send", exec_status: "executed", exec_result: null });
    expect(await rebuildSendOutcome(T, ref("sent"))).toEqual({ o: expect.objectContaining({ tenant_id: T, outcome: "sent" }) });
    db.rows.set("decisions", { id: CARD, tenant_id: OTHER, decision_class: "email_campaign.create_and_send", status: "acted", dispatch_error: null });
    expect(await rebuildSendOutcome(T, dref("sent"))).toBeNull();
    expect(new Set(db.tenants)).toEqual(new Set([T]));
  });
});

describe("tellEmailSendOutcomeOrQueue", () => {
  const o: SendOutcome = { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 0, reason: "Something went wrong." };
  const deps = (over: Partial<TellOrQueueDeps> = {}) => {
    const d = {
      tell: vi.fn(async () => "retry" as const),
      rebuild: vi.fn(async () => ({ o })),
      enqueue: vi.fn(async () => ({})),
      keep: vi.fn(async () => true),
      ...over,
    };
    return d as typeof d & TellOrQueueDeps;
  };

  it("the row is rebuilt under the outcome's own tenant", async () => {
    const d = deps();
    await tellEmailSendOutcomeOrQueue(o, d);
    expect(d.rebuild).toHaveBeenCalledWith(T, { rail: "decisions", card_id: CARD, outcome: "failed" });
  });

  it("told or skipped is returned as is, with nothing queued or kept", async () => {
    for (const r of ["told", "skipped"] as const) {
      const d = deps({ tell: vi.fn(async () => r) });
      expect(await tellEmailSendOutcomeOrQueue(o, d)).toBe(r);
      expect(d.rebuild).not.toHaveBeenCalled();
      expect(d.enqueue).not.toHaveBeenCalled();
      expect(d.keep).not.toHaveBeenCalled();
    }
  });

  it("a retry is queued with the reference only, never the reason or counts", async () => {
    const d = deps();
    expect(await tellEmailSendOutcomeOrQueue(o, d)).toBe("queued");
    expect(d.enqueue).toHaveBeenCalledWith({ id: `email-send-outcome-tell:decisions:${CARD}:failed:`, name: "email-send-outcome/tell.requested", data: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed" } });
    expect(d.keep).not.toHaveBeenCalled();
  });

  it("a tell that throws, a pending row, or a read that throws is still queued", async () => {
    for (const over of [{ tell: vi.fn(async () => { throw new Error("boom"); }) }, { rebuild: vi.fn(async () => ({ pending: true as const })) }, { rebuild: vi.fn(async () => { throw new Error("db"); }) }]) {
      const d = deps(over as Partial<TellOrQueueDeps>);
      expect(await tellEmailSendOutcomeOrQueue(o, d)).toBe("queued");
    }
  });

  it("a queue that is down, a row that cannot be rebuilt, or a row of another tenant keeps the line instead", async () => {
    for (const over of [
      { enqueue: vi.fn(async () => { throw new Error("inngest down"); }) },
      { rebuild: vi.fn(async () => null) },
      { rebuild: vi.fn(async () => ({ o: { ...o, tenant_id: OTHER } })) },
    ]) {
      const d = deps(over as Partial<TellOrQueueDeps>);
      expect(await tellEmailSendOutcomeOrQueue(o, d)).toBe("kept");
      expect(d.keep).toHaveBeenCalledWith(o);
    }
  });

  it("never throws, even when keeping the line fails", async () => {
    const d = deps({ enqueue: vi.fn(async () => { throw new Error("inngest down"); }), keep: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(tellEmailSendOutcomeOrQueue(o, d)).resolves.toBe("retry");
  });
});
