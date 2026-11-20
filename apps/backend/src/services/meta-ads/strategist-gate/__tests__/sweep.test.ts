import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { RESOLVE_STALE_MS, MAX_REVIEW_ATTEMPTS } from "../constants";

let fake: FakeSupabase;
vi.mock("@/services/supabase", () => ({ serviceClient: () => fake }));
const enqueueSpy = vi.fn(async () => ({ run_id: "r_new" }));
vi.mock("../enqueue-review", () => ({ enqueueStrategistReview: (...a: unknown[]) => enqueueSpy(...(a as [])) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { sweepStrategistReviews } from "../sweep";
import { finalizeFailed } from "../review-state";

const TENANT = "t1";
const NOW = 10_000_000_000;
const OLD = new Date(NOW - 60 * 60 * 1000).toISOString();

function finalCreates() {
  return fake.decisions().filter((d) => d.decision_class === "meta_ads.create_ad_set");
}
function advisories() {
  return fake.decisions().filter((d) => d.decision_class === "agent.urgent_advisory");
}
function reviewRow(pid = "p1") {
  return fake.reviews().find((r) => r.pending_decision_id === pid)!;
}
function seedParked(pid = "p1") {
  fake.seedDecision({
    id: pid,
    tenant_id: TENANT,
    decision_class: "perfmkt.create_ad_set_pending_strategist",
    status: "acted",
    body: { kind: "create_ad_set_pending_strategist", create_ad_set: { campaign_id: "c", name: "n", daily_budget_usd: 10, optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", targeting: {}, rationale: "r", promoted_object: { pixel_id: "1234567890", custom_event_type: "COMPLETE_REGISTRATION" } } },
  });
}

beforeEach(() => {
  fake = new FakeSupabase();
  enqueueSpy.mockClear();
});

describe("sweepStrategistReviews — dead-letter money path (real store)", () => {
  it("CRASH-THEN-RECOVER: a stale resolving row whose create already emitted is recovered — NO second create", async () => {
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "resolving", claimed_at: OLD, updated_at: OLD, final_decision_id: null });
    fake.seedDecision({
      id: "orphan_create",
      tenant_id: TENANT,
      decision_class: "meta_ads.create_ad_set",
      status: "proposed",
      body: { campaign_id: "c", strategist_gate: { origin_pending_decision_id: "p1" } },
    });
    const res = await sweepStrategistReviews(NOW);
    expect(res.recovered).toBe(1);
    expect(res.retried).toBe(0);
    expect(finalCreates()).toHaveLength(1);
    expect(enqueueSpy).not.toHaveBeenCalled();
    const row = reviewRow();
    expect(row.status).toBe("approved");
    expect(row.final_decision_id).toBe("orphan_create");
  });

  it("a resolving row younger than RESOLVE_STALE_MS is LEFT ALONE (live resolver may hold the lease)", async () => {
    const recentClaim = new Date(NOW - (RESOLVE_STALE_MS - 1000)).toISOString();
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "resolving", claimed_at: recentClaim, updated_at: OLD, final_decision_id: null });
    const res = await sweepStrategistReviews(NOW);
    expect(res.waited).toBe(1);
    expect(reviewRow().status).toBe("resolving");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("a stale resolving row that NEVER emitted (attempts<max) is safely reset to pending + re-enqueued", async () => {
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "resolving", claimed_at: OLD, updated_at: OLD, attempts: 0, final_decision_id: null });
    seedParked("p1");
    const res = await sweepStrategistReviews(NOW);
    expect(res.retried).toBe(1);
    expect(finalCreates()).toHaveLength(0);
    expect(reviewRow().status).toBe("pending");
    expect(reviewRow().attempts).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("P1-3 NO SILENT LOSS: when the failure-notice emit FAILS, the row stays non-terminal (retried next tick)", async () => {
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "pending", updated_at: OLD, attempts: MAX_REVIEW_ATTEMPTS, review_run_id: "run_dead" });
    fake.seedAgentRun({ id: "run_dead", tenant_id: TENANT, status: "failed" });
    fake.failRpc = true;
    const res = await sweepStrategistReviews(NOW);
    expect(res.failed).toBe(0);
    expect(advisories()).toHaveLength(0);
    expect(reviewRow().status).toBe("pending");
  });

  it("dead-letter SUCCESS: notice emitted THEN row marked failed", async () => {
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "pending", updated_at: OLD, attempts: MAX_REVIEW_ATTEMPTS, review_run_id: "run_dead" });
    fake.seedAgentRun({ id: "run_dead", tenant_id: TENANT, status: "failed" });
    const res = await sweepStrategistReviews(NOW);
    expect(res.failed).toBe(1);
    expect(advisories()).toHaveLength(1);
    const notice = advisories()[0].body as Record<string, unknown>;
    expect(notice.kind).toBe("strategist_review_failed");
    expect(notice.pending_decision_id).toBe("p1");
    expect(reviewRow().status).toBe("failed");
    expect(finalCreates()).toHaveLength(0);
  });

  it("P1 INVARIANT (create exists ⇒ approved, never failed): a max-attempt row that already produced a create is RECOVERED, not dead-lettered", async () => {
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "pending", updated_at: OLD, attempts: MAX_REVIEW_ATTEMPTS, review_run_id: "run_dead", claimed_at: null });
    fake.seedAgentRun({ id: "run_dead", tenant_id: TENANT, status: "failed" });
    fake.seedDecision({
      id: "created_anyway",
      tenant_id: TENANT,
      decision_class: "meta_ads.create_ad_set",
      status: "proposed",
      body: { strategist_gate: { origin_pending_decision_id: "p1" } },
    });
    const res = await sweepStrategistReviews(NOW);
    expect(res.recovered).toBe(1);
    expect(res.failed).toBe(0);
    expect(advisories()).toHaveLength(0);
    expect(reviewRow().status).toBe("approved");
    expect(finalCreates()).toHaveLength(1);
  });

  it("P1 SELF-HEAL: a terminal `failed` row that has a create is recovered to approved + notice retracted (next tick)", async () => {
    const recentFail = new Date(NOW - 60_000).toISOString();
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "failed", updated_at: recentFail, final_decision_id: null });
    fake.seedDecision({
      id: "late_create",
      tenant_id: TENANT,
      decision_class: "meta_ads.create_ad_set",
      status: "proposed",
      body: { strategist_gate: { origin_pending_decision_id: "p1" } },
    });
    fake.seedDecision({
      id: "adv_1",
      tenant_id: TENANT,
      decision_class: "agent.urgent_advisory",
      status: "proposed",
      body: { kind: "strategist_review_failed", pending_decision_id: "p1" },
    });
    const res = await sweepStrategistReviews(NOW);
    expect(res.recovered).toBe(1);
    expect(reviewRow().status).toBe("approved");
    expect(reviewRow().final_decision_id).toBe("late_create");
    expect(fake.decisions().find((d) => d.id === "adv_1")!.status).toBe("superseded");
    expect(finalCreates()).toHaveLength(1);
  });

  it("a genuinely failed row (no create) is NOT resurrected by self-heal", async () => {
    const recentFail = new Date(NOW - 60_000).toISOString();
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "failed", updated_at: recentFail, final_decision_id: null });
    const res = await sweepStrategistReviews(NOW);
    expect(res.recovered).toBe(0);
    expect(reviewRow().status).toBe("failed");
  });

  it("a pending row whose run is still in flight (young) is left waiting", async () => {
    const recent = new Date(NOW - 60_000).toISOString();
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "pending", updated_at: recent, review_run_id: "run_live" });
    fake.seedAgentRun({ id: "run_live", tenant_id: TENANT, status: "running" });
    const res = await sweepStrategistReviews(NOW);
    expect(res.scanned).toBe(0);
  });
});

describe("finalizeFailed — staleness guard protects a live resolver's fresh claim", () => {
  const cutoff = new Date(NOW - RESOLVE_STALE_MS).toISOString();
  it("REFUSES to fail a resolving row a resolver just claimed (fresh claimed_at)", async () => {
    const fresh = new Date(NOW - 1000).toISOString();
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "resolving", claimed_at: fresh });
    const won = await finalizeFailed("p1", TENANT, "x", cutoff);
    expect(won).toBe(false);
    expect(reviewRow().status).toBe("resolving");
  });
  it("FAILS a never-claimed pending row (claimed_at null)", async () => {
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "pending", claimed_at: null });
    expect(await finalizeFailed("p1", TENANT, "x", cutoff)).toBe(true);
    expect(reviewRow().status).toBe("failed");
  });
  it("FAILS a stale-claimed resolving row (dead resolver)", async () => {
    const old = new Date(NOW - RESOLVE_STALE_MS - 60_000).toISOString();
    fake.seedReview({ pending_decision_id: "p1", tenant_id: TENANT, status: "resolving", claimed_at: old });
    expect(await finalizeFailed("p1", TENANT, "x", cutoff)).toBe(true);
    expect(reviewRow().status).toBe("failed");
  });
});
