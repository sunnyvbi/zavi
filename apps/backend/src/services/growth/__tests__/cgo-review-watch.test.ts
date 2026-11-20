import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const logged: Array<Record<string, unknown>> = [];
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async (r: Record<string, unknown>) => void logged.push(r) }));
vi.mock("@/services/logging/alert", () => ({ alert: vi.fn() }));
const ledger: Array<{ data?: unknown[]; error?: { message: string } | null; throws?: boolean }> = [];
vi.mock("@/services/tenant-client", async (orig) => ({
  ...((await orig()) as object),
  globalClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["upsert", "update", "delete", "eq", "is", "lt", "select"]) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const r = ledger.shift() ?? { data: [], error: null };
        return (r.throws ? Promise.reject(new Error("ledger down")) : Promise.resolve({ data: r.data ?? [], error: r.error ?? null })).then(ok, bad);
      };
      return q;
    },
  }),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "../booking-metrics/__tests__/pglite";
import {
  findMissedReviews,
  foldDigest,
  ledgerClaim,
  missedReviewPage,
  missedReviewPageKey,
  probeMissedReviews,
  toMissed,
  MISSED_GRACE_HOURS,
  PAGE,
  PASS_MAX_AGE_HOURS,
  type MissedRow,
  type ScanState,
  type PageClaim,
  type WatchDeps,
} from "../cgo-review-watch";

const DUE = "2026-10-18T06:45:09.000Z";
const H = 3_600_000;
const at = (hoursAfterDue: number) => new Date(Date.parse(DUE) + hoursAfterDue * H);
const MIGRATION = readFileSync(join(__dirname, "../../../../../../supabase/migrations/20261111020000_cgo_missed_reviews.sql"), "utf8");

describe("cgo_missed_reviews (the rule, executed in Postgres)", () => {
  let db: Pg | null = null;
  beforeAll(async () => {
    db = await openPglite();
    if (!db) return;
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table tenants (id uuid primary key, kind text, deleted_at timestamptz, disabled_at timestamptz);
      create table tenant_app_setting (tenant_id uuid, key text, value jsonb);
      create table autopilot_goals (tenant_id uuid, status text, created_at timestamptz);
      create table cgo_notes (tenant_id uuid, next_review_at timestamptz, alarm_keys text[], created_at timestamptz);
      create table agent_runs (tenant_id uuid, agent_slug text, payload jsonb, status text, enqueued_at timestamptz);
      create table cgo_wake_skips (tenant_id uuid, wake_reason text, why text, created_at timestamptz);
    `);
    await db.exec(MIGRATION);
  });
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db?.exec("delete from tenants; delete from tenant_app_setting; delete from autopilot_goals; delete from cgo_notes; delete from agent_runs; delete from cgo_wake_skips;");
  });

  const T = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
  type Seed = { kind?: string; autopilot?: unknown; goal?: string | null; note?: string | null; run?: { status: string; at: string }; skip?: string; gone?: boolean };
  async function seed(n: number, o: Seed = {}) {
    await db!.query("insert into tenants values ($1, $2, $3, null)", [T(n), o.kind ?? "real", o.gone ? DUE : null]);
    if (o.autopilot !== undefined) await db!.query("insert into tenant_app_setting values ($1, 'cgo_autopilot_enabled', $2::jsonb)", [T(n), JSON.stringify(o.autopilot)]);
    if (o.goal !== null) await db!.query("insert into autopilot_goals values ($1, 'active', $2)", [T(n), o.goal ?? "2026-10-01T00:00:00Z"]);
    if (o.note !== null) await db!.query("insert into cgo_notes values ($1, $2, '{}', '2026-10-18T04:15:35Z')", [T(n), o.note ?? DUE]);
    if (o.run) await db!.query(`insert into agent_runs values ($1, 'cgo', '{"stage":"own_goals"}', $2, $3)`, [T(n), o.run.status, o.run.at]);
    if (o.skip) await db!.query("insert into cgo_wake_skips values ($1, 'daily_check', $2, $3)", [T(n), o.skip, at(1).toISOString()]);
  }
  const missed = async () =>
    (await db!.query("select tenant_id, test, why from cgo_missed_reviews($1, $2) where missed", [at(40).toISOString(), MISSED_GRACE_HOURS])).rows;

  it("finds the incident case and leaves out every case that is not a missed review", async () => {
    if (!db) return;
    await seed(1, { kind: "test", autopilot: true, skip: "not_live_tenant" });
    await seed(2, { autopilot: true, note: at(30).toISOString() });
    await seed(3, { autopilot: true, run: { status: "running", at: at(30).toISOString() } });
    await seed(4, { autopilot: true, run: { status: "success", at: at(30).toISOString() } });
    await seed(5, { autopilot: false });
    await seed(6, {});
    await seed(7, { autopilot: true, goal: null });
    await seed(8, { autopilot: true, gone: true });
    await seed(9, { autopilot: true, note: null, goal: DUE });
    expect(await missed()).toEqual([
      { tenant_id: T(1), test: true, why: "daily_check: not_live_tenant" },
      { tenant_id: T(4), test: false, why: null },
      { tenant_id: T(9), test: false, why: null },
    ]);
  });

  it("pages by workspace: one row per Autopilot workspace read, bounded by the limit, resumed from the cursor", async () => {
    if (!db) return;
    for (const n of [1, 2, 3]) await seed(n, { autopilot: true });
    await seed(4, { autopilot: true, gone: true });
    const page = async (after: string | null) =>
      (await db!.query("select tenant_id, missed from cgo_missed_reviews($1, $2, $3, 2)", [at(40).toISOString(), MISSED_GRACE_HOURS, after])).rows;
    expect(await page(null)).toEqual([{ tenant_id: T(1), missed: true }, { tenant_id: T(2), missed: true }]);
    expect(await page(T(2))).toEqual([{ tenant_id: T(3), missed: true }, { tenant_id: T(4), missed: false }]);
    expect(await page(T(4))).toEqual([]);
  });

  it("missed from exactly the grace onward", async () => {
    if (!db) return;
    await seed(1, { autopilot: true });
    const at_ = async (h: number) => (await db!.query("select missed from cgo_missed_reviews($1, $2)", [at(h).toISOString(), MISSED_GRACE_HOURS])).rows[0];
    expect(await at_(MISSED_GRACE_HOURS)).toEqual({ missed: true });
    expect(await at_(MISSED_GRACE_HOURS - 0.01)).toEqual({ missed: false });
  });

  it("a budget-clock or blocker note is not the check-in that sets the due time", async () => {
    if (!db) return;
    await seed(1, { autopilot: true });
    await db.query("insert into cgo_notes values ($1, $2, $3, $4)", [T(1), at(60).toISOString(), ["ad_budget_review"], at(20).toISOString()]);
    await db.query("insert into cgo_notes values ($1, $2, $3, $4)", [T(1), at(60).toISOString(), ["cgo_blockers", "urgent"], at(21).toISOString()]);
    expect((await missed()).map((x) => x.tenant_id)).toEqual([T(1)]);
  });
});

const ROWS: MissedRow[] = [{ tenant_id: "t-test", due_at: DUE, test: true, why: "daily_check: not_live_tenant" }];
const deps = (rows: MissedRow[]): WatchDeps => ({
  page: async (_n, _g, after) => (after === null ? rows.map((r) => ({ ...r, missed: true })) : []),
  loadState: async () => null,
  saveState: async () => undefined,
});

describe("the scan resumes where it stopped (F5)", () => {
  const row = (id: string, missed: boolean) => ({ tenant_id: id, missed, due_at: DUE, test: false, why: null });
  const page1 = Array.from({ length: PAGE }, (_, i) => row(`a${String(i).padStart(3, "0")}`, i === 7));
  const page2 = [row("b1", true), row("b2", false)];

  it("a page that keeps failing costs the probe, not the scan: the next probe resumes after the last page read", async () => {
    let state: ScanState | null = null;
    let down = true;
    const calls: Array<string | null> = [];
    const clocks: string[] = [];
    const d: WatchDeps = {
      page: async (n, _g, after) => {
        calls.push(after);
        clocks.push(n.toISOString());
        if (after === null) return page1;
        if (down) throw new Error("timeout");
        return page2;
      },
      loadState: async () => state,
      saveState: async (s) => void (state = s),
    };
    await expect(findMissedReviews(at(40), d)).rejects.toThrow("timeout");
    expect(calls).toEqual([null, `a${PAGE - 1}`, `a${PAGE - 1}`, `a${PAGE - 1}`]);
    expect(state).toMatchObject({ after: `a${PAGE - 1}`, found_count: 1, sample: [{ tenant_id: "a007" }] });
    down = false;
    calls.length = 0;
    const found: string[] = [];
    const out = await findMissedReviews(at(41), d, async (rows) => void found.push(...rows.map((m) => m.tenant_id)));
    expect(calls).toEqual([`a${PAGE - 1}`]);
    expect(found).toEqual(["b1"]);
    expect(out.count).toBe(2);
    expect(new Set(clocks)).toEqual(new Set([at(40).toISOString()]));
    expect(out.sample.map((m) => m.tenant_id)).toEqual(["a007", "b1"]);
    expect(state).toBeNull();
  });

  it("the saved state stays bounded however many are missed: a count and a sample of 5, never the list", async () => {
    const all = (p: string) => Array.from({ length: PAGE }, (_, i) => row(`${p}${String(i).padStart(3, "0")}`, true));
    const pages = [all("a"), all("b"), [row("c1", true)]];
    const saved: Array<ScanState | null> = [];
    let state: ScanState | null = null;
    const d: WatchDeps = { page: async () => pages.shift()!, loadState: async () => state, saveState: async (s) => void (saved.push(s), (state = s)) };
    const out = await findMissedReviews(at(40), d);
    expect(out.count).toBe(PAGE * 2 + 1);
    expect(out.sample).toHaveLength(5);
    expect(saved.filter(Boolean).every((s) => s!.sample.length <= 5)).toBe(true);
    expect(saved.at(-1)).toBeNull();
  });

  it("a saved scan older than the pass limit starts over", async () => {
    let state: ScanState | null = { after: "zzz", found_count: 1, digest: "0000000000000000", sample: [{ tenant_id: "old", due_at: DUE, test: false, why: null }], pass_started_at: at(40 - PASS_MAX_AGE_HOURS - 1).toISOString() };
    const calls: Array<string | null> = [];
    const d: WatchDeps = { page: async (_n, _g, after) => (calls.push(after), page2), loadState: async () => state, saveState: async (s) => void (state = s) };
    const out = await findMissedReviews(at(40), d);
    expect(calls).toEqual([null]);
    expect(out).toMatchObject({ count: 1, sample: [{ tenant_id: "b1" }] });
  });
});

describe("toMissed / findMissedReviews", () => {
  it("adds how late each is and sorts by workspace", async () => {
    expect((await findMissedReviews(at(40), deps([{ tenant_id: "b", due_at: DUE, test: null, why: null }, ...ROWS]))).sample).toEqual([
      { tenant_id: "b", due_at: DUE, hours_overdue: 40, test: false, why: null },
      { tenant_id: "t-test", due_at: DUE, hours_overdue: 40, test: true, why: "daily_check: not_live_tenant" },
    ]);
    expect(toMissed([], at(40))).toEqual([]);
  });
});

function memClaim(): PageClaim & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    take: async (k) => (held.has(k) ? false : (held.add(k), true)),
    confirm: async () => undefined,
    release: async (k) => void held.delete(k),
  };
}

describe("probeMissedReviews", () => {
  beforeEach(() => {
    logged.length = 0;
  });

  it("logs each missed workspace and pages once per set (a durable claim, any container), again when the set changes", async () => {
    const send = vi.fn(async () => undefined);
    const claim = memClaim();
    await probeMissedReviews(at(40), deps(ROWS), send, () => true, claim);
    await probeMissedReviews(at(41), deps(ROWS), send, () => true, claim);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logged.filter((l) => l.code === "cgo.review_missed")).toHaveLength(2);
    expect(logged[0]).toMatchObject({ tenant_id: "t-test", meta: { count: 40 } });
    const page = (send.mock.calls[0] as unknown[])[0] as { msg: string; email: { dedupeKey: string; required?: boolean }; tenant_id?: string };
    expect(page.msg).toContain("1 test Autopilot workspace(s)");
    expect(page.msg).toContain("t-test (40h)");
    expect(page.tenant_id).toBeUndefined();
    expect(page.email.required).toBe(true);
    await probeMissedReviews(at(42), deps([...ROWS, { tenant_id: "t-other", due_at: DUE, test: false, why: null }]), send, () => true, claim);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("live workspaces lead the page by slug; test ones are one line; a test-only set does not page again the next day", async () => {
    const send = vi.fn(async () => undefined);
    const claim = memClaim();
    const tests = Array.from({ length: 9 }, (_, i) => ({ tenant_id: `t${i}`, due_at: DUE, test: true, why: null }));
    const live = { tenant_id: "z-live", due_at: DUE, test: false, why: "daily_check: nothing_due" };
    const withSlugs = (rows: MissedRow[]): WatchDeps => ({ ...deps(rows), slugs: async () => new Map([["z-live", "stock-dashboard"]]) });
    await probeMissedReviews(at(40), withSlugs([...tests, live]), send, () => true, claim);
    const msg = ((send.mock.calls[0] as unknown[])[0] as { msg: string }).msg;
    expect(msg).toMatch(/^cgo: 1 live Autopilot workspace\(s\) missed/);
    expect(msg).toContain("stock-dashboard (40h overdue; last skip daily_check: nothing_due).");
    expect(msg).toContain("Also 9 test workspace(s)");
    expect(msg).not.toContain("t0");
    const send2 = vi.fn(async () => undefined);
    await probeMissedReviews(at(40), deps(tests), send2, () => true, claim);
    await probeMissedReviews(at(70), deps(tests), send2, () => true, claim);
    expect(send2).toHaveBeenCalledTimes(1);
  });

  it("a slug lookup that fails still pages, naming ids", async () => {
    const send = vi.fn(async () => undefined);
    const d: WatchDeps = { ...deps([{ tenant_id: "z-live", due_at: DUE, test: false, why: null }]), slugs: () => Promise.reject(new Error("down")) };
    await probeMissedReviews(at(40), d, send, () => true, memClaim());
    expect(((send.mock.calls[0] as unknown[])[0] as { msg: string }).msg).toContain("z-live (40h overdue)");
  });

  it("does nothing off the prod container; a failed read never throws and pages once a day that the watch is blind", async () => {
    const send = vi.fn(async () => undefined);
    const claim = memClaim();
    expect(await probeMissedReviews(at(40), deps(ROWS), send, () => false, claim)).toMatchObject({ skipped: "not_canonical" });
    expect(send).not.toHaveBeenCalled();
    const blind: WatchDeps = { ...deps(ROWS), page: () => Promise.reject(new Error("rpc down")) };
    expect(await probeMissedReviews(at(40), blind, send, () => true, claim)).toMatchObject({ missed: 0, failed: "rpc down" });
    await probeMissedReviews(at(41), blind, send, () => true, claim);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({ code: "cgo_review_watch_failed" });
  });

  it("a page that failed to send releases its claim, so the next probe tries again", async () => {
    const claim = memClaim();
    const send = vi.fn().mockRejectedValueOnce(new Error("mail down")).mockResolvedValue(undefined);
    await probeMissedReviews(at(40), deps(ROWS), send, () => true, claim);
    expect(claim.held.size).toBe(0);
    await probeMissedReviews(at(41), deps(ROWS), send, () => true, claim);
    expect(send).toHaveBeenCalledTimes(2);
    expect(claim.held.size).toBe(1);
  });

  it("the page key is per UTC day and per live set; a test-only set has no day", () => {
    const a = [{ tenant_id: "a", due_at: DUE, hours_overdue: 30, test: false, why: null }];
    const d = foldDigest("", ["a"]);
    expect(missedReviewPageKey({ count: 1, digest: d, real_count: 1, real_digest: d }, at(30))).toMatch(/^cgo-review-missed:2026-10-19:1:/);
    expect(missedReviewPageKey({ count: 2, digest: d, real_count: 0, real_digest: "0000000000000000" }, at(30))).toBe(`cgo-review-missed-test:2:${d}`);
    expect(foldDigest("", ["a", "b", "c"])).not.toBe(foldDigest("", ["a", "b", "d"]));
    expect(foldDigest(foldDigest("", ["c"]), ["a", "b"])).toBe(foldDigest("", ["b", "c", "a"]));
    expect(foldDigest("", [])).toBe("0000000000000000");
    expect(missedReviewPage({ count: 7, real_count: 7, sample: Array.from({ length: 5 }, (_, i) => ({ ...a[0], tenant_id: `t${i}` })) })).toContain("(+2 more)");
  });
});

describe("ledgerClaim", () => {
  beforeEach(() => void (ledger.length = 0));
  it("the insert wins; a held key loses; an abandoned (unconfirmed, past the lease) claim is taken over", async () => {
    ledger.push({ data: [{ dedupe_key: "k:fanout" }] });
    expect(await ledgerClaim.take("k", at(40))).toBe(true);
    ledger.push({ data: [] }, { data: [] });
    expect(await ledgerClaim.take("k", at(40))).toBe(false);
    ledger.push({ data: [] }, { data: [{ dedupe_key: "k:fanout" }] });
    expect(await ledgerClaim.take("k", at(40))).toBe(true);
  });
  it("a ledger outage sends once per key from this process, not every hour; a failed send frees it", async () => {
    ledger.push({ error: { message: "down" } });
    expect(await ledgerClaim.take("outage-key", at(40))).toBe(true);
    ledger.push({ throws: true });
    expect(await ledgerClaim.take("outage-key", at(41))).toBe(false);
    ledger.push({ error: null });
    await ledgerClaim.release("outage-key");
    ledger.push({ throws: true });
    expect(await ledgerClaim.take("outage-key", at(42))).toBe(true);
  });
});
