import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/memory", () => ({ listNotes: vi.fn() }));
vi.mock("@/services/tenants/new-tenant-alert", () => ({
  DOGFOOD_SLUGS: new Set(["upcar-ai", "upcar-private", "apna-tutor-dogfood"]),
}));
import {
  aggregateSignupCosts,
  signupCostCohort,
  isTeamWebsite,
  type CostRun,
  type CostTenant,
} from "../signup-credit-costs";
const tenant: CostTenant = {
  id: "t",
  kind: "real",
  slug: "customer",
  created_at: "2026-11-01T00:00:00Z",
  product_url: { marketing: "https://customer.example" },
};
const since = "2026-11-05T00:00:00Z",
  until = "2026-11-19T00:00:00Z";
const run = (patch: Partial<CostRun> = {}): CostRun => ({
  id: "r",
  tenant_id: "t",
  agent_slug: "seo",
  trigger: "channel_recipe",
  enqueued_by: null,
  cron_dedupe_key: "first-run-preview:t:seo",
  status: "success",
  enqueued_at: "2026-11-10T09:00:00Z",
  finished_at: "2026-11-10T10:00:00Z",
  cost_usd: 0.001,
  build_id: null,
  ...patch,
});
const report = (
  runs: CostRun[],
  evidence = {
    refunds: [] as { tenant_id: string; run_id: string }[],
    builds: [] as { tenant_id: string; id: string }[],
  },
) =>
  aggregateSignupCosts(
    [tenant],
    runs,
    [
      {
        tenant_id: "t",
        value: { from: "filter-coffee", utm_source: "ignored" },
      },
    ],
    evidence,
    since,
    until,
  );
describe("launch signup cost report", () => {
  it("uses exact team roots and keeps customer subdomains, similar names and unknown websites", () => {
    expect(isTeamWebsite("HTTPS://WWW.UPCAR.AI/path")).toBe(true);
    expect(isTeamWebsite({ marketing: "zaviagent.com." })).toBe(true);
    for (const value of [
      "customer.zaviagent.com",
      "upcar.ai.evil.example",
      "zaviagent.com.evil.example",
      null,
      "invalid value",
    ])
      expect(isTeamWebsite(value)).toBe(false);
    const input = [
      tenant,
      { ...tenant, id: "team", product_url: "https://upcar.ai" },
      { ...tenant, id: "test", kind: "test" },
      { ...tenant, id: "dog", slug: "upcar-ai" },
      { ...tenant, id: "shell", kind: "launch_video_shell" },
      { ...tenant, id: "deleted", deleted_at: until },
      {
        ...tenant,
        id: "hosted",
        product_url: "https://customer.zaviagent.com",
      },
      { ...tenant, id: "named", slug: "microsoft" },
    ];
    expect(signupCostCohort(input).map((t) => t.id)).toEqual([
      "t",
      "hosted",
      "named",
    ]);
  });
  it("converts per run, includes failed expense, reuses source precedence and reconciles drilldown", () => {
    const result = report([run(), run({ id: "r2", status: "failed" })]);
    expect(result.credits).toBe(2);
    expect(result.usd).toBe(0.002);
    expect(result.rows[0]).toMatchObject({
      source: "filter-coffee",
      credits: 2,
      runs: 2,
      date: "2026-11-10",
    });
    expect(result.entries.reduce((n, e) => n + e.credits, 0)).toBe(
      result.credits,
    );
  });
  it("still counts a preview whose key was retired to first-run-preview-done: after an upgrade", () => {
    const result = report([
      run({ id: "done", cron_dedupe_key: "first-run-preview-done:t:seo" }),
      run({ id: "donelookalike", cron_dedupe_key: "first-run-preview-done:other:seo" }),
    ]);
    expect(result.credits).toBe(1);
    expect(result.otherRuns).toBe(1);
  });
  it("does not treat an arbitrary channel_recipe or user-written lookalike as house-paid", () => {
    const result = report([
      run({ cron_dedupe_key: null }),
      run({ id: "user", enqueued_by: "person" }),
      run({
        id: "wrongtenant",
        cron_dedupe_key: "first-run-preview:other:seo",
      }),
    ]);
    expect(result.credits).toBe(0);
    expect(result.otherRuns).toBe(3);
  });
  it("requires refund evidence and tenant-bound free build evidence", () => {
    const result = report(
      [
        run({
          id: "setup",
          agent_slug: "cgo",
          trigger: "a2a",
          cron_dedupe_key: "cgo:draft:t:setup",
          cost_usd: 1,
        }),
        run({
          id: "unrefunded",
          agent_slug: "cgo",
          trigger: "a2a",
          cron_dedupe_key: "cgo:draft:t:setup:2",
        }),
        run({
          id: "build",
          agent_slug: "engineer",
          trigger: "a2a",
          cron_dedupe_key: null,
          build_id: "build",
          cost_usd: 2,
        }),
        run({
          id: "foreign-build",
          agent_slug: "engineer",
          trigger: "a2a",
          cron_dedupe_key: null,
          build_id: "foreign",
        }),
      ],
      {
        refunds: [{ tenant_id: "t", run_id: "setup" }],
        builds: [
          { tenant_id: "t", id: "build" },
          { tenant_id: "other", id: "foreign" },
        ],
      },
    );
    expect(result.entries.map((e) => e.category).sort()).toEqual([
      "free_first_build",
      "setup_draft_subsidy",
    ]);
    expect(result.credits).toBe(1200);
  });
  it("reports full done-for-you cost over 1000 without clipping", () => {
    const result = report([
      run({ cron_dedupe_key: "done-for-you:t:1", cost_usd: 3 }),
    ]);
    expect(result.credits).toBe(1200);
    expect(result.rows[0]).toMatchObject({
      done_for_you_credits: 1200,
      over_1000_runs: 1,
    });
  });
  it("includes the server-owned first goal review and retry only", () => {
    const result = report([
      run({
        agent_slug: "cgo",
        trigger: "a2a",
        cron_dedupe_key: "t:cgo-first-review",
      }),
      run({
        id: "retry",
        agent_slug: "cgo",
        trigger: "a2a",
        cron_dedupe_key: "t:cgo-first-review:retry",
      }),
      run({
        id: "daily",
        agent_slug: "cgo",
        trigger: "a2a",
        cron_dedupe_key: "t:cgo-daily",
      }),
    ]);
    expect(result.entries).toHaveLength(2);
    expect(result.otherRuns).toBe(1);
  });
  it("shows unknown and unfinished costs separately rather than a zero", () => {
    const result = report([
      run({ cost_usd: null }),
      run({ id: "running", status: "running", finished_at: null }),
      run({ id: "zero", cost_usd: 0 }),
    ]);
    expect(result).toMatchObject({
      missingCostRuns: 1,
      unfinishedRuns: 1,
      credits: 0,
      freeOrCompedCredits: null,
    });
    expect(result.entries).toHaveLength(1);
  });
  it("uses completion UTC date and excludes runs before signup, after day 14 or outside report", () => {
    const result = report([
      run({ id: "before", enqueued_at: "2026-10-31T23:59:59Z" }),
      run({ id: "day14", finished_at: "2026-11-15T00:00:00Z" }),
      run({ id: "old", finished_at: "2026-11-04T23:59:59Z" }),
      run({ id: "boundary", finished_at: since }),
      run({ id: "foreign", tenant_id: "other" }),
    ]);
    expect(result.entries.map((e) => e.run_id)).toEqual(["boundary"]);
  });
  it("compares UTC instants, not PostgREST timestamp spellings", () => {
    const result = report([
      run({ id: "offset", finished_at: "2026-11-05T00:00:00+00:00" }),
      run({ id: "fraction", finished_at: "2026-11-05T00:00:00.000000+00:00" }),
      run({ id: "zone", finished_at: "2026-11-05T05:30:00+05:30" }),
      run({ id: "invalid", finished_at: "invalid" }),
      run({ id: "end", finished_at: "2026-11-15T05:30:00+05:30" }),
    ]);
    expect(result.entries.map((e) => e.run_id).sort()).toEqual([
      "fraction",
      "offset",
      "zone",
    ]);
    expect(result.unfinishedRuns).toBe(1);
  });
  it("counts recorded setup subsidy intent even when credits expired instead of returning", () => {
    const refundRecord = {
      tenant_id: "t",
      run_id: "setup",
      refunded_daily: 0,
      refunded_included: 0,
      refunded_purchased: 0,
      forfeited: 400,
    };
    const result = report(
      [
        run({
          id: "setup",
          agent_slug: "cgo",
          trigger: "a2a",
          cron_dedupe_key: "cgo:draft:t:setup",
          cost_usd: 1,
        }),
      ],
      { refunds: [refundRecord], builds: [] },
    );
    expect(result.entries[0]).toMatchObject({
      category: "setup_draft_subsidy",
      credits: 400,
    });
  });
});
