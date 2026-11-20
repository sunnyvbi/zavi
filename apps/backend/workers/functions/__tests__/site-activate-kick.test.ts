import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getBoolSetting: vi.fn(async () => true),
  requestConductorTick: vi.fn(async () => true),
  runRow: { data: null as unknown, error: null as unknown },
  tenantClient: vi.fn(),
  eqs: [] as Array<[string, unknown]>,
}));

vi.mock("@/services/sites/store", () => ({ siteStore: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting: h.getBoolSetting }));
vi.mock("@/services/agents/conductor-kick", () => ({ requestConductorTick: h.requestConductorTick }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => {
    h.tenantClient(t);
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        h.eqs.push([col, val]);
        return q;
      },
      maybeSingle: async () => h.runRow,
    };
    return { from: (table: string) => (table === "conductor_runs" ? q : null) };
  },
}));

import {
  handleSiteActivate,
  kickConductorAfterActivate,
  requestSiteActivate,
  runBelongsToSite,
  SITE_ACTIVATE_EVENT,
  type SiteActivateDeps,
} from "../site-activate";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "c0ffee00-0000-4000-8000-000000000042";
const SHA = "a".repeat(40);
const DEPLOY = "d0mg1abcde-0123abcd";
const data = { tenant_id: TENANT, site_id: SITE, deploy_id: DEPLOY, sha: SHA, conductor_run_id: RUN };

function harness(over: Partial<SiteActivateDeps> = {}) {
  const order: string[] = [];
  const deps: SiteActivateDeps = {
    activate: vi.fn(async () => {
      order.push("activate");
      return { url: "https://x.zaviagent.com" };
    }),
    prune: vi.fn(async () => {
      order.push("prune");
      return { deleted: [] };
    }),
    reconcile: vi.fn(async () => {
      order.push("reconcile");
      return { outcome: "repaired" as const, site: null };
    }),
    run: async (name, fn) => {
      order.push(`step:${name}`);
      return fn();
    },
    kickConductor: vi.fn(async () => {
      order.push("kick");
      return true;
    }),
    ...over,
  };
  return { deps, order };
}

beforeEach(() => {
  h.getBoolSetting.mockReset();
  h.getBoolSetting.mockImplementation(async () => true);
  h.requestConductorTick.mockReset();
  h.requestConductorTick.mockImplementation(async () => true);
  h.runRow = { data: { id: RUN, s0: SITE, s1: SITE, s2: null }, error: null };
  h.tenantClient.mockReset();
  h.eqs = [];
});

describe("site/activate wakes the run that asked for it", () => {
  it("requests a conductor tick in its own step once activation lands, before pruning", async () => {
    const t = harness();
    expect(await handleSiteActivate(data, t.deps)).toEqual({ url: "https://x.zaviagent.com" });
    expect(t.order).toEqual(["step:activate", "activate", "step:kick-conductor", "kick", "step:prune", "prune"]);
    expect(t.deps.kickConductor).toHaveBeenCalledWith({ tenant_id: TENANT, site_id: SITE, conductor_run_id: RUN });
  });

  it("a superseded activation also wakes the run, so it fails at once instead of on its next check", async () => {
    const t = harness({ activate: vi.fn(async () => ({ superseded: true as const })) });
    expect(await handleSiteActivate(data, t.deps)).toEqual({ superseded: true });
    expect(t.deps.kickConductor).toHaveBeenCalledTimes(1);
  });

  it("no run id, or one that is not a uuid, kicks nothing", async () => {
    for (const bad of [{ ...data, conductor_run_id: undefined }, { ...data, conductor_run_id: "run-1" }, { ...data, conductor_run_id: 7 }]) {
      const t = harness();
      await handleSiteActivate(bad, t.deps);
      expect(t.deps.kickConductor).not.toHaveBeenCalled();
    }
  });

  it("a failing kick never changes the activation result", async () => {
    const t = harness({ kickConductor: vi.fn(async () => { throw new Error("inngest 503"); }) });
    expect(await handleSiteActivate(data, t.deps)).toEqual({ url: "https://x.zaviagent.com" });
    expect(t.deps.kickConductor).toHaveBeenCalledTimes(1);
    expect(t.order).toEqual(["step:activate", "activate", "step:kick-conductor", "step:prune", "prune"]);
  });

  it("a rejected activation never kicks", async () => {
    const t = harness({ activate: vi.fn(async () => { throw new Error("kv down"); }) });
    await expect(handleSiteActivate(data, t.deps)).rejects.toThrow("kv down");
    expect(t.deps.kickConductor).not.toHaveBeenCalled();
  });

  it("requestSiteActivate carries the run id on the event, and drops a malformed one", async () => {
    const send = vi.fn(async (_event: { data: Record<string, unknown> }) => undefined);
    await requestSiteActivate(data, send);
    expect(send).toHaveBeenCalledWith({
      id: `site-activate:${SITE}:${DEPLOY}`,
      name: SITE_ACTIVATE_EVENT,
      data: { tenant_id: TENANT, site_id: SITE, deploy_id: DEPLOY, sha: SHA, conductor_run_id: RUN },
    });
    await requestSiteActivate({ ...data, conductor_run_id: "x; drop" }, send);
    expect(send.mock.calls[1][0]).toMatchObject({ data: { tenant_id: TENANT, site_id: SITE, deploy_id: DEPLOY, sha: SHA } });
    expect(send.mock.calls[1][0].data).not.toHaveProperty("conductor_run_id");
  });

  it("the real kick reads site_activate_kicks_conductor for the tenant and requests the tick", async () => {
    expect(await kickConductorAfterActivate({ tenant_id: TENANT, site_id: SITE, conductor_run_id: RUN })).toBe(true);
    expect(h.getBoolSetting).toHaveBeenCalledWith("site_activate_kicks_conductor", TENANT);
    expect(h.requestConductorTick).toHaveBeenCalledWith(expect.anything(), RUN);
  });

  it("with the setting off, or unreadable, no tick is requested", async () => {
    h.getBoolSetting.mockImplementation(async () => false);
    expect(await kickConductorAfterActivate({ tenant_id: TENANT, site_id: SITE, conductor_run_id: RUN })).toBe(false);
    h.getBoolSetting.mockImplementation(async () => {
      throw new Error("db down");
    });
    expect(await kickConductorAfterActivate({ tenant_id: TENANT, site_id: SITE, conductor_run_id: RUN })).toBe(false);
    expect(h.requestConductorTick).not.toHaveBeenCalled();
  });

  it("the real kick checks the run in a tenant-scoped read before ticking it", async () => {
    expect(await kickConductorAfterActivate({ tenant_id: TENANT, site_id: SITE, conductor_run_id: RUN })).toBe(true);
    expect(h.tenantClient).toHaveBeenCalledWith(TENANT);
    expect(h.eqs).toEqual([["id", RUN]]);
  });
});

describe("site/activate never wakes a run that is not this tenant's run of this site", () => {
  const OTHER_SITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const input = { tenant_id: TENANT, site_id: SITE, conductor_run_id: RUN };

  it("another tenant's run (not found by the tenant-scoped read) is refused, no tick", async () => {
    h.runRow = { data: null, error: null };
    expect(await kickConductorAfterActivate(input)).toBe(false);
    expect(h.requestConductorTick).not.toHaveBeenCalled();
  });

  it("this tenant's run of a DIFFERENT site is refused, no tick", async () => {
    h.runRow = { data: { id: RUN, s0: OTHER_SITE, s1: OTHER_SITE, s2: OTHER_SITE }, error: null };
    expect(await kickConductorAfterActivate(input)).toBe(false);
    expect(h.requestConductorTick).not.toHaveBeenCalled();
  });

  it("an old-flow run with no site marker is refused", async () => {
    h.runRow = { data: { id: RUN, s0: null, s1: null, s2: null }, error: null };
    expect(await kickConductorAfterActivate(input)).toBe(false);
    expect(h.requestConductorTick).not.toHaveBeenCalled();
  });

  it("a read error or a throwing check refuses (fails closed)", async () => {
    h.runRow = { data: null, error: { message: "db down" } };
    expect(await kickConductorAfterActivate(input)).toBe(false);
    expect(
      await kickConductorAfterActivate(input, async () => {
        throw new Error("boom");
      }),
    ).toBe(false);
    expect(h.requestConductorTick).not.toHaveBeenCalled();
  });

  it("a refine or republish run marks the site on node 0 only, and the site id matches case-insensitively", async () => {
    h.runRow = { data: { id: RUN, s0: SITE.toUpperCase(), s1: null, s2: null }, error: null };
    expect(await runBelongsToSite(input)).toBe(true);
    h.runRow = { data: { id: RUN, s0: null, s1: null, s2: SITE }, error: null };
    expect(await runBelongsToSite(input)).toBe(true);
  });

  it("end to end: an event naming tenant A, A's site and B's run activates A's site but wakes nothing", async () => {
    h.runRow = { data: null, error: null };
    const t = harness({ kickConductor: (i) => kickConductorAfterActivate(i) });
    expect(await handleSiteActivate(data, t.deps)).toEqual({ url: "https://x.zaviagent.com" });
    expect(h.requestConductorTick).not.toHaveBeenCalled();
    expect(t.order).toContain("prune");
  });
});
