import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ stopped: false }));
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: () => h.stopped }));
vi.mock("@/services/settings", () => ({ getAppSetting: async () => undefined }));

import {
  alertBucket,
  backfillFromMs,
  BACKFILL_STARTS,
  DUE_LIMIT,
  skipList,
  failureClass,
  nextCheckDelay,
  retrySkip,
  runFirstPlanWatch,
  type FirstPlanReads,
  type FirstPlanWatchDeps,
  type LatestDraft,
  type WatchPatch,
  type WatchRow,
} from "../first-plan-watch";
import type { SetupDraftStart } from "@/services/setup/draft-start";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const MIN = 60_000;
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();
const KEY1 = `cgo:draft:${T}:setup`;

function watchRow(connectorsMinAgo: number, over: Partial<WatchRow> = {}): WatchRow {
  return { tenant_id: T, setup_connectors_at: ago(connectorsMinAgo), alert_bucket: null, alert_emailed_bucket: null, ...over };
}
function draft(over: Partial<LatestDraft> = {}): LatestDraft {
  return { id: "run-1", status: "dispatch_error", cron_dedupe_key: KEY1, error: "dispatch: worker lost", finished_at: ago(5), ...over };
}

let state: {
  rows: WatchRow[];
  excluded: Set<string>;
  leaving: Set<string> | "throw";
  table: WatchRow[];
  progress: Array<{ tenant_id: string; setup_connectors_at: string }>;
  latest: LatestDraft | null;
  inFlight: boolean;
  receipt: string | null;
  observed: boolean;
  setupOn: boolean;
  recovered: boolean;
  hadPlan: boolean;
  emailOk: boolean;
  startResult: SetupDraftStart;
};
let starts: Array<[string, number]>;
let alerts: Array<Record<string, unknown>>;
let emails: Array<Record<string, unknown>>;
let updates: Array<[string, WatchPatch]>;
let dueLimit: number | null;
let windowArgs: [string, string] | null;

function deps(): FirstPlanWatchDeps {
  const reads: FirstPlanReads = {
    due: async (_now, limit) => {
      dueLimit = limit;
      return state.rows;
    },
    tenants: async (ids) => ({ slug: new Map(ids.map((id) => [id, "acme"])), excluded: state.excluded }),
    leaving: async () => {
      if (state.leaving === "throw") throw new Error("first-plan-watch deletions read failed: down");
      return state.leaving;
    },
    enrollBackfill: async (from, before, now) => {
      windowArgs = [from, before];
      const added: WatchRow[] = [];
      for (const p of state.progress) {
        if (p.setup_connectors_at < from || p.setup_connectors_at >= before) continue;
        if (state.table.some((r) => r.tenant_id === p.tenant_id)) continue;
        const bucket = alertBucket(p.setup_connectors_at, now);
        const row = { tenant_id: p.tenant_id, setup_connectors_at: p.setup_connectors_at, alert_bucket: bucket, alert_emailed_bucket: bucket };
        state.table.push(row);
        added.push(row);
      }
      return added;
    },
    hadPlan: async () => state.hadPlan,
    latestDraft: async () => state.latest,
    draftInFlight: async () => state.inFlight,
    receiptPhase: async () => state.receipt,
    observed: async () => state.observed,
    verdict: async () =>
      (state.recovered
        ? { status: "ok", last_success_at: ago(1) }
        : { status: "limited", last_success_at: null }) as never,
    setupOn: async () => state.setupOn,
    update: async (t, p) => {
      updates.push([t, p]);
    },
  };
  return {
    reads,
    start: async (t, attempt) => {
      starts.push([t, attempt]);
      return state.startResult;
    },
    alert: async (a) => {
      alerts.push(a as unknown as Record<string, unknown>);
    },
    emailAlert: async (a) => {
      emails.push(a as unknown as Record<string, unknown>);
      return state.emailOk;
    },
    log: async () => {},
    now: () => NOW,
  };
}
const lastPatch = () => updates[updates.length - 1]![1];

beforeEach(() => {
  h.stopped = false;
  state = {
    rows: [watchRow(5)],
    excluded: new Set(),
    leaving: new Set(),
    table: [],
    progress: [],
    latest: null,
    inFlight: false,
    receipt: null,
    observed: false,
    setupOn: true,
    recovered: true,
    hadPlan: false,
    emailOk: true,
    startResult: { status: "queued", run_id: "new-run" },
  };
  starts = [];
  alerts = [];
  emails = [];
  updates = [];
  dueLimit = null;
  windowArgs = null;
});

describe("backstop start", () => {
  it("starts attempt 1 for a finished setup with no draft (founder closed the tab), checks again in 2 minutes", async () => {
    const out = await runFirstPlanWatch(deps());
    expect(starts).toEqual([[T, 1]]);
    expect(out).toMatchObject({ checked: 1, started: 1, retried: 0, alerted: 0 });
    expect(dueLimit).toBe(DUE_LIMIT);
    expect(lastPatch().next_check_at).toBe(new Date(NOW + 2 * MIN).toISOString());
  });

  it("counts nothing when the page started the same attempt first (unique key -> already)", async () => {
    state.startResult = { status: "already", run_id: null };
    const out = await runFirstPlanWatch(deps());
    expect(starts).toEqual([[T, 1]]);
    expect(out).toMatchObject({ started: 0 });
  });

  it("waits while research or a file read is still open (retry next tick)", async () => {
    state.startResult = { retry: true };
    expect(await runFirstPlanWatch(deps())).toMatchObject({ started: 0, errors: 0 });
    expect(lastPatch().next_check_at).toBe(new Date(NOW + 2 * MIN).toISOString());
  });

  it("does not start while another strategy draft is running", async () => {
    state.inFlight = true;
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([]);
  });

  it("starts at most 5 per tick; the rest come back in 2 minutes", async () => {
    state.rows = Array.from({ length: 8 }, (_, i) => watchRow(5, { tenant_id: `t${i}` }));
    const out = await runFirstPlanWatch(deps());
    expect(out).toMatchObject({ checked: 8, started: 5 });
    expect(updates.filter(([, p]) => p.next_check_at === new Date(NOW + 2 * MIN).toISOString())).toHaveLength(8);
  });

  it("does nothing when the scheduled-worker allowlist stops it", async () => {
    h.stopped = true;
    expect(await runFirstPlanWatch(deps())).toEqual({ cron_stopped: true });
    expect(starts).toEqual([]);
  });
});

describe("resolution: watched until a plan, never dropped by age", () => {
  it("resolves a workspace that has a plan in any status, with no start and no page", async () => {
    state.rows = [watchRow(45)];
    state.hadPlan = true;
    expect(await runFirstPlanWatch(deps())).toMatchObject({ resolved: 1 });
    expect(updates).toEqual([[T, { resolved_at: new Date(NOW).toISOString(), resolved_reason: "plan" }]]);
    expect(starts).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("resolves a test, dogfood or deleted workspace", async () => {
    state.excluded = new Set([T]);
    await runFirstPlanWatch(deps());
    expect(lastPatch()).toMatchObject({ resolved_reason: "excluded" });
    expect(starts).toEqual([]);
  });

  it("setup switched off: no start, no page, looked at again in a day", async () => {
    state.rows = [watchRow(60)];
    state.setupOn = false;
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([]);
    expect(alerts).toEqual([]);
    expect(updates).toEqual([[T, { next_check_at: new Date(NOW + 24 * 60 * MIN).toISOString() }]]);
  });

  it("a workspace three weeks old with no plan is still started and paged (weekly bucket)", async () => {
    state.rows = [watchRow(21 * 24 * 60)];
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([[T, 1]]);
    expect(lastPatch().alert_bucket).toBe("w3");
  });

  it("checks taper with age: 2 min, 15 min, hourly, then every 6 hours", () => {
    expect(nextCheckDelay(ago(20), NOW, false)).toBe(2 * MIN);
    expect(nextCheckDelay(ago(120), NOW, false)).toBe(15 * MIN);
    expect(nextCheckDelay(ago(3 * 24 * 60), NOW, false)).toBe(60 * MIN);
    expect(nextCheckDelay(ago(10 * 24 * 60), NOW, false)).toBe(6 * 60 * MIN);
    expect(nextCheckDelay(ago(10 * 24 * 60), NOW, true)).toBe(2 * MIN);
  });
});

describe("retry of a failed first attempt (money-safe)", () => {
  it("starts attempt 2 when attempt 1 died before any tool ran", async () => {
    state.latest = draft();
    const out = await runFirstPlanWatch(deps());
    expect(starts).toEqual([[T, 2]]);
    expect(out).toMatchObject({ retried: 1 });
  });

  it("retries a pre-tool failure even when it is more than 12 hours old (no age cut-off)", async () => {
    state.rows = [watchRow(20 * 60)];
    state.latest = draft({ finished_at: ago(19 * 60) });
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([[T, 2]]);
  });

  it("never retries a run that executed a tool or filed anything", async () => {
    state.latest = draft();
    state.observed = true;
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([]);
  });

  it("never retries a run that reached its strategy receipt", async () => {
    state.latest = draft();
    state.receipt = "checking";
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([]);
  });

  it("retries only attempt 1: the founder keeps the last free try and a paid try is never re-run", async () => {
    state.latest = draft({ cron_dedupe_key: `${KEY1}:2` });
    await runFirstPlanWatch(deps());
    state.latest = draft({ cron_dedupe_key: `${KEY1}:paid:4` });
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([]);
  });

  it("waits for the provider to recover before retrying an outage failure", async () => {
    state.latest = draft({ status: "failed", error: "Claude Code returned an error result: You've hit your limit · resets 3pm" });
    state.recovered = false;
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([]);
    state.recovered = true;
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([[T, 2]]);
  });

  it("leaves a running draft alone and checks it again in 2 minutes", async () => {
    state.rows = [watchRow(3 * 60)];
    state.latest = draft({ status: "running", error: null, finished_at: null });
    await runFirstPlanWatch(deps());
    expect(starts).toEqual([]);
    expect(lastPatch().next_check_at).toBe(new Date(NOW + 2 * MIN).toISOString());
  });
});

describe("retrySkip (row-local)", () => {
  it("skips a refusal, a run still settling and one with no finish time", () => {
    expect(retrySkip(T, draft({ error: "model_refusal: no" }), NOW)).toBe("refusal");
    expect(retrySkip(T, draft({ finished_at: new Date(NOW - 5_000).toISOString() }), NOW)).toBe("settling");
    expect(retrySkip(T, draft({ finished_at: null }), NOW)).toBe("not_finished");
    expect(retrySkip(T, draft({ finished_at: ago(13 * 60) }), NOW)).toBeNull();
    expect(retrySkip(T, draft(), NOW)).toBeNull();
  });
});

describe("ops page at 30 minutes", () => {
  beforeEach(() => {
    state.rows = [watchRow(31)];
    state.latest = draft({ status: "failed", error: "boot_reap: container restarted", finished_at: ago(25) });
    state.observed = true;
  });

  it("pages the wire once (no email on it) and emails separately, ids and statuses only", async () => {
    const out = await runFirstPlanWatch(deps());
    expect(out).toMatchObject({ alerted: 1, retried: 0 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.email).toBeUndefined();
    const email = emails[0]!.email as { dedupeKey: string; detail: string; required: boolean };
    expect(email.dedupeKey).toBe(`first_plan_missing:${T}:2026-10-28`);
    expect(email.required).toBe(true);
    expect(email.detail).toContain("run run-1, attempt 1, status failed, failure infra");
    expect(email.detail).not.toContain("container restarted");
    expect(lastPatch()).toMatchObject({ alert_bucket: "2026-10-28", alert_emailed_bucket: "2026-10-28" });
  });

  it("a bucket already paged and emailed sends nothing at all", async () => {
    state.rows = [watchRow(31, { alert_bucket: "2026-10-28", alert_emailed_bucket: "2026-10-28" })];
    await runFirstPlanWatch(deps());
    expect(alerts).toEqual([]);
    expect(emails).toEqual([]);
  });

  it("a failed email is retried on the next check WITHOUT repeating the wire page", async () => {
    state.emailOk = false;
    await runFirstPlanWatch(deps());
    expect(lastPatch()).toMatchObject({ alert_bucket: "2026-10-28" });
    expect(lastPatch().alert_emailed_bucket).toBeUndefined();
    state.rows = [watchRow(33, { alert_bucket: "2026-10-28" })];
    state.emailOk = true;
    alerts = [];
    emails = [];
    await runFirstPlanWatch(deps());
    expect(alerts).toEqual([]);
    expect(emails).toHaveLength(1);
    expect(lastPatch()).toMatchObject({ alert_emailed_bucket: "2026-10-28" });
  });

  it("a new UTC day is a new page", () => {
    expect(alertBucket(ago(31), NOW)).toBe("2026-10-28");
    expect(alertBucket(ago(31), NOW + 24 * 60 * MIN)).toBe("2026-10-29");
  });

  it("does not page before 30 minutes", async () => {
    state.rows = [watchRow(29)];
    state.latest = draft({ status: "running", error: null, finished_at: null });
    await runFirstPlanWatch(deps());
    expect(alerts).toEqual([]);
    expect(emails).toEqual([]);
  });

  it("a failure on one workspace still reschedules it and never stops the rest", async () => {
    state.rows = [watchRow(31, { tenant_id: "bad" }), watchRow(31, { tenant_id: "good" })];
    const d = deps();
    const latest = d.reads.latestDraft;
    d.reads.latestDraft = async (t) => {
      if (t === "bad") throw new Error("read down");
      return latest(t);
    };
    const out = await runFirstPlanWatch(d);
    expect(out).toMatchObject({ checked: 2, errors: 1, alerted: 1 });
    expect(updates.map(([t]) => t)).toEqual(["bad", "good"]);
  });
});

describe("failureClass", () => {
  it("names a fixed class, never the error text", () => {
    expect(failureClass(null)).toBe("no draft");
    expect(failureClass(draft({ error: null, status: "running" }))).toBe("none");
    expect(failureClass(draft({ status: "failed", error: "watchdog_reap: stuck" }))).toBe("infra");
    expect(failureClass(draft({ status: "failed", error: "something else" }))).toBe("other");
  });
});

describe("deletion request skip (normal tick)", () => {
  it("never starts or pages a workspace with an account deletion row; looks again in a day, not resolved", async () => {
    state.rows = [watchRow(45)];
    state.leaving = new Set([T]);
    const out = await runFirstPlanWatch(deps());
    expect(starts).toEqual([]);
    expect(alerts).toEqual([]);
    expect(emails).toEqual([]);
    expect(out).toMatchObject({ skipped_leaving: 1, resolved: 0 });
    expect(updates).toEqual([[T, { next_check_at: new Date(NOW + 24 * 60 * MIN).toISOString() }]]);
  });

  it("an unreadable deletions read starts nothing, pages no workspace, and emails ops once a day that the watch stopped", async () => {
    state.rows = [watchRow(45), watchRow(45, { tenant_id: "other" })];
    state.leaving = "throw";
    await expect(runFirstPlanWatch(deps())).rejects.toThrow(/deletions read failed/);
    expect(starts).toEqual([]);
    expect(alerts).toEqual([]);
    expect(emails).toHaveLength(1);
    expect((emails[0] as { code: string; email: { dedupeKey: string } }).email.dedupeKey).toBe("first_plan_watch_deletions_unreadable:2026-10-28");
  });

  it("the skip setting: unset means the registry default (twinpics); a stored list replaces it; a non-list fails closed", () => {
    expect(skipList(undefined)).toEqual(["d52644ab-2d94-47b2-8e33-d35016c5cf41"]);
    expect(skipList([T.toUpperCase()])).toEqual([T]);
    expect(skipList([])).toEqual([]);
    expect(() => skipList("d52644ab-2d94-47b2-8e33-d35016c5cf41")).toThrow(/list of workspace uuids/);
    expect(() => skipList([T, "d52644ab-2d94-47b2-8e33-d35016c5cf4"])).toThrow(/list of workspace uuids/);
  });
});

describe("one-time backfill", () => {
  const OLD = "11111111-1111-4111-8111-111111111111";
  const FAILED = "22222222-2222-4222-8222-222222222222";
  const FRESH = "33333333-3333-4333-8333-333333333333";
  const FROM = "2026-10-14";
  const DAY_MIN = 24 * 60;
  let drafts: Map<string, LatestDraft | null>;
  let observed: Set<string>;

  function bdeps(): FirstPlanWatchDeps {
    const d = deps();
    d.reads.latestDraft = async (t) => drafts.get(t) ?? null;
    d.reads.observed = async (_t, run_id) => observed.has(run_id);
    d.start = async (t, attempt) => {
      starts.push([t, attempt]);
      if (starts.filter(([x, a]) => x === t && a === attempt).length > 1) return { status: "already", run_id: null };
      drafts.set(t, { id: `${t}-a${attempt}`, status: "queued", cron_dedupe_key: attempt === 1 ? `cgo:draft:${t}:setup` : `cgo:draft:${t}:setup:2`, error: null, finished_at: null });
      return { status: "queued", run_id: `${t}-a${attempt}` };
    };
    return d;
  }

  beforeEach(() => {
    drafts = new Map();
    observed = new Set();
    state.progress = [
      { tenant_id: OLD, setup_connectors_at: "2026-10-14T09:00:00Z" },
      { tenant_id: FAILED, setup_connectors_at: "2026-10-21T09:00:00Z" },
      { tenant_id: FRESH, setup_connectors_at: ago(60) },
    ];
    drafts.set(FAILED, {
      id: "failed-a1",
      status: "dispatch_error",
      cron_dedupe_key: `cgo:draft:${FAILED}:setup`,
      error: "dispatch: worker lost",
      finished_at: "2026-10-21T09:10:00Z",
    });
  });

  it("enrols a 10-14 setup and a 7-day-old failed one; the normal window (last 24h) is not touched", async () => {
    const out = await runFirstPlanWatch(bdeps(), { backfillFrom: FROM });
    expect(windowArgs).toEqual(["2026-10-14T00:00:00.000Z", new Date(NOW - DAY_MIN * MIN).toISOString()]);
    expect(out.backfill.enrolled).toBe(2);
    expect(state.table.map((r) => r.tenant_id)).toEqual([OLD, FAILED]);
    expect(starts).toEqual([
      [OLD, 1],
      [FAILED, 2],
    ]);
    expect(out).toMatchObject({ started: 1, retried: 1 });
  });

  it("retries a 7-day-old dispatch_error attempt 1, but never one that executed anything", async () => {
    observed.add("failed-a1");
    const out = await runFirstPlanWatch(bdeps(), { backfillFrom: FROM });
    expect(starts).toEqual([[OLD, 1]]);
    expect(out.backfill.skipped).toEqual([{ tenant_id: FAILED, reason: "not_retried:dispatch_error" }]);
  });

  it("sends no per-workspace page and exactly one summary, ids and counts only", async () => {
    await runFirstPlanWatch(bdeps(), { backfillFrom: FROM });
    expect(alerts).toHaveLength(1);
    expect(emails).toHaveLength(1);
    const a = alerts[0] as { code: string; msg: string; email?: unknown };
    expect(a.code).toBe("first_plan_backfill");
    expect(a.email).toBeUndefined();
    expect(a.msg).toContain("started 1, retried 1");
    const e = emails[0] as { email: { dedupeKey: string; detail: string } };
    expect(e.email.dedupeKey).toBe("first_plan_backfill:2026-10-14:2026-10-28");
    for (const r of state.table) expect(r.alert_bucket).toBe(alertBucket(r.setup_connectors_at, NOW));
    expect(updates.every(([, p]) => p.alert_bucket === undefined)).toBe(true);
  });

  it("a second call starts nothing new", async () => {
    await runFirstPlanWatch(bdeps(), { backfillFrom: FROM });
    starts = [];
    const second = await runFirstPlanWatch(bdeps(), { backfillFrom: FROM });
    expect(second).toMatchObject({ started: 0, retried: 0 });
    expect(second.backfill.enrolled).toBe(0);
    expect(starts).toEqual([]);
    expect(second.checked).toBe(0);
  });

  it("skips a workspace with a deletion request (twinpics) in the backfill too", async () => {
    state.leaving = new Set([FAILED]);
    const out = await runFirstPlanWatch(bdeps(), { backfillFrom: FROM });
    expect(starts).toEqual([[OLD, 1]]);
    expect(out.backfill.skipped).toEqual([{ tenant_id: FAILED, reason: "deletion_requested" }]);
  });

  it("an unreadable deletions read starts nothing in the backfill", async () => {
    state.leaving = "throw";
    await expect(runFirstPlanWatch(bdeps(), { backfillFrom: FROM })).rejects.toThrow();
    expect(starts).toEqual([]);
  });

  it("caps starts at 25 per call; the rest come back in 2 minutes for the normal tick", async () => {
    state.progress = Array.from({ length: 30 }, (_, i) => ({
      tenant_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
      setup_connectors_at: "2026-10-15T00:00:00Z",
    }));
    drafts = new Map();
    const out = await runFirstPlanWatch(bdeps(), { backfillFrom: FROM });
    expect(out.started).toBe(BACKFILL_STARTS);
    expect(out.backfill.skipped.filter((s) => s.reason === "start_cap")).toHaveLength(5);
  });

  it("runs even when the clock is stopped by the allowlist (a person pressed it), and refuses a bad from", async () => {
    h.stopped = true;
    const out = await runFirstPlanWatch(bdeps(), { backfillFrom: FROM });
    expect(out.started).toBe(1);
    await expect(runFirstPlanWatch(bdeps(), { backfillFrom: "yesterday" })).rejects.toThrow(/invalid from/);
    await expect(runFirstPlanWatch(bdeps(), { backfillFrom: new Date(NOW).toISOString().slice(0, 10) })).rejects.toThrow(/24 hours/);
    await expect(runFirstPlanWatch(bdeps(), { backfillFrom: "2026-10-14T01:00:00Z" })).rejects.toThrow(/invalid from/);
    expect(backfillFromMs("2026-10-14")).toBe(Date.parse("2026-10-14T00:00:00Z"));
  });
});

describe("re-check right before a start", () => {
  it("a deletion request that lands mid-loop stops the start, with no page and a check tomorrow", async () => {
    let calls = 0;
    const d = deps();
    state.rows = [watchRow(45)];
    d.reads.leaving = async () => (++calls === 1 ? new Set() : new Set([T]));
    const out = await runFirstPlanWatch(d);
    expect(starts).toEqual([]);
    expect(calls).toBe(2);
    expect(alerts).toEqual([]);
    expect(emails).toEqual([]);
    expect(out).toMatchObject({ skipped_leaving: 1 });
    expect(updates).toEqual([[T, { next_check_at: new Date(NOW + 24 * 60 * MIN).toISOString() }]]);
  });

  it("a workspace marked test or deleted mid-loop is resolved excluded before attempt 2, no page", async () => {
    state.rows = [watchRow(45)];
    state.latest = draft();
    let calls = 0;
    const d = deps();
    d.reads.tenants = async (ids) => ({ slug: new Map(ids.map((id) => [id, "acme"])), excluded: ++calls === 1 ? new Set() : new Set([T]) });
    const out = await runFirstPlanWatch(d);
    expect(starts).toEqual([]);
    expect(alerts).toEqual([]);
    expect(out).toMatchObject({ resolved: 1 });
    expect(lastPatch()).toMatchObject({ resolved_reason: "excluded" });
  });

  it("a per-start re-read error on attempt 1 retries in 2 minutes, not hours", async () => {
    state.rows = [watchRow(10 * 24 * 60)];
    let calls = 0;
    const d = deps();
    d.reads.leaving = async () => {
      if (++calls === 2) throw new Error("down");
      return new Set();
    };
    const out = await runFirstPlanWatch(d);
    expect(out).toMatchObject({ errors: 1, started: 0 });
    expect(lastPatch().next_check_at).toBe(new Date(NOW + 2 * MIN).toISOString());
  });

  it("a per-start re-read failure starts nothing for that workspace and keeps going", async () => {
    let calls = 0;
    const d = deps();
    d.reads.leaving = async () => {
      calls += 1;
      if (calls === 2) throw new Error("down");
      return new Set();
    };
    state.rows = [watchRow(5, { tenant_id: "a" }), watchRow(5, { tenant_id: "b" })];
    const out = await runFirstPlanWatch(d);
    expect(starts).toEqual([["b", 1]]);
    expect(out).toMatchObject({ errors: 1, started: 1 });
  });

  it("refuses a calendar-invalid backfill day", () => {
    expect(Number.isNaN(backfillFromMs("2026-02-30"))).toBe(true);
    expect(Number.isNaN(backfillFromMs("2026-13-01"))).toBe(true);
  });
});
