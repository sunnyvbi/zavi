import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ stopped: false }));
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: () => h.stopped }));

import {
  runStalledSetupTakeover,
  stalledAfterMs,
  stalledSetupDue,
  stalledSetupReads,
  stalledTickFailureLogDue,
  STALLED_WINDOW_MS,
  type StalledCandidate,
  type StalledSetupDeps,
} from "../stalled-setup";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const MIN = 60_000;
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();
const AFTER = 120 * MIN;
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function cand(over: Partial<StalledCandidate> = {}): StalledCandidate {
  return {
    tenant_id: A,
    slug: "forefield",
    kind: "real",
    created_at: ago(150),
    setup_docs_at: null,
    setup_connectors_at: null,
    setup_done_at: null,
    ...over,
  };
}

describe("stalledSetupDue: who is taken over, and when", () => {
  it("never started setup, 2 hours after signup: due (A1)", () => {
    expect(stalledSetupDue(cand({ created_at: ago(120) }), NOW, AFTER)).toEqual({ due: true, since: ago(120) });
  });

  it("one minute short of 2 hours: not yet", () => {
    expect(stalledSetupDue(cand({ created_at: ago(119) }), NOW, AFTER)).toEqual({ due: false, reason: "too_soon" });
  });

  it("Past work done, then left: the wait counts from Past work (A2)", () => {
    expect(stalledSetupDue(cand({ created_at: ago(200), setup_docs_at: ago(100) }), NOW, AFTER)).toEqual({ due: false, reason: "too_soon" });
    expect(stalledSetupDue(cand({ created_at: ago(200), setup_docs_at: ago(130) }), NOW, AFTER)).toEqual({ due: true, since: ago(130) });
  });

  it("setup finished (connectors saved, or setup done): the first plan watch already has it", () => {
    expect(stalledSetupDue(cand({ setup_connectors_at: ago(140) }), NOW, AFTER)).toEqual({ due: false, reason: "finished" });
    expect(stalledSetupDue(cand({ setup_done_at: ago(140) }), NOW, AFTER)).toEqual({ due: false, reason: "finished" });
  });

  it("signed up a day ago or more: left alone (day 1 has passed)", () => {
    expect(stalledSetupDue(cand({ created_at: new Date(NOW - STALLED_WINDOW_MS).toISOString() }), NOW, AFTER)).toEqual({ due: false, reason: "too_old" });
  });

  it("test and dogfood workspaces are never taken over", () => {
    expect(stalledSetupDue(cand({ kind: "test" }), NOW, AFTER)).toEqual({ due: false, reason: "excluded" });
    expect(stalledSetupDue(cand({ slug: "upcar-ai" }), NOW, AFTER)).toEqual({ due: false, reason: "excluded" });
  });

  it("an unclaimed launch-video shell is never taken over: only a real workspace is", () => {
    expect(stalledSetupDue(cand({ kind: "launch_video_shell" }), NOW, AFTER)).toEqual({ due: false, reason: "excluded" });
  });
});

describe("stalledTickFailureLogDue: a tick that keeps failing", () => {
  it("is logged once, then not again until an hour has passed", () => {
    expect(stalledTickFailureLogDue(NOW)).toBe(true);
    expect(stalledTickFailureLogDue(NOW + 2 * MIN)).toBe(false);
    expect(stalledTickFailureLogDue(NOW + 59 * MIN)).toBe(false);
    expect(stalledTickFailureLogDue(NOW + 60 * MIN)).toBe(true);
    expect(stalledTickFailureLogDue(NOW + 62 * MIN)).toBe(false);
  });
});

describe("stalledAfterMs: the setting", () => {
  it("unset is the 120-minute default; 0 is off", () => {
    expect(stalledAfterMs(undefined)).toBe(120 * MIN);
    expect(stalledAfterMs(0)).toBe(0);
    expect(stalledAfterMs(45)).toBe(45 * MIN);
  });

  it("anything else stops the tick", () => {
    for (const bad of ["120", -1, 1.5, 1381, null]) expect(() => stalledAfterMs(bad)).toThrow(/whole number/);
  });
});

let state: {
  setting: unknown;
  candidates: StalledCandidate[];
  leaving: Set<string> | "throw";
  setupOff: Set<string>;
  fresh: Set<string>;
  planned: Set<string>;
  skipThrows: Set<string>;
};
let calls: string[];
let window: [string, string] | null;

function deps(): StalledSetupDeps {
  return {
    reads: {
      candidates: async (from, before) => {
        window = [from, before];
        return state.candidates;
      },
      leaving: async () => {
        if (state.leaving === "throw") throw new Error("first-plan-watch deletions read failed: down");
        return state.leaving;
      },
      setupOn: async (t) => !state.setupOff.has(t),
      buildIntent: async (t) => (state.fresh.has(t) ? "fresh" : "existing"),
      hadPlanOrDraft: async (t) => state.planned.has(t),
    },
    afterSetting: async () => state.setting,
    research: async (t) => {
      calls.push(`research:${t}`);
    },
    skipSetup: async (t) => {
      if (state.skipThrows.has(t)) throw new Error("setup connectors skip failed: down");
      calls.push(`skip:${t}`);
    },
    log: async (e) => {
      calls.push(`log:${e.code}:${e.tenant_id}`);
    },
    now: () => NOW,
  };
}

beforeEach(() => {
  h.stopped = false;
  state = {
    setting: undefined,
    candidates: [cand()],
    leaving: new Set(),
    setupOff: new Set(),
    fresh: new Set(),
    planned: new Set(),
    skipThrows: new Set(),
  };
  calls = [];
  window = null;
});

describe("runStalledSetupTakeover", () => {
  it("researches the website, then marks the rest of setup skipped (which enrols the first plan watch)", async () => {
    expect(await runStalledSetupTakeover(deps())).toEqual({ checked: 1, taken: 1, skipped: 0, errors: 0 });
    expect(calls).toEqual([`research:${A}`, `skip:${A}`, `log:first_plan_stalled_setup:${A}`]);
    expect(window).toEqual([new Date(NOW - STALLED_WINDOW_MS).toISOString(), ago(120)]);
  });

  it("at most one takeover a tick; the next one goes on the next tick", async () => {
    state.candidates = [cand(), cand({ tenant_id: B, slug: "crumb-co" })];
    expect(await runStalledSetupTakeover(deps())).toMatchObject({ taken: 1 });
    expect(calls.filter((c) => c.startsWith("skip:"))).toEqual([`skip:${A}`]);
  });

  it("a workspace it must not touch is passed over, and the next one is taken", async () => {
    state.candidates = [cand(), cand({ tenant_id: B, slug: "crumb-co" })];
    for (const block of [
      () => (state.leaving = new Set([A])),
      () => state.setupOff.add(A),
      () => state.fresh.add(A),
      () => state.planned.add(A),
    ]) {
      state.leaving = new Set();
      state.setupOff.clear();
      state.fresh.clear();
      state.planned.clear();
      calls = [];
      block();
      expect(await runStalledSetupTakeover(deps())).toEqual({ checked: 2, taken: 1, skipped: 1, errors: 0 });
      expect(calls).toEqual([`research:${B}`, `skip:${B}`, `log:first_plan_stalled_setup:${B}`]);
    }
  });

  it("an unclaimed launch-video shell spends nothing; the real signup next to it is taken", async () => {
    state.candidates = [cand({ kind: "launch_video_shell" }), cand({ tenant_id: B, slug: "crumb-co" })];
    expect(await runStalledSetupTakeover(deps())).toEqual({ checked: 1, taken: 1, skipped: 0, errors: 0 });
    expect(calls).toEqual([`research:${B}`, `skip:${B}`, `log:first_plan_stalled_setup:${B}`]);
  });

  it("a setup that is not due spends nothing and reads no deletions", async () => {
    state.candidates = [cand({ created_at: ago(60) }), cand({ tenant_id: B, setup_connectors_at: ago(140) })];
    state.leaving = "throw";
    expect(await runStalledSetupTakeover(deps())).toEqual({ checked: 0, taken: 0, skipped: 0, errors: 0 });
    expect(calls).toEqual([]);
  });

  it("the deletion read failing ends the tick before any research or write", async () => {
    state.leaving = "throw";
    await expect(runStalledSetupTakeover(deps())).rejects.toThrow(/deletions read failed/);
    expect(calls).toEqual([]);
  });

  it("a failed skip write is counted and logged; it is tried again next tick", async () => {
    state.skipThrows.add(A);
    expect(await runStalledSetupTakeover(deps())).toEqual({ checked: 1, taken: 0, skipped: 0, errors: 1 });
    expect(calls).toEqual([`research:${A}`, `log:first_plan_stalled_setup_failed:${A}`]);
  });

  it("the setting at 0 turns it off; the allowlist stop stops it", async () => {
    state.setting = 0;
    expect(await runStalledSetupTakeover(deps())).toEqual({ off: true });
    state.setting = undefined;
    h.stopped = true;
    expect(await runStalledSetupTakeover(deps())).toEqual({ cron_stopped: true });
    expect(window).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a setting it cannot read or parse does nothing", async () => {
    const d = deps();
    d.afterSetting = async () => {
      throw new Error("app_setting read failed for first_plan_stalled_setup_minutes: down");
    };
    await expect(runStalledSetupTakeover(d)).rejects.toThrow(/read failed/);
    state.setting = "two hours";
    await expect(runStalledSetupTakeover(deps())).rejects.toThrow(/whole number/);
    expect(calls).toEqual([]);
  });
});

describe("stalledSetupReads (recording fake of the query builder)", () => {
  type Call = { table: string; ops: Array<[string, unknown[]]> };
  let rec: Call[];
  let results: Record<string, { data: unknown; error: { message: string } | null }>;
  const svc = () =>
    ({
      from(table: string) {
        const call: Call = { table, ops: [] };
        rec.push(call);
        const b: Record<string, unknown> = {};
        for (const op of ["select", "in", "eq", "is", "gte", "lt", "order", "limit", "like"]) {
          b[op] = (...args: unknown[]) => {
            call.ops.push([op, args]);
            return b;
          };
        }
        b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
          Promise.resolve(results[table] ?? { data: [], error: null }).then(ok, bad);
        return b;
      },
    }) as never;
  const reads = () => stalledSetupReads(svc(), { leaving: async () => new Set(), setupOn: async () => true, buildIntent: async () => "existing" });
  const op = (c: Call, name: string) => c.ops.filter(([n]) => n === name).map(([, a]) => a);

  beforeEach(() => {
    rec = [];
    results = {};
  });

  it("candidates: live signups in the window, with setup progress when there is a row", async () => {
    results.tenants = { data: [{ id: A, slug: "forefield", kind: "real", created_at: ago(150) }, { id: B, slug: "crumb-co", kind: "real", created_at: ago(140) }], error: null };
    results.tenant_first_run_progress = { data: [{ tenant_id: B, setup_docs_at: ago(139), setup_connectors_at: null, setup_done_at: null }], error: null };
    const out = await reads().candidates(ago(1440), ago(120));
    expect(out.map((c) => [c.tenant_id, c.setup_docs_at])).toEqual([[A, null], [B, ago(139)]]);
    const [t, p] = rec;
    expect(op(t!, "gte")).toEqual([["created_at", ago(1440)]]);
    expect(op(t!, "lt")).toEqual([["created_at", ago(120)]]);
    expect(op(t!, "is")).toEqual([["deleted_at", null]]);
    expect(op(p!, "in")).toEqual([["tenant_id", [A, B]]]);
  });

  it("hadPlanOrDraft: any plan, else any cgo strategy draft, each read scoped to the workspace", async () => {
    results.growth_plan = { data: [], error: null };
    results.agent_runs = { data: [{ id: "r1" }], error: null };
    expect(await reads().hadPlanOrDraft(A)).toBe(true);
    expect(op(rec[0]!, "eq")).toEqual([["tenant_id", A]]);
    expect(op(rec[1]!, "eq")).toEqual([["tenant_id", A], ["agent_slug", "cgo"]]);
    expect(op(rec[1]!, "like")).toEqual([["cron_dedupe_key", `cgo:draft:${A}:%`]]);
    results.agent_runs = { data: [], error: null };
    expect(await reads().hadPlanOrDraft(A)).toBe(false);
  });

  it("a failed read throws (the workspace is skipped this tick, never taken over on a guess)", async () => {
    results.growth_plan = { data: null, error: { message: "down" } };
    await expect(reads().hadPlanOrDraft(A)).rejects.toThrow(/plan read failed/);
    results.tenants = { data: null, error: { message: "down" } };
    await expect(reads().candidates(ago(1440), ago(120))).rejects.toThrow(/tenants read failed/);
  });
});
