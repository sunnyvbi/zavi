import { beforeEach, describe, expect, it, vi } from "vitest";

type Run = { id: string; status: string; failure_class?: string; refine?: boolean; site_id?: string; provisioned?: boolean };

const h = vi.hoisted(() => ({
  keys: {} as Record<string, boolean>,
  runs: [] as Run[],
  runsError: null as null | { message: string },
  resources: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return { ...real, getBoolSetting: async (key: string) => h.keys[key] ?? true };
});

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      let nonRefine = false;
      let noSite = false;
      let doneOnly = false;
      let selected = "";
      const runRows = (n: number) =>
        h.runs
          .filter((r) => !(nonRefine && r.refine))
          .filter((r) => !(noSite && r.site_id))
          .filter((r) => !(doneOnly && r.status !== "done"))
          .slice(0, n)
          .map((r) => ({
            id: r.id,
            status: r.status,
            failure_class: r.failure_class ?? null,
            objective: "Build product: Lane Four Cakes — a bakery site",
            s0: null,
            s1: r.site_id ?? null,
            s2: null,
            ...(selected.includes("p0_stage:goal_graph->0->payload->>stage") && selected.includes("p0_status:goal_graph->0->>status")
              ? { p0_stage: r.provisioned ? "provision" : null, p0_status: r.provisioned ? "done" : null }
              : {}),
          }));
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          selected = cols;
          return b;
        },
        eq: (col: string, val: string) => {
          if (col === "status" && val === "done") doneOnly = true;
          if (table === "tenant_resources") return Promise.resolve({ data: h.resources, error: null });
          return b;
        },
        or: (f: string) => {
          if (f.includes("refine_mode")) nonRefine = true;
          return b;
        },
        is: (col: string, val: unknown) => {
          if (col.endsWith("site_id") && val === null) noSite = true;
          return b;
        },
        order: () => b,
        limit: async (n: number) =>
          h.runsError && !doneOnly ? { data: null, error: h.runsError } : { data: runRows(n), error: null },
        maybeSingle: async () => ({ data: { display_name: "Lane Four" }, error: null }),
      };
      return b;
    },
  }),
}));

import { oldFlowBuiltApp } from "../built-sites";

const HOSTING = {
  resource_kind: "hosting",
  status: "ready",
  external_ref: { url: "https://lane-four-cakes-9441dc9d.onrender.com" },
  updated_at: "2026-10-01T08:00:00Z",
};
const DOMAIN = {
  resource_kind: "domain",
  status: "ready",
  external_ref: { hostname: "lane-four-cakes-9441dc9d.zaviagent.com", status: "live" },
  updated_at: "2026-10-01T08:00:00Z",
};

const list = async () => {
  const app = await oldFlowBuiltApp("tenant-a");
  return app ? [{ ...app, id: "app:workspace", status: "live" as const }] : [];
};

beforeEach(() => {
  h.keys = {};
  h.runs = [];
  h.runsError = null;
  h.resources = [HOSTING, DOMAIN];
});

describe("Artifacts > Websites uses the same live truth and address as Domains and Publish", () => {
  it("QA lane4.3: hosting and domain ready while the first build is still running lists no Live site", async () => {
    h.runs = [{ id: "run-1", status: "running" }];
    const sites = await list();
    expect(sites.filter((s) => s.status === "live")).toEqual([]);
    expect(sites).toEqual([]);
  });

  it("a fresh rebuild in flight after a shipped build is not Live, because it put the starter back", async () => {
    h.runs = [{ id: "run-2", status: "running", provisioned: true }, { id: "run-1", status: "done" }];
    expect(await list()).toEqual([]);
  });

  it("a failed first build is not Live", async () => {
    h.runs = [{ id: "run-1", status: "failed" }];
    expect(await list()).toEqual([]);
  });

  it("a shipped build is Live at the zaviagent.com address, not the raw onrender host", async () => {
    h.runs = [{ id: "run-1", status: "done" }];
    const [site] = await list();
    expect(site).toMatchObject({
      id: "app:workspace",
      status: "live",
      live_url: "https://lane-four-cakes-9441dc9d.zaviagent.com",
      hostname: "lane-four-cakes-9441dc9d.zaviagent.com",
      build_run_id: "run-1",
      name: "Lane Four Cakes",
    });
    expect(site.live_url).not.toContain("onrender.com");
  });

  it("a shipped build whose address is not live yet falls back to the hosting URL", async () => {
    h.runs = [{ id: "run-1", status: "done" }];
    h.resources = [HOSTING, { ...DOMAIN, external_ref: { hostname: "x.zaviagent.com", status: "verifying" } }];
    expect((await list())[0]?.live_url).toBe("https://lane-four-cakes-9441dc9d.onrender.com");
  });

  it("a refine running on a shipped build stays Live", async () => {
    h.runs = [{ id: "run-2", status: "running", refine: true }, { id: "run-1", status: "done" }];
    expect((await list())[0]?.status).toBe("live");
  });

  it("a new-flow site build in flight never hides the old app", async () => {
    h.runs = [
      { id: "run-2", status: "running", site_id: "6f1c2a7e-1b2c-4d3e-8f90-123456789abc" },
      { id: "run-1", status: "done" },
    ];
    expect((await list())[0]?.status).toBe("live");
  });

  it("DEL-1323 B1: a newer build that failed at provisioning never re-seeded the repo, so the earlier shipped build stays listed Live", async () => {
    h.runs = [
      { id: "run-2", status: "failed", failure_class: "provision_failed" },
      { id: "run-1", status: "done" },
    ];
    expect(await list()).toMatchObject([{ status: "live", build_run_id: "run-1" }]);
  });

  it("DEL-1323 B1: a newer build still provisioning has not re-seeded the repo, so the earlier shipped build stays listed Live", async () => {
    h.runs = [
      { id: "run-3", status: "provisioning" },
      { id: "run-2", status: "failed", failure_class: "provision_failed" },
      { id: "run-1", status: "done" },
    ];
    expect(await list()).toMatchObject([{ status: "live", build_run_id: "run-1" }]);
  });

  it("a newer build that failed after re-seeding replaced the shipped app, so nothing is listed Live", async () => {
    h.runs = [
      { id: "run-3", status: "failed", failure_class: "provision_failed" },
      { id: "run-2", status: "failed", failure_class: "build_failed", provisioned: true },
      { id: "run-1", status: "done" },
    ];
    expect(await list()).toEqual([]);
  });

  it.each(["user_cancelled", "stale_reaped", "unknown"])(
    "a newer build stopped as %s before its provision step finished never re-seeded the repo, so the shipped build stays listed Live",
    async (failure_class) => {
      h.runs = [
        { id: "run-2", status: "failed", failure_class },
        { id: "run-1", status: "done" },
      ];
      expect(await list()).toMatchObject([{ status: "live", build_run_id: "run-1" }]);
    },
  );

  it.each(["user_cancelled", "stale_reaped", "unknown"])(
    "a newer build stopped as %s after its provision step finished replaced the shipped app, so nothing is listed Live",
    async (failure_class) => {
      h.runs = [
        { id: "run-2", status: "failed", failure_class, provisioned: true },
        { id: "run-1", status: "done" },
      ];
      expect(await list()).toEqual([]);
    },
  );

  it("a first build that failed at provisioning is not Live", async () => {
    h.runs = [{ id: "run-1", status: "failed", failure_class: "provision_failed" }];
    expect(await list()).toEqual([]);
  });

  it("key off: the running build's site is listed as before", async () => {
    h.keys.build_domains_wait_for_build = false;
    h.runs = [{ id: "run-1", status: "running" }];
    expect((await list())[0]?.status).toBe("live");
  });
});
