import { describe, it, expect } from "vitest";
import { deriveSetupState, type ProgressRow } from "../state";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const empty: ProgressRow = {
  setup_docs_at: null, setup_docs_skipped: false,
  setup_connectors_at: null, setup_connectors_skipped: false,
  setup_done_at: null, setup_home_at: null,
};
const base = { tenant_id: T, row: null, files: 0, facts: 0, runs: [], hasPlan: false };

describe("deriveSetupState", () => {
  it("no row = nothing done (existing tenants are NOT grandfathered)", () => {
    const s = deriveSetupState(base);
    expect(s).toMatchObject({ enabled: true, done: false, docs: { status: "pending" }, connectors: { status: "pending" } });
    expect(s.draft).toEqual({ status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: false });
  });
  it("reports whether a plan exists, whoever drafted it", () => {
    expect(deriveSetupState(base).has_plan).toBe(false);
    expect(deriveSetupState({ ...base, hasPlan: true }).has_plan).toBe(true);
  });
  it("maps done vs skipped per step", () => {
    const s = deriveSetupState({
      ...base,
      row: { ...empty, setup_docs_at: "2026-09-24T00:00:00Z", setup_connectors_at: "2026-09-24T00:01:00Z", setup_connectors_skipped: true },
      files: 3, facts: 12,
    });
    expect(s.docs).toEqual({ status: "done", files: 3, facts: 12 });
    expect(s.connectors.status).toBe("skipped");
  });
  it("draft: running while the latest attempt is in flight", () => {
    const s = deriveSetupState({ ...base, runs: [{ id: "r1", status: "running", cron_dedupe_key: `cgo:draft:${T}:setup` }] });
    expect(s.draft).toMatchObject({ status: "running", run_id: "r1", attempts: 1, can_retry: false });
  });
  it("draft: done only when the latest attempt succeeded AND a plan exists", () => {
    const run = { id: "r1", status: "success", cron_dedupe_key: `cgo:draft:${T}:setup` };
    expect(deriveSetupState({ ...base, runs: [run], hasPlan: true }).draft.status).toBe("done");
    expect(deriveSetupState({ ...base, runs: [run], hasPlan: false }).draft.status).toBe("failed");
  });
  it("draft: the latest attempt wins even past 12 attempts (no fixed window)", () => {
    const k = (n: number) => (n === 1 ? `cgo:draft:${T}:setup` : n <= 3 ? `cgo:draft:${T}:setup:${n}` : `cgo:draft:${T}:setup:paid:${n}`);
    const runs = Array.from({ length: 13 }, (_, i) => ({ id: `r${i + 1}`, status: i === 12 ? "running" : "error", cron_dedupe_key: k(i + 1) }))
      .sort(() => 0.5 - Math.random());
    expect(deriveSetupState({ ...base, runs }).draft).toMatchObject({ status: "running", run_id: "r13", attempts: 13 });
  });
  it("draft: a failure can always retry; only the first 3 drafts are refunded", () => {
    const k = (s: string) => `cgo:draft:${T}:setup${s}`;
    const two = [
      { id: "r2", status: "error", cron_dedupe_key: k(":2") },
      { id: "r1", status: "error", cron_dedupe_key: k("") },
    ];
    expect(deriveSetupState({ ...base, runs: two }).draft).toMatchObject({ status: "failed", run_id: "r2", attempts: 2, can_retry: true, free_retry: true });
    const three = [{ id: "r3", status: "error", cron_dedupe_key: k(":3") }, ...two];
    expect(deriveSetupState({ ...base, runs: three }).draft).toMatchObject({ can_retry: true, free_retry: false });
  });

  it("a successful paid try (attempt 4) makes the draft done and clears the failed banner", () => {
    const k = (s: string) => `cgo:draft:${T}:setup${s}`;
    const runs = [
      { id: "r4", status: "success", cron_dedupe_key: k(":paid:4") },
      { id: "r3", status: "error", cron_dedupe_key: k(":3") },
    ];
    expect(deriveSetupState({ ...base, runs, hasPlan: true }).draft).toMatchObject({ status: "done", run_id: "r4", attempts: 4, can_retry: false });
  });
});

describe("durable strategy receipts", () => {
  const run = { id: "r1", status: "success", cron_dedupe_key: `cgo:draft:${T}:setup` };
  it("an unrelated live plan cannot make a failed delivery look successful", () => {
    expect(deriveSetupState({ ...base, runs: [run], hasPlan: true, livePlanIds: ["old"],
      delivery: { phase: "failed", plan_id: null, has_artifact: true } }).draft)
      .toMatchObject({ status: "failed", can_retry: true, save_retry: true });
  });
  it("a later plan replacing the applied one keeps the setup draft done", () => {
    expect(deriveSetupState({ ...base, runs: [run], hasPlan: true, livePlanIds: ["later"],
      delivery: { phase: "applied", plan_id: "first" } }).draft.status).toBe("done");
    expect(deriveSetupState({ ...base, runs: [run], hasPlan: false, livePlanIds: [],
      delivery: { phase: "applied", plan_id: "first" } }).draft.status).toBe("failed");
  });
  it("a committed receipt can recover an interrupted run finalization", () => {
    expect(deriveSetupState({ ...base, runs: [{ ...run, status: "error" }], hasPlan: true,
      livePlanIds: ["new"], delivery: { phase: "applied", plan_id: "new" } }).draft.status).toBe("done");
  });
  it.each(["checking", "saving"])("shows the persisted %s phase", (phase) => {
    expect(deriveSetupState({ ...base, runs: [{ ...run, status: "running" }],
      delivery: { phase, plan_id: null } }).draft).toMatchObject({ status: "running", phase });
  });
  it("a draft set aside by Start over or a newer plan is not a failure and offers no retry", () => {
    for (const hasPlan of [false, true]) {
      const draft = deriveSetupState({ ...base, runs: [{ ...run, status: "cancelled" }], hasPlan,
        delivery: { phase: "superseded", plan_id: null, has_artifact: true } }).draft;
      expect(draft).toMatchObject({ status: "done", can_retry: false, free_retry: false });
      expect(draft.save_retry).not.toBe(true);
    }
  });
  it("a failed save is not a failure once a plan committed after the draft began is live", () => {
    expect(deriveSetupState({ ...base, runs: [run], hasPlan: true, livePlanIds: ["chat"], laterPlan: true,
      delivery: { phase: "failed", plan_id: null, has_artifact: true } }).draft)
      .toMatchObject({ status: "done", can_retry: false });
  });
});
