
import { describe, it, expect, vi, beforeEach } from "vitest";

type ChainResult = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
  count?: number | null;
};

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  tableResults: {} as Record<string, ChainResult[]>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

vi.mock("@/services/supabase", () => {
  function makeChain(table: string): Record<string, unknown> {
    const result = (mocks.tableResults[table] ?? []).shift() ?? {
      data: [],
      error: null,
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      contains: () => chain,
      is: () => chain,
      not: () => chain,
      gte: () => chain,
      gt: () => chain,
      lt: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(result),
      then: (
        onFulfilled: (v: ChainResult) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return chain;
  }
  return {
    serverClientFromBearer: () => ({ from: (table: string) => makeChain(table) }),
    serviceClient: () => ({ from: (table: string) => makeChain(table) }),
  };
});

import { workspaceMorningBrief } from "../morning-brief";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function resetTableResults() {
  for (const k of Object.keys(mocks.tableResults)) {
    delete mocks.tableResults[k];
  }
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  resetTableResults();
  mocks.requireAuth.mockResolvedValue({
    tenant_id: "tnt-1",
    user_id: "user-1",
    access_token: "tok",
  });
});

describe("workspaceMorningBrief", () => {
  it("401s when requireAuth fails (no DB calls)", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();
    await workspaceMorningBrief({} as never, res as never);
    expect(res.body).toBeUndefined();
  });

  it("200s with the documented shape on the happy path", async () => {
    const now = new Date();
    const recentIso = new Date(now.getTime() - 60_000).toISOString();

    mocks.tableResults["conductor_runs"] = [
      {
        data: [
          { id: "b1", status: "done", kind: "build_app", created_at: recentIso },
          { id: "b2", status: "failed", kind: "build_app", created_at: recentIso },
          { id: "b3", status: "active", kind: "build_app", created_at: recentIso },
        ],
        error: null,
      },
      {
        data: [
          { id: "p1", objective: "Launch X", created_at: recentIso },
        ],
        error: null,
      },
      {
        data: [
          { id: "b1", objective: "Build X", status: "done", kind: "build_app", updated_at: recentIso },
          { id: "b2", objective: "Build Y", status: "failed", kind: "build_app", updated_at: recentIso },
        ],
        error: null,
      },
      {
        data: [
          { id: "p1", objective: "Launch X", created_at: recentIso },
        ],
        error: null,
      },
    ];
    mocks.tableResults["agent_runs"] = [
      {
        data: [{ cost_usd: 1.25 }, { cost_usd: "0.75" }],
        error: null,
      },
    ];
    mocks.tableResults["decisions"] = [{ count: 4, data: null, error: null }];
    mocks.tableResults["autopilot_goals"] = [
      {
        data: [
          {
            objective: "Get to $1M ARR",
            target_metric: "arr_usd",
            current_value: 100,
            target_value: 1000000,
            status: "active",
          },
          {
            objective: "Hit 200 customers",
            target_metric: "customer_count",
            current_value: 100,
            target_value: 200,
            status: "active",
          },
        ],
        error: null,
      },
    ];
    mocks.tableResults["refine_suggestions"] = [
      { count: 1, data: null, error: null },
    ];
    mocks.tableResults["autopilot_action_ledger"] = [
      {
        data: [
          {
            id: "lg-1",
            conductor_run_id: "b1",
            action: "undo",
            target_agent_slug: "engineer",
            created_at: recentIso,
          },
        ],
        error: null,
      },
    ];

    const res = mockRes();
    await workspaceMorningBrief({} as never, res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      yesterday: {
        builds_started: number;
        builds_done: number;
        builds_failed: number;
        spend_usd: number;
        pr_count: number | null;
      };
      today: {
        proposed_plans: number;
        pending_suggestions: number | null;
        pending_approvals: number;
      };
      goals: Array<{
        objective: string;
        target_metric: string;
        current_value: number | null;
        target_value: number | null;
        status: string;
      }>;
      recent_activity: Array<{
        kind: "build_done" | "plan_proposed" | "suggestion" | "undo";
        label: string;
        at: string;
        link: string | null;
      }>;
    };

    expect(Object.keys(body).sort()).toEqual(
      ["goals", "recent_activity", "standup_atoms", "today", "top_decisions", "yesterday"],
    );

    expect(body.yesterday.builds_started).toBe(3);
    expect(body.yesterday.builds_done).toBe(1);
    expect(body.yesterday.builds_failed).toBe(1);
    expect(body.yesterday.spend_usd).toBeCloseTo(2.0, 5);
    expect(body.yesterday.pr_count).toBeNull();

    expect(body.today.proposed_plans).toBe(1);
    expect(body.today.pending_suggestions).toBe(1);
    expect(body.today.pending_approvals).toBe(4);

    expect(body.goals.length).toBe(2);
    expect(body.goals[0]?.objective).toBe("Get to $1M ARR");
    expect(body.goals[0]?.current_value).toBe(100);
    expect(body.goals[0]?.target_value).toBe(1000000);

    expect(body.recent_activity.length).toBe(4);
    const kinds = body.recent_activity.map((a) => a.kind).sort();
    expect(kinds).toEqual(["build_done", "build_done", "plan_proposed", "undo"]);
  });

  it("defensively returns null/[]/0 when optional tables are missing (42P01)", async () => {
    mocks.tableResults["conductor_runs"] = [
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];
    mocks.tableResults["agent_runs"] = [{ data: [], error: null }];
    mocks.tableResults["decisions"] = [{ count: 0, data: null, error: null }];
    mocks.tableResults["autopilot_goals"] = [
      { data: null, error: { code: "42P01", message: 'relation "autopilot_goals" does not exist' } },
    ];
    mocks.tableResults["refine_suggestions"] = [
      { data: null, count: null, error: { code: "42P01", message: 'relation "refine_suggestions" does not exist' } },
    ];
    mocks.tableResults["autopilot_action_ledger"] = [{ data: [], error: null }];

    const res = mockRes();
    await workspaceMorningBrief({} as never, res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      yesterday: { builds_started: number; spend_usd: number; pr_count: number | null };
      today: { pending_suggestions: number | null; proposed_plans: number; pending_approvals: number };
      goals: unknown[];
      recent_activity: unknown[];
    };

    expect(body.yesterday.builds_started).toBe(0);
    expect(body.yesterday.spend_usd).toBe(0);
    expect(body.yesterday.pr_count).toBeNull();

    expect(body.today.proposed_plans).toBe(0);
    expect(body.today.pending_approvals).toBe(0);
    expect(body.today.pending_suggestions).toBeNull();

    expect(body.goals).toEqual([]);
    expect(body.recent_activity).toEqual([]);
  });

  it("treats a PostgREST-style PGRST205 missing-table error the same as 42P01", async () => {
    mocks.tableResults["conductor_runs"] = [
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];
    mocks.tableResults["agent_runs"] = [{ data: [], error: null }];
    mocks.tableResults["decisions"] = [{ count: 0, data: null, error: null }];
    mocks.tableResults["autopilot_goals"] = [{ data: [], error: null }];
    mocks.tableResults["refine_suggestions"] = [
      { data: null, count: null, error: { code: "PGRST205", message: "Could not find the table 'public.refine_suggestions'" } },
    ];
    mocks.tableResults["autopilot_action_ledger"] = [{ data: [], error: null }];

    const res = mockRes();
    await workspaceMorningBrief({} as never, res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { today: { pending_suggestions: number | null } }).today.pending_suggestions)
      .toBeNull();
  });
});
