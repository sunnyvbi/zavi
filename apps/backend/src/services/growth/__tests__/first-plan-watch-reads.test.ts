import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ skip: undefined as unknown, skipThrows: false }));
vi.mock("@/services/settings", () => ({
  getAppSetting: async (_k: string, _t: unknown, opts: { strict?: boolean }) => {
    if (h.skipThrows && opts?.strict) throw new Error("app_setting read failed");
    return h.skip;
  },
}));

import { alertBucket, BACKFILL_MAX_PAGES, BACKFILL_PAGE, firstPlanReads } from "../first-plan-watch";

type Call = { table: string; ops: Array<[string, unknown[]]> };
let calls: Call[];
let results: Record<string, (c: Call) => { data: unknown; error: { message: string } | null }>;

function fakeSvc() {
  return {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "in", "or", "eq", "is", "gte", "lt", "order", "limit", "upsert", "like", "lte", "update", "overlaps", "range"]) {
        b[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return b;
        };
      }
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve((results[table] ?? (() => ({ data: [], error: null })))(call)).then(ok, bad);
      return b;
    },
  } as never;
}
const op = (c: Call, name: string) => c.ops.find(([n]) => n === name)?.[1];
const NOW = Date.parse("2026-10-30T12:00:00Z");
const TWIN = "d52644ab-2d94-47b2-8e33-d35016c5cf41";
const id = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;

beforeEach(() => {
  calls = [];
  results = {};
  h.skip = undefined;
  h.skipThrows = false;
});

describe("leaving()", () => {
  it("reads only live deletion requests for deleted workspaces, in URL-sized chunks, plus the skip list default", async () => {
    results.account_deletions = () => ({ data: [{ deleted_tenant_ids: [id(3), "other"] }], error: null });
    const ids = Array.from({ length: 90 }, (_, i) => id(i)).concat(TWIN);
    const out = await firstPlanReads(fakeSvc(), async () => true).leaving(ids);
    expect([...out].sort()).toEqual([id(3), TWIN].sort());
    const reads = calls.filter((c) => c.table === "account_deletions");
    expect(reads).toHaveLength(3);
    expect(op(reads[0]!, "in")).toEqual(["status", ["pending", "soft_deleted", "held"]]);
    expect(op(reads[0]!, "overlaps")).toEqual(["deleted_tenant_ids", ids.slice(0, 40)]);
    expect(reads.some((c) => c.ops.some(([n, a]) => String(a[0]).includes("left_tenant_ids")))).toBe(false);
  });

  it("a stored skip list replaces the default; a failed deletions or setting read throws", async () => {
    h.skip = [];
    expect([...(await firstPlanReads(fakeSvc(), async () => true).leaving([TWIN]))]).toEqual([]);
    h.skipThrows = true;
    await expect(firstPlanReads(fakeSvc(), async () => true).leaving([TWIN])).rejects.toThrow(/app_setting/);
    h.skipThrows = false;
    results.account_deletions = () => ({ data: null, error: { message: "down" } });
    await expect(firstPlanReads(fakeSvc(), async () => true).leaving([TWIN])).rejects.toThrow(/deletions read failed/);
  });
});

describe("tenants()", () => {
  it("only a real, live, non-dogfood workspace stays in: a test one or an unclaimed launch-video shell is excluded", async () => {
    results.tenants = () => ({
      data: [
        { id: id(1), slug: "forefield", kind: "real", deleted_at: null },
        { id: id(2), slug: "qa-run", kind: "test", deleted_at: null },
        { id: id(3), slug: "video-shell", kind: "launch_video_shell", deleted_at: null },
        { id: id(4), slug: "gone", kind: "real", deleted_at: "2026-10-29T00:00:00Z" },
        { id: id(5), slug: "upcar-ai", kind: "real", deleted_at: null },
      ],
      error: null,
    });
    const out = await firstPlanReads(fakeSvc(), async () => true).tenants([id(1), id(2), id(3), id(4), id(5)]);
    expect([...out.excluded].sort()).toEqual([id(2), id(3), id(4), id(5)]);
    expect(out.slug.get(id(1))).toBe("forefield");
  });
});

describe("enrollBackfill()", () => {
  it("enrols only planless setups in the window, never overwrites a watch row, and presets the page bucket", async () => {
    results.tenant_first_run_progress = () => ({
      data: [
        { tenant_id: id(1), setup_connectors_at: "2026-10-14T09:00:00Z" },
        { tenant_id: id(2), setup_connectors_at: "2026-10-20T09:00:00Z" },
      ],
      error: null,
    });
    results.growth_plan = () => ({ data: [{ tenant_id: id(2) }], error: null });
    results.first_plan_watch = (c) => {
      const rows = op(c, "upsert")![0] as Array<Record<string, unknown>>;
      return { data: rows.map(({ tenant_id, setup_connectors_at, alert_bucket, alert_emailed_bucket }) => ({ tenant_id, setup_connectors_at, alert_bucket, alert_emailed_bucket })), error: null };
    };
    const out = await firstPlanReads(fakeSvc(), async () => true).enrollBackfill("2026-10-14T00:00:00.000Z", "2026-10-29T12:00:00.000Z", NOW);
    const progress = calls.find((c) => c.table === "tenant_first_run_progress")!;
    expect(op(progress, "gte")).toEqual(["setup_connectors_at", "2026-10-14T00:00:00.000Z"]);
    expect(op(progress, "lt")).toEqual(["setup_connectors_at", "2026-10-29T12:00:00.000Z"]);
    const upsert = op(calls.find((c) => c.table === "first_plan_watch")!, "upsert")!;
    expect(upsert[1]).toEqual({ onConflict: "tenant_id", ignoreDuplicates: true });
    const bucket = alertBucket("2026-10-14T09:00:00Z", NOW);
    expect(upsert[0]).toEqual([
      { tenant_id: id(1), setup_connectors_at: "2026-10-14T09:00:00Z", next_check_at: new Date(NOW + 3_600_000).toISOString(), alert_bucket: bucket, alert_emailed_bucket: bucket },
    ]);
    expect(out.map((r) => r.tenant_id)).toEqual([id(1)]);
  });

  it("pages through every setup in the window, so a later call reaches setups past the first page", async () => {
    const all = Array.from({ length: 450 }, (_, i) => ({ tenant_id: id(i), setup_connectors_at: "2026-10-15T00:00:00Z" }));
    results.tenant_first_run_progress = (c) => {
      const [a, b] = op(c, "range") as [number, number];
      return { data: all.slice(a, b + 1), error: null };
    };
    results.growth_plan = () => ({ data: [], error: null });
    results.first_plan_watch = (c) => ({ data: (op(c, "upsert")![0] as Array<Record<string, unknown>>).map((r) => ({ ...r })), error: null });
    const out = await firstPlanReads(fakeSvc(), async () => true).enrollBackfill("a", "b", NOW);
    expect(out).toHaveLength(450);
    expect(calls.filter((c) => c.table === "tenant_first_run_progress")).toHaveLength(3);
  });

  it("exactly the page cap of setups is fine; one more fails the call instead of stopping short", async () => {
    const cap = BACKFILL_MAX_PAGES * BACKFILL_PAGE;
    let total = cap;
    results.tenant_first_run_progress = (c) => {
      const [a, b] = op(c, "range") as [number, number];
      const n = Math.max(0, Math.min(b, total - 1) - a + 1);
      return { data: Array.from({ length: n }, (_, i) => ({ tenant_id: id(a + i), setup_connectors_at: "2026-10-15T00:00:00Z" })), error: null };
    };
    results.growth_plan = () => ({ data: [], error: null });
    results.first_plan_watch = () => ({ data: [], error: null });
    await expect(firstPlanReads(fakeSvc(), async () => true).enrollBackfill("a", "b", NOW)).resolves.toEqual([]);
    total = cap + 1;
    await expect(firstPlanReads(fakeSvc(), async () => true).enrollBackfill("a", "b", NOW)).rejects.toThrow(/more than/);
  });

  it("a failed read or insert throws (the route answers 503)", async () => {
    results.tenant_first_run_progress = () => ({ data: [{ tenant_id: id(1), setup_connectors_at: "2026-10-14T09:00:00Z" }], error: null });
    results.first_plan_watch = () => ({ data: null, error: { message: "denied" } });
    await expect(firstPlanReads(fakeSvc(), async () => true).enrollBackfill("a", "b", NOW)).rejects.toThrow(/enrol failed/);
  });
});
