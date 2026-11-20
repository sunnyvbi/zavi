import { describe, it, expect, vi } from "vitest";
vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantClient: vi.fn(), tenantRpc: vi.fn() }));
vi.mock("../snapshot-deps", () => ({ realSnapshotDeps: vi.fn() }));
import { runSnapshotJob, runDraftJob, reviewLink, type DraftJobDeps } from "../jobs";
import { realRun } from "./fixtures";
import { hashToken } from "../token";

const cfg = realRun();
const inputs = { day: "2026-10-03", isFirstDay: false, budgetChanges: [], changedLines: [], results: { spent_usd: 1, bookings: 1, hosts: 1 }, campaignNames: [] };

describe("runSnapshotJob", () => {
  it("off with no runs; per run: skip outside its window, save inside it", async () => {
    const save = vi.fn(async () => {});
    const base = { readPrevious: async () => null, build: async () => ({ by_day: [] }) as never, save };
    expect(await runSnapshotJob({ ...base, readRuns: async () => [], now: () => new Date("2026-10-02T00:00:00Z") })).toMatchObject({ skipped: "off" });
    const test = realRun({ start_at: "2026-09-28T09:00:00-04:00", unlock_at: undefined, end_at: "2026-09-30T23:59:59-04:00", budget_usd: 500 }, "upcar-test");
    const r = await runSnapshotJob({ ...base, readRuns: async () => [cfg, test], now: () => new Date("2026-08-31T12:00:00Z") });
    expect(r.runs).toEqual([{ slug: "upcar", result: "window" }, { slug: "upcar-test", result: "saved:0" }]);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("runDraftJob", () => {
  const deps = (over: Partial<DraftJobDeps> = {}): DraftJobDeps => ({
    readRuns: async () => [cfg],
    gather: async () => inputs,
    upsert: vi.fn(async () => "ok" as const),
    now: () => new Date("2026-10-04T03:30:00Z"),
    ...over,
  });
  it("stores only the token hash and returns the raw token for the link", async () => {
    const d = deps();
    const [r] = await runDraftJob(d);
    expect(r).toMatchObject({ slug: "upcar", day: "2026-10-03", dayNumber: 3 });
    const call = (d.upsert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[4]).toBe(hashToken(r.token));
    expect(JSON.stringify(call)).not.toContain(r.token);
  });
  it("reports kept_published so the worker sends nothing", async () => {
    const [r] = await runDraftJob(deps({ upsert: async () => "kept_published" }));
    expect(r.result).toBe("kept_published");
  });
  it("skips runs outside their window, drafts the ones inside", async () => {
    const test = realRun({ start_at: "2026-09-28T09:00:00-04:00", unlock_at: undefined, end_at: "2026-09-30T23:59:59-04:00", budget_usd: 500 }, "upcar-test");
    const out = await runDraftJob(deps({ readRuns: async () => [cfg, test], now: () => new Date("2026-09-29T03:30:00Z") }));
    expect(out.map((r) => r.slug)).toEqual(["upcar-test"]);
  });
});

describe("realDraftJobDeps.gather", () => {
  it("throws when a source read fails instead of drafting an empty day", async () => {
    const { tenantClient } = await import("@/services/tenant-client");
    const failing = { select: () => failing, eq: () => failing, gte: () => failing, lt: () => failing, order: () => failing, limit: () => failing, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(ok) };
    (tenantClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ from: () => failing });
    const { realDraftJobDeps } = await import("../jobs");
    await expect(realDraftJobDeps.gather(cfg, "2026-10-03")).rejects.toThrow(/live_stunt_draft_read_failed/);
  });
});

describe("reviewLink", () => {
  it("uses the first WEB_ORIGIN entry", () => {
    process.env.WEB_ORIGIN = "https://www.zaviagent.com, https://zaviagent.com";
    expect(reviewLink("upcar-test", "2026-10-03", "abc")).toBe("https://www.zaviagent.com/live/upcar-test/review/2026-10-03?t=abc");
  });
});
