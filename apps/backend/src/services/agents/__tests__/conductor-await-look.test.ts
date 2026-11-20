import { describe, it, expect, vi } from "vitest";
import { conductorTick, type ConductorNode, type ConductorRow, type ConductorTickDeps } from "../conductor";
import { needsFollowUpTick } from "../conductor-kick";
import { buildSiteGoalGraph } from "../product-pipeline";
import { buildAwaitsLook, lookAwaitingSiteId } from "@/services/sites/look-wait";
import type { SiteDesignRow } from "@/services/sites/site-design-store";

const SITE = "site-1";
const T0 = Date.parse("2026-10-07T10:00:00Z");

function graph(awaitLook: boolean): ConductorNode[] {
  return buildSiteGoalGraph(
    { tenant_id: "t1", company_name: "Acme", idea: "a bakery site", max_usd: 5 },
    {
      site_id: SITE,
      target: { github_full_name: "o/r", repo_url: "https://github.com/o/r", default_branch: "main" },
      seed_sha: "a".repeat(40),
      publish_on_request: true,
      await_look: awaitLook,
    },
  ) as unknown as ConductorNode[];
}

function designRow(over: Partial<SiteDesignRow> = {}): SiteDesignRow {
  return {
    site_id: SITE,
    tenant_id: "t1",
    conductor_run_id: "cond-1",
    brief: {} as SiteDesignRow["brief"],
    directions: [{ id: "brand" }, { id: "bold" }, { id: "calm" }] as unknown as SiteDesignRow["directions"],
    theme_mode: "theme_css",
    chosen_direction: "brand",
    chosen_at: null,
    applied_direction: "brand",
    sealed_at: null,
    journey_fix_claimed_at: null,
    journey_fix_conductor_run_id: null,
    fidelity: null,
    updated_at: null,
    ...over,
  };
}

function harness(opts: {
  goal: ConductorNode[];
  design: () => Promise<SiteDesignRow | null>;
  flag?: () => Promise<boolean>;
  clock?: { ms: number };
  checkPark?: ConductorTickDeps["checkLookPark"];
}) {
  const clock = opts.clock ?? { ms: T0 };
  const state: { row: ConductorRow } = {
    row: { id: "cond-1", tenant_id: "t1", objective: "site", status: "active", max_usd: 100, spend_usd: 0, kind: "build_app", goal_graph: opts.goal },
  };
  const storeGet = vi.fn(async (_t: string, _s: string) => opts.design());
  const flag = vi.fn(async (_t: string) => (opts.flag ? opts.flag() : true));
  const consumeBudget = vi.fn(async () => "charged" as const);
  const consumeClassBudget = vi.fn(async () => "charged" as const);
  const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "child-1" }));
  const saveGraph = vi.fn(async (_id: string, g: ConductorNode[]) => {
    state.row = { ...state.row, goal_graph: JSON.parse(JSON.stringify(g)) };
  });
  const deps: ConductorTickDeps = {
    load: vi.fn(async () => state.row),
    childStatus: vi.fn(async () => "running"),
    consumeBudget,
    consumeClassBudget,
    decisionClassForStage: () => "build",
    dispatch,
    saveGraph,
    setStatus: vi.fn(async () => {}),
    siteAwaitsLook: (input) => buildAwaitsLook({ waitsForLook: flag, store: { get: storeGet } }, input),
    now: () => clock.ms,
    ...(opts.checkPark ? { checkLookPark: opts.checkPark } : {}),
  };
  return { deps, state, storeGet, flag, consumeBudget, consumeClassBudget, dispatch, saveGraph };
}

const WAITING = { action: "waiting", in_flight: 0, awaiting: "look" };
const HOUR = 60 * 60_000;

describe("conductorTick holds a first site build until the look is picked", () => {
  it("holds with no dispatch, no budget and no class cap while chosen_at is null, then dispatches exactly once after the pick", async () => {
    let design = designRow();
    const h = harness({ goal: graph(true), design: async () => design });

    for (let i = 0; i < 3; i++) expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.consumeClassBudget).not.toHaveBeenCalled();
    expect(h.saveGraph).not.toHaveBeenCalled();
    expect(h.storeGet).toHaveBeenCalledWith("t1", SITE);
    expect(lookAwaitingSiteId(h.state.row.goal_graph)).toBe(SITE);

    design = designRow({ chosen_at: "2026-10-07T10:00:00Z", chosen_direction: "bold" });
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toMatchObject({ action: "dispatched", child_run_id: "child-1" });
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 1 });
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 1 });

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.consumeBudget).toHaveBeenCalledTimes(1);
    expect(h.consumeClassBudget).toHaveBeenCalledTimes(1);
    const sent = (h.dispatch.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0].payload;
    expect(sent.await_look).toBeUndefined();
    const build = h.state.row.goal_graph.find((n) => n.payload.stage === "build")!;
    expect(build.status).toBe("dispatched");
    expect(build.payload.await_look).toBeUndefined();
    expect(build.payload.await_look_since).toBeUndefined();
    expect(build.payload.await_look_parked_at).toBeUndefined();
    expect(lookAwaitingSiteId(h.state.row.goal_graph)).toBeNull();
  });

  it("with no auto start wired, no pick never starts the build; when the database says the wait expired the run ends once and spends nothing", async () => {
    const states: Array<{ state: "waiting" | "expired"; parked_at: string | null }> = [
      { state: "waiting", parked_at: "2026-10-07T10:00:00.000Z" },
      { state: "waiting", parked_at: "2026-10-07T10:00:00.000Z" },
      { state: "expired", parked_at: "2026-10-07T10:00:00.000Z" },
    ];
    const checkPark = vi.fn(async () => states.shift()!);
    const h = harness({ goal: graph(true), design: async () => designRow(), checkPark });
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "completed", final: "failed" });
    expect(checkPark).toHaveBeenCalledTimes(3);
    expect(checkPark).toHaveBeenCalledWith({ tenant_id: "t1", conductor_run_id: "cond-1" });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.consumeClassBudget).not.toHaveBeenCalled();
  });

  it("a pick made before the wait expires starts the build; the wait is not checked once the pick is saved", async () => {
    let design = designRow();
    const checkPark = vi.fn(async () => ({ state: "waiting" as const, parked_at: "2026-10-07T10:00:00.000Z" }));
    const h = harness({ goal: graph(true), design: async () => design, checkPark });
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    design = designRow({ chosen_at: "2026-10-07T10:29:00Z", chosen_direction: "bold" });
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    expect(checkPark).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the database's wait stamp on a graph it saves, and stops with no heartbeat on a check error or an ended run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = harness({ goal: graph(true), design: async () => designRow(), checkPark: vi.fn(async () => Promise.reject(new Error("db down"))) });
    expect(await conductorTick("cond-1", failing.deps)).toEqual({ action: "waiting", in_flight: 0 });
    const ended = harness({ goal: graph(true), design: async () => designRow(), checkPark: vi.fn(async () => ({ state: "ended" as const, parked_at: null })) });
    expect(await conductorTick("cond-1", ended.deps)).toEqual({ action: "noop", reason: "look_wait_ended" });
    expect(failing.dispatch).not.toHaveBeenCalled();
    expect(ended.dispatch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a run parked before this change, with an old wait stamp long past, still waits for the pick", async () => {
    const stamped = graph(true).map((n) =>
      n.payload.stage === "build" ? { ...n, payload: { ...n.payload, await_look_since: new Date(T0 - 2 * HOUR).toISOString() } } : n,
    );
    let design = designRow();
    const h = harness({ goal: stamped, design: async () => design });
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(h.dispatch).not.toHaveBeenCalled();
    design = designRow({ chosen_at: new Date(T0).toISOString(), chosen_direction: "bold" });
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    const sent = (h.dispatch.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0].payload;
    expect(sent.await_look).toBeUndefined();
    expect(sent.await_look_since).toBeUndefined();
  });

  it("a design store read error keeps holding the build long after the old 30 second wait", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = { ms: T0 };
    const h = harness({ goal: graph(true), design: async () => Promise.reject(new Error("db down")), clock });
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    clock.ms = T0 + 20 * 60_000;
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(h.dispatch).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a build released by the pick never waits again, even when it goes back to pending for a repair", async () => {
    let design = designRow({ chosen_at: "2026-10-07T10:00:00Z" });
    const h = harness({ goal: graph(true), design: async () => design });
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    h.state.row = {
      ...h.state.row,
      goal_graph: h.state.row.goal_graph.map((n) => (n.payload.stage === "build" ? { ...n, status: "pending", child_run_id: null } : n)),
    };
    design = designRow();
    h.storeGet.mockClear();
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    expect(h.storeGet).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it("a pick made minutes later starts in the chosen look", async () => {
    const clock = { ms: T0 };
    let design = designRow();
    const h = harness({ goal: graph(true), design: async () => design, clock });
    for (const at of [T0, T0 + 30_000, T0 + 10 * 60_000]) {
      clock.ms = at;
      expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    }
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.consumeClassBudget).not.toHaveBeenCalled();
    expect(lookAwaitingSiteId(h.state.row.goal_graph)).toBe(SITE);

    design = designRow({ chosen_at: new Date(clock.ms).toISOString(), chosen_direction: "calm" });
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched", child_run_id: "child-1" });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const sent = (h.dispatch.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0].payload;
    expect(sent.await_look).toBeUndefined();
    expect(sent.await_look_since).toBeUndefined();
  });

  it("no websites to pick from (the design brief failed): dispatches at once and never parks", async () => {
    for (const directions of [[], [{ id: "brand" }]] as unknown as SiteDesignRow["directions"][]) {
      const h = harness({ goal: graph(true), design: async () => designRow({ directions }) });
      expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
      expect(h.dispatch).toHaveBeenCalledTimes(1);
      expect(lookAwaitingSiteId(h.state.row.goal_graph)).toBeNull();
    }
  });

  it("no design row: dispatches at once", async () => {
    const h = harness({ goal: graph(true), design: async () => null });
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a sealed look or a non-switchable theme never holds the build", async () => {
    for (const row of [designRow({ sealed_at: "2026-10-07T10:00:00Z" }), designRow({ theme_mode: "index_css" }), designRow({ theme_mode: "none" })]) {
      const h = harness({ goal: graph(true), design: async () => row });
      expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    }
  });

  it("a design store read error holds the build and spends nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness({ goal: graph(true), design: async () => Promise.reject(new Error("db down")) });
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.consumeClassBudget).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a settings read error fails closed to waiting, without even reading the store", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness({ goal: graph(true), design: async () => null, flag: async () => Promise.reject(new Error("settings down")) });
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.storeGet).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("turning the flag off releases a parked build on its next tick", async () => {
    let on = true;
    const h = harness({ goal: graph(true), design: async () => designRow(), flag: async () => on });
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    on = false;
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a graph without await_look (fix, refine, flag off at start) never consults the look", async () => {
    const h = harness({ goal: graph(false), design: async () => designRow() });
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    expect(h.storeGet).not.toHaveBeenCalled();
    expect(h.flag).not.toHaveBeenCalled();
  });
});

describe("needsFollowUpTick", () => {
  it("is false while the build waits on the look, true for any other wait", () => {
    expect(needsFollowUpTick({ action: "waiting", awaiting: "look" })).toBe(false);
    expect(needsFollowUpTick({ action: "waiting" })).toBe(true);
    expect(needsFollowUpTick({ action: "dispatched" })).toBe(true);
  });
});

describe("conductorTick starts a parked first build on the recommended look after 60 seconds", () => {
  const PARKED = "2026-10-07T10:00:00.000Z";
  const waiting = vi.fn(async () => ({ state: "waiting" as const, parked_at: PARKED }));

  function parked(clock: { ms: number }, autoPick: ConductorTickDeps["autoPickLook"], design: () => Promise<SiteDesignRow | null> = async () => designRow()) {
    const h = harness({ goal: graph(true), design, clock, checkPark: waiting });
    h.deps.autoPickLook = autoPick;
    return h;
  }

  it("before 60 seconds it waits, says when it will start, and never auto-picks", async () => {
    const clock = { ms: Date.parse("2026-10-07T10:00:59.000Z") };
    const autoPick = vi.fn(async () => true);
    const h = parked(clock, autoPick);
    expect(await conductorTick("cond-1", h.deps)).toEqual({ ...WAITING, auto_start_at: "2026-10-07T10:01:00.000Z" });
    expect(autoPick).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
  });

  it("at 60 seconds with no pick it saves the recommended look and dispatches the build once, in the same tick", async () => {
    const clock = { ms: Date.parse("2026-10-07T10:01:00.000Z") };
    const autoPick = vi.fn(async () => true);
    const h = parked(clock, autoPick);
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched", child_run_id: "child-1" });
    expect(autoPick).toHaveBeenCalledTimes(1);
    expect(autoPick).toHaveBeenCalledWith({ tenant_id: "t1", site_id: SITE });
    expect(h.consumeBudget).toHaveBeenCalledTimes(1);
    expect(h.consumeClassBudget).toHaveBeenCalledTimes(1);
    const sent = (h.dispatch.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0].payload;
    expect(sent.await_look).toBeUndefined();
    expect(sent.await_look_parked_at).toBeUndefined();
    expect(lookAwaitingSiteId(h.state.row.goal_graph)).toBeNull();
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 1 });
    expect(autoPick).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a founder pick that wins the race still starts the build, on the founder's look, without a second write", async () => {
    const clock = { ms: Date.parse("2026-10-07T10:01:05.000Z") };
    let design = designRow();
    const autoPick = vi.fn(async () => {
      design = designRow({ chosen_at: "2026-10-07T10:01:04.000Z", chosen_direction: "calm" });
      return false;
    });
    const h = parked(clock, autoPick, async () => design);
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    expect(autoPick).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a failed auto-pick keeps the build parked and spends nothing; the next tick tries again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = { ms: Date.parse("2026-10-07T10:02:00.000Z") };
    const autoPick = vi.fn<[{ tenant_id: string; site_id: string }], Promise<boolean>>().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(true);
    const h = parked(clock, autoPick);
    expect(await conductorTick("cond-1", h.deps)).toEqual({ ...WAITING, auto_start_at: "2026-10-07T10:01:00.000Z" });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "dispatched" });
    expect(autoPick).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("an expired or ended wait never auto-picks", async () => {
    const clock = { ms: Date.parse("2026-10-07T11:00:00.000Z") };
    const autoPick = vi.fn(async () => true);
    const expired = harness({ goal: graph(true), design: async () => designRow(), clock, checkPark: vi.fn(async () => ({ state: "expired" as const, parked_at: PARKED })) });
    expired.deps.autoPickLook = autoPick;
    expect(await conductorTick("cond-1", expired.deps)).toEqual({ action: "completed", final: "failed" });
    const ended = harness({ goal: graph(true), design: async () => designRow(), clock, checkPark: vi.fn(async () => ({ state: "ended" as const, parked_at: PARKED })) });
    ended.deps.autoPickLook = autoPick;
    expect(await conductorTick("cond-1", ended.deps)).toEqual({ action: "noop", reason: "look_wait_ended" });
    expect(autoPick).not.toHaveBeenCalled();
  });

  it("a wait not stamped yet never auto-picks and gives no start time", async () => {
    const clock = { ms: Date.parse("2026-10-07T12:00:00.000Z") };
    const autoPick = vi.fn(async () => true);
    const h = harness({ goal: graph(true), design: async () => designRow(), clock, checkPark: vi.fn(async () => ({ state: "waiting" as const, parked_at: null })) });
    h.deps.autoPickLook = autoPick;
    expect(await conductorTick("cond-1", h.deps)).toEqual(WAITING);
    expect(autoPick).not.toHaveBeenCalled();
  });
});
