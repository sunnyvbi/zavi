import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "./fake-supabase";

let fake: FakeSupabase;
vi.mock("@/services/supabase", () => ({ serviceClient: () => fake }));

import { resolveMarketFitVerdict, type ResolveVerdictDeps } from "../resolve-verdict";
import {
  claimForResolve,
  getParkedDecision,
  findFinalCreateFor,
  finalizeApproved,
  finalizeBounced,
  recoverApproved,
  supersedeFailureNotice,
  releaseClaim,
} from "../review-state";
import { emitFinalCreateIdempotent } from "../emit-idempotent";
import { PENDING_STRATEGIST_CLASS } from "../constants";

const TENANT = "t1";
const CREATE = {
  campaign_id: "camp_1",
  name: "PR Turo Host — San Juan",
  daily_budget_usd: 50,
  optimization_goal: "OFFSITE_CONVERSIONS",
  promoted_object: { pixel_id: "1234567890", custom_event_type: "COMPLETE_REGISTRATION" },
  billing_event: "IMPRESSIONS",
  targeting: { geo: "PR" },
  rationale: "expand",
};

function seedPending(pid = "pending_1", createOverride: Record<string, unknown> = {}) {
  fake.seedReview({ pending_decision_id: pid, tenant_id: TENANT, status: "pending" });
  fake.seedDecision({
    id: pid,
    tenant_id: TENANT,
    decision_class: PENDING_STRATEGIST_CLASS,
    agent_run_id: "run_perfmkt",
    status: "acted",
    body: { kind: "create_ad_set_pending_strategist", create_ad_set: { ...CREATE, ...createOverride } },
  });
}

function realDeps(pid = "pending_1"): ResolveVerdictDeps {
  return {
    claimForResolve,
    getParkedDecision,
    findExistingFinalCreate: findFinalCreateFor,
    finalizeApproved,
    finalizeBounced,
    recoverApproved,
    supersedeFailureNotice,
    releaseClaim,
    emitFinalCreate: async ({ body, tenant_id }) =>
      emitFinalCreateIdempotent({
        rawEmit: async (b) => {
          const { data, error } = await fake.rpc("emit_decision", {
            p_tenant_id: tenant_id,
            p_agent_run_id: null,
            p_decision_class: "meta_ads.create_ad_set",
            p_body: b,
          });
          if (error) throw new Error(error.message);
          return data as string;
        },
        findExisting: findFinalCreateFor,
        body,
        tenant_id,
        pending_decision_id: pid,
      }),
    log: async () => {},
  };
}

function finalCreates() {
  return fake.decisions().filter((d) => d.decision_class === "meta_ads.create_ad_set");
}
function reviewRow(pid = "pending_1") {
  return fake.reviews().find((r) => r.pending_decision_id === pid)!;
}

beforeEach(() => {
  fake = new FakeSupabase();
});

describe("resolveMarketFitVerdict — real store, real ordering", () => {
  it("APPROVE emits exactly ONE server-reconstructed create + flips the row to approved", async () => {
    seedPending();
    const res = await resolveMarketFitVerdict(
      { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "approve", reason: "served + liquid" },
      realDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("approved");
    const creates = finalCreates();
    expect(creates).toHaveLength(1);
    const body = creates[0].body as Record<string, unknown>;
    expect(body.campaign_id).toBe("camp_1");
    expect(body.daily_budget_usd).toBe(50);
    expect((body.strategist_gate as { origin_pending_decision_id: string }).origin_pending_decision_id).toBe("pending_1");
    const row = reviewRow();
    expect(row.status).toBe("approved");
    expect(row.final_decision_id).toBe((creates[0] as { id: string }).id);
  });

  it("TRUST BOUNDARY: hostile extra keys in the parked create are stripped from the emitted body", async () => {
    seedPending("pending_1", { daily_budget_usd: 50, evil: "x", approved_by: "attacker", never_auto: false });
    await resolveMarketFitVerdict(
      { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "approve", reason: "x" },
      realDeps(),
    );
    const body = finalCreates()[0].body as Record<string, unknown>;
    expect(body.daily_budget_usd).toBe(50);
    expect(body.evil).toBeUndefined();
    expect(body.approved_by).toBeUndefined();
    expect(body.never_auto).toBeUndefined();
  });

  it("BOUNCE flips the row to bounced with the reason and emits NO create", async () => {
    seedPending();
    const res = await resolveMarketFitVerdict(
      { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "bounce", reason: "PR not a served market" },
      realDeps(),
    );
    expect(res).toEqual({ ok: true, outcome: "bounced" });
    expect(finalCreates()).toHaveLength(0);
    const row = reviewRow();
    expect(row.status).toBe("bounced");
    expect(row.bounce_reason).toBe("PR not a served market");
  });

  it("P1-5 CONCURRENT resolvers on the same row → exactly ONE create (real CAS)", async () => {
    seedPending();
    const input = { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "approve" as const, reason: "ok" };
    const [a, b] = await Promise.all([
      resolveMarketFitVerdict(input, realDeps()),
      resolveMarketFitVerdict(input, realDeps()),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["approved", "lost_race"]);
    expect(finalCreates()).toHaveLength(1);
  });

  it("P1 IDEMPOTENT emit: a pre-existing origin-tagged create is REUSED, not re-emitted", async () => {
    seedPending();
    fake.seedDecision({
      id: "dec_pre",
      tenant_id: TENANT,
      decision_class: "meta_ads.create_ad_set",
      status: "proposed",
      body: { ...CREATE, strategist_gate: { origin_pending_decision_id: "pending_1" } },
    });
    const res = await resolveMarketFitVerdict(
      { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "approve", reason: "ok" },
      realDeps(),
    );
    expect(res).toEqual({ ok: true, outcome: "approved", final_decision_id: "dec_pre" });
    expect(finalCreates()).toHaveLength(1);
    expect(reviewRow().final_decision_id).toBe("dec_pre");
  });

  it("P2 WRONG-CLASS: a non-pending decision id is refused, no create, claim released", async () => {
    fake.seedReview({ pending_decision_id: "pending_1", tenant_id: TENANT, status: "pending" });
    fake.seedDecision({
      id: "pending_1",
      tenant_id: TENANT,
      decision_class: "meta_ads.update_ad_set_budget",
      status: "proposed",
      body: { create_ad_set: { ...CREATE } },
    });
    const res = await resolveMarketFitVerdict(
      { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "approve", reason: "x" },
      realDeps(),
    );
    expect(res).toEqual({ ok: false, outcome: "wrong_class" });
    expect(finalCreates()).toHaveLength(0);
    expect(reviewRow().status).toBe("pending");
  });

  it("P1 DEFINITIVE: two emits for the same origin (constraint enforced) → EXACTLY ONE create, loser reuses winner's id", async () => {
    const rawEmit = async (b: Record<string, unknown>) => {
      const { data, error } = await fake.rpc("emit_decision", {
        p_tenant_id: TENANT,
        p_agent_run_id: null,
        p_decision_class: "meta_ads.create_ad_set",
        p_body: b,
      });
      if (error) throw new Error(error.message);
      return data as string;
    };
    const body = { campaign_id: "c", strategist_gate: { origin_pending_decision_id: "pending_9" } };
    const emitOnce = () =>
      emitFinalCreateIdempotent({
        rawEmit,
        findExisting: findFinalCreateFor,
        body,
        tenant_id: TENANT,
        pending_decision_id: "pending_9",
      });
    const [id1, id2] = await Promise.all([emitOnce(), emitOnce()]);
    expect(finalCreates()).toHaveLength(1);
    expect(id1).toBe(id2);
  });

  it("P1 NOTICE-RETRACT on the finalizeApproved-WINS path: sweep posted a failure notice but its finalizeFailed no-op'd (fresh claim protected) → resolver's finalizeApproved SUCCEEDS → notice still retracted", async () => {
    seedPending();
    fake.seedDecision({
      id: "adv_win",
      tenant_id: TENANT,
      decision_class: "agent.urgent_advisory",
      status: "proposed",
      body: { kind: "strategist_review_failed", pending_decision_id: "pending_1" },
    });
    const res = await resolveMarketFitVerdict(
      { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "approve", reason: "ok" },
      realDeps(),
    );
    expect(res.outcome).toBe("approved");
    expect(reviewRow().status).toBe("approved");
    expect(finalCreates()).toHaveLength(1);
    expect(fake.decisions().find((d) => d.id === "adv_win")!.status).toBe("superseded");
  });

  it("P1 CONVERGENCE: sweep flips the row to FAILED while the resolver's emit is in flight → resolver forces it back to approved + retracts the notice", async () => {
    seedPending();
    fake.seedDecision({
      id: "adv_1",
      tenant_id: TENANT,
      decision_class: "agent.urgent_advisory",
      status: "proposed",
      body: { kind: "strategist_review_failed", pending_decision_id: "pending_1" },
    });
    const deps = realDeps();
    const inner = deps.emitFinalCreate;
    deps.emitFinalCreate = async (args) => {
      const id = await inner(args);
      reviewRow().status = "failed";
      return id;
    };
    const res = await resolveMarketFitVerdict(
      { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "approve", reason: "ok" },
      deps,
    );
    expect(res.outcome).toBe("approved");
    expect(reviewRow().status).toBe("approved");
    expect(finalCreates()).toHaveLength(1);
    expect(fake.decisions().find((d) => d.id === "adv_1")!.status).toBe("superseded");
  });

  it("emit failure releases the claim to pending and emits nothing (sweep re-drives)", async () => {
    seedPending();
    const deps = realDeps();
    deps.emitFinalCreate = async () => {
      throw new Error("meta emit boom");
    };
    const res = await resolveMarketFitVerdict(
      { pending_decision_id: "pending_1", tenant_id: TENANT, verdict: "approve", reason: "ok" },
      deps,
    );
    expect(res).toEqual({ ok: false, outcome: "emit_failed" });
    expect(finalCreates()).toHaveLength(0);
    expect(reviewRow().status).toBe("pending");
  });
});
