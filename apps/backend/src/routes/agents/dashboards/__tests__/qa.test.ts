
import { describe, it, expect, vi, afterEach } from "vitest";
import { build } from "../qa";
import type { DashboardContext } from "../_contract";

type Row = Record<string, unknown> & { tenant_id?: string };

function makeSb(tables: Record<string, Row[]>) {
  function chain(table: string) {
    const eqs: Record<string, unknown> = {};
    const gts: Record<string, unknown> = {};
    const c: Record<string, unknown> = {
      select: () => c,
      order: () => c,
      limit: () => c,
      in: () => c,
      eq(col: string, val: unknown) {
        eqs[col] = val;
        return c;
      },
      gt(col: string, val: unknown) {
        gts[col] = val;
        return c;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        const rows = (tables[table] ?? []).filter((r) => {
          for (const [k, v] of Object.entries(eqs)) {
            if ((r as Record<string, unknown>)[k] !== v) return false;
          }
          for (const [k, v] of Object.entries(gts)) {
            const cell = (r as Record<string, unknown>)[k];
            if (cell === undefined || cell === null || String(cell) <= String(v))
              return false;
          }
          return true;
        });
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return c;
  }
  return { from: (t: string) => chain(t) };
}

function ctx(tenantId: string, tables: Record<string, Row[]>): DashboardContext {
  return {
    tenantId,
    sb: makeSb(tables),
  } as unknown as DashboardContext;
}

const TA = "tenant-a";
const TB = "tenant-b";

function digest(tenant_id: string, emitted_at: string, pass: number, fails: string[], blocked: string[]) {
  const ran = pass + fails.length + blocked.length;
  return {
    tenant_id,
    decision_class: "qa.weekly-digest",
    emitted_at,
    body: {
      tier1: fails.map((f) => ({ category: "qa-test-fail", summary: f })),
      tier3: blocked.map((b) => ({ category: "qa-test-blocked", summary: b })),
      tier4: [
        {
          category: "qa-weekly-execute",
          summary: `Ran ${ran}: ${pass} pass / ${fails.length} fail / ${blocked.length} blocked.`,
        },
      ],
    },
  };
}

describe("qa dashboard builder — execution richness", () => {
  it("parses latest run + trend + red/brittle/healed from real persisted data", async () => {
    const tables: Record<string, Row[]> = {
      test_cases: [
        {
          tenant_id: TA,
          status: "active",
          id: "c1",
          title: "Guest can sign up",
          role: "guest",
          created_by: "agent-onboarding",
          created_at: "2026-06-01T00:00:00Z",
          manual_tested_at: null,
          last_status: "passed",
          consecutive_red: 0,
          last_run_at: "2026-06-20T00:00:00Z",
          last_healed_at: null,
        },
        {
          tenant_id: TA,
          status: "muted",
          id: "c2",
          title: "Host can edit listing price",
          role: "host",
          created_by: "operator-chat",
          created_at: "2026-06-02T00:00:00Z",
          manual_tested_at: null,
          last_status: "failed",
          consecutive_red: 4,
          last_run_at: "2026-06-20T00:00:00Z",
          last_healed_at: null,
        },
        {
          tenant_id: TA,
          status: "active",
          id: "c3",
          title: "Public pricing loads",
          role: "public",
          created_by: "agent-onboarding",
          created_at: "2026-06-03T00:00:00Z",
          manual_tested_at: null,
          last_status: "healed",
          consecutive_red: 0,
          last_run_at: "2026-06-19T00:00:00Z",
          last_healed_at: "2026-06-19T00:00:00Z",
        },
      ],
      agent_runs: [],
      run_artifacts: [],
      decisions: [
        digest(TA, "2026-06-20T01:00:00Z", 5, ["FAIL: Host can edit listing price"], ["BLOCKED (needs_write): X"]),
        digest(TA, "2026-06-13T01:00:00Z", 6, [], []),
        digest(TA, "2026-06-06T01:00:00Z", 4, ["FAIL: a"], []),
      ],
    };

    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    const exec = payload.execution as {
      latest: { ran: number; pass: number; fail: number; blocked: number; pass_rate: number | null };
      trend: Array<{ pass_rate: number | null }>;
      red_now: number;
      brittle: Array<{ title: string; consecutive_red: number }>;
      healed: number;
      last_executed_at: string | null;
    };

    expect(exec).toBeTruthy();
    expect(exec.latest).toMatchObject({ ran: 7, pass: 5, fail: 1, blocked: 1 });
    expect(exec.latest.pass_rate).toBe(83);
    expect(exec.trend).toHaveLength(3);
    expect(exec.trend[exec.trend.length - 1].pass_rate).toBe(83);
    expect(exec.red_now).toBe(1);
    expect(exec.healed).toBe(1);
    expect(exec.brittle).toHaveLength(1);
    expect(exec.brittle[0].title).toBe("Host can edit listing price");
    expect(exec.brittle[0].consecutive_red).toBe(4);
    expect(exec.last_executed_at).toBe("2026-06-20T00:00:00Z");

    const attention = payload.attention as Array<{ severity: string; title: string }>;
    expect(attention[0].severity).toBe("high");
    expect(attention[0].title).toContain("is brittle");
  });

  it("CROSS-TENANT: tenant A's panel excludes tenant B's cases AND digests", async () => {
    const tables: Record<string, Row[]> = {
      test_cases: [
        {
          tenant_id: TB,
          status: "muted",
          id: "b1",
          title: "B-SECRET host flow",
          role: "host",
          created_by: "operator-chat",
          created_at: "2026-06-01T00:00:00Z",
          manual_tested_at: null,
          last_status: "failed",
          consecutive_red: 9,
          last_run_at: "2026-06-20T00:00:00Z",
          last_healed_at: null,
        },
        {
          tenant_id: TA,
          status: "active",
          id: "a1",
          title: "A guest signup",
          role: "guest",
          created_by: "agent-onboarding",
          created_at: "2026-06-01T00:00:00Z",
          manual_tested_at: null,
          last_status: "passed",
          consecutive_red: 0,
          last_run_at: "2026-06-20T00:00:00Z",
          last_healed_at: null,
        },
      ],
      agent_runs: [],
      run_artifacts: [],
      decisions: [
        digest(TB, "2026-06-20T01:00:00Z", 0, ["x", "y", "z"], []),
        digest(TA, "2026-06-20T02:00:00Z", 1, [], []),
      ],
    };

    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    const exec = payload.execution as {
      latest: { pass: number; fail: number };
      red_now: number;
      brittle: Array<{ title: string }>;
    };
    const cases = payload.cases as Array<{ title: string }>;
    const attention = payload.attention as Array<{ title: string }>;

    expect(cases.map((x) => x.title)).toEqual(["A guest signup"]);
    expect(exec.latest).toMatchObject({ pass: 1, fail: 0 });
    expect(exec.red_now).toBe(0);
    expect(exec.brittle).toHaveLength(0);
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain("B-SECRET");
    expect(blob).not.toContain(TB);
    expect(attention.some((a) => /B-SECRET/.test(a.title))).toBe(false);
  });

  it("ignores a non-execution qa.weekly-digest (no 'Ran N:' signature)", async () => {
    const tables: Record<string, Row[]> = {
      test_cases: [
        {
          tenant_id: TA,
          status: "active",
          id: "c1",
          title: "Guest signup",
          role: "guest",
          created_by: "agent-onboarding",
          created_at: "2026-06-01T00:00:00Z",
          manual_tested_at: null,
          last_status: null,
          consecutive_red: 0,
          last_run_at: null,
          last_healed_at: null,
        },
      ],
      agent_runs: [],
      run_artifacts: [],
      decisions: [
        {
          tenant_id: TA,
          decision_class: "qa.weekly-digest",
          emitted_at: "2026-06-20T00:00:00Z",
          body: {
            tier1: [],
            tier2: [],
            tier3: [],
            tier4: [
              {
                category: "qa-weekly-execute",
                summary:
                  "Blocked: connect your staging site — no tests were run. Set the Staging URL in QA Setup.",
              },
            ],
          },
        },
      ],
    };

    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    expect(payload.execution).toBeUndefined();
  });

  it("first-time tenant (never executed) → execution block is undefined", async () => {
    const tables: Record<string, Row[]> = {
      test_cases: [
        {
          tenant_id: TA,
          status: "active",
          id: "c1",
          title: "Guest signup",
          role: "guest",
          created_by: "agent-onboarding",
          created_at: "2026-06-01T00:00:00Z",
          manual_tested_at: null,
          last_status: null,
          consecutive_red: 0,
          last_run_at: null,
          last_healed_at: null,
        },
      ],
      agent_runs: [],
      run_artifacts: [],
      decisions: [],
    };

    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    expect(payload.execution).toBeUndefined();
    expect((payload.cases as unknown[]).length).toBe(1);
  });
});

describe("qa dashboard builder — in-flight pipeline status", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type ARun = Row & {
    trigger: string;
    status: string;
    enqueued_at: string;
    correlation_id: string | null;
  };
  const qaRun = (
    tenant_id: string,
    status: string,
    enqueued_at: string,
    correlation_id: string | null,
  ): ARun => ({
    tenant_id,
    trigger: "qa-weekly-execute",
    status,
    enqueued_at,
    correlation_id,
  });

  it("derives done/total for the running batch only (correlation_id-isolated)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T12:00:00Z"));
    const start = "2026-06-22T11:58:00Z";
    const CID = "qa-weekly:tenant-a:1782000000000";

    const tables: Record<string, Row[]> = {
      test_cases: [],
      decisions: [],
      run_artifacts: [],
      agent_runs: [
        qaRun(TA, "success", start, CID),
        qaRun(TA, "running", start, CID),
        qaRun(TA, "queued", start, CID),
        qaRun(TA, "success", "2026-06-22T11:50:00Z", "qa-weekly:tenant-a:1781999000000"),
        qaRun(TA, "failed", "2026-06-22T11:50:00Z", "qa-weekly:tenant-a:1781999000000"),
        qaRun(TB, "running", start, "qa-weekly:tenant-b:1782000000000"),
      ],
    };

    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    const inf = payload.in_flight as {
      total: number;
      done: number;
      started_at: string;
    };
    expect(inf).toBeTruthy();
    expect(inf.total).toBe(3);
    expect(inf.done).toBe(1);
    expect(new Date(inf.started_at).getTime()).toBe(new Date(start).getTime());
  });

  it("counts blocked as active, not done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T12:00:00Z"));
    const start = "2026-06-22T11:59:00Z";
    const CID = "qa-weekly:tenant-a:1782000111000";
    const tables: Record<string, Row[]> = {
      test_cases: [],
      decisions: [],
      run_artifacts: [],
      agent_runs: [
        qaRun(TA, "success", start, CID),
        qaRun(TA, "blocked", start, CID),
        qaRun(TA, "running", start, CID),
      ],
    };
    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    const inf = payload.in_flight as { total: number; done: number };
    expect(inf.total).toBe(3);
    expect(inf.done).toBe(1);
  });

  it("returns null in_flight when nothing is queued/running/blocked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T12:00:00Z"));
    const CID = "qa-weekly:tenant-a:1782000222000";
    const tables: Record<string, Row[]> = {
      test_cases: [],
      decisions: [],
      run_artifacts: [],
      agent_runs: [
        qaRun(TA, "success", "2026-06-22T11:55:00Z", CID),
        qaRun(TA, "failed", "2026-06-22T11:55:00Z", CID),
      ],
    };
    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    expect(payload.in_flight).toBeNull();
  });

  it("ignores a stuck run older than the 50-min window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T12:00:00Z"));
    const tables: Record<string, Row[]> = {
      test_cases: [],
      decisions: [],
      run_artifacts: [],
      agent_runs: [
        qaRun(TA, "running", "2026-06-22T10:30:00Z", "qa-weekly:tenant-a:1781990000000"),
      ],
    };
    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    expect(payload.in_flight).toBeNull();
  });

  it("degrades to a 1-row batch when the active row has no correlation_id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T12:00:00Z"));
    const tables: Record<string, Row[]> = {
      test_cases: [],
      decisions: [],
      run_artifacts: [],
      agent_runs: [
        qaRun(TA, "running", "2026-06-22T11:59:30Z", null),
        qaRun(TA, "success", "2026-06-22T11:40:00Z", "qa-weekly:tenant-a:1781998000000"),
      ],
    };
    const payload = (await build(ctx(TA, tables))) as Record<string, unknown>;
    const inf = payload.in_flight as { total: number; done: number };
    expect(inf.total).toBe(1);
    expect(inf.done).toBe(0);
  });
});
