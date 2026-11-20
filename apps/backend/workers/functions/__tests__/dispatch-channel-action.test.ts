
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/services/analytics/mixpanel", () => ({ track }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient must not be reached: the claim is injected");
  },
}));
vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({ id: "dispatch-channel-action" }), send: vi.fn() },
}));

import {
  buildExecDecisionRow,
  executeChannelAction,
  runChannelActionMutation,
  settleChannelActionOutcome,
} from "../dispatch-channel-action";
import { capGovernsDispatch } from "@/services/decisions/ads-approval-authority";
import { notePlatformWrite } from "@/services/channels/write-fence";
import { ExpectedToolError } from "@/services/tools/types";
import { classifyExecFailure, verdictFor } from "@/services/channels/exec-failure";
import { isPartialRiskExecCode } from "@zavi/shared";

vi.mock("@/services/growth/preview-plan", () => ({
  channelPlanLock: vi.fn(async () => null),
  planIncludesChannel: vi.fn(async () => true),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const FOUNDER = "aaaaaaaa-0000-4000-8000-000000000001";
const ACTION = "99999999-9999-4999-8999-999999999999";

const LEASE_MS = 10 * 60 * 1000;

let nowMs = 1_700_000_000_000;

type Row = {
  tenant_id: string;
  channel_slug: string;
  status: "pending" | "acted";
  exec_class: string;
  exec_payload: Record<string, unknown>;
  exec_status: null | "queued" | "dispatching" | "executed" | "failed";
  exec_claim_id: string | null;
  exec_claimed_at: number | null;
  approved_by: string | null;
  approved_by_source: string | null;
  note: string | null;
  events: string[];
};

function newRow(over: Partial<Row> = {}): Row {
  return {
    tenant_id: TENANT,
    channel_slug: "google_ads",
    status: "pending",
    exec_class: "google_ads.update_campaign_budget",
    exec_payload: {
      campaign_id: "1",
      daily_budget_usd: 150,
      expected_current_daily_budget_usd: 100,
    },
    exec_status: null,
    exec_claim_id: null,
    exec_claimed_at: null,
    approved_by: null,
    approved_by_source: null,
    note: null,
    events: ["proposed"],
    ...over,
  };
}

function approve(row: Row, opts: { source?: "staff" | null } = {}): { fires: boolean } {
  if (row.exec_status === "queued" || row.exec_status === "dispatching") return { fires: false };
  if (row.exec_status === "executed") return { fires: false };
  row.exec_status = "queued";
  row.exec_claim_id = null;
  row.exec_claimed_at = null;
  row.approved_by = FOUNDER;
  row.approved_by_source = opts.source ?? null;
  row.events.push("approved");
  return { fires: true };
}

let claimSeq = 0;

function makeDeps(row: Row, google: { calls: unknown[] }, handlerResult = { ok: true, notice: "done" }) {
  return {
    tellOutcome: vi.fn(async () => "not_a_direct_ask" as const),
    retimeFlight: vi.fn(async (r: { exec_payload: Record<string, unknown> }) => r.exec_payload),
    claim: vi.fn(async () => {
      if (row.exec_status === "queued") {
        row.exec_status = "dispatching";
        row.exec_claim_id = `claim-${++claimSeq}`;
        row.exec_claimed_at = nowMs;
        return {
          ok: true as const,
          row: {
            claim_id: row.exec_claim_id,
            tenant_id: row.tenant_id,
            channel_slug: row.channel_slug,
            exec_class: row.exec_class,
            exec_payload: row.exec_payload,
            approved_by: row.approved_by,
            approved_by_source: row.approved_by_source,
            agent_run_id: "run-1",
          },
        };
      }
      return {
        ok: false as const,
        code: "not_queued" as const,
        tenant_id: row.tenant_id,
        exec_status: row.exec_status,
        lease_expired:
          row.exec_status === "dispatching" &&
          (row.exec_claimed_at === null || row.exec_claimed_at < nowMs - LEASE_MS),
      };
    }),
    settle: vi.fn(
      async (
        _t: string,
        a: { ok: boolean; error?: string | null; claimId?: string | null },
      ) => {
        const owner = !!a.claimId && !!row.exec_claim_id && row.exec_claim_id === a.claimId;
        if (owner && row.exec_status === (a.ok ? "executed" : "failed")) {
          return { ok: true, code: undefined, replayed: true };
        }
        if (row.exec_status !== "dispatching") {
          return { ok: false, code: "not_dispatching", replayed: false };
        }
        if (!owner) {
          if (a.ok) return { ok: false, code: "not_owner", replayed: false };
          if (row.exec_claimed_at !== null && row.exec_claimed_at >= nowMs - LEASE_MS) {
            return { ok: false, code: "lease_held", replayed: false };
          }
        }
        if (a.ok) {
          row.status = "acted";
          row.exec_status = "executed";
          row.events.push("executed");
        } else {
          row.exec_status = "failed";
          row.note = a.error ?? null;
          row.events.push("exec_failed");
        }
        return { ok: true, code: undefined, replayed: false };
      },
    ),
    loadHandler: async () => async (d: { body: Record<string, unknown> }) => {
      google.calls.push(d.body);
      return handlerResult;
    },
    writeEnabled: vi.fn(async () => writeEnabled),
    tenantDisabled: vi.fn(async (): Promise<boolean | null> => tenantDisabled),
    channelStopped: vi.fn(async (): Promise<boolean | null> => channelStopped),
    releaseClaim: vi.fn(async () => true),
    execClassOf: vi.fn(async (): Promise<string | null> => row.exec_class),
  };
}

let writeEnabled = true;
let tenantDisabled: boolean | null = false;
let channelStopped: boolean | null = false;

beforeEach(() => {
  vi.clearAllMocks();
  nowMs = 1_700_000_000_000;
  claimSeq = 0;
  writeEnabled = true;
  tenantDisabled = false;
  channelStopped = false;
});

describe("two overlapping Approves plus one Inngest retry = EXACTLY ONE Google call", () => {
  it("counts one call", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);

    expect(approve(row).fires).toBe(true);
    expect(approve(row).fires).toBe(false);

    const first = await executeChannelAction(ACTION, deps);
    const retry = await executeChannelAction(ACTION, deps);

    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]).toEqual(row.exec_payload);
    expect(first.ok).toBe(true);
    expect(retry).toMatchObject({ ok: true, skipped: "not_queued" });
    expect(row.status).toBe("acted");
    expect(row.exec_status).toBe("executed");
    expect(row.events.filter((e) => e === "executed")).toHaveLength(1);
  });

  it("two workers racing the same queued row make one call", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    await Promise.all([executeChannelAction(ACTION, deps), executeChannelAction(ACTION, deps)]);
    expect(google.calls).toHaveLength(1);
  });
});

describe("a row stuck in `dispatching` becomes failed and is NEVER re-run", () => {
  it("settles failed without calling Google, once the lease has expired", async () => {
    const row = newRow({
      exec_status: "dispatching",
      exec_claim_id: "claim-dead",
      exec_claimed_at: nowMs - LEASE_MS - 1000,
      approved_by: FOUNDER,
    });
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);

    const res = await executeChannelAction(ACTION, deps);

    expect(google.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, skipped: "interrupted" });
    expect(row.exec_status).toBe("failed");
    expect(row.status).toBe("pending");
    expect(row.note).toMatch(/may already have gone through/i);
  });

  it.each([
    ["chatgpt_ads.create_campaign_bundle", "chatgpt_ads.create_campaign_bundle"],
    ["google_ads.create_ad_group", "google_ads.create_ad_group"],
    ["an unreadable class", null],
  ])("an interrupted %s settles exec_outcome_unknown", async (_label, execClass) => {
    const row = newRow({
      exec_class: execClass ?? "x.y",
      exec_status: "dispatching",
      exec_claim_id: "claim-dead",
      exec_claimed_at: nowMs - LEASE_MS - 1000,
      approved_by: FOUNDER,
    });
    const deps = makeDeps(row, { calls: [] });
    deps.execClassOf = vi.fn(async () => execClass);
    const mutation = await runChannelActionMutation(ACTION, deps as never);
    expect(mutation.settle).toMatchObject({ ok: false, claim_id: null, result: { interrupted: true, code: "exec_outcome_unknown" } });
    expect(mutation.settle?.error).toMatch(/will not run it again/i);
  });

  it("an interrupted LinkedIn launch says Zavi could not confirm it and is checking, never that LinkedIn refused it, and is not re-approvable", async () => {
    const row = newRow({
      exec_class: "linkedin_ads.launch_campaign",
      exec_status: "dispatching",
      exec_claim_id: "claim-dead",
      exec_claimed_at: nowMs - LEASE_MS - 1000,
      approved_by: FOUNDER,
    });
    const deps = makeDeps(row, { calls: [] });
    deps.execClassOf = vi.fn(async (): Promise<string | null> => "linkedin_ads.launch_campaign");
    (deps as Record<string, unknown>).interruptedLinkedinLaunch = vi.fn(async () => "unknown");
    const mutation = await runChannelActionMutation(ACTION, deps as never);
    expect(mutation.settle).toMatchObject({ ok: false, claim_id: null, result: { interrupted: true, lease_expired: true, code: "exec_outcome_unknown" } });
    expect(mutation.settle?.error).toMatch(/could not confirm whether it reached LinkedIn/);
    expect(mutation.settle?.error).toMatch(/is checking it now/);
    expect(mutation.settle?.error).not.toMatch(/did not accept|approve again|second copy|Try again/i);
    expect(classifyExecFailure(mutation.settle?.result)).toEqual({ bucket: "partial_risk", fix: null, platform_code: null });
  });

  const interruptedCreate = async (progress: () => Promise<unknown>) => {
    const row = newRow({ exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "dispatching", exec_claim_id: "claim-dead", exec_claimed_at: nowMs - LEASE_MS - 1000, approved_by: FOUNDER });
    const deps = makeDeps(row, { calls: [] });
    deps.execClassOf = vi.fn(async (): Promise<string | null> => "linkedin_ads.create_campaign_bundle");
    (deps as Record<string, unknown>).execProgressOf = vi.fn(progress);
    return runChannelActionMutation(ACTION, deps as never);
  };
  const saved = (over: Record<string, unknown>) => ({ version: 1, payload_hash: "h", account_binding_id: "b", group_id: null, campaign_id: null, creative_id: null, in_flight: null, group_paused: false, ...over });

  it.each([
    ["nothing saved yet", null, /before it created anything/],
    ["the account checkpoint only", saved({}), /before it created anything/],
    ["a saved group and campaign", saved({ group_id: "600", group_paused: true, campaign_id: "700" }), /What it made so far is saved/],
    ["a campaign create in flight under a saved group", saved({ group_id: "600", group_paused: true, in_flight: "campaign_id" }), /checks LinkedIn for the step it was on/],
    ["an ad create in flight under a saved campaign", saved({ group_id: "600", group_paused: true, campaign_id: "700", in_flight: "creative_id" }), /checks LinkedIn for the step it was on/],
  ])("an interrupted LinkedIn create with %s offers Try again, because saved progress proves it can finish without a second copy", async (_label, progress, words) => {
    const mutation = await interruptedCreate(async () => progress);
    expect(mutation.settle).toMatchObject({ ok: false, claim_id: null, result: { interrupted: true, lease_expired: true, code: "linkedin_ads_creation_incomplete" } });
    expect(mutation.settle?.error).toMatch(words);
    expect(mutation.settle?.error).toMatch(/Try again/);
    expect(classifyExecFailure(mutation.settle?.result)?.bucket).toBe("temporary");
  });

  it.each([
    ["a campaign group create in flight", async () => saved({ in_flight: "group_id" })],
    ["unreadable saved progress", async () => ({ version: 1, garbage: true })],
    ["a failed progress read", async () => { throw new Error("db down"); }],
  ])("an interrupted LinkedIn create with %s stays closed to a re-run", async (_label, progress) => {
    const mutation = await interruptedCreate(progress);
    expect(mutation.settle).toMatchObject({ ok: false, claim_id: null, result: { interrupted: true, code: "exec_outcome_unknown" } });
    expect(classifyExecFailure(mutation.settle?.result)?.bucket).toBe("partial_risk");
  });

  const interruptedLaunch = async (judge: () => Promise<string>) => {
    const row = newRow({ exec_class: "linkedin_ads.launch_campaign", exec_status: "dispatching", exec_claim_id: "claim-dead", exec_claimed_at: nowMs - LEASE_MS - 1000, approved_by: FOUNDER });
    const deps = makeDeps(row, { calls: [] });
    deps.execClassOf = vi.fn(async (): Promise<string | null> => "linkedin_ads.launch_campaign");
    (deps as Record<string, unknown>).interruptedLinkedinLaunch = vi.fn(judge);
    return runChannelActionMutation(ACTION, deps as never);
  };

  it.each([
    ["succeeded", /went through and the campaign is live/, /is checking it now|Try again/],
    ["reconciled", /keeps the campaign paused to be safe/, /is checking it now|Try again/],
    ["unknown", /is checking it now/, /is live|Try again/],
  ])("an interrupted LinkedIn launch judged %s says exactly that and keeps Approve closed", async (state, words, never) => {
    const mutation = await interruptedLaunch(async () => state);
    expect(mutation.settle?.error).toMatch(words);
    expect(mutation.settle?.error).not.toMatch(never);
    expect(mutation.settle?.result).toMatchObject({ code: "exec_outcome_unknown" });
    expect(classifyExecFailure(mutation.settle?.result)?.bucket).toBe("partial_risk");
  });

  it("must catch (Review 7): nothing reached LinkedIn, so the card says so, never 'checking' or 'stays held', and Try again stays open", async () => {
    const mutation = await interruptedLaunch(async () => "not_sent");
    expect(mutation.settle?.error).toMatch(/before anything reached LinkedIn/);
    expect(mutation.settle?.error).toMatch(/Try again/);
    expect(mutation.settle?.error).not.toMatch(/checking|stays held|may have|could not confirm/i);
    expect(mutation.settle).toMatchObject({ ok: false, claim_id: null, result: { interrupted: true, lease_expired: true, code: "linkedin_ads_launch_not_sent" } });
    expect(isPartialRiskExecCode(mutation.settle?.result?.code as string)).toBe(false);
    expect(classifyExecFailure(mutation.settle?.result)).toEqual({ bucket: "temporary", fix: null, platform_code: null });
  });

  it("must catch: nothing reached LinkedIn but the used request cannot be reopened: closed with a way forward, not a Try again that would do nothing", async () => {
    const mutation = await interruptedLaunch(async () => "not_reopened");
    expect(mutation.settle?.error).toMatch(/before anything reached LinkedIn/);
    expect(mutation.settle?.error).toMatch(/Review the launch again/);
    expect(mutation.settle?.result).toEqual({ code: "linkedin_ads_launch_not_reopened" });
    expect(classifyExecFailure(mutation.settle?.result)?.bucket).toBe("blocked_on_us");
  });

  it("must not catch: a judge that throws is an unknown outcome, never 'nothing reached LinkedIn' and never live", async () => {
    const mutation = await interruptedLaunch(async () => { throw new Error("read failed"); });
    expect(mutation.settle?.error).toMatch(/is checking it now/);
    expect(mutation.settle?.result).toMatchObject({ code: "exec_outcome_unknown" });
  });

  it("an interrupted non-create settles without a partial-risk code (re-approve stays open)", async () => {
    const row = newRow({ exec_status: "dispatching", exec_claim_id: "claim-dead", exec_claimed_at: nowMs - LEASE_MS - 1000 });
    const mutation = await runChannelActionMutation(ACTION, makeDeps(row, { calls: [] }) as never);
    expect(mutation.settle?.result).toEqual({ interrupted: true, lease_expired: true });
  });

  it("the failed row is open again, and a re-approve is a fresh attempt", async () => {
    const row = newRow({ exec_status: "failed", approved_by: FOUNDER });
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    expect(approve(row).fires).toBe(true);
    await executeChannelAction(ACTION, deps);
    expect(google.calls).toHaveLength(1);
  });
});

describe("a settlement that fails is retried, and the retry calls Google ZERO extra times", () => {
  it("settle throws once, then succeeds: row executed, EXACTLY ONE Google call", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);

    const mutation = await runChannelActionMutation(ACTION, deps);
    expect(google.calls).toHaveLength(1);
    expect(mutation.settle).toMatchObject({ ok: true, claim_id: "claim-1" });

    const realSettle = deps.settle;
    deps.settle = vi.fn(async () => {
      throw new Error("supabase unavailable");
    }) as unknown as typeof realSettle;
    await expect(settleChannelActionOutcome(ACTION, mutation, deps)).rejects.toThrow(
      /supabase unavailable/,
    );
    expect(row.exec_status).toBe("dispatching");

    deps.settle = realSettle;
    const out = await settleChannelActionOutcome(ACTION, mutation, deps);

    expect(google.calls).toHaveLength(1);
    expect(row.exec_status).toBe("executed");
    expect(row.status).toBe("acted");
    expect(out.ok).toBe(true);
    expect(row.events.filter((e) => e === "executed")).toHaveLength(1);
  });

  it("a settle that RESOLVES {ok:false} does not report success — it throws", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    const mutation = await runChannelActionMutation(ACTION, deps);

    deps.settle = vi.fn(async () => ({ ok: false, code: "not_dispatching" })) as never;
    await expect(settleChannelActionOutcome(ACTION, mutation, deps)).rejects.toThrow(
      /settle_channel_action_exec refused/,
    );
    expect(row.exec_status).toBe("dispatching");
    expect(google.calls).toHaveLength(1);
  });

  it("an owner replaying a settlement that already landed is answered ok, not retried forever", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    const mutation = await runChannelActionMutation(ACTION, deps);

    await settleChannelActionOutcome(ACTION, mutation, deps);
    const again = await settleChannelActionOutcome(ACTION, mutation, deps);

    expect(again.ok).toBe(true);
    expect(row.exec_status).toBe("executed");
    expect(row.events.filter((e) => e === "executed")).toHaveLength(1);
    expect(google.calls).toHaveLength(1);
  });
});

describe("a LIVE claim is never treated as abandoned", () => {
  it("a concurrent duplicate delivery makes ZERO extra Google calls and does not flip the row", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);

    const claimed = await deps.claim();
    expect(claimed.ok).toBe(true);
    expect(row.exec_status).toBe("dispatching");

    const b = await executeChannelAction(ACTION, deps);

    expect(b).toMatchObject({ ok: true, skipped: "in_flight" });
    expect(google.calls).toHaveLength(0);
    expect(row.exec_status).toBe("dispatching");
    expect(row.events).toEqual(["proposed", "approved"]);
    expect(row.exec_claim_id).toBe("claim-1");

    const a = await settleChannelActionOutcome(
      ACTION,
      {
        settle: {
          tenant_id: row.tenant_id,
          claim_id: "claim-1",
          ok: true,
          error: null,
          result: {},
        },
        outcome: { ok: true },
        log: null,
      },
      deps,
    );
    expect(a.ok).toBe(true);
    expect(row.exec_status).toBe("executed");
  });

  it("a non-owner settle is REFUSED while the lease runs", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    await deps.claim();

    const stranger = await deps.settle(row.tenant_id, {
      ok: false,
      error: "I think this died",
      claimId: null,
    });
    expect(stranger).toMatchObject({ ok: false, code: "lease_held" });
    expect(row.exec_status).toBe("dispatching");

    nowMs += LEASE_MS + 1000;
    const forged = await deps.settle(row.tenant_id, { ok: true, claimId: "claim-99" });
    expect(forged).toMatchObject({ ok: false, code: "not_owner" });
    expect(row.exec_status).toBe("dispatching");
  });

  it("two takeovers of the same abandoned row: one writes, the other is not an alarm", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    await deps.claim();
    nowMs += LEASE_MS + 1000;

    const first = await executeChannelAction(ACTION, deps);
    expect(first).toMatchObject({ ok: false, skipped: "interrupted" });
    expect(row.exec_status).toBe("failed");

    const second = await settleChannelActionOutcome(
      ACTION,
      {
        settle: {
          tenant_id: row.tenant_id,
          claim_id: null,
          ok: false,
          error: "interrupted",
          result: {},
        },
        outcome: { ok: false, skipped: "interrupted" },
        log: null,
      },
      deps,
    );
    expect(second).toMatchObject({ ok: false, skipped: "interrupted" });
    expect(row.events.filter((e) => e === "exec_failed")).toHaveLength(1);
    expect(google.calls).toHaveLength(0);
  });

  it("a GENUINELY stale claim still settles failed, and is never re-run", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    await deps.claim();

    nowMs += LEASE_MS + 1000;

    const res = await executeChannelAction(ACTION, deps);

    expect(res).toMatchObject({ ok: false, skipped: "interrupted" });
    expect(row.exec_status).toBe("failed");
    expect(row.status).toBe("pending");
    expect(row.note).toMatch(/may already have gone through/i);
    expect(google.calls).toHaveLength(0);
  });
});

describe("nothing executes without an approved event", () => {
  it("a never-approved row is never handed to a handler", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);

    const res = await executeChannelAction(ACTION, deps);

    expect(google.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: true, skipped: "not_queued" });
    expect(row.exec_status).toBeNull();
    expect(row.events).toEqual(["proposed"]);
  });

  it("a replayed event for an already-executed row makes no second call", async () => {
    const row = newRow({ exec_status: "executed", status: "acted" });
    const google = { calls: [] as unknown[] };
    await executeChannelAction(ACTION, makeDeps(row, google));
    expect(google.calls).toHaveLength(0);
  });
});

describe("capGovernsDispatch on the row the worker builds", () => {
  const claimed = (over: Partial<Row> = {}) => {
    const r = newRow(over);
    return {
      claim_id: "claim-1",
      tenant_id: r.tenant_id,
      channel_slug: r.channel_slug,
      exec_class: r.exec_class,
      exec_payload: r.exec_payload,
      approved_by: r.approved_by,
      approved_by_source: r.approved_by_source,
      agent_run_id: "run-1",
    };
  };

  it("FALSE for a founder Approve of a cap-bypass class", () => {
    const d = buildExecDecisionRow(ACTION, claimed({ approved_by: FOUNDER }));
    expect(capGovernsDispatch(d)).toBe(false);
  });

  it("TRUE for a staff-sourced approval: staff are not tenant spend authority", () => {
    const d = buildExecDecisionRow(
      ACTION,
      claimed({ approved_by: FOUNDER, approved_by_source: "staff" }),
    );
    expect(capGovernsDispatch(d)).toBe(true);
  });

  it("TRUE for a cgo-sourced approval: the CGO's Autopilot approval is not tenant spend authority", () => {
    const d = buildExecDecisionRow(
      ACTION,
      claimed({ approved_by: FOUNDER, approved_by_source: "cgo" }),
    );
    expect(capGovernsDispatch(d)).toBe(true);
  });

  it("TRUE when approved_by is missing: fail-safe, the cap stays in force", () => {
    const d = buildExecDecisionRow(ACTION, claimed({ approved_by: null }));
    expect(capGovernsDispatch(d)).toBe(true);
  });

  it("TRUE for a class outside the bypass set, even with a founder approval", () => {
    const d = buildExecDecisionRow(
      ACTION,
      claimed({ approved_by: FOUNDER, exec_class: "google_ads.add_keywords" }),
    );
    expect(capGovernsDispatch(d)).toBe(true);
  });
});

describe("the DecisionRow the handler sees", () => {
  it("is built from exec_payload, NEVER the card body", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    await executeChannelAction(ACTION, deps);
    expect(google.calls[0]).toBe(row.exec_payload);
  });

  it("carries decision_class = exec_class and handler = exec_class", () => {
    const d = buildExecDecisionRow(ACTION, {
      claim_id: "claim-1",
      tenant_id: TENANT,
      channel_slug: "google_ads",
      exec_class: "google_ads.set_status",
      exec_payload: { campaign_id: "1", status: "PAUSED" },
      approved_by: FOUNDER,
      approved_by_source: null,
      agent_run_id: "run-1",
    });
    expect(d.decision_class).toBe("google_ads.set_status");
    expect(d.handler).toBe("google_ads.set_status");
    expect(d.tenant_id).toBe(TENANT);
    expect(d.body).toEqual({ campaign_id: "1", status: "PAUSED" });
  });
});

describe("a handler failure leaves the action open", () => {
  it("settles failed with the error and does not mark it acted", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google, { ok: false, notice: "" } as never);
    (deps as unknown as { loadHandler: unknown }).loadHandler = async () => async () => {
      google.calls.push("call");
      return { ok: false, error: "google_ads_budget_drift: refused" };
    };
    approve(row);
    const res = await executeChannelAction(ACTION, deps);
    expect(res.ok).toBe(false);
    expect(row.status).toBe("pending");
    expect(row.exec_status).toBe("failed");
    expect(row.note).toMatch(/drift/);
  });

  it("S1: a CGO approval the gate holds for the founder settles not-executed, card pending, Approve open again", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    (deps as unknown as { loadHandler: unknown }).loadHandler = async () => async () => ({
      ok: false,
      held_for_founder: true,
      error: "I did not make this change on my own: Pausing is your call. The card is waiting for you. Approve it if you agree.",
    });
    approve(row);
    const mutation = await runChannelActionMutation(ACTION, deps);
    expect(mutation.settle).toMatchObject({ ok: false, result: { held_for_founder: true } });
    await settleChannelActionOutcome(ACTION, mutation, deps);
    expect(google.calls).toHaveLength(0);
    expect(row.status).toBe("pending");
    expect(row.exec_status).toBe("failed");
    expect(row.note).toMatch(/waiting for you/);
  });

  it("a handler that THROWS is caught, not retried into a second call", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    (deps as unknown as { loadHandler: unknown }).loadHandler = async () => async () => {
      google.calls.push("call");
      throw new Error("socket hang up");
    };
    approve(row);
    await expect(executeChannelAction(ACTION, deps)).resolves.toMatchObject({ ok: false });
    expect(google.calls).toHaveLength(1);
    expect(row.exec_status).toBe("failed");
  });

  it("a typed refusal keeps its code on the settlement, a plain throw adds none", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    const row = newRow();
    const deps = makeDeps(row, { calls: [] as unknown[] });
    (deps as unknown as { loadHandler: unknown }).loadHandler = async () => async () => {
      throw new ExpectedToolError("exec_partial", "Created the campaign (paused), then the rest failed.");
    };
    approve(row);
    const mutation = await runChannelActionMutation(ACTION, deps);
    expect(mutation.settle).toMatchObject({ ok: false, result: { code: "exec_partial", error: expect.stringContaining("Created the campaign") } });

    const row2 = newRow();
    const deps2 = makeDeps(row2, { calls: [] as unknown[] });
    (deps2 as unknown as { loadHandler: unknown }).loadHandler = async () => async () => {
      throw new Error("socket hang up");
    };
    approve(row2);
    const m2 = await runChannelActionMutation(ACTION, deps2);
    expect(m2.settle?.result).toEqual({ error: "socket hang up" });
  });

  it("a returned partial-risk code reaches the settlement unchanged", async () => {
    const row = newRow();
    const deps = makeDeps(row, { calls: [] as unknown[] });
    (deps as unknown as { loadHandler: unknown }).loadHandler = async () => async () => ({ ok: false, code: "exec_outcome_unknown", error: "may or may not exist" });
    approve(row);
    const mutation = await runChannelActionMutation(ACTION, deps);
    expect(mutation.settle).toMatchObject({ ok: false, result: { code: "exec_outcome_unknown" } });
  });

  it("an email send's not-sent proof reaches the settlement (the send ledger frees the list on it alone)", async () => {
    const row = newRow();
    const deps = makeDeps(row, { calls: [] as unknown[] });
    (deps as unknown as { loadHandler: unknown }).loadHandler = async () => async () => ({ ok: false, code: "exec_partial", not_sent: true, error: "refused" });
    approve(row);
    const mutation = await runChannelActionMutation(ACTION, deps);
    expect(mutation.settle).toMatchObject({ ok: false, result: { code: "exec_partial", not_sent: true } });
  });

  it("an Autopilot hold after a proven refusal keeps its not-sent proof", async () => {
    const row = newRow();
    const deps = makeDeps(row, { calls: [] as unknown[] });
    (deps as unknown as { loadHandler: unknown }).loadHandler = async () => async () => ({
      ok: false,
      held_for_founder: true,
      code: "exec_partial",
      not_sent: true,
      error: "Autopilot stopped after the provider refused the first attempt.",
    });
    approve(row);
    const mutation = await runChannelActionMutation(ACTION, deps);
    expect(mutation.settle).toMatchObject({ ok: false, result: { held_for_founder: true, code: "exec_partial", not_sent: true } });
  });

  it("an unregistered exec_class settles failed instead of stranding the row", async () => {
    const row = newRow({ exec_class: "google_ads.not_a_class" });
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    (deps as unknown as { loadHandler: unknown }).loadHandler = async () => null;
    approve(row);
    const res = await executeChannelAction(ACTION, deps);
    expect(res).toMatchObject({ ok: false, skipped: "no_handler" });
    expect(row.exec_status).toBe("failed");
    expect(google.calls).toHaveLength(0);
  });
});

describe("the platform kill switch is re-read at EXECUTE time, not only at propose time", () => {
  it("makes no Google call, and says so on the card", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);

    expect(approve(row).fires).toBe(true);
    writeEnabled = false;

    const out = await executeChannelAction(ACTION, deps);

    expect(google.calls).toHaveLength(0);
    expect(out).toMatchObject({ ok: false, skipped: "kill_switch" });
    expect(row.exec_status).toBe("failed");
    expect(row.note).toMatch(/switched off at the platform level/);
    expect(row.status).not.toBe("acted");
  });

  it("runs normally once the switch is back on", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    writeEnabled = false;
    approve(row);
    await executeChannelAction(ACTION, deps);
    expect(google.calls).toHaveLength(0);

    writeEnabled = true;
    row.exec_status = null;
    expect(approve(row).fires).toBe(true);
    const out = await executeChannelAction(ACTION, deps);

    expect(google.calls).toHaveLength(1);
    expect(out.ok).toBe(true);
    expect(row.exec_status).toBe("executed");
  });
});

describe("a channel the founder stopped (Growth J6)", () => {
  it("an approval queued before the stop makes no Google call and settles refused", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    channelStopped = true;
    const out = await executeChannelAction(ACTION, deps);
    expect(google.calls).toHaveLength(0);
    expect(out).toMatchObject({ ok: false, skipped: "founder_stopped" });
    expect(row.exec_status).toBe("failed");
    expect(row.note).toMatch(/You stopped this channel/);
    expect(deps.channelStopped).toHaveBeenCalledWith(row.tenant_id, row.channel_slug);
  });

  it("an unreadable stop hands the claim back while retries remain", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    channelStopped = null;
    await expect(runChannelActionMutation(ACTION, deps as never, { retryable: true })).rejects.toThrow(/channel_stop_check_failed/);
    expect(deps.releaseClaim).toHaveBeenCalled();
    expect(google.calls).toHaveLength(0);
  });

  it("an unreadable stop on the last attempt settles refused, never runs", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    channelStopped = null;
    const m = await runChannelActionMutation(ACTION, deps as never, { retryable: false });
    expect(m.outcome).toMatchObject({ ok: false, skipped: "founder_stopped" });
    expect(google.calls).toHaveLength(0);
  });
});

describe("a disabled workspace (staff Disable workspace)", () => {
  it("makes no Google call and settles the card failed", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    tenantDisabled = true;
    const out = await executeChannelAction(ACTION, deps);
    expect(google.calls).toHaveLength(0);
    expect(out).toMatchObject({ ok: false, skipped: "tenant_disabled" });
    expect(row.exec_status).toBe("failed");
    expect(row.note).toMatch(/workspace is disabled/);
  });

  it("an unreadable flag hands the claim back and retries while retries remain", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    tenantDisabled = null;
    await expect(runChannelActionMutation(ACTION, deps as never, { retryable: true })).rejects.toThrow(/tenant_disabled_check_failed/);
    expect(deps.releaseClaim).toHaveBeenCalled();
    expect(google.calls).toHaveLength(0);
  });

  it("an unreadable flag on the last attempt settles refused, never runs", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    tenantDisabled = null;
    const m = await runChannelActionMutation(ACTION, deps as never, { retryable: false });
    expect(m.outcome).toMatchObject({ ok: false, skipped: "tenant_disabled" });
    expect(m.settle?.result).toMatchObject({ code: "tenant_disabled_check_failed" });
    expect(google.calls).toHaveLength(0);
  });
});

describe("the executed count follows the settlement, not the attempt", () => {
  it("a retried settle reports ok a second time and sends no second event", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = makeDeps(row, google);
    approve(row);
    const claimed = await deps.claim();
    expect(claimed.ok).toBe(true);
    const claimId = row.exec_claim_id!;

    const mutation = {
      settle: { tenant_id: row.tenant_id, claim_id: claimId, ok: true, error: null, result: {} },
      outcome: { ok: true as const },
      log: {
        ok: true,
        tenant_id: row.tenant_id,
        run_id: null,
        channel_slug: "google_ads",
        message: "google_ads set_status",
      },
    };

    track.mockReset();
    await settleChannelActionOutcome(ACTION, mutation, deps);
    const first = track.mock.calls.filter((c) => c[0] === "channel_action_executed");
    expect(first).toHaveLength(1);
    expect(row.exec_status).toBe("executed");

    await settleChannelActionOutcome(ACTION, mutation, deps);
    const all = track.mock.calls.filter((c) => c[0] === "channel_action_executed");
    expect(all).toHaveLength(1);
  });
});

describe("the plan is re-read when an approved action executes", () => {
  it("a channel the plan does not include is refused and nothing is called", async () => {
    const row = newRow();
    const google = { calls: [] as unknown[] };
    const deps = {
      ...makeDeps(row, google),
      channelLock: vi.fn(async () => ({ slug: row.channel_slug, required_tier: "pro" as const })),
    };
    approve(row);
    const out = await executeChannelAction(ACTION, deps);
    expect(out).toMatchObject({ ok: false, skipped: "plan_upgrade_required" });
    expect(google.calls).toHaveLength(0);
  });

  it("a LinkedIn pause still runs after a downgrade, because it only stops spend", async () => {
    const row = newRow({ channel_slug: "linkedin_ads", exec_class: "linkedin_ads.set_status", exec_payload: { campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring" } });
    const linkedin = { calls: [] as unknown[] };
    const channelLock = vi.fn(async () => ({ slug: row.channel_slug, required_tier: "pro" as const }));
    approve(row);
    const out = await executeChannelAction(ACTION, { ...makeDeps(row, linkedin), channelLock });
    expect(out).toMatchObject({ ok: true });
    expect(linkedin.calls).toEqual([{ campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring" }]);
    expect(row.exec_status).toBe("executed");
  });

  it.each([
    ["linkedin_ads", "linkedin_ads.create_campaign_bundle"],
    ["reddit_ads", "reddit_ads.set_object_status"],
  ])("a %s %s card is still refused after a downgrade", async (channel_slug, exec_class) => {
    const row = newRow({ channel_slug, exec_class, exec_payload: { campaign_id: "22", account_id: "11", status: "PAUSED" } });
    const calls = { calls: [] as unknown[] };
    approve(row);
    const out = await executeChannelAction(ACTION, { ...makeDeps(row, calls), channelLock: vi.fn(async () => ({ slug: channel_slug, required_tier: "pro" as const })) });
    expect(out).toMatchObject({ ok: false, skipped: "plan_upgrade_required" });
    expect(calls.calls).toHaveLength(0);
    expect(row.exec_status).toBe("failed");
  });
});

describe("the no-friction switch is re-read at EXECUTE time for an envelope-approved create", () => {
  it("switched off since the approval: no handler call, settled refused", async () => {
    const row = newRow({ exec_class: "google_ads.create_campaign", exec_payload: { daily_budget_usd: 10, end_date: "2026-10-18" } });
    const google = { calls: [] as unknown[] };
    const seen: Array<[string, string]> = [];
    const deps = { ...makeDeps(row, google), envelopeSwitchedOff: vi.fn(async (r: { exec_class: string }, id: string) => (seen.push([r.exec_class, id]), true)) };
    approve(row);
    const out = await executeChannelAction(ACTION, deps);
    expect(google.calls).toHaveLength(0);
    expect(out).toMatchObject({ ok: false, skipped: "kill_switch" });
    expect(row.exec_status).toBe("failed");
    expect(row.note).toMatch(/switched off right now/);
    expect(seen).toEqual([["google_ads.create_campaign", ACTION]]);
  });
  it("switch on (or no envelope): the create runs; a non-create class is never checked", async () => {
    const create = newRow({ exec_class: "google_ads.create_campaign", exec_payload: { daily_budget_usd: 10, end_date: "2026-10-18" } });
    const g1 = { calls: [] as unknown[] };
    const on = { ...makeDeps(create, g1), envelopeSwitchedOff: vi.fn(async () => false) };
    approve(create);
    await executeChannelAction(ACTION, on);
    expect(g1.calls).toHaveLength(1);
    const budget = newRow();
    const g2 = { calls: [] as unknown[] };
    const check = vi.fn(async () => true);
    approve(budget);
    await executeChannelAction(ACTION, { ...makeDeps(budget, g2), envelopeSwitchedOff: check });
    expect(check).not.toHaveBeenCalled();
    expect(g2.calls).toHaveLength(1);
  });
});

describe("a failure is stamped nothing_written only on proof that no platform write went out", () => {
  const meta = () => newRow({ channel_slug: "meta_ads", exec_class: "meta_ads.create_ad", exec_payload: { ad_set_id: "1" } });
  const run = async (row: Row, handler: () => Promise<unknown>, firstAttempt = true) => {
    const deps = { ...makeDeps(row, { calls: [] }), loadHandler: async () => handler };
    approve(row);
    return (await runChannelActionMutation(ACTION, deps as never, { firstAttempt })).settle?.result as Record<string, unknown>;
  };

  it("stamps a fenced platform's failure that sent no write, on the first attempt", async () => {
    expect(await run(meta(), async () => ({ ok: false, code: "meta_ads_token_expired", error: "Reconnect" }))).toMatchObject({ nothing_written: true });
  });

  it("does not stamp once a write went out, whether the handler returns or throws", async () => {
    expect(await run(meta(), async () => { notePlatformWrite(); return { ok: false, code: "meta_ads_launch_not_live", error: "Not live" }; })).not.toHaveProperty("nothing_written");
    expect(await run(meta(), async () => { notePlatformWrite(); throw new ExpectedToolError("meta_ads_token_expired", "Reconnect"); })).not.toHaveProperty("nothing_written");
  });

  it("does not stamp a retried attempt or a platform without a fence", async () => {
    expect(await run(meta(), async () => ({ ok: false, code: "meta_ads_token_expired", error: "Reconnect" }), false)).not.toHaveProperty("nothing_written");
    expect(await run(newRow(), async () => ({ ok: false, code: "google_ads_token_revoked", error: "Reconnect" }))).not.toHaveProperty("nothing_written");
  });

  it("keeps what a refused LinkedIn post left archived on the stored result, so the closed card can say it", async () => {
    const row = newRow({ channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: {} });
    const result = await run(row, async () => ({ ok: false, code: "linkedin_ads_post_author_refused", error: "Refused", archived: { group: true, group_name: "G (Zavi 1)" } }));
    expect(result).toMatchObject({ code: "linkedin_ads_post_author_refused", archived: { group: true, group_name: "G (Zavi 1)" } });
    expect(verdictFor(result, "linkedin_ads.create_campaign_bundle")?.note).toMatch(/archived both/);
  });

  it("stamps a refusal made before the handler ran", async () => {
    writeEnabled = false;
    expect(await run(newRow(), async () => ({ ok: true }))).toMatchObject({ kill_switch: true, nothing_written: true });
  });
});
