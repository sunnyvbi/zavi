import { describe, it, expect } from "vitest";
import {
  buildNeedsYouNow,
  dayFraction,
  deltaPct,
  failureRate,
  lastDays,
  netScore,
  summarizeCrons,
  summarizeRuns,
  summarizeSpend,
  summarizeTenants,
  windowStartMs,
  type RunRow,
} from "../overview";
import { tallyFeedback } from "../stats";

const NOW = Date.parse("2026-10-14T18:00:00Z");
const H = 60 * 60 * 1000;
const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();

let n = 0;
function run(p: Partial<RunRow> & { at: number }): RunRow {
  const { at, ...rest } = p;
  return {
    id: `r${n++}`,
    tenant_id: "t1",
    agent_slug: "cgo",
    status: "success",
    enqueued_at: iso(at),
    finished_at: iso(at + 60_000),
    cost_usd: 0,
    cron_dedupe_key: null,
    error: null,
    ...rest,
  };
}

const quiet = {
  runs: { failed_24h: 0, failure_rate_24h: null, top_failing_agent: null },
  crons: { down: 0, degraded: 0, failing: [] },
  decisions: { pending: 0, pending_older_48h: 0 },
  stuck: { count: 0, sla_minutes: 15, oldest: [] },
  spikes: [],
};

describe("small math", () => {
  it("failure rate is null with no runs", () => {
    expect(failureRate(0, 0)).toBeNull();
    expect(failureRate(1, 4)).toBe(0.25);
  });
  it("delta is null without a baseline and rounds otherwise", () => {
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(89, 100)).toBe(-11);
    expect(deltaPct(150, 100)).toBe(50);
  });
  it("net score matches the old FeedbackBlock math", () => {
    expect(netScore(3, 2)).toBe(20);
    expect(netScore(0, 0)).toBeNull();
    expect(netScore(1, 2)).toBe(-33);
  });
  it("14 UTC days ending today, window starts at midnight UTC 13 days back", () => {
    const days = lastDays(NOW);
    expect(days).toHaveLength(14);
    expect(days[13]).toBe("2026-10-14");
    expect(days[0]).toBe("2026-10-01");
    expect(iso(windowStartMs(NOW))).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("dayFraction", () => {
  it("is the share of the UTC day elapsed", () => {
    expect(dayFraction(NOW)).toBe(0.75);
    expect(dayFraction(Date.parse("2026-10-14T00:00:00Z"))).toBe(0);
  });
});

describe("summarizeRuns", () => {
  it("counts the last 24h, the same window a week earlier, and daily buckets", () => {
    const rows = [
      run({ at: NOW - 1 * H }),
      run({ at: NOW - 2 * H, status: "failed", agent_slug: "engineer" }),
      run({ at: NOW - 3 * H, status: "parse_failed", agent_slug: "engineer" }),
      run({ at: NOW - 4 * H, status: "dispatch_error", agent_slug: "cgo" }),
      run({ at: NOW - 5 * H, status: "running" }),
      run({ at: NOW - 7 * D - 2 * H }),
      run({ at: NOW - 7 * D - 3 * H }),
      run({ at: NOW - 6 * D }),
    ];
    const s = summarizeRuns(rows, NOW);
    expect(s.last_24h).toBe(5);
    expect(s.failed_24h).toBe(3);
    expect(s.prev_week_24h).toBe(2);
    expect(s.failure_rate_24h).toBeCloseTo(0.6);
    expect(s.delta_pct).toBe(150);
    expect(s.top_failing_agent).toEqual({ agent_slug: "engineer", count: 2 });
    const today = s.daily[13];
    expect(today).toEqual({ day: "2026-10-14", ok: 1, failed: 3, other: 1 });
    expect(s.daily.reduce((a, d) => a + d.ok + d.failed + d.other, 0)).toBe(8);
  });
});

describe("summarizeTenants", () => {
  it("counts new in 7d and a cumulative daily total", () => {
    const s = summarizeTenants(
      [
        { id: "a", slug: "a", display_name: null, created_at: "2026-01-01T00:00:00Z" },
        { id: "b", slug: "b", display_name: null, created_at: iso(NOW - 2 * D) },
        { id: "c", slug: "c", display_name: null, created_at: iso(NOW - 1 * H) },
      ],
      NOW,
    );
    expect(s.total).toBe(3);
    expect(s.new_7d).toBe(2);
    expect(s.daily_total[0]).toBe(1);
    expect(s.daily_total[13]).toBe(3);
  });
});

describe("summarizeSpend", () => {
  it("today vs prior 7-day average, top tenants today, and the 3x spike rule", () => {
    const labels = new Map([
      ["t1", "Acme"],
      ["t2", "Bright"],
    ]);
    const rows: RunRow[] = [];
    for (let d = 2; d <= 7; d++) rows.push(run({ at: NOW - d * D, cost_usd: 1, tenant_id: "t1" }));
    rows.push(run({ at: NOW - 1 * D - 3 * H, cost_usd: 1, tenant_id: "t1" }));
    rows.push(run({ at: NOW - 2 * H, cost_usd: 10, tenant_id: "t1" }));
    for (let d = 1; d <= 7; d++) rows.push(run({ at: NOW - d * D - H, cost_usd: 2, tenant_id: "t2" }));
    rows.push(run({ at: NOW - 3 * H, cost_usd: 2, tenant_id: "t2" }));
    const s = summarizeSpend(rows, NOW, labels);
    expect(s.today_usd).toBe(12);
    expect(s.top_today.map((t) => t.label)).toEqual(["Acme", "Bright"]);
    expect(s.spikes).toHaveLength(1);
    expect(s.spikes[0]).toMatchObject({ tenant_id: "t1", label: "Acme", cost_24h: 10 });
    expect(s.daily_usd).toHaveLength(14);
    expect(s.avg_daily_7d_usd).toBe(3);
    expect(s.delta_pct).toBe(433);
  });
});

describe("summarizeCrons", () => {
  it("classifies enabled schedules as healthy, degraded or down", () => {
    const labels = new Map([["t1", "Acme"]]);
    const rows = [
      run({ at: NOW - H, agent_slug: "brief", cron_dedupe_key: "k1", status: "failed", error: "SendGrid 401" }),
      run({ at: NOW - 2 * H, agent_slug: "brief", cron_dedupe_key: "k2", status: "failed" }),
      run({ at: NOW - H, agent_slug: "sync", cron_dedupe_key: "k3", status: "failed" }),
      run({ at: NOW - 2 * H, agent_slug: "sync", cron_dedupe_key: "k4", status: "success" }),
      run({ at: NOW - H, agent_slug: "ok", cron_dedupe_key: "k5" }),
      run({ at: NOW - 2 * D, agent_slug: "ok", cron_dedupe_key: "k6", status: "failed" }),
      run({ at: NOW - H, agent_slug: "brief", status: "failed" }),
    ];
    const s = summarizeCrons(
      [
        { tenant_id: "t1", agent_slug: "brief", enabled: true },
        { tenant_id: "t1", agent_slug: "sync", enabled: true },
        { tenant_id: "t1", agent_slug: "ok", enabled: true },
        { tenant_id: "t1", agent_slug: "idle", enabled: true },
        { tenant_id: "t1", agent_slug: "off", enabled: false },
      ],
      rows,
      NOW,
      labels,
    );
    expect({ healthy: s.healthy, degraded: s.degraded, down: s.down }).toEqual({ healthy: 2, degraded: 1, down: 1 });
    expect(s.failing[0]).toEqual({ name: "Acme · brief", ok_24h: 0, fail_24h: 2 });
    expect(s.recent_failures).toHaveLength(2);
    expect(s.recent_failures[0]).toMatchObject({ name: "Acme · brief", error: "SendGrid 401" });
  });
});

describe("buildNeedsYouNow", () => {
  it("is empty when nothing needs attention", () => {
    expect(buildNeedsYouNow(quiet)).toEqual([]);
  });

  it("adds one row per true condition, in priority order, each linking to its page", () => {
    const rows = buildNeedsYouNow({
      runs: { failed_24h: 3, failure_rate_24h: 0.025, top_failing_agent: { agent_slug: "cgo", count: 2 } },
      crons: { down: 1, degraded: 1, failing: [{ name: "Acme · brief", ok_24h: 1, fail_24h: 2 }] },
      decisions: { pending: 39, pending_older_48h: 6 },
      stuck: { count: 2, sla_minutes: 15, oldest: [{ tenant: "Bright", agent_slug: "engineer", age_min: 41 }] },
      spikes: [{ tenant_id: "t1", label: "Acme", cost_24h: 41.2, avg_daily_7d: 6.1, x_multiple: 6.8 }],
    });
    expect(rows.map((r) => [r.kind, r.severity, r.href])).toEqual([
      ["failed_runs", "red", "/errors"],
      ["crons", "red", "/crons"],
      ["decisions", "amber", "/decisions?status=proposed"],
      ["stuck_runs", "amber", "/stuck-runs"],
      ["cost_spike", "blue", "/cost-anomaly"],
    ]);
    expect(rows[0].title).toBe("3 failed runs in the last 24h");
    expect(rows[0].detail).toBe("2.5% of runs. Most on cgo (2).");
    expect(rows[1].detail).toBe("Acme · brief failed 2 of its last 3 runs in 24h.");
    expect(rows[2].detail).toBe("6 older than 48h.");
    expect(rows[3].detail).toBe("Bright · engineer (41 min)");
    expect(rows[4].title).toBe("Cost spike on Acme");
  });

  it("uses singular wording for one item", () => {
    const rows = buildNeedsYouNow({ ...quiet, decisions: { pending: 1, pending_older_48h: 0 } });
    expect(rows[0].title).toBe("1 decision waiting for approval");
    expect(rows[0].detail).toBe("None older than 48h.");
  });
});

describe("tallyFeedback", () => {
  it("splits staff from everyone else and ignores unrated rows", () => {
    expect(
      tallyFeedback([
        { rating: 1, created_by_role: "staff" },
        { rating: -1, created_by_role: "owner" },
        { rating: 1, created_by_role: null },
        { rating: null, created_by_role: "staff" },
      ]),
    ).toEqual({ operator_up: 1, operator_down: 1, staff_up: 1, staff_down: 0 });
  });
});
