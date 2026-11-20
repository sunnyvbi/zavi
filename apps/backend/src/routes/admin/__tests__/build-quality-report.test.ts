import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { fake } = vi.hoisted(() => ({
  fake: {
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    missing: null as { code?: string; message: string } | null,
    feedbackError: null as { message: string } | null,
    feedbackReads: [] as Array<{ cols: string; ids: unknown }>,
  },
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: () => undefined }));
vi.mock("@/services/tenants/new-tenant-alert", () => ({ DOGFOOD_SLUGS: new Set<string>() }));
vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({
    from: (table: string) => {
      let cols = "";
      let ids: unknown = null;
      const q = {
        select: (c: string) => ((cols = c), q),
        eq: () => q,
        gte: () => q,
        order: () => q,
        limit: () => q,
        in: (_col: string, v: unknown) => ((ids = v), q),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          let out: { data: unknown; error: unknown };
          if (table === "agent_feedback") {
            fake.feedbackReads.push({ cols, ids });
            const wanted = new Set(ids as string[]);
            const rows = (fake.tables.agent_feedback ?? []).filter((r) => wanted.has(r.target_id as string));
            if (fake.feedbackError) out = { data: null, error: fake.feedbackError };
            else if (fake.missing && cols.includes("build_reasons")) out = { data: null, error: fake.missing };
            else out = { data: fake.missing ? rows.map(({ build_reasons: _drop, ...r }) => r) : rows, error: null };
          } else {
            out = { data: fake.tables[table] ?? [], error: null };
          }
          return Promise.resolve(out).then(resolve, reject);
        },
      };
      return q;
    },
  }),
}));

import { buildQualityReport, feedbackBreakdown, staffBuildQuality, toQualityRun, wilsonLow, type QualityRunInput } from "../build-quality";

const T = "t-1";
type Node = QualityRunInput["nodes"][number];
const node = (over: Partial<Node> = {}): Node => ({
  site_id: null,
  refine_mode: false,
  repair_attempts: 0,
  site_repair_attempts: 0,
  vision_qualifying: null,
  vision_status: null,
  vision_fix_outcome: null,
  ...over,
});
const build = (id: string, at: string, over: Partial<QualityRunInput> = {}, nodes: Node[] = [node({ site_id: `site-${id}` }), node({ site_id: `site-${id}` })]): QualityRunInput => ({
  id,
  tenant_id: T,
  status: "done",
  created_at: at,
  objective: `A site for ${id}`,
  parent_id: null,
  republish: false,
  nodes,
  ...over,
});
const change = (id: string, site: string, at: string, over: Partial<QualityRunInput> = {}): QualityRunInput => ({
  id,
  tenant_id: T,
  status: "done",
  created_at: at,
  objective: "change",
  parent_id: null,
  republish: false,
  nodes: [node({ site_id: site, refine_mode: true })],
  ...over,
});

const report = (runs: QualityRunInput[], feedback: Array<{ target_id: string; rating: number | null; comment: string | null }> = [], fidelity: Array<{ site_id: string; fidelity: { found?: unknown; total?: unknown; gross?: unknown } | null }> = []) =>
  buildQualityReport({ days: 14, scope: "real", runs, feedback, fidelity, slugs: { [T]: "acme" } });

describe("buildQualityReport", () => {
  it("gives each build a verdict from its rating, its changes and its checks", () => {
    const r = report(
      [
        build("good", "2026-10-01T00:00:00Z"),
        build("down", "2026-10-02T00:00:00Z"),
        build("defect", "2026-10-03T00:00:00Z", {}, [node({ site_id: "site-defect", vision_status: "reviewed", vision_qualifying: 2 })]),
        build("clean", "2026-10-04T00:00:00Z", {}, [node({ site_id: "site-clean", vision_status: "reviewed", vision_qualifying: 0 })]),
        build("unknown", "2026-10-05T00:00:00Z"),
        build("broke", "2026-10-06T00:00:00Z", { status: "failed" }),
        build("going", "2026-10-07T00:00:00Z", { status: "active" }),
        build("missed", "2026-10-07T01:00:00Z"),
      ],
      [
        { target_id: "good", rating: 1, comment: null },
        { target_id: "down", rating: -1, comment: "Looks like every other site" },
      ],
      [
        { site_id: "site-missed", fidelity: { found: 1, total: 6, gross: true } },
        { site_id: "site-good", fidelity: { found: 5, total: 5, gross: false } },
      ],
    );
    const v = Object.fromEntries(r.builds.map((b) => [b.id, b.verdict]));
    expect(v).toEqual({ good: "clean", down: "needs_review", defect: "needs_review", clean: "clean", unknown: "insufficient_data", broke: "failed", going: "in_progress", missed: "needs_review" });
    expect(r.builds.find((b) => b.id === "down")).toMatchObject({ rating: -1, rating_comment: "Looks like every other site", reasons: ["founder rated it bad"] });
    expect(r.builds.find((b) => b.id === "defect")!.reasons).toEqual(["2 visible defects at publish"]);
    expect(r.builds.find((b) => b.id === "missed")!.reasons).toEqual(["site missed most of its plan"]);
    expect(r.summary.by_verdict).toEqual({ failed: 1, needs_review: 3, clean: 2, insufficient_data: 1, in_progress: 1 });
    expect(r.summary).toMatchObject({ builds: 8, rated: 2, rated_good: 1, good_share: 0.5, checked: 4, with_visible_defect: 1 });
    expect(r.summary.avg_fidelity).toBeCloseTo((1 / 6 + 1) / 2);
    expect(r.recent_negative).toEqual([{ build_id: "down", tenant_slug: "acme", comment: "Looks like every other site" }]);
    expect(r.builds.map((b) => b.verdict).slice(0, 4)).toEqual(["failed", "needs_review", "needs_review", "needs_review"]);
  });

  it("attributes each change to the latest build of its site before it, and a bad change flags the build", () => {
    const r = report(
      [
        build("first", "2026-10-01T00:00:00Z", {}, [node({ site_id: "s1" })]),
        change("c1", "s1", "2026-10-01T01:00:00Z"),
        build("rebuild", "2026-10-02T00:00:00Z", {}, [node({ site_id: "s1" })]),
        change("c2", "s1", "2026-10-02T01:00:00Z"),
        change("c3", "s1", "2026-10-02T02:00:00Z"),
        change("orphan", "s9", "2026-10-02T02:00:00Z"),
      ],
      [
        { target_id: "c1", rating: 1, comment: null },
        { target_id: "c2", rating: -1, comment: null },
      ],
    );
    expect(r.builds.find((b) => b.id === "first")!.changes).toEqual({ total: 1, rated: 1, up: 1, down: 0 });
    expect(r.builds.find((b) => b.id === "rebuild")).toMatchObject({ verdict: "needs_review", changes: { total: 2, rated: 1, up: 0, down: 1 }, reasons: ["1 change rated bad"] });
    expect(r.summary.change_ratings).toEqual({ rated: 2, up: 1 });
    expect(r.builds).toHaveLength(2);
  });

  it("a change goes to the build it names as parent; a republish is neither a build nor a change", () => {
    const r = report(
      [
        build("first", "2026-10-01T00:00:00Z", {}, [node({ site_id: "s1" })]),
        build("rebuild", "2026-10-02T00:00:00Z", {}, [node({ site_id: "s1" })]),
        change("named", "s1", "2026-10-02T01:00:00Z", { parent_id: "first" }),
        change("pub", "s1", "2026-10-02T02:00:00Z", { republish: true }),
      ],
      [{ target_id: "named", rating: -1, comment: null }],
    );
    expect(r.builds.find((b) => b.id === "first")!.changes).toEqual({ total: 1, rated: 1, up: 0, down: 1 });
    expect(r.builds.find((b) => b.id === "rebuild")!.changes.total).toBe(0);
    expect(r.builds.map((b) => b.id).sort()).toEqual(["first", "rebuild"]);
  });

  it("a paused build that never resumed counts with the failed ones", () => {
    const r = report([build("p", "2026-10-01T00:00:00Z", { status: "paused" })]);
    expect(r.builds[0]).toMatchObject({ verdict: "failed", reasons: ["paused, never resumed"] });
  });

  it("several members: a thumbs down wins, and fix passes are counted and named", () => {
    const r = report(
      [build("b", "2026-10-01T00:00:00Z", {}, [node({ site_id: "s", repair_attempts: 1 }), node({ site_id: "s", site_repair_attempts: 2 })])],
      [
        { target_id: "b", rating: 1, comment: null },
        { target_id: "b", rating: -1, comment: "the hero is wrong" },
      ],
    );
    expect(r.builds[0]).toMatchObject({ rating: -1, fix_passes: 3, reasons: ["founder rated it bad", "3 fix passes"] });
  });

  it("an empty window is an empty report, not an error", () => {
    const r = report([]);
    expect(r.summary).toMatchObject({ builds: 0, rated: 0, good_share: null, good_share_low: null, avg_fidelity: null });
    expect(r.builds).toEqual([]);
  });
});

describe("wilsonLow", () => {
  it("never reads 1 of 1 as certain, and tightens with N", () => {
    expect(wilsonLow(0, 0)).toBeNull();
    expect(wilsonLow(1, 1)!).toBeLessThan(0.25);
    expect(wilsonLow(90, 100)!).toBeGreaterThan(0.82);
    expect(wilsonLow(90, 100)!).toBeLessThan(0.9);
  });
});

describe("toQualityRun", () => {
  it("reads the narrow node columns and skips nodes that are not there", () => {
    const run = toQualityRun({
      id: "r",
      tenant_id: T,
      status: "done",
      created_at: "2026-10-01T00:00:00Z",
      objective: null,
      s0: "site-1",
      r0: null,
      a0: "1",
      sa0: null,
      vq0: null,
      vs0: null,
      vf0: null,
      s1: "site-1",
      r1: "true",
      a1: null,
      sa1: "2",
      vq1: "3",
      vs1: "reviewed",
      vf1: "fixed",
      s2: null, r2: null, a2: null, sa2: null, vq2: null, vs2: null, vf2: null,
      p0: "parent-1",
      rp0: null,
    });
    expect(run).toMatchObject({ parent_id: "parent-1", republish: false });
    expect(run.nodes).toEqual([
      { site_id: "site-1", refine_mode: false, repair_attempts: 1, site_repair_attempts: 0, vision_qualifying: null, vision_status: null, vision_fix_outcome: null },
      { site_id: "site-1", refine_mode: true, repair_attempts: 0, site_repair_attempts: 2, vision_qualifying: 3, vision_status: "reviewed", vision_fix_outcome: "fixed" },
    ]);
  });
});

describe("feedbackBreakdown", () => {
  const runs = [
    build("b1", "2026-10-01T00:00:00Z"),
    build("b2", "2026-10-02T00:00:00Z"),
    build("b3", "2026-10-02T12:00:00Z"),
    change("c1", "site-b1", "2026-10-03T00:00:00Z"),
    build("rp", "2026-10-04T00:00:00Z", { republish: true }, [node({ site_id: "site-b1" })]),
  ];
  const feedback = [
    { target_id: "b1", rating: -1, comment: "Looks generic", build_reasons: ["look", "layout"] },
    { target_id: "c1", rating: -1, comment: null, build_reasons: ["look"] },
    { target_id: "b2", rating: 1, comment: null, build_reasons: [] },
    { target_id: "b2", rating: -1, comment: null, build_reasons: [] },
    { target_id: "b3", rating: -1, comment: null, build_reasons: ["copy", "nonsense"] },
    { target_id: "rp", rating: -1, comment: null, build_reasons: ["slow"] },
    { target_id: "ghost", rating: -1, comment: null, build_reasons: ["broken"] },
    { target_id: "c1", rating: null, comment: "just a note", build_reasons: ["missing"] },
  ];
  const sites = [
    { site_id: "site-b1", fidelity: null, chosen_direction: "brand", build_direction: "midnight", industry: "Gym" },
    { site_id: "site-b2", fidelity: null, chosen_direction: "brand", build_direction: null, industry: " gym " },
  ];

  it("counts thumbs down by reason over this window's builds and changes only, scored with the Wilson lower bound", () => {
    const b = feedbackBreakdown({ runs, feedback, sites });
    expect(b.downs).toBe(4);
    expect(b.by_reason).toEqual([
      { reason: "look", down: 2, share_low: wilsonLow(2, 4) },
      { reason: "layout", down: 1, share_low: wilsonLow(1, 4) },
      { reason: "copy", down: 1, share_low: wilsonLow(1, 4) },
      { reason: "missing", down: 0, share_low: 0 },
      { reason: "broken", down: 0, share_low: 0 },
      { reason: "slow", down: 0, share_low: 0 },
    ]);
  });

  it("groups by the look that was built (falling back to the chosen one) and by industry, worst first", () => {
    const b = feedbackBreakdown({ runs, feedback, sites });
    expect(b.by_look).toEqual([
      { key: "midnight", rated: 2, up: 0, down: 2, down_share_low: wilsonLow(2, 2) },
      { key: "unknown", rated: 1, up: 0, down: 1, down_share_low: wilsonLow(1, 1) },
      { key: "brand", rated: 2, up: 1, down: 1, down_share_low: wilsonLow(1, 2) },
    ]);
    expect(b.by_look[0]!.down_share_low).toBeCloseTo(0.3424, 3);
    expect(b.by_industry).toEqual([
      { key: "gym", rated: 4, up: 1, down: 3, down_share_low: wilsonLow(3, 4) },
      { key: "unknown", rated: 1, up: 0, down: 1, down_share_low: wilsonLow(1, 1) },
    ]);
  });

  it("is part of the report, and empty when nobody rated", () => {
    const r = buildQualityReport({ days: 14, scope: "real", runs, feedback, fidelity: sites, slugs: {} });
    expect(r.feedback_breakdown).toEqual(feedbackBreakdown({ runs, feedback, sites }));
    const none = feedbackBreakdown({ runs, feedback: [], sites });
    expect(none.downs).toBe(0);
    expect(none.by_reason!.every((x) => x.down === 0 && x.share_low === null)).toBe(true);
    expect(none.by_look).toEqual([]);
    expect(none.by_industry).toEqual([]);
  });
});

describe("GET /api/admin/build-quality on a database without the build_reasons column", () => {
  const RUNS = 150;
  const runRow = (i: number) => ({ id: `run-${i}`, tenant_id: T, status: "done", created_at: `2026-10-0${1 + (i % 5)}T00:00:00Z`, objective: `site ${i}`, s0: `site-${i}`, s1: `site-${i}` });
  const send = async () => {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
    };
    await staffBuildQuality({ query: { days: "14", scope: "all" } } as unknown as Request, res as unknown as Response);
    return res as { statusCode: number; body: ReturnType<typeof buildQualityReport> };
  };

  beforeEach(() => {
    fake.missing = null;
    fake.feedbackError = null;
    fake.feedbackReads = [];
    fake.tables = {
      tenants: [{ id: T, slug: "acme", kind: "customer" }],
      conductor_runs: Array.from({ length: RUNS }, (_, i) => runRow(i)),
      agent_feedback: [
        { target_id: "run-1", rating: -1, comment: "Looks generic", build_reasons: ["look"] },
        { target_id: "run-2", rating: 1, comment: null, build_reasons: [] },
        { target_id: "run-140", rating: -1, comment: "Wrong copy", build_reasons: ["copy"] },
      ],
      site_design_briefs: [{ site_id: "site-1", fidelity: null, chosen_direction: "brand", build_direction: "midnight", industry: "Gym" }],
    };
  });

  it("still reports every rating across chunks, without reasons, and stops asking for the column after the first miss", async () => {
    for (const missing of [
      { code: "42703", message: "column agent_feedback.build_reasons does not exist" },
      { message: "Could not find the 'build_reasons' column of 'agent_feedback' in the schema cache" },
    ]) {
      fake.missing = missing;
      fake.feedbackReads = [];
      const res = await send();
      expect(res.statusCode).toBe(200);
      expect(res.body.summary).toMatchObject({ builds: RUNS, rated: 3, rated_good: 1 });
      expect(res.body.summary.by_verdict.needs_review).toBe(2);
      expect(res.body.recent_negative.map((n) => n.comment).sort()).toEqual(["Looks generic", "Wrong copy"]);
      expect(res.body.feedback_breakdown.downs).toBe(2);
      expect(res.body.feedback_breakdown.by_reason).toBeNull();
      expect(res.body.feedback_breakdown.by_look.find((g) => g.key === "midnight")).toMatchObject({ rated: 1, down: 1 });
      expect(fake.feedbackReads.map((r) => [r.cols, (r.ids as string[]).length])).toEqual([
        ["target_id, rating, comment, build_reasons", 100],
        ["target_id, rating, comment", 100],
        ["target_id, rating, comment", 50],
      ]);
    }
  });

  it("with the column it keeps counting reasons", async () => {
    const res = await send();
    expect(res.statusCode).toBe(200);
    const by = Object.fromEntries(res.body.feedback_breakdown.by_reason!.map((r) => [r.reason, r.down]));
    expect(by).toMatchObject({ look: 1, copy: 1 });
    expect(fake.feedbackReads.map((r) => r.cols)).toEqual(["target_id, rating, comment, build_reasons", "target_id, rating, comment, build_reasons"]);
  });

  it("any other feedback read error is still a 500", async () => {
    fake.feedbackError = { message: "permission denied for table agent_feedback" };
    const res = await send();
    expect(res.statusCode).toBe(500);
    expect(fake.feedbackReads).toHaveLength(1);
  });
});
