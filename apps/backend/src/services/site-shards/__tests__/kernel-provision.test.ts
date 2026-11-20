import { describe, expect, it, vi } from "vitest";
import {
  createKernelProvisionLedger,
  KERNEL_SITE_ALERT_ATTEMPTS,
  KernelSiteRefused,
  KernelSiteUnavailable,
  prepareKernelProject,
  provisionDedicatedKernelSiteWith,
  type DedicatedKernelSiteDeps,
  type KernelPrepDeps,
  type KernelProvisionLedger,
  type KernelProvisionRow,
  type KernelProvisionState,
} from "../kernel-provision";
import type { ShardRow } from "../contract";
import type { SiteRow } from "@/services/sites/contract";

const T = "aaaaaaaa-0000-4000-8000-00000000000a";
const SITE = "11111111-1111-4111-8111-111111111111";
const KERNEL_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const REF = "ownprojectref0001";
const row = (over: Partial<ShardRow> = {}): ShardRow => ({
  id: KERNEL_ID, env: "dev", name: `zavi-shard-dev-k${SITE.replace(/-/g, "")}`,
  project_ref: REF, url: `https://${REF}.supabase.co`, region: "us-west-1",
  state: "full", is_canary: false, schema_version: null, provision_step: "done", max_sites: 1, site_count: 1,
  created_at: "2026-10-01T00:00:00Z", dedicated_site_id: SITE, ...over,
});

function prepDeps(registered: ShardRow, starter: boolean) {
  const calls: string[] = [];
  const d = {
    registry: {
      registerKernel: vi.fn(async () => (calls.push("register"), registered)),
      kernelReady: vi.fn(async () => (calls.push("ready"), { ...registered, state: "full" })),
      get: vi.fn(),
    },
    provision: {} as KernelPrepDeps["provision"],
    env: () => "dev" as const,
    applyStarter: starter ? vi.fn(async () => void calls.push("starter")) : null,
  };
  return { d: d as unknown as KernelPrepDeps, calls };
}

describe("prepareKernelProject", () => {
  it("graduation: an already serving kernel is not re-provisioned; the legacy starter ledger is re-applied (idempotent)", async () => {
    const { d, calls } = prepDeps(row(), true);
    expect(await prepareKernelProject(d, { tenant_id: T, site_id: SITE, project_ref: REF, region: "us-west-1" })).toEqual({ kernel_shard_id: KERNEL_ID });
    expect(calls).toEqual(["register", "starter"]);
  });

  it("a BUILT kernel site: no starter SQL at all", async () => {
    const { d, calls } = prepDeps(row(), false);
    await prepareKernelProject(d, { tenant_id: T, site_id: SITE, project_ref: REF, region: "us-west-1" });
    expect(calls).toEqual(["register"]);
  });

  it("refuses when the registered project is not the site's project", async () => {
    const { d } = prepDeps(row(), true);
    await expect(prepareKernelProject(d, { tenant_id: T, site_id: SITE, project_ref: "someoneelseref001", region: "us-west-1" })).rejects.toThrow(/not the site's project/);
  });
});

function siteRow(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: SITE, tenant_id: T, hostname: "alpha.sites.zaviagent.com", label: "alpha", status: "building",
    backend_mode: "static", shard_id: null, kernel_shard_id: null, supabase_project_ref: null, supabase_url: null,
    gateway_binding: null, ...over,
  } as unknown as SiteRow;
}

function memLedger(site: { current: SiteRow }, opts: { kernelServing?: () => boolean } = {}) {
  let rec: KernelProvisionRow | null = null;
  let token = 0;
  const leased = () => !!rec?.lease_id;
  const eligible = () => {
    const s = site.current;
    if (["deleting", "deleted", "failed"].includes(s.status)) throw new KernelSiteRefused("site_deleting", "x");
    if (s.backend_mode === "pooled" || s.shard_id) throw new KernelSiteRefused("pooled_site_must_graduate", "x");
    if (s.backend_mode === "dedicated" && !s.kernel_shard_id) throw new KernelSiteRefused("legacy_dedicated_site", "x");
  };
  const ledger: KernelProvisionLedger = {
    claim: vi.fn(async (tenant_id, site_id, reason) => {
      if (tenant_id !== T || site_id !== SITE) throw new KernelSiteRefused("site_not_found", "x");
      eligible();
      if (rec?.state === "attached") return rec;
      rec ??= { site_id, tenant_id, state: "requested", reason, project_ref: null, region: null, kernel_shard_id: null, attempts: 0, last_error: null, lease_id: null, lease_until: null };
      if (leased()) return null;
      rec = { ...rec, attempts: rec.attempts + 1, lease_id: `00000000-0000-4000-8000-${String(++token).padStart(12, "0")}` };
      return rec;
    }),
    advance: vi.fn(async (_t, _s, lease_id: string, from: KernelProvisionState, to: KernelProvisionState, patch = {}, release = false) => {
      if (!(release && from === to)) eligible();
      if (!rec || rec.state !== from || rec.lease_id !== lease_id) return null;
      rec = { ...rec, ...patch, state: to, last_error: "last_error" in patch ? (patch.last_error ?? null) : to !== from ? null : rec.last_error, lease_id: release ? null : rec.lease_id };
      return rec;
    }),
    attach: vi.fn(async (_t, _s, lease_id: string | null) => {
      eligible();
      if (!rec || (rec.state !== "kernel_ready" && rec.state !== "attached")) throw new Error("not ready");
      if (opts.kernelServing && !opts.kernelServing()) throw new Error("site_kernel_attach: the kernel shard of x is not registered to its project or not serving");
      if (rec.state === "attached") return site.current;
      if (rec.lease_id !== lease_id) throw new Error("site_kernel_attach: the lease on x is not held");
      site.current = { ...site.current, backend_mode: "dedicated", kernel_shard_id: KERNEL_ID };
      rec = { ...rec, state: "attached", kernel_shard_id: KERNEL_ID, lease_id: null };
      return site.current;
    }),
  };
  return { ledger, get: () => rec, lease: leased, steal: () => rec && (rec = { ...rec, lease_id: "99999999-0000-4000-8000-000000000000" }) };
}

function world(over: Partial<DedicatedKernelSiteDeps> = {}, initial: Partial<SiteRow> = {}) {
  const site = { current: siteRow(initial) };
  const mem = memLedger(site);
  const order: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const deps: DedicatedKernelSiteDeps = {
    getSite: vi.fn(async (t, id) => (t === T && id === SITE ? site.current : null)),
    ledger: mem.ledger,
    ensureProject: vi.fn(async () => {
      order.push("project");
      site.current = { ...site.current, supabase_project_ref: REF, supabase_url: `https://${REF}.supabase.co` };
      return { project_ref: REF, url: `https://${REF}.supabase.co` };
    }),
    prepareKernel: vi.fn(async (i) => {
      order.push(`kernel:${i.project_ref}:${i.region}`);
      return { kernel_shard_id: KERNEL_ID };
    }),
    projectRegion: vi.fn(async () => "us-west-1"),
    ready: () => true,
    log: (r) => void logs.push(r),
    alert: vi.fn(async () => undefined),
    ...over,
  };
  return { deps, site, mem, order, logs };
}

describe("provisionDedicatedKernelSite", () => {
  it("a static site: own project -> one-site kernel (no SQL) -> the atomic attach; returns the kernel", async () => {
    const w = world();
    const out = await provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE });
    expect(out).toMatchObject({ kernel_shard_id: KERNEL_ID, project_ref: REF });
    expect(out.site).toMatchObject({ backend_mode: "dedicated", kernel_shard_id: KERNEL_ID });
    expect(w.order).toEqual(["project", `kernel:${REF}:us-west-1`]);
    expect(w.mem.get()).toMatchObject({ state: "attached", kernel_shard_id: KERNEL_ID, project_ref: REF, region: "us-west-1" });
    expect(w.mem.lease()).toBe(false);
    expect(w.logs.map((l) => l.step)).toEqual(["project_ready", "kernel_ready", "attached"]);
    for (const l of w.logs) expect(l).toMatchObject({ evt: "site_kernel_provision", tenant_id: T, site_id: SITE });
  });

  it("the region is the project's ACTUAL one, read once and kept on the ledger for a resumed pass", async () => {
    let fail = true;
    const w = world({
      projectRegion: vi.fn(async () => "eu-central-1"),
      prepareKernel: vi.fn(async (i) => {
        if (fail) throw new Error("vendor 503");
        return { kernel_shard_id: KERNEL_ID, region: i.region } as unknown as { kernel_shard_id: string };
      }),
    });
    await expect(provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE })).rejects.toThrow(/503/);
    expect(w.mem.get()?.region).toBe("eu-central-1");
    fail = false;
    await provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE });
    expect(w.deps.projectRegion).toHaveBeenCalledTimes(1);
    expect(w.deps.prepareKernel).toHaveBeenLastCalledWith(expect.objectContaining({ region: "eu-central-1" }));
    await expect(provisionDedicatedKernelSiteWith(world({ projectRegion: async () => "" }).deps, { tenant_id: T, site_id: SITE })).rejects.toThrow(/region/);
  });

  it("a runner whose lease was re-taken changes nothing: its steps and its release miss (token CAS)", async () => {
    let w!: ReturnType<typeof world>;
    w = world({
      ensureProject: vi.fn(async () => {
        w.site.current = { ...w.site.current, supabase_project_ref: REF };
        w.mem.steal();
        return { project_ref: REF, url: "u" };
      }),
    });
    await expect(provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE })).rejects.toThrow(/lost the lease/);
    expect(w.mem.get()).toMatchObject({ state: "requested", lease_id: "99999999-0000-4000-8000-000000000000" });
    expect(w.deps.prepareKernel).not.toHaveBeenCalled();
  });

  it("a site deleted mid-provision is refused before any kernel work, typed, and never paged", async () => {
    const v = world();
    (v.deps.ensureProject as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      v.site.current = { ...v.site.current, supabase_project_ref: REF, status: "deleting" } as SiteRow;
      return { project_ref: REF, url: "u" };
    });
    const e = await provisionDedicatedKernelSiteWith(v.deps, { tenant_id: T, site_id: SITE }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KernelSiteRefused);
    expect((e as KernelSiteRefused).code).toBe("site_deleting");
    expect(v.deps.prepareKernel).not.toHaveBeenCalled();
    expect(v.deps.alert).not.toHaveBeenCalled();
    const x = world({}, { status: "deleting", backend_mode: "dedicated", kernel_shard_id: KERNEL_ID, supabase_project_ref: REF } as Partial<SiteRow>);
    await expect(provisionDedicatedKernelSiteWith(x.deps, { tenant_id: T, site_id: SITE })).rejects.toMatchObject({ code: "site_deleting" });
  });

  it("idempotent: a second call returns at once (fast path), nothing re-created", async () => {
    const w = world();
    await provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE });
    const again = await provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE });
    expect(again.kernel_shard_id).toBe(KERNEL_ID);
    expect(w.deps.ensureProject).toHaveBeenCalledTimes(1);
    expect(w.deps.prepareKernel).toHaveBeenCalledTimes(1);
    expect(w.mem.ledger.claim).toHaveBeenCalledTimes(1);
  });

  it("resumable: a crash in kernel preparation is recorded, the lease released, and the next call resumes there (no second project)", async () => {
    let fail = true;
    const w = world({
      prepareKernel: vi.fn(async () => {
        if (fail) throw new Error("auth_config: vendor 503");
        return { kernel_shard_id: KERNEL_ID };
      }),
    });
    await expect(provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE })).rejects.toThrow(/vendor 503/);
    expect(w.mem.get()).toMatchObject({ state: "project_ready", last_error: "auth_config: vendor 503", project_ref: REF });
    expect(w.mem.lease()).toBe(false);
    expect(w.site.current.backend_mode).toBe("static");
    expect(w.logs.at(-1)).toMatchObject({ step: "failed", state: "project_ready", error: "auth_config: vendor 503" });
    fail = false;
    const out = await provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE });
    expect(out.kernel_shard_id).toBe(KERNEL_ID);
    expect(w.deps.ensureProject).toHaveBeenCalledTimes(1);
  });

  it("resumes at the attach when the kernel was ready but the switch never ran", async () => {
    const site = { current: siteRow() };
    let serving = false;
    const mem = memLedger(site, { kernelServing: () => serving });
    const w = world({ ledger: mem.ledger });
    w.site.current = site.current;
    (w.deps.getSite as ReturnType<typeof vi.fn>).mockImplementation(async () => site.current);
    (w.deps.ensureProject as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      site.current = { ...site.current, supabase_project_ref: REF };
      return { project_ref: REF, url: "u" };
    });
    await expect(provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE })).rejects.toThrow(/not serving/);
    expect(mem.get()?.state).toBe("kernel_ready");
    serving = true;
    await provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE });
    expect(w.deps.prepareKernel).toHaveBeenCalledTimes(1);
    expect(site.current).toMatchObject({ backend_mode: "dedicated", kernel_shard_id: KERNEL_ID });
  });

  it("refuses (typed, nothing created) a pooled site, a legacy dedicated site and an unknown site", async () => {
    for (const [initial, code] of [
      [{ backend_mode: "pooled", shard_id: "33333333-3333-4333-8333-333333333333" }, "pooled_site_must_graduate"],
      [{ backend_mode: "dedicated", supabase_project_ref: REF }, "legacy_dedicated_site"],
    ] as const) {
      const w = world({}, initial as Partial<SiteRow>);
      const e = await provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KernelSiteRefused);
      expect((e as KernelSiteRefused).code).toBe(code);
      expect(w.deps.ensureProject).not.toHaveBeenCalled();
    }
    const w = world();
    const other = "22222222-2222-4222-8222-222222222222";
    await expect(provisionDedicatedKernelSiteWith(w.deps, { tenant_id: other, site_id: SITE })).rejects.toMatchObject({ code: "site_not_found" });
    expect(w.deps.ensureProject).not.toHaveBeenCalled();
  });

  it("not configured / another runner holds the lease: typed, retryable, nothing created", async () => {
    const off = world({ ready: () => false });
    await expect(provisionDedicatedKernelSiteWith(off.deps, { tenant_id: T, site_id: SITE })).rejects.toMatchObject({ code: "not_configured" });
    expect(off.deps.ensureProject).not.toHaveBeenCalled();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = world({
      ensureProject: vi.fn(async () => {
        await gate;
        return { project_ref: REF, url: "u" };
      }),
    });
    const first = provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE });
    await vi.waitFor(() => expect(w.deps.ensureProject).toHaveBeenCalled());
    const second = await provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE }).catch((x: unknown) => x);
    expect(second).toBeInstanceOf(KernelSiteUnavailable);
    expect((second as KernelSiteUnavailable).code).toBe("busy");
    expect(w.deps.ensureProject).toHaveBeenCalledTimes(1);
    w.site.current = { ...w.site.current, supabase_project_ref: REF };
    release();
    await first;
  });

  it("pages ops once a site keeps failing, never on the first failures", async () => {
    const w = world({ ensureProject: vi.fn(async () => { throw new Error("quota"); }) });
    for (let i = 1; i <= KERNEL_SITE_ALERT_ATTEMPTS; i++) {
      await expect(provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE })).rejects.toThrow(/quota/);
      expect(w.deps.alert).toHaveBeenCalledTimes(i >= KERNEL_SITE_ALERT_ATTEMPTS ? 1 : 0);
    }
  });

  it("refuses a project ref that is not the one recorded for the site", async () => {
    const w = world();
    (w.deps.ensureProject as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      w.site.current = { ...w.site.current, supabase_project_ref: "differentref00001" };
      return { project_ref: REF, url: "u" };
    });
    await expect(provisionDedicatedKernelSiteWith(w.deps, { tenant_id: T, site_id: SITE })).rejects.toThrow(/not the one recorded/);
    expect(w.deps.prepareKernel).not.toHaveBeenCalled();
  });
});

describe("createKernelProvisionLedger", () => {
  it("maps the RPCs' refusals to typed errors; other errors stay retryable", async () => {
    const cases: Array<[{ message: string; code?: string }, string | null]> = [
      [{ message: "site_kernel_provision_claim: site x already has pooled data; it must graduate", code: "55000" }, "pooled_site_must_graduate"],
      [{ message: "site_kernel_provision_claim: site x is a legacy dedicated site", code: "55000" }, "legacy_dedicated_site"],
      [{ message: "site_kernel_provision_claim: site x is deleting", code: "55000" }, "site_deleting"],
      [{ message: "site_kernel_attach: site x is failed", code: "55000" }, "site_deleting"],
      [{ message: "site_kernel_register: site x not found for tenant y", code: "P0001" }, "site_not_found"],
      [{ message: "site_kernel_provision_claim: site x not found for tenant y", code: "P0002" }, "site_not_found"],
      [{ message: "connection reset" }, null],
    ];
    for (const [error, code] of cases) {
      const l = createKernelProvisionLedger(async () => ({ data: null, error }));
      const e = await l.claim(T, SITE, "isolation", 60).catch((x: unknown) => x);
      if (code) expect((e as KernelSiteRefused).code, error.message).toBe(code);
      else expect(e).not.toBeInstanceOf(KernelSiteRefused);
    }
  });

  it("sends only the site id (the tenant is injected by tenantRpc); refuses non-uuids before any call", async () => {
    const rpc = vi.fn(async () => ({ data: [{ site_id: SITE, tenant_id: T, state: "requested" }], error: null }));
    const l = createKernelProvisionLedger(rpc);
    await l.claim(T, SITE, "capacity", 120);
    expect(rpc).toHaveBeenCalledWith(T, "site_kernel_provision_claim", { p_site_id: SITE, p_reason: "capacity", p_lease_seconds: 120 });
    await expect(l.claim("nope", SITE, "isolation", 60)).rejects.toThrow(/uuids/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("attach refuses a row that is not this tenant's site", async () => {
    const l = createKernelProvisionLedger(async () => ({ data: { id: SITE, tenant_id: "22222222-2222-4222-8222-222222222222" }, error: null }));
    await expect(l.attach(T, SITE, null)).rejects.toThrow(/returned no row/);
  });
});
