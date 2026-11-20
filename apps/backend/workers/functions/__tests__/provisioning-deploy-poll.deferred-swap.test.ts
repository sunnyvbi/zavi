import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  destroyed: [] as string[],
  failTable: null as string | null,
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}), send: vi.fn() } }));
vi.mock("@/services/settings", () => ({ getAppSetting: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/agents/conductor-kick", () => ({ requestTicksForTenantBuilds: vi.fn().mockResolvedValue(0) }));
vi.mock("@/services/sandbox/lifecycle", () => ({
  destroySandboxRow: vi.fn(async (id: string) => {
    h.destroyed.push(id);
    const r = h.db.tenant_sandbox.find((x) => x.id === id);
    if (r) r.status = "destroyed";
  }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const preds: Array<(r: Row) => boolean> = [];
      let cap = Infinity;
      const run = () =>
        h.failTable === table
          ? { data: null, error: { message: `${table} unavailable` } }
          : { data: (h.db[table] ?? []).filter((r) => preds.every((p) => p(r))).slice(0, cap).map((r) => ({ ...r })), error: null };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: unknown) => (preds.push((r) => r[k] === v), b),
        in: (k: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[k])), b),
        is: (k: string, v: unknown) => (preds.push((r) => (r[k] ?? null) === v), b),
        not: (k: string, _op: string, v: unknown) => (preds.push((r) => (r[k] ?? null) !== v), b),
        gte: (k: string, v: string) => (preds.push((r) => String(r[k]) >= v), b),
        limit: (n: number) => ((cap = n), b),
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
      };
      return b;
    },
    rpc: async (name: string, a: Record<string, unknown>) => {
      if (name === "set_tenant_resource") {
        const r = h.db.tenant_resources.find((x) => x.tenant_id === a.p_tenant_id && x.resource_kind === a.p_resource_kind);
        if (r) Object.assign(r, { status: a.p_status, external_ref: a.p_external_ref });
      }
      if (name === "clear_sandbox_preview") {
        const r = h.db.tenant_sandbox.find((x) => x.id === a.p_id);
        if (r) r.preview_status = a.p_final_status;
      }
      return { data: null, error: null };
    },
  }),
}));

import { pollDeployStatuses, realDeployPollDeps } from "../provisioning-deploy-poll";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const render = async (url: string) => {
  if (url.includes("/deploys")) return { status: 200, json: async () => [{ deploy: { status: "live" } }], text: async () => "" };
  if (url.includes("/v1/services/")) return { status: 200, json: async () => ({ serviceDetails: { url: "https://acme.onrender.com" } }), text: async () => "" };
  return { status: 200, json: async () => ({}), text: async () => "ok" };
};

const tick = () => pollDeployStatuses(realDeployPollDeps("rnd_tok", render));

function seed() {
  h.destroyed = [];
  h.failTable = null;
  h.db = {
    tenant_resources: [
      { tenant_id: T1, resource_kind: "hosting", mode: "provisioned", status: "provisioning", external_ref: { render_service_id: "srv-1" } },
    ],
    tenant_sandbox: [
      { id: "sb-row-1", tenant_id: T1, preview_status: "live", preview_run_id: null, status: "active" },
    ],
    conductor_runs: [{ id: "run-1", tenant_id: T1, kind: "build_app", status: "active" }],
  };
}

beforeEach(seed);

describe("a first build whose seed deploy went live mid-build still tears the instant preview down", () => {
  it("skips the swap while the build runs, then swaps on the first sweep after the build ends", async () => {
    const first = await tick();
    expect(first.ready).toBe(1);
    expect(h.db.tenant_resources[0].status).toBe("ready");
    expect(h.destroyed).toEqual([]);

    await tick();
    expect(h.destroyed).toEqual([]);
    expect(h.db.tenant_sandbox[0].preview_status).toBe("live");

    h.db.conductor_runs[0].status = "completed";
    await tick();
    expect(h.destroyed).toEqual(["sb-row-1"]);
    expect(h.db.tenant_sandbox[0].preview_status).toBe("swapped");

    await tick();
    expect(h.destroyed).toEqual(["sb-row-1"]);
  });

  it("swaps after a failed build too, and never while the build is still provisioning", async () => {
    h.db.conductor_runs[0].status = "provisioning";
    await tick();
    await tick();
    expect(h.destroyed).toEqual([]);
    h.db.conductor_runs[0].status = "failed";
    await tick();
    expect(h.destroyed).toEqual(["sb-row-1"]);
  });

  it("never touches live-edit or engineer previews, or a tenant whose hosting is not ready", async () => {
    h.db.conductor_runs = [];
    h.db.tenant_resources = [
      { tenant_id: T1, resource_kind: "hosting", mode: "provisioned", status: "ready", external_ref: {} },
      { tenant_id: T2, resource_kind: "hosting", mode: "provisioned", status: "failed", external_ref: {}, updated_at: "2000-01-01T00:00:00.000Z" },
    ];
    h.db.tenant_sandbox = [
      { id: "le", tenant_id: T1, preview_status: "live", preview_run_id: "live-edit:wake", status: "active" },
      { id: "eng", tenant_id: T1, preview_status: "live", preview_run_id: "run-42", status: "active" },
      { id: "t2-instant", tenant_id: T2, preview_status: "live", preview_run_id: null, status: "active" },
    ];
    await tick();
    expect(h.destroyed).toEqual([]);
  });

  it("keeps the sandbox when the active-build check errors, and one tenant's failure does not stop the sweep", async () => {
    h.db.conductor_runs = [];
    h.db.tenant_resources = [
      { tenant_id: T1, resource_kind: "hosting", mode: "provisioned", status: "ready", external_ref: {} },
      { tenant_id: T2, resource_kind: "hosting", mode: "provisioned", status: "ready", external_ref: {} },
    ];
    h.db.tenant_sandbox = [
      { id: "a", tenant_id: T1, preview_status: "live", preview_run_id: null, status: "active" },
      { id: "b", tenant_id: T2, preview_status: "live", preview_run_id: null, status: "active" },
    ];
    h.failTable = "conductor_runs";
    await tick();
    expect(h.destroyed).toEqual([]);
    h.failTable = null;
    await tick();
    expect(h.destroyed.sort()).toEqual(["a", "b"]);
  });

  it("a failed preview read never fails the deploy sweep", async () => {
    h.failTable = "tenant_sandbox";
    const r = await tick();
    expect(r.ready).toBe(1);
    expect(h.destroyed).toEqual([]);
  });
});
