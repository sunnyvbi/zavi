
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  classifyAppDatabaseError,
  APP_DATABASE_SETUP_FAILED_COPY,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
  type RepairConfig,
} from "../conductor";
import { mapTickToLedger } from "../conductor-ledger";
import { classifyBuildFailure } from "../build-failure";
import { AppDatabaseSetupError, ensureAppDatabase } from "@/services/provisioning/app-db-on-demand";
import { attachAppDatabase } from "@/services/provisioning/render-hosting";
import { APP_HOSTING_NOT_READY_COPY } from "../run-failure-code";

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return {
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build" },
    estimate_usd: 3,
    child_run_id: null,
    ...over,
  };
}

function row(over: Partial<ConductorRow> & { goal_graph: ConductorNode[] }): ConductorRow {
  return {
    id: "cond-1",
    tenant_id: "t1",
    objective: "build product",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    ...over,
  };
}

const REPAIR_ON: RepairConfig = { enabled: true, maxAttempts: 3, repairableStages: ["scaffold", "build", "qa"] };

function makeDeps(opts: Partial<ConductorTickDeps> & { row: ConductorRow | null }): ConductorTickDeps {
  return {
    load: vi.fn(async () => opts.row),
    childStatus: opts.childStatus ?? vi.fn(async () => "running" as ChildTerminalStatus),
    consumeBudget: opts.consumeBudget ?? vi.fn(async () => "charged"),
    dispatch: opts.dispatch ?? vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
    saveGraph: opts.saveGraph ?? vi.fn(async () => {}),
    setStatus: opts.setStatus ?? vi.fn(async () => {}),
    repairConfig: opts.repairConfig,
    captureFailureSignal: opts.captureFailureSignal,
    dispatchRepair: opts.dispatchRepair,
  };
}

const RUN_ERROR = new AppDatabaseSetupError("database not ready: neon 500").message;

describe("classifyAppDatabaseError", () => {
  it("matches the stored run error of an AppDatabaseSetupError", () => {
    expect(classifyAppDatabaseError(RUN_ERROR)).toEqual({
      app_database: true,
      reason: "Couldn't set up your site's database. No changes were published. Retry.",
    });
  });

  for (const s of [
    "error: relation \"todos\" does not exist",
    "database connection refused at lib/db.ts:12",
    "app_database_setup",
    "",
  ]) {
    it(`does NOT match: ${s || "(empty)"}`, () => {
      expect(classifyAppDatabaseError(s).app_database).toBe(false);
    });
  }

  it("null/undefined → no match", () => {
    expect(classifyAppDatabaseError(null).app_database).toBe(false);
    expect(classifyAppDatabaseError(undefined).app_database).toBe(false);
  });
});

describe("conductorTick — app-database short-circuit", () => {
  it("a build failure from database setup fails cleanly, no repair, no charge, founder copy", async () => {
    const dispatchRepair = vi.fn();
    const consumeBudget = vi.fn(async () => "charged" as const);
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "scaffold", status: "failed", child_run_id: "sc-1", payload: { stage: "scaffold" } }),
          node({ id: "build", status: "pending", payload: { stage: "build" } }),
        ],
      }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => RUN_ERROR),
      dispatchRepair,
      consumeBudget,
    });

    const r = await conductorTick("cond-1", deps);

    expect(r).toEqual({
      action: "completed_app_database_setup",
      node_id: "scaffold",
      root_cause: APP_DATABASE_SETUP_FAILED_COPY,
      attempts: 0,
    });
    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "failed", {
      failure_class: "app_database_setup",
      failure_reason: APP_DATABASE_SETUP_FAILED_COPY,
    });
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
  });

  it("with repair DISABLED a child that died on database setup still ends app_database_setup", async () => {
    const saveGraph = vi.fn(async () => {});
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "scaffold", status: "dispatched", child_run_id: "sc-1", payload: { stage: "scaffold" } }),
          node({ id: "build", status: "pending", payload: { stage: "build" } }),
        ],
      }),
      childStatus: vi.fn(async () => "failed" as ChildTerminalStatus),
      captureFailureSignal: vi.fn(async () => RUN_ERROR),
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "failed", {
      failure_class: "app_database_setup",
      failure_reason: APP_DATABASE_SETUP_FAILED_COPY,
    });
    const saved = (saveGraph.mock.calls.at(-1) as unknown as [string, ConductorNode[]])[1];
    const failed = saved.find((n) => n.id === "scaffold")!;
    expect(failed).toMatchObject({ status: "failed", failure_class: "app_database_setup" });
    expect(failed.error).toBe(APP_DATABASE_SETUP_FAILED_COPY);
  });

  it("with repair ENABLED a child that died on database setup short-circuits, no repair", async () => {
    const dispatchRepair = vi.fn();
    const deps = makeDeps({
      row: row({
        goal_graph: [node({ id: "build", status: "dispatched", child_run_id: "bc-1" })],
      }),
      childStatus: vi.fn(async () => "failed" as ChildTerminalStatus),
      captureFailureSignal: vi.fn(async () => RUN_ERROR),
      repairConfig: REPAIR_ON,
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect((r as { action: string }).action).toBe("completed_app_database_setup");
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("an app's own database error still enters the normal repair loop", async () => {
    const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "repair-1" }));
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "build", status: "failed", child_run_id: "bc-2" })] }),
      repairConfig: REPAIR_ON,
      captureFailureSignal: vi.fn(async () => "database connection refused at lib/db.ts:12"),
      dispatchRepair,
    });
    const r = await conductorTick("cond-1", deps);
    expect((r as { action: string }).action).toBe("repair_dispatched");
    expect(dispatchRepair).toHaveBeenCalledOnce();
  });
});

describe("app_database_setup in the ledger + status projection", () => {
  it("ledger folds onto 'completed' / 'failed' with the reason", () => {
    const e = mapTickToLedger({
      action: "completed_app_database_setup",
      node_id: "build",
      root_cause: APP_DATABASE_SETUP_FAILED_COPY,
      attempts: 0,
    });
    expect(e).toMatchObject({ action: "completed", outcome: "failed" });
    expect(e.error).toBe(`app_database_setup: ${APP_DATABASE_SETUP_FAILED_COPY}`);
  });

  it("classifyBuildFailure maps the raw run error to app_database_setup", () => {
    expect(classifyBuildFailure(RUN_ERROR)).toBe("app_database_setup");
  });
});

async function hostingRunError(tenant_id: string): Promise<string> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const err = await ensureAppDatabase(
      { tenant_id, files: [] },
      {
        readDbRow: async () => ({ status: "ready", mode: "provisioned" }),
        requestAppDatabase: async () => {},
        provision: async () => ({ provisioned: ["db"], connected: [], pending_creds: [], failed: [], context: {} }),
        attach: (t) => attachAppDatabase(t, { token: () => "tok", fetchFn: vi.fn() as never, resolveServiceId: async () => null }),
      },
    ).then(
      () => null,
      (e: Error) => e,
    );
    if (!err) throw new Error("ensureAppDatabase did not fail");
    return err.message;
  } finally {
    warn.mockRestore();
  }
}

const DIAGNOSTIC = /Render|render service|1edf051e|attach app database|repository URL/i;

describe("hosting not ready: the founder is told hosting, not database", () => {
  it("classifyAppDatabaseError keeps the code and swaps in the hosting copy", async () => {
    const signal = await hostingRunError("1edf051e");
    expect(signal).toBe(`app_database_setup_failed: ${APP_HOSTING_NOT_READY_COPY}`);
    expect(classifyAppDatabaseError(signal)).toEqual({ app_database: true, reason: APP_HOSTING_NOT_READY_COPY });
  });

  it("the database copy still classifies as the database copy", () => {
    expect(classifyAppDatabaseError(RUN_ERROR).reason).toBe(APP_DATABASE_SETUP_FAILED_COPY);
  });

  it("the hosting copy without the code is not an app-database failure", () => {
    expect(classifyAppDatabaseError(APP_HOSTING_NOT_READY_COPY).app_database).toBe(false);
  });

  it("repair DISABLED: reconcile fails the stage with the hosting copy and no diagnostic", async () => {
    const signal = await hostingRunError("1edf051e");
    const saveGraph = vi.fn(async () => {});
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "dispatched", child_run_id: "bc-1" }),
          node({ id: "qa", status: "pending", payload: { stage: "qa" } }),
        ],
      }),
      childStatus: vi.fn(async () => "failed" as ChildTerminalStatus),
      captureFailureSignal: vi.fn(async () => signal),
      saveGraph,
    });

    await conductorTick("cond-1", deps);

    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "failed", {
      failure_class: "app_database_setup",
      failure_reason: APP_HOSTING_NOT_READY_COPY,
    });
    const saved = (saveGraph.mock.calls.at(-1) as unknown as [string, ConductorNode[]])[1];
    const failed = saved.find((n) => n.id === "build")!;
    expect(failed).toMatchObject({
      status: "failed",
      failure_class: "app_database_setup",
      error: APP_HOSTING_NOT_READY_COPY,
      last_failure_signal: APP_HOSTING_NOT_READY_COPY,
    });
    expect(JSON.stringify(saved)).not.toMatch(DIAGNOSTIC);
    expect(JSON.stringify((deps.setStatus as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(DIAGNOSTIC);
  });

  it("repair ENABLED: reconcile then the already-classified short-circuit keeps the hosting copy", async () => {
    const signal = await hostingRunError("1edf051e");
    const dispatchRepair = vi.fn();
    const consumeBudget = vi.fn(async () => "charged" as const);
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "build", status: "dispatched", child_run_id: "bc-1" })] }),
      childStatus: vi.fn(async () => "failed" as ChildTerminalStatus),
      captureFailureSignal: vi.fn(async () => signal),
      repairConfig: REPAIR_ON,
      dispatchRepair,
      consumeBudget,
    });

    const r = await conductorTick("cond-1", deps);

    expect(r).toEqual({
      action: "completed_app_database_setup",
      node_id: "build",
      root_cause: APP_HOSTING_NOT_READY_COPY,
      attempts: 0,
    });
    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "failed", {
      failure_class: "app_database_setup",
      failure_reason: APP_HOSTING_NOT_READY_COPY,
    });
    expect(dispatchRepair).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
  });

  for (const [copy, name] of [
    [APP_HOSTING_NOT_READY_COPY, "hosting"],
    [APP_DATABASE_SETUP_FAILED_COPY, "database"],
  ] as const) {
    it(`a node persisted as app_database_setup with the ${name} copy ends with the ${name} copy`, async () => {
      const captureFailureSignal = vi.fn(async () => "should not be read");
      const deps = makeDeps({
        row: row({
          goal_graph: [
            node({
              id: "build",
              status: "failed",
              child_run_id: "bc-1",
              failure_class: "app_database_setup",
              error: copy,
              last_failure_signal: copy,
            }),
          ],
        }),
        repairConfig: REPAIR_ON,
        captureFailureSignal,
        dispatchRepair: vi.fn(),
      });

      const r = await conductorTick("cond-1", deps);

      expect((r as { root_cause: string }).root_cause).toBe(copy);
      expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "failed", {
        failure_class: "app_database_setup",
        failure_reason: copy,
      });
      expect(captureFailureSignal).not.toHaveBeenCalled();
    });
  }

  it("a Neon failure through ensureAppDatabase still ends with the database copy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await ensureAppDatabase(
      { tenant_id: "t1", files: [] },
      {
        readDbRow: async () => ({ status: "pending", mode: "provisioned" }),
        requestAppDatabase: async () => {},
        provision: async () => ({ provisioned: [], connected: [], pending_creds: [], failed: [{ kind: "db", error: "neon 500" }], context: {} }),
        attach: vi.fn(),
      },
    ).catch((e: Error) => e);
    warn.mockRestore();
    const deps = makeDeps({
      row: row({ goal_graph: [node({ id: "build", status: "dispatched", child_run_id: "bc-1" })] }),
      childStatus: vi.fn(async () => "failed" as ChildTerminalStatus),
      captureFailureSignal: vi.fn(async () => (err as Error).message),
      repairConfig: REPAIR_ON,
      dispatchRepair: vi.fn(),
    });

    await conductorTick("cond-1", deps);

    expect(deps.setStatus).toHaveBeenCalledWith("cond-1", "failed", {
      failure_class: "app_database_setup",
      failure_reason: APP_DATABASE_SETUP_FAILED_COPY,
    });
    expect(JSON.stringify((deps.setStatus as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/neon 500/);
  });

  it("classifyBuildFailure still maps the hosting run error to app_database_setup", async () => {
    expect(classifyBuildFailure(await hostingRunError("t1"))).toBe("app_database_setup");
  });
});
