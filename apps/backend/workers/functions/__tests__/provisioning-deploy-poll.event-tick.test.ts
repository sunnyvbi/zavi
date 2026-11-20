import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  send: vi.fn(),
  conductorRows: [] as Array<{ id: unknown }>,
  conductorError: null as null | { message: string },
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({}), send: h.send },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      h.calls.push(["from", table]);
      const b: Record<string, unknown> = {};
      b.select = (...a: unknown[]) => (h.calls.push(["select", ...a]), b);
      b.eq = (...a: unknown[]) => (h.calls.push(["eq", ...a]), b);
      b.limit = async (n: number) => {
        h.calls.push(["limit", n]);
        return { data: h.conductorError ? null : h.conductorRows, error: h.conductorError };
      };
      return b;
    },
  }),
}));

import {
  pollDeployStatuses,
  realDeployPollDeps,
  type DeployPollDeps,
} from "../provisioning-deploy-poll";
import {
  CONDUCTOR_TICK_REQUESTED,
  resetConductorKickDedupe,
} from "@/services/agents/conductor-kick";

const T1 = "a7ec7367-acc8-4abc-995b-7da60a572de3";
const T2 = "b7ec7367-acc8-4abc-995b-7da60a572de3";
const C1 = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";
const C2 = "609235e5-bb1b-448c-9a2b-4acdb9ccb0b2";

function row(tenant_id: string, id = "srv-1") {
  return { tenant_id, external_ref: { render_service_id: id } };
}

function fakeDeps(over: Partial<DeployPollDeps> = {}) {
  const kick = vi.fn(async (_tenant: string) => 1);
  const deps: DeployPollDeps = {
    loadProvisioningHosting: vi.fn().mockResolvedValue([]),
    fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
    fetchServiceUrl: vi.fn().mockResolvedValue("https://x.onrender.com"),
    probeLiveness: vi.fn().mockResolvedValue(true),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setProductUrl: vi.fn().mockResolvedValue(undefined),
    isBuildFlowTenant: vi.fn().mockResolvedValue(false),
    bumpProvisioning: vi.fn().mockResolvedValue(undefined),
    kickBuildConductors: kick,
    ...over,
  };
  return { deps, kick };
}

function tickSends() {
  return h.send.mock.calls.filter(
    (c) => (c[0] as { name?: string }).name === CONDUCTOR_TICK_REQUESTED,
  );
}

beforeEach(() => {
  resetConductorKickDedupe();
  h.send.mockReset();
  h.send.mockResolvedValue({ ids: ["evt"] });
  h.conductorRows = [];
  h.conductorError = null;
  h.calls = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BUILD_DEPLOY_STAGE_ENABLED;
});

describe("pollDeployStatuses → conductor kick on deploy settle", () => {
  it("kicks the tenant's builds after the row flips to ready, and only after the flip persisted", async () => {
    const order: string[] = [];
    const { deps, kick } = fakeDeps({
      loadProvisioningHosting: vi.fn().mockResolvedValue([row(T1)]),
      setStatus: vi.fn(async () => {
        order.push("setStatus");
      }),
    });
    kick.mockImplementation(async () => {
      order.push("kick");
      return 1;
    });
    const res = await pollDeployStatuses(deps);
    expect(res.ready).toBe(1);
    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith(T1);
    expect(order).toEqual(["setStatus", "kick"]);
  });

  it("kicks on a failed deploy so the deploy gate fails fast instead of waiting for the cron", async () => {
    const { deps, kick } = fakeDeps({
      loadProvisioningHosting: vi.fn().mockResolvedValue([row(T1)]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("build_failed"),
    });
    const res = await pollDeployStatuses(deps);
    expect(res.failed).toBe(1);
    expect(kick).toHaveBeenCalledWith(T1);
  });

  it("does not kick while the deploy is still building or awaiting liveness", async () => {
    const { deps, kick } = fakeDeps({
      loadProvisioningHosting: vi.fn().mockResolvedValue([row(T1, "a"), row(T2, "b")]),
      fetchLatestDeployStatus: vi
        .fn()
        .mockResolvedValueOnce("build_in_progress")
        .mockResolvedValueOnce("live"),
      probeLiveness: vi.fn().mockResolvedValue(false),
    });
    const res = await pollDeployStatuses(deps);
    expect(res.still_provisioning).toBe(2);
    expect(kick).not.toHaveBeenCalled();
  });

  it("does not kick when the status write throws (row stays provisioning)", async () => {
    const { deps, kick } = fakeDeps({
      loadProvisioningHosting: vi.fn().mockResolvedValue([row(T1)]),
      setStatus: vi.fn().mockRejectedValue(new Error("rpc down")),
    });
    const res = await pollDeployStatuses(deps);
    expect(res.errored).toBe(1);
    expect(kick).not.toHaveBeenCalled();
  });

  it("kicks each tenant at most once per sweep even with several settled rows", async () => {
    const { deps, kick } = fakeDeps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([row(T1, "a"), row(T1, "b"), row(T2, "c")]),
    });
    await pollDeployStatuses(deps);
    expect(kick.mock.calls.map((c) => c[0])).toEqual([T1, T2]);
  });

  it("a throwing kick never fails the sweep or miscounts the row", async () => {
    const { deps, kick } = fakeDeps({
      loadProvisioningHosting: vi.fn().mockResolvedValue([row(T1, "a"), row(T2, "b")]),
    });
    kick.mockRejectedValue(new Error("inngest down"));
    const res = await pollDeployStatuses(deps);
    expect(res).toMatchObject({ ready: 2, errored: 0 });
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it("kicks when a recently-failed row recovers to ready", async () => {
    const { deps, kick } = fakeDeps({
      loadRecentFailedHosting: vi.fn().mockResolvedValue([row(T2)]),
    });
    const res = await pollDeployStatuses(deps);
    expect(res.recovered).toBe(1);
    expect(kick).toHaveBeenCalledWith(T2);
  });
});

describe("realDeployPollDeps.kickBuildConductors (real wiring)", () => {
  it("sends one tenant-scoped tick per active build_app conductor", async () => {
    h.conductorRows = [{ id: C1 }, { id: C2 }];
    const deps = realDeployPollDeps("tok", vi.fn() as never);
    await deps.kickBuildConductors!(T1);
    expect(tickSends().map((c) => c[0])).toEqual([
      { name: CONDUCTOR_TICK_REQUESTED, data: { conductor_run_id: C1 } },
      { name: CONDUCTOR_TICK_REQUESTED, data: { conductor_run_id: C2 } },
    ]);
    const eqs = h.calls.filter(([n]) => n === "eq");
    expect(h.calls[0]).toEqual(["from", "conductor_runs"]);
    expect(eqs).toEqual(
      expect.arrayContaining([
        ["eq", "tenant_id", T1],
        ["eq", "status", "active"],
        ["eq", "kind", "build_app"],
      ]),
    );
    expect(h.calls.find(([n]) => n === "limit")?.[1]).toBeLessThanOrEqual(3);
  });

  it("sends nothing when the tenant has no active build", async () => {
    const deps = realDeployPollDeps("tok", vi.fn() as never);
    await deps.kickBuildConductors!(T1);
    expect(tickSends()).toHaveLength(0);
  });

  it("swallows a lookup error and a send failure without throwing", async () => {
    h.conductorError = { message: "boom" };
    const deps = realDeployPollDeps("tok", vi.fn() as never);
    await expect(deps.kickBuildConductors!(T1)).resolves.toBe(0);
    h.conductorError = null;
    h.conductorRows = [{ id: C1 }];
    h.send.mockRejectedValue(new Error("401"));
    await expect(deps.kickBuildConductors!(T1)).resolves.toBe(0);
  });

  it("dedupes a second settle for the same conductor inside the window", async () => {
    h.conductorRows = [{ id: C1 }];
    const deps = realDeployPollDeps("tok", vi.fn() as never);
    await deps.kickBuildConductors!(T1);
    await deps.kickBuildConductors!(T1);
    expect(tickSends()).toHaveLength(1);
  });

  it("drops malformed conductor ids instead of sending them", async () => {
    h.conductorRows = [{ id: "not-a-uuid" }, { id: null }, { id: C1 }];
    const deps = realDeployPollDeps("tok", vi.fn() as never);
    await deps.kickBuildConductors!(T1);
    expect(tickSends().map((c) => (c[0] as { data: unknown }).data)).toEqual([
      { conductor_run_id: C1 },
    ]);
  });
});
