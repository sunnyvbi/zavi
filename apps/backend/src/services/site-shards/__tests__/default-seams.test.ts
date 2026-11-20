
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reg = vi.hoisted(() => ({
  calls: [] as string[],
  shards: [] as Array<Record<string, unknown>>,
}));
vi.mock("../registry", async (orig) => {
  const real = (await orig()) as typeof import("../registry");
  const fake = {
    initStatic: async (_t: string, site: string) => void reg.calls.push(`static:${site}`),
    list: async () => reg.shards,
    placementReadiness: async () => {
      const open = reg.shards.filter((s) => s.state === "open").length;
      return { open, placeable: open, stale: 0, paused: 0 };
    },
    place: async (_t: string, site: string, env: string) => {
      reg.calls.push(`place:${site}:${env}`);
      return { shard: { id: "5a5a5a5a-0000-4000-8000-00000000005a", project_ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co" }, placed: true };
    },
    get: async (id: string) => ({ id, project_ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co", state: "provisioning", provision_step: "schema", name: "zavi-shard-dev-1" }),
  };
  return { ...real, shardRegistry: () => fake };
});

import { startFastBuild } from "@/services/agents/fast-build";
import { createZaviStarterProvider, zaviStarterProvider } from "@/services/provisioning/templates/vite-react-zavi";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import { fakeRepo, fakeStore, fakeSupabase } from "@/services/sites/__tests__/site-fakes";
import { SITE_MANIFEST_PATH } from "@/services/sites/contract";
import { createPooledBackend, pooledSeams, resetPooledReadiness, resetPooledSeams, setPooledSeams } from "../facade";
import { PooledBackendUnavailable } from "../pooled-site";

const T1 = "11111111-1111-4111-8111-111111111111";
const WITH_LOCK = createZaviStarterProvider({ ...TEMPLATE_FILES, "package-lock.json": '{"lockfileVersion":3}' });

const OPEN_SHARD = { id: "5a5a5a5a-0000-4000-8000-00000000005a", state: "open", project_ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co" };
const READY_ENV: Record<string, string> = {
  SITE_AUTH_ALIAS_KEY: "k".repeat(48),
  SITE_GATEWAY_BROKER_SECRET: "g".repeat(48),
  SITE_SIGNER_KEK_PUBLIC_JWK: JSON.stringify({ kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43), kid: "kek-1" }),
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_STATIC_API_TOKEN: "tok",
  CLOUDFLARE_ZONE_ID: "zone",
  ZAVI_STATIC_R2_BUCKET: "bucket",
  ZAVI_STATIC_KV_NAMESPACE_ID: "kv",
  ZAVI_STATIC_WORKER_NAME: "static-host",
  ZAVI_SITE_GATEWAY_WORKER_NAME: "zavi-site-gateway",
};

beforeEach(() => {
  reg.calls = [];
  reg.shards = [OPEN_SHARD];
  resetPooledSeams();
  resetPooledReadiness();
  for (const [k, v] of Object.entries(READY_ENV)) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetPooledSeams();
  resetPooledReadiness();
});

describe("pooled backend production wiring", () => {
  it("defaults to the real seams: the zavi starter, the shared manifest package, the S3 broker adapter", () => {
    const s = pooledSeams();
    expect(s.starter).toBe(zaviStarterProvider);
    expect(s.manifest!.validateManifest(JSON.parse(TEMPLATE_FILES[SITE_MANIFEST_PATH]))).toMatchObject({ ok: true });
    expect(typeof s.auth?.ensureFounderAdmin).toBe("function");
    expect(typeof s.auth?.ownerMagicLink).toBe("function");
    expect(typeof s.resumeDeletions).toBe("function");
  });

  it("enabledFor: ON with no flag and no off switch; off only with a missing prerequisite or no open shard", async () => {
    const b = createPooledBackend();
    expect(() => zaviStarterProvider.starterFiles()).not.toThrow();
    expect(await b.enabledFor(T1)).toBe(true);
    vi.stubEnv("SITE_BACKEND_POOLED", "0");
    expect(await b.enabledFor(T1)).toBe(true);
    vi.stubEnv("SITE_GATEWAY_BROKER_SECRET", "");
    expect(await b.enabledFor(T1)).toBe(false);
    vi.stubEnv("SITE_GATEWAY_BROKER_SECRET", "g".repeat(48));
    vi.stubEnv("ZAVI_SITE_GATEWAY_WORKER_NAME", "");
    expect(await b.enabledFor(T1)).toBe(false);
    vi.stubEnv("ZAVI_SITE_GATEWAY_WORKER_NAME", "zavi-site-gateway");
    vi.stubEnv("SITE_SIGNER_KEK_PUBLIC_JWK", "");
    expect(await b.enabledFor(T1)).toBe(false);
    vi.stubEnv("SITE_SIGNER_KEK_PUBLIC_JWK", READY_ENV.SITE_SIGNER_KEK_PUBLIC_JWK);
    setPooledSeams({ starter: createZaviStarterProvider(Object.fromEntries(Object.entries(TEMPLATE_FILES).filter(([k]) => k !== "package-lock.json"))) });
    expect(await b.enabledFor(T1)).toBe(false);
    setPooledSeams({ starter: zaviStarterProvider });
    expect(await b.enabledFor(T1)).toBe(true);
  });

  it("enabledFor: no OPEN shard in the env = off (fresh readiness, nothing cached)", async () => {
    reg.shards = [{ ...OPEN_SHARD, state: "full" }];
    expect(await createPooledBackend().enabledFor(T1)).toBe(false);
    reg.shards = [];
    resetPooledReadiness();
    expect(await createPooledBackend().enabledFor(T1)).toBe(false);
  });

  it("startFastBuild with every prerequisite missing (fresh backend, no env) is a retryable setup failure, never the dedicated path", async () => {
    vi.unstubAllEnvs();
    resetPooledReadiness();
    const pooled = createPooledBackend();
    expect(await pooled.enabledFor(T1)).toBe(false);
    const store = fakeStore();
    const repo = fakeRepo();
    const sb = fakeSupabase(store);
    const r = await startFastBuild(
      { tenant_id: T1, conductor_run_id: "run-2", company_name: "Studio", idea: "A booking site", max_usd: 50, started_by_user_id: "u1", owner_email: "owner@example.com", first_build_free: false },
      {
        store, repo, supabase: sb, pooled,
        updateConductorRunStatus: async () => {},
        ensureGithubConnector: async () => undefined,
        alert: async () => undefined,
      },
    );
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true });
    expect(reg.calls).toEqual([]);
    expect(sb.calls).toEqual([]);
    expect(repo.repos.size).toBe(0);
  });

  it("startFastBuild takes the pooled path: static first, NO per-site project, zavi starter seeded; the first backend deploy places it on a shard", async () => {
    setPooledSeams({ starter: WITH_LOCK });
    const pooled = createPooledBackend();
    const store = fakeStore();
    const repo = fakeRepo();
    const sb = fakeSupabase(store);
    const seeded: Array<Record<string, string>> = [];
    repo.seed = async (_t: string, _r: string, files: Record<string, string>) => {
      seeded.push(files);
      return "a".repeat(40);
    };
    const r = await startFastBuild(
      { tenant_id: T1, conductor_run_id: "run-1", company_name: "Studio", idea: "A booking site", max_usd: 50, started_by_user_id: "u1", owner_email: "owner@example.com", first_build_free: false },
      {
        store, repo, supabase: sb, pooled,
        updateConductorRunStatus: async () => {},
        ensureGithubConnector: async () => undefined,
        alert: async () => undefined,
        sleep: async () => undefined,
        publishOnRequest: async () => false,
        waitsForLook: async () => false,
        industryLookRules: async () => false,
        designBrief: async () => ({ brief: null, reason: "test_default" }),
        companyBrand: async () => null,
        buildLogo: null,
        designStore: null,
      },
    );
    expect(r.kind, JSON.stringify(r)).toBe("started");
    const [site] = [...store.sites.values()];
    expect(sb.calls).toEqual([]);
    expect(sb.projects.size).toBe(0);
    expect(reg.calls).toEqual([`static:${site.id}`]);
    expect(seeded[0][SITE_MANIFEST_PATH]).toBe(TEMPLATE_FILES[SITE_MANIFEST_PATH]);
    expect(seeded[0]["src/zavi/client.ts"]).toBeDefined();
    expect(Object.keys(seeded[0]).some((k) => k.startsWith("supabase/"))).toBe(false);

    const row = { ...store.sites.get(site.id)!, backend_mode: "static" as const };
    await expect(pooled.apply({ tenant_id: T1, site: row, manifestRaw: JSON.parse(TEMPLATE_FILES[SITE_MANIFEST_PATH]) }))
      .rejects.toBeInstanceOf(PooledBackendUnavailable);
    expect(reg.calls).toEqual([`static:${site.id}`, `place:${site.id}:dev`]);
    expect(sb.calls).toEqual([]);
  });
});
