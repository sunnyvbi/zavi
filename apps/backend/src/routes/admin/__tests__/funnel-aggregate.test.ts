
import { describe, it, expect } from "vitest";
import {
  aggregateFunnel,
  signupSource,
  type FunnelTenant,
  type FunnelRunInput,
  type FunnelFeedbackInput,
} from "../funnel";

describe("aggregateFunnel", () => {
  it("empty input → zero totals, empty rows", () => {
    expect(aggregateFunnel([], [], [])).toEqual({
      totals: { signed_up: 0, ran: 0, gave_feedback: 0 },
      rows: [],
      sources: [],
    });
  });

  it("counts signups for every tenant even with no runs/feedback", () => {
    const tenants: FunnelTenant[] = [
      { id: "t1", created_at: "2026-01-01T00:00:00Z" },
      { id: "t2", created_at: "2026-01-02T00:00:00Z" },
    ];
    const out = aggregateFunnel(tenants, [], []);
    expect(out.totals).toEqual({ signed_up: 2, ran: 0, gave_feedback: 0 });
    expect(out.rows).toEqual([
      { tenant_id: "t1", source: {source:"Unknown",kind:"unknown"}, signed_up_at: "2026-01-01T00:00:00Z", first_run_at: null, first_feedback_at: null },
      { tenant_id: "t2", source: {source:"Unknown",kind:"unknown"}, signed_up_at: "2026-01-02T00:00:00Z", first_run_at: null, first_feedback_at: null },
    ]);
  });

  it("first_run_at = earliest started_at across a tenant's runs", () => {
    const tenants: FunnelTenant[] = [{ id: "t1", created_at: "2026-01-01T00:00:00Z" }];
    const runs: FunnelRunInput[] = [
      { tenant_id: "t1", started_at: "2026-01-05T00:00:00Z", enqueued_at: "2026-01-04T00:00:00Z" },
      { tenant_id: "t1", started_at: "2026-01-03T00:00:00Z", enqueued_at: "2026-01-02T00:00:00Z" },
    ];
    const out = aggregateFunnel(tenants, runs, []);
    expect(out.rows[0].first_run_at).toBe("2026-01-03T00:00:00Z");
    expect(out.totals.ran).toBe(1);
  });

  it("falls back to enqueued_at when started_at is null", () => {
    const tenants: FunnelTenant[] = [{ id: "t1", created_at: "2026-01-01T00:00:00Z" }];
    const runs: FunnelRunInput[] = [
      { tenant_id: "t1", started_at: null, enqueued_at: "2026-01-02T00:00:00Z" },
    ];
    const out = aggregateFunnel(tenants, runs, []);
    expect(out.rows[0].first_run_at).toBe("2026-01-02T00:00:00Z");
    expect(out.totals.ran).toBe(1);
  });

  it("a run with neither started_at nor enqueued_at is ignored (tenant stays un-ran)", () => {
    const tenants: FunnelTenant[] = [{ id: "t1", created_at: "2026-01-01T00:00:00Z" }];
    const runs: FunnelRunInput[] = [{ tenant_id: "t1", started_at: null, enqueued_at: null }];
    const out = aggregateFunnel(tenants, runs, []);
    expect(out.rows[0].first_run_at).toBeNull();
    expect(out.totals.ran).toBe(0);
  });

  it("first_feedback_at = earliest feedback created_at; feedback counts only when present", () => {
    const tenants: FunnelTenant[] = [
      { id: "t1", created_at: "2026-01-01T00:00:00Z" },
      { id: "t2", created_at: "2026-01-01T00:00:00Z" },
    ];
    const feedback: FunnelFeedbackInput[] = [
      { tenant_id: "t1", created_at: "2026-01-10T00:00:00Z" },
      { tenant_id: "t1", created_at: "2026-01-08T00:00:00Z" },
    ];
    const out = aggregateFunnel(tenants, [], feedback);
    const t1 = out.rows.find((r) => r.tenant_id === "t1")!;
    const t2 = out.rows.find((r) => r.tenant_id === "t2")!;
    expect(t1.first_feedback_at).toBe("2026-01-08T00:00:00Z");
    expect(t2.first_feedback_at).toBeNull();
    expect(out.totals.gave_feedback).toBe(1);
  });

  it("runs/feedback for an unknown tenant don't create phantom rows", () => {
    const tenants: FunnelTenant[] = [{ id: "t1", created_at: "2026-01-01T00:00:00Z" }];
    const runs: FunnelRunInput[] = [
      { tenant_id: "ghost", started_at: "2026-01-02T00:00:00Z", enqueued_at: null },
    ];
    const feedback: FunnelFeedbackInput[] = [{ tenant_id: "ghost", created_at: "2026-01-03T00:00:00Z" }];
    const out = aggregateFunnel(tenants, runs, feedback);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].tenant_id).toBe("t1");
    expect(out.totals).toEqual({ signed_up: 1, ran: 0, gave_feedback: 0 });
  });

  it("full monotonic funnel: signed_up >= ran >= gave_feedback", () => {
    const tenants: FunnelTenant[] = [
      { id: "a", created_at: "2026-01-01T00:00:00Z" },
      { id: "b", created_at: "2026-01-01T00:00:00Z" },
      { id: "c", created_at: "2026-01-01T00:00:00Z" },
    ];
    const runs: FunnelRunInput[] = [
      { tenant_id: "a", started_at: "2026-01-02T00:00:00Z", enqueued_at: null },
      { tenant_id: "b", started_at: "2026-01-02T00:00:00Z", enqueued_at: null },
    ];
    const feedback: FunnelFeedbackInput[] = [{ tenant_id: "a", created_at: "2026-01-03T00:00:00Z" }];
    const out = aggregateFunnel(tenants, runs, feedback);
    expect(out.totals).toEqual({ signed_up: 3, ran: 2, gave_feedback: 1 });
  });
});

it.each(["github.com", "slack.com", "app.slack.com", "team.slack.com"])("does not count an auth return from %s as acquisition", referrer_host => {
  expect(signupSource({landing_path: "/workspace", referrer_host})).toEqual({source: "Unknown", kind: "unknown"});
  expect(signupSource({landing_path: "/auth/callback", referrer_host})).toEqual({source: "Unknown", kind: "unknown"});
  expect(signupSource({landing_path: "/workspace", referrer_host, from: "filter-coffee"})).toEqual({source: "filter-coffee", kind: "from"});
});
it("keeps real outside referrals to login and marketing pages", () => {
  expect(signupSource({landing_path: "/login", referrer_host: "newsletter.example"})).toEqual({source: "newsletter.example", kind: "referrer"});
  expect(signupSource({landing_path: "/pricing", referrer_host: "github.com"})).toEqual({source: "github.com", kind: "referrer"});
  expect(signupSource({landing_path: "/login", referrer_host: "www.zaviagent.com"})).toEqual({source: "Unknown", kind: "unknown"});
});

it("counts every workspace once by source, preserving unknown and explicit direct evidence", () => {
  const tenants = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, created_at: "2026-11-01T00:00:00Z" }));
  const attrs = [
    { tenant_id: "t0", value: { from: "filter-coffee", utm_source: "email", referrer_host: "example.com" } },
    { tenant_id: "t1", value: { utm_source: "email" } },
    { tenant_id: "t2", value: { referrer_host: "example.com" } },
    { tenant_id: "t3", value: { landing_path: "/pricing" } },
    { tenant_id: "t4", value: { utm_campaign: "launch2" } },
    { tenant_id: "t5", value: { from: "unknown" } },
    { tenant_id: "outside", value: { from: "not-in-cohort" } },
  ];
  const result = aggregateFunnel(tenants, [], [], attrs);
  expect(result.sources).toEqual(expect.arrayContaining([
    { source: "Unknown", kind: "unknown", signups: 2 },
    { source: "Direct", kind: "direct", signups: 1 },
    { source: "filter-coffee", kind: "from", signups: 1 },
    { source: "email", kind: "utm_source", signups: 1 },
    { source: "example.com", kind: "referrer", signups: 1 },
    { source: "unknown", kind: "from", signups: 1 },
  ]));
  expect(result.sources.reduce((n, row) => n + row.signups, 0)).toBe(result.totals.signed_up);
});

it("a first touch captured on the sign-in page or an identity-provider return is not a source", () => {
  const tenants = ["login", "google", "ms", "real"].map(id => ({ id, created_at: "2026-11-01T00:00:00Z" }));
  const attrs = [
    { tenant_id: "login", value: { landing_path: "/login" } },
    { tenant_id: "google", value: { landing_path: "/workspace", referrer_host: "accounts.google.com" } },
    { tenant_id: "ms", value: { landing_path: "/auth/callback", referrer_host: "login.microsoftonline.com" } },
    { tenant_id: "real", value: { landing_path: "/pricing", referrer_host: "t.co" } },
  ];
  expect(aggregateFunnel(tenants, [], [], attrs).sources).toEqual(expect.arrayContaining([
    { source: "Unknown", kind: "unknown", signups: 3 },
    { source: "t.co", kind: "referrer", signups: 1 },
  ]));
});
