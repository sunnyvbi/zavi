
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  handlerDeps: null as Record<string, unknown> | null,
  step: vi.fn(async () => ({ kind: "waiting" as const })),
  provisioner: {
    ensureProject: vi.fn(async () => ({ project_ref: "ref", url: "https://ref.supabase.co" })),
    configureAuth: vi.fn(async () => undefined),
    applySql: vi.fn(async () => "applied" as const),
    verifyCatalog: vi.fn(async () => [] as string[]),
    ensureOwnerAdmin: vi.fn(async () => ({ user_id: "u" })),
    ownerMagicLink: vi.fn(async () => "https://ref.supabase.co/verify?token=x"),
    pause: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
  },
  publisher: {
    stage: vi.fn(async () => ({ deploy_id: "d1", preview_url: "p", sha: "abcdef1" })),
    activate: vi.fn(async () => ({ url: "https://a.zaviagent.com" })),
    verify: vi.fn(async () => true),
    teardown: vi.fn(async () => undefined),
    prune: vi.fn(async () => ({ deleted: [] })),
  },
  publisherDeps: null as Record<string, unknown> | null,
  requestSiteActivate: vi.fn(async () => undefined),
  verifySiteDeploy: vi.fn(async () => ({ ok: true as const })),
  getBoolSetting: vi.fn(async () => true),
  wakeSite: vi.fn(async () => ({ status: "waking" })),
  defaultIdleDeps: vi.fn(() => ({ idle: true })),
  store: { get: vi.fn() },
  sandboxDeps: null as Record<string, unknown> | null,
}));

vi.mock("../site-deploy", () => ({
  createSiteDeployHandler: (deps: Record<string, unknown>) => {
    h.handlerDeps = deps;
    return { step: h.step };
  },
}));
vi.mock("../supabase-site-provisioner", () => ({ supabaseSiteProvisioner: () => h.provisioner }));
vi.mock("@/services/hosting/site-publish", () => ({
  createSitePublisher: (deps: Record<string, unknown>) => {
    h.publisherDeps = deps;
    return h.publisher;
  },
  activationState: () => "pending",
  verifySiteDeploy: h.verifySiteDeploy,
}));
vi.mock("@/../workers/functions/site-activate", () => ({ requestSiteActivate: h.requestSiteActivate }));
vi.mock("@/services/settings", () => ({ getBoolSetting: h.getBoolSetting }));
vi.mock("../idle", () => ({ wakeSite: h.wakeSite, defaultIdleDeps: h.defaultIdleDeps }));
vi.mock("../store", () => ({ siteStore: () => h.store }));
const ts = vi.hoisted(() => ({
  createTestSite: vi.fn(async () => ({ test_site_id: "ts-1", preview_host: "v-1.preview.zaviagent.com", owner_login: "https://link", owner_email: "o@v", expires_at: "x" })),
  destroyTestSite: vi.fn(async () => "already" as const),
}));
vi.mock("@/services/site-shards/test-site", () => ts);
vi.mock("../sandbox-resolver", () => ({
  createSiteSandboxResolver: (deps: Record<string, unknown>) => {
    h.sandboxDeps = deps;
    return { forSite: vi.fn() };
  },
}));

import { siteWiring, siteWiringComplete, setSiteWiring, resetSiteWiring, siteOwnerMagicLink } from "../wiring";
import { viteStarterProvider } from "@/services/provisioning/templates/vite-react-supabase";
import { runWithNodeCheckpoints } from "../deploy-checkpoints";

const T = "11111111-1111-4111-8111-111111111111";

describe("default site wiring", () => {
  beforeEach(() => {
    resetSiteWiring();
    h.handlerDeps = null;
    h.publisherDeps = null;
    vi.clearAllMocks();
  });
  afterEach(() => resetSiteWiring());

  it("fills every piece with the real implementation and is complete", () => {
    const w = siteWiring();
    expect(w.starter).toBe(viteStarterProvider);
    expect(w.supabase).not.toBeNull();
    expect(w.publisher).not.toBeNull();
    expect(w.deployHandler).not.toBeNull();
    expect(siteWiringComplete()).toBe(true);
  });

  it("building the wiring loads no vendor module (no credential needed at import)", () => {
    siteWiring();
    expect(h.handlerDeps).toBeNull();
    expect(h.publisherDeps).toBeNull();
    expect(h.provisioner.ensureProject).not.toHaveBeenCalled();
  });

  it("any missing piece makes the wiring incomplete (fail closed)", () => {
    for (const k of ["starter", "supabase", "publisher", "deployHandler"] as const) {
      resetSiteWiring();
      setSiteWiring({ [k]: null });
      expect(siteWiringComplete()).toBe(false);
    }
  });

  it("supabase delegates to Slice 2's provisioner", async () => {
    const w = siteWiring();
    expect(await w.supabase!.applySql({ tenant_id: T, site_id: "s", migration_id: "m", sql: "select 1" })).toBe("applied");
    expect(h.provisioner.applySql).toHaveBeenCalledWith({ tenant_id: T, site_id: "s", migration_id: "m", sql: "select 1" });
    await w.supabase!.teardown({ tenant_id: T, site_id: "s" });
    expect(h.provisioner.teardown).toHaveBeenCalledWith({ tenant_id: T, site_id: "s" });
  });

  it("publisher delegates to Slice 3's site publisher over the site store", async () => {
    const w = siteWiring();
    await w.publisher!.teardown({ tenant_id: T, site_id: "s" });
    expect(h.publisher.teardown).toHaveBeenCalledWith({ tenant_id: T, site_id: "s" });
    expect(h.publisherDeps).toMatchObject({ store: h.store });
    expect(await w.publisher!.verify("a.zaviagent.com")).toBe(true);
  });

  it("the deploy handler reads the colour-edit light gate from its own per-tenant setting, which ships on", async () => {
    const w = siteWiring();
    await runWithNodeCheckpoints({}, () => w.deployHandler!.step({ tenant_id: T, conductor_run_id: "r", site_id: "s", sha: "abcdef1", attempt: 1 }));
    const d = h.handlerDeps!;
    h.getBoolSetting.mockClear();
    h.getBoolSetting.mockResolvedValueOnce(false);
    expect(typeof d.lightGateColorEdits).toBe("function");
    expect(await (d.lightGateColorEdits as (t: string) => Promise<boolean>)(T)).toBe(false);
    expect(h.getBoolSetting.mock.calls).toEqual([["site_light_gate_color_edits", T]]);
    expect(await (d.lightGateEnabled as (t: string) => Promise<boolean>)(T)).toBe(true);
    expect(h.getBoolSetting).toHaveBeenLastCalledWith("site_light_gate_copy_edits", T);
    const { APP_SETTINGS } = await import("@/services/settings/registry");
    expect((APP_SETTINGS as Record<string, unknown>).site_light_gate_color_edits).toMatchObject({
      type: "boolean",
      scope: "per-tenant",
      defaultValue: true,
    });
  });

  it("the handler is built once and reused across ticks", async () => {
    const w = siteWiring();
    const input = { tenant_id: T, conductor_run_id: "r", site_id: "s", sha: "abcdef1", attempt: 1 };
    await runWithNodeCheckpoints({}, () => w.deployHandler!.step(input));
    const first = h.handlerDeps;
    await runWithNodeCheckpoints({}, () => w.deployHandler!.step(input));
    expect(h.handlerDeps).toBe(first);
    expect(h.step).toHaveBeenCalledTimes(2);
  });

  it("siteOwnerMagicLink: a dedicated site mints through the provisioner, a pooled / kernel site through the shard broker", async () => {
    const pooledMint = vi.fn(async () => "https://a.zaviagent.com/auth/confirm?type=magiclink&t=p");
    const sites: Record<string, Record<string, unknown>> = {
      ded: { id: "ded", tenant_id: T, backend_mode: "dedicated", kernel_shard_id: null },
      pool: { id: "pool", tenant_id: T, backend_mode: "pooled", shard_id: "sh1" },
      kern: { id: "kern", tenant_id: T, backend_mode: "dedicated", kernel_shard_id: "k1" },
      other: { id: "other", tenant_id: "22222222-2222-4222-8222-222222222222", backend_mode: "pooled" },
    };
    const store = async () => ({ get: async (_t: string, id: string) => (sites[id] ?? null) as never });
    setSiteWiring({ pooled: { ownerMagicLink: pooledMint } as never });
    const mint = siteOwnerMagicLink({ store });
    expect(mint).not.toBeNull();
    const i = (site_id: string) => ({ tenant_id: T, site_id, owner_email: "o@x.test", redirect_to: "https://a.zaviagent.com/admin" });
    expect(await mint!(i("ded"))).toBe("https://ref.supabase.co/verify?token=x");
    expect(h.provisioner.ownerMagicLink).toHaveBeenCalledWith(i("ded"));
    for (const id of ["pool", "kern"]) {
      expect(await mint!(i(id))).toBe("https://a.zaviagent.com/auth/confirm?type=magiclink&t=p");
      expect(pooledMint).toHaveBeenLastCalledWith({ tenant_id: T, site: sites[id], email: "o@x.test", redirect_to: "https://a.zaviagent.com/admin" });
    }
    expect(h.provisioner.ownerMagicLink).toHaveBeenCalledTimes(1);
    await expect(mint!(i("other"))).rejects.toThrow(/not found/);
    await expect(mint!(i("missing"))).rejects.toThrow(/not found/);
    expect(pooledMint).toHaveBeenCalledTimes(2);
    setSiteWiring({ supabase: null, pooled: null });
    expect(siteOwnerMagicLink()).toBeNull();
  });
});
