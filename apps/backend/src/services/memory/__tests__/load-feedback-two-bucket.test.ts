
import { describe, it, expect, vi, beforeEach } from "vitest";

const { serviceClientMock, setBuckets, lastQueries } = vi.hoisted(() => {
  const state: {
    recent: unknown[];
    evergreen: unknown[];
    queries: Array<{ gteCalled: boolean; tenantEq: boolean; containsArgs: unknown[][] }>;
  } = { recent: [], evergreen: [], queries: [] };

  const client = {
    from: () => {
      const trace = { gteCalled: false, tenantEq: false, containsArgs: [] as unknown[][], orArgs: [] as string[] };
      state.queries.push(trace);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string) => {
        if (col === "tenant_id") trace.tenantEq = true;
        return b;
      };
      b.gte = () => {
        trace.gteCalled = true;
        return b;
      };
      b.is = () => b;
      b.contains = (...args: unknown[]) => {
        trace.containsArgs.push(args);
        return b;
      };
      b.not = () => b;
      b.or = (f: string) => {
        trace.orArgs.push(f);
        return b;
      };
      b.order = () => b;
      b.limit = () => {
        const isEvergreen =
          !trace.gteCalled &&
          trace.containsArgs.some((a) =>
            Array.isArray(a[1]) && (a[1] as unknown[]).includes("admin-correction"),
          );
        return Promise.resolve({
          data: isEvergreen ? state.evergreen : state.recent,
          error: null,
        });
      };
      return b;
    },
  };

  return {
    serviceClientMock: vi.fn(() => client),
    setBuckets: (recent: unknown[], evergreen: unknown[]) => {
      state.recent = recent;
      state.evergreen = evergreen;
      state.queries = [];
    },
    lastQueries: () => state.queries,
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { loadRecentFeedbackForAgent, mergeFeedbackBuckets } from "../feedback-recall";

const row = (body: string, tags: string[], created_at: string) => ({
  body_markdown: body,
  tags,
  source: "praxis_staff",
  source_ref: null,
  created_at,
  note_type: "agent_feedback",
});

beforeEach(() => {
  serviceClientMock.mockClear();
});

describe("loadRecentFeedbackForAgent — two-bucket evergreen recall", () => {
  it("loads a 20-day-old admin-correction (evergreen ignores the 14d window)", async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    setBuckets(
      [],
      [row("standing correction", ["agent:support-lead", "admin-correction"], old)],
    );
    const out = await loadRecentFeedbackForAgent("t-1", "support-lead", 14);
    expect(out.some((r) => r.body_markdown === "standing correction")).toBe(true);
  });

  it("evergreen does NOT crowd out recent feedback — both buckets present", async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    setBuckets(
      [row("recent thumb", ["agent:support-lead"], now)],
      [row("old correction", ["agent:support-lead", "admin-correction"], old)],
    );
    const out = await loadRecentFeedbackForAgent("t-1", "support-lead", 14);
    const bodies = out.map((r) => r.body_markdown);
    expect(bodies).toContain("recent thumb");
    expect(bodies).toContain("old correction");
  });

  it("de-dups a note that appears in both buckets", async () => {
    const now = new Date().toISOString();
    const dupe = row("same note", ["agent:support-lead", "admin-correction"], now);
    setBuckets([dupe], [dupe]);
    const out = await loadRecentFeedbackForAgent("t-1", "support-lead", 14);
    expect(out.filter((r) => r.body_markdown === "same note").length).toBe(1);
  });

  it("recent feedback never recalls operator_preference notes (standing instructions are rules)", async () => {
    setBuckets([], []);
    await loadRecentFeedbackForAgent("t1", "engineer");
    const ors = lastQueries().flatMap((q) => (q as unknown as { orArgs: string[] }).orArgs);
    expect(ors.length).toBeGreaterThan(0);
    for (const f of ors) expect(f).not.toContain("operator_preference");
    expect(ors.join(",")).toContain("note_type.eq.agent_feedback");
  });

  it("both queries are tenant-scoped", async () => {
    setBuckets([], []);
    await loadRecentFeedbackForAgent("t-1", "support-lead", 14);
    const qs = lastQueries();
    expect(qs.length).toBe(2);
    expect(qs.every((q) => q.tenantEq)).toBe(true);
  });

  it("evergreen query does NOT apply a date window; recent query does", async () => {
    setBuckets([], []);
    await loadRecentFeedbackForAgent("t-1", "support-lead", 14);
    const qs = lastQueries();
    const evergreen = qs.find((q) =>
      q.containsArgs.some((a) => Array.isArray(a[1]) && (a[1] as unknown[]).includes("admin-correction")),
    );
    const recent = qs.find((q) => q.gteCalled);
    expect(evergreen).toBeDefined();
    expect(evergreen!.gteCalled).toBe(false);
    expect(recent).toBeDefined();
  });
});

describe("mergeFeedbackBuckets — pure", () => {
  const r = (body: string) => ({ body_markdown: body, tags: [], source: "x", source_ref: null, created_at: "2026-01-01" });
  it("evergreen comes first, then recent", () => {
    const out = mergeFeedbackBuckets([r("ever")], [r("recent")]);
    expect(out.map((x) => x.body_markdown)).toEqual(["ever", "recent"]);
  });
  it("dedups across buckets by body", () => {
    const out = mergeFeedbackBuckets([r("same")], [r("same"), r("other")]);
    expect(out.map((x) => x.body_markdown)).toEqual(["same", "other"]);
  });
});
