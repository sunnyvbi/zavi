import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/agents/conductor-driver", () => ({ realConductorTickDeps: {} }));

import { handleBuildScreenCheck, buildScreenCheckFn, BUILD_SCREEN_CHECK_REQUESTED } from "../build-screen-check";
import type { BuildScreenCheckDeps } from "../build-screen-check";
import type { ConductorNode } from "@/services/agents/conductor";
import type { ScreenCheckRecord } from "@/services/qa/post-deploy-screen-check";

const RUN = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";
const TENANT = "a7ec7367-acc8-4abc-995b-7da60a572de3";

type Row = {
  id: string;
  tenant_id: string;
  kind: string | null;
  goal_graph: ConductorNode[];
  updated_at: string | null;
};

const pass: ScreenCheckRecord = { status: "pass", checked_at: "2026-09-29T00:00:00.000Z", fails: [] };

function graph(overrides: Partial<ConductorNode> = {}): ConductorNode[] {
  return [
    { id: "b", status: "done", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 3, child_run_id: "c" },
    {
      id: "d",
      status: "done",
      target_agent_slug: "",
      payload: { stage: "deploy", tenant_id: "evil" },
      estimate_usd: 0,
      child_run_id: null,
      ...overrides,
    },
  ];
}

function fakeDb(initial: Row | null, opts: { halted?: boolean; haltErr?: boolean } = {}) {
  const db = { row: initial ? (JSON.parse(JSON.stringify(initial)) as Row) : null };
  const updates: Array<{ filters: Record<string, unknown>; patch: Record<string, unknown> }> = [];
  const hooks: { beforeUpdate?: () => void } = {};
  const svc = {
    rpc: vi.fn(async () =>
      opts.haltErr ? { data: null, error: { message: "rpc down" } } : { data: opts.halted === true, error: null },
    ),
    from: (_table: string) => ({
      select: () => {
        const filters: Record<string, unknown> = {};
        const q = {
          eq(col: string, v: unknown) {
            filters[col] = v;
            return q;
          },
          async maybeSingle() {
            const r = db.row;
            if (!r || r.id !== filters.id) return { data: null, error: null };
            return { data: JSON.parse(JSON.stringify(r)), error: null };
          },
        };
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const q = {
          eq(col: string, v: unknown) {
            filters[col] = v;
            return q;
          },
          is(col: string, v: unknown) {
            filters[col] = v;
            return q;
          },
          async select() {
            const hook = hooks.beforeUpdate;
            hooks.beforeUpdate = undefined;
            hook?.();
            updates.push({ filters: { ...filters }, patch });
            const r = db.row;
            const hit =
              r &&
              r.id === filters.id &&
              r.tenant_id === filters.tenant_id &&
              r.updated_at === filters.updated_at;
            if (!hit) return { data: [], error: null };
            db.row = { ...r, ...(JSON.parse(JSON.stringify(patch)) as Partial<Row>) };
            return { data: [{ id: r.id }], error: null };
          },
        };
        return q;
      },
    }),
  };
  return { db, svc: svc as unknown as BuildScreenCheckDeps["svc"], updates, hooks, rpc: svc.rpc };
}

function baseRow(g: ConductorNode[] = graph()): Row {
  return { id: RUN, tenant_id: TENANT, kind: "build_app", goal_graph: g, updated_at: "2026-09-29T10:00:00.000Z" };
}

const deployOf = (row: Row | null) => row!.goal_graph.find((n) => n.id === "d")!;

const makeCheck = () => vi.fn(async (_input: { tenant_id: string }) => pass);
let screenCheck: ReturnType<typeof makeCheck>;
beforeEach(() => {
  screenCheck = makeCheck();
});

describe("build-screen-check worker", () => {
  it("runs the check with the conductor row's tenant and records it on the deploy node", async () => {
    const f = fakeDb(baseRow());
    const out = await handleBuildScreenCheck(
      { conductor_run_id: RUN, node_id: "d", tenant_id: "evil" },
      { svc: f.svc, screenCheck },
    );
    expect(out).toEqual({ recorded: true, status: "pass" });
    expect(screenCheck).toHaveBeenCalledWith({ tenant_id: TENANT });
    expect(deployOf(f.db.row).screen_check).toEqual(pass);
    expect(deployOf(f.db.row).status).toBe("done");
    expect(f.updates[0]!.filters).toMatchObject({ id: RUN, tenant_id: TENANT, updated_at: "2026-09-29T10:00:00.000Z" });
    expect(f.updates[0]!.patch).not.toHaveProperty("updated_at");
  });

  it("a FAIL verdict is recorded as-is and never touches run or node status", async () => {
    const fail: ScreenCheckRecord = { ...pass, status: "fail", fails: ["[mobile/] overflow"] };
    const f = fakeDb(baseRow());
    await handleBuildScreenCheck({ conductor_run_id: RUN, node_id: "d" }, { svc: f.svc, screenCheck: vi.fn(async () => fail) });
    expect(deployOf(f.db.row).screen_check).toEqual(fail);
    expect(deployOf(f.db.row).status).toBe("done");
    expect(Object.keys(f.updates[0]!.patch)).toEqual(["goal_graph"]);
  });

  it("a throwing check is recorded as skipped with the reason, same as the inline path did", async () => {
    const f = fakeDb(baseRow());
    const out = await handleBuildScreenCheck(
      { conductor_run_id: RUN, node_id: "d" },
      {
        svc: f.svc,
        screenCheck: vi.fn(async () => {
          throw new Error("anchor 503");
        }),
        now: () => new Date("2026-09-29T11:00:00.000Z"),
      },
    );
    expect(out).toEqual({ recorded: true, status: "skipped" });
    expect(deployOf(f.db.row).screen_check).toEqual({
      status: "skipped",
      checked_at: "2026-09-29T11:00:00.000Z",
      reason: "screen check threw: anchor 503",
    });
  });

  it("a tick that rewrote the graph mid-check is not clobbered: the write re-reads and keeps its change", async () => {
    const f = fakeDb(baseRow());
    f.hooks.beforeUpdate = () => {
      const r = f.db.row!;
      r.goal_graph.push({ id: "late", status: "pending", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 1, child_run_id: null });
      r.updated_at = "2026-09-29T10:01:00.000Z";
    };
    const out = await handleBuildScreenCheck({ conductor_run_id: RUN, node_id: "d" }, { svc: f.svc, screenCheck });
    expect(out).toEqual({ recorded: true, status: "pass" });
    expect(f.updates).toHaveLength(2);
    expect(f.db.row!.goal_graph.map((n) => n.id)).toEqual(["b", "d", "late"]);
    expect(deployOf(f.db.row).screen_check).toEqual(pass);
    expect(screenCheck).toHaveBeenCalledTimes(1);
  });

  it("gives up after bounded retries when the graph keeps changing, and never runs the check twice", async () => {
    const f = fakeDb(baseRow());
    let n = 0;
    const bump = () => {
      f.db.row!.updated_at = `2026-09-29T10:0${++n}:00.000Z`;
      f.hooks.beforeUpdate = bump;
    };
    f.hooks.beforeUpdate = bump;
    const out = await handleBuildScreenCheck({ conductor_run_id: RUN, node_id: "d" }, { svc: f.svc, screenCheck });
    expect(out).toEqual({ skipped: true, reason: "graph_changed" });
    expect(f.updates).toHaveLength(3);
    expect(screenCheck).toHaveBeenCalledTimes(1);
    expect(deployOf(f.db.row).screen_check).toBeUndefined();
  });

  it("a retried event after a recorded check does not open another cloud browser", async () => {
    const f = fakeDb(baseRow(graph({ screen_check: pass })));
    const out = await handleBuildScreenCheck({ conductor_run_id: RUN, node_id: "d" }, { svc: f.svc, screenCheck });
    expect(out).toEqual({ skipped: true, reason: "already_recorded" });
    expect(screenCheck).not.toHaveBeenCalled();
    expect(f.updates).toHaveLength(0);
  });

  it("skips a deploy node that is not done, a non-deploy node, a missing run and a non-build run", async () => {
    const cases: Array<[Row | null, string, string]> = [
      [baseRow(graph({ status: "pending" })), "d", "deploy_node_not_done"],
      [baseRow(), "b", "deploy_node_not_done"],
      [null, "d", "run_not_found"],
      [{ ...baseRow(), kind: "company_goal" }, "d", "run_not_found"],
    ];
    for (const [row, node_id, reason] of cases) {
      const f = fakeDb(row);
      expect(await handleBuildScreenCheck({ conductor_run_id: RUN, node_id }, { svc: f.svc, screenCheck })).toEqual({
        skipped: true,
        reason,
      });
      expect(f.updates).toHaveLength(0);
    }
    expect(screenCheck).not.toHaveBeenCalled();
  });

  it("a halted fleet or an unreadable halt switch runs no check", async () => {
    for (const opts of [{ halted: true }, { haltErr: true }]) {
      const f = fakeDb(baseRow(), opts);
      expect(await handleBuildScreenCheck({ conductor_run_id: RUN, node_id: "d" }, { svc: f.svc, screenCheck })).toEqual({
        skipped: true,
        reason: "fleet_halted",
      });
    }
    expect(screenCheck).not.toHaveBeenCalled();
  });

  it("rejects a malformed request and a disabled check before touching the database", async () => {
    const f = fakeDb(baseRow());
    for (const data of [{ conductor_run_id: "../etc", node_id: "d" }, { conductor_run_id: RUN }, null]) {
      expect(await handleBuildScreenCheck(data, { svc: f.svc, screenCheck })).toEqual({ skipped: true, reason: "bad_request" });
    }
    expect(await handleBuildScreenCheck({ conductor_run_id: RUN, node_id: "d" }, { svc: f.svc })).toEqual({
      skipped: true,
      reason: "screen_check_disabled",
    });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(screenCheck).not.toHaveBeenCalled();
  });

  it("listens on its own event, one check at a time per build", () => {
    const o = (buildScreenCheckFn as unknown as { opts: { triggers: unknown; concurrency: unknown } }).opts;
    expect(o.triggers).toEqual([{ event: BUILD_SCREEN_CHECK_REQUESTED }]);
    expect(o.concurrency).toEqual([{ limit: 1, key: "event.data.conductor_run_id" }, { limit: 5 }]);
  });
});
