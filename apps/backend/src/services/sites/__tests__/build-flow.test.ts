
import { describe, it, expect, vi } from "vitest";
import {
  createSiteBuildPrereqs,
  e2bTemplateExists,
  SITE_BUILD_REQUIRED_ENV,
  TEMPLATE_PROBE_MISS_TTL_MS,
  TEMPLATE_PROBE_OK_TTL_MS,
  type SiteBuildPrereqDeps,
} from "../build-flow";

const FULL_ENV: Record<string, string> = {
  GITHUB_PROVISION_TOKEN: "ghp_x",
  E2B_API_KEY: "e2b_x",
  SITE_WAKE_HMAC_SECRET: "s",
  SITE_PREVIEW_HMAC_SECRET: "p",
  SITE_PREVIEW_DOMAIN: "preview.example.com",
  SITE_PREVIEW_ZONE_ID: "zone1",
  ZAVI_SITE_GATEWAY_WORKER_NAME: "gw",
  SUPABASE_URL: "https://wmycgyjsenvgtczlupoe.supabase.co",
};
const STAGING_URL = "https://dgzgwclslzzzrjopbobp.supabase.co";

type D = SiteBuildPrereqDeps & { log: ReturnType<typeof vi.fn>; alert: ReturnType<typeof vi.fn> };

function deps(over: Partial<SiteBuildPrereqDeps> = {}): D {
  return {
    env: () => ({ ...FULL_ENV }),
    staticHostingOk: () => true,
    starterReady: () => true,
    wiringComplete: () => true,
    pooledReasons: async () => [],
    dedicatedNeeded: async () => false,
    templateExists: async () => true,
    now: () => 0,
    log: vi.fn(),
    alert: vi.fn(async () => undefined),
    ...over,
  } as D;
}

async function check(d: SiteBuildPrereqDeps) {
  return createSiteBuildPrereqs(d).checkSiteBuildPrereqs();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("checkSiteBuildPrereqs", () => {
  it("everything present is ok, with no tenant setting read at all", async () => {
    expect(await check(deps())).toEqual({ ok: true });
  });

  it("the dedicated-project credentials are NOT build prerequisites (pooled sites never need them)", async () => {
    expect(SITE_BUILD_REQUIRED_ENV).toEqual([
      "GITHUB_PROVISION_TOKEN",
      "SITE_WAKE_HMAC_SECRET",
      "SITE_PREVIEW_HMAC_SECRET",
      "SITE_PREVIEW_DOMAIN",
      "SITE_PREVIEW_ZONE_ID",
      "ZAVI_SITE_GATEWAY_WORKER_NAME",
    ]);
    expect(await check(deps({ env: () => ({ ...FULL_ENV, SUPABASE_MGMT_TOKEN: "", SUPABASE_ORG_ID: "" }) }))).toEqual({ ok: true });
  });

  it("blocks a build when the publish gate's preview routing is not configured (names logged, ops alerted)", async () => {
    const env = { ...FULL_ENV, SITE_PREVIEW_ZONE_ID: "", SITE_PREVIEW_DOMAIN: "not a domain" };
    const d = deps({ env: () => env });
    const r = await createSiteBuildPrereqs(d).checkSiteBuildPrereqs();
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.missing).toEqual(expect.arrayContaining(["SITE_PREVIEW_ZONE_ID", "valid SITE_PREVIEW_DOMAIN (a hostname)"]));
  });

  it("each required key, and the e2b key under either name, is checked (blank counts as missing)", async () => {
    for (const key of SITE_BUILD_REQUIRED_ENV) {
      const env = { ...FULL_ENV };
      delete env[key];
      const r = await check(deps({ env: () => env }));
      expect(r.ok, key).toBe(false);
      expect(r.ok ? [] : r.missing, key).toContain(key);
      const r2 = await check(deps({ env: () => ({ ...FULL_ENV, [key]: "  " }) }));
      expect(r2.ok, `${key} blank`).toBe(false);
    }
    const { E2B_API_KEY: _k, ...noE2b } = FULL_ENV;
    const r = await check(deps({ env: () => noE2b }));
    expect(r).toEqual({ ok: false, missing: ["E2B_API_KEY (or E2B_KEY)"] });
    expect(await check(deps({ env: () => ({ ...noE2b, E2B_KEY: "k" }) }))).toEqual({ ok: true });
  });

  it("names wiring and static hosting gaps; the dedicated starter's lockfile is not needed for pooled sites", async () => {
    const r = await check(deps({ starterReady: () => false, wiringComplete: () => false, staticHostingOk: () => false }));
    expect(r.ok).toBe(false);
    const missing = r.ok ? [] : r.missing;
    expect(missing.some((m) => m.includes("package-lock.json"))).toBe(false);
    expect(missing.some((m) => m.includes("wiring.ts"))).toBe(true);
    expect(missing.some((m) => m.includes("static hosting"))).toBe(true);
  });

  it("probes the pooled image only; a starter needing a dedicated project also needs its credentials, lockfile and image", async () => {
    const seen: string[] = [];
    const templateExists = async (alias: string) => { seen.push(alias); return true; };
    expect(await check(deps({ templateExists }))).toEqual({ ok: true });
    expect(seen).toEqual(["zavi-vite-pooled-starter"]);

    const r = await check(deps({ dedicatedNeeded: async () => true, starterReady: () => false }));
    expect(r).toEqual({
      ok: false,
      missing: ["SUPABASE_MGMT_TOKEN", "SUPABASE_ORG_ID", expect.stringContaining("package-lock.json")],
    });
    seen.length = 0;
    const env = { ...FULL_ENV, SUPABASE_MGMT_TOKEN: "sbp_x", SUPABASE_ORG_ID: "org" };
    expect(await check(deps({ dedicatedNeeded: async () => true, env: () => env, templateExists }))).toEqual({ ok: true });
    expect(seen).toEqual(["zavi-vite-pooled-starter", "zavi-vite-starter"]);
  });

  it("a pooled backend that cannot take a site refuses the build (no dedicated fallback)", async () => {
    const r = await check(deps({ pooledReasons: async () => ["no_open_shard_prod"] }));
    expect(r).toEqual({ ok: false, missing: ["pooled site backend: no_open_shard_prod"] });
    const r2 = await check(deps({ pooledReasons: async () => { throw new Error("db down"); } }));
    expect(r2).toEqual({ ok: false, missing: ["pooled site backend: readiness_check_failed"] });
  });

  it("a staging backend without SITE_HOSTNAME_SUFFIX is refused; a missing or unparsable SUPABASE_URL is not prod either", async () => {
    const r = await check(deps({ env: () => ({ ...FULL_ENV, SUPABASE_URL: STAGING_URL }) }));
    expect(r.ok ? [] : r.missing).toEqual([expect.stringMatching(/SITE_HOSTNAME_SUFFIX/)]);
    for (const url of [undefined, "", "not a url", "https://wmycgyjsenvgtczlupoe.supabase.co.evil.test"]) {
      const env = { ...FULL_ENV, SUPABASE_URL: url } as Record<string, string | undefined>;
      expect((await check(deps({ env: () => env }))).ok, String(url)).toBe(false);
    }
  });

  it("staging with SITE_HOSTNAME_SUFFIX=-dev is ok; an invalid suffix or base domain is refused", async () => {
    expect(await check(deps({ env: () => ({ ...FULL_ENV, SUPABASE_URL: STAGING_URL, SITE_HOSTNAME_SUFFIX: "-dev" }) }))).toEqual({ ok: true });
    for (const over of [{ SITE_HOSTNAME_SUFFIX: "dev" }, { SITE_HOSTNAME_SUFFIX: "-DEV" }, { SITE_HOSTNAME_SUFFIX: ".dev" },
      { PRAXIS_PRODUCT_DOMAIN: "evil.com/x" }, { PRAXIS_PRODUCT_DOMAIN: "" }]) {
      const r = await check(deps({ env: () => ({ ...FULL_ENV, SUPABASE_URL: STAGING_URL, SITE_HOSTNAME_SUFFIX: "-dev", ...over }) }));
      expect(r.ok, JSON.stringify(over)).toBe(false);
    }
  });

  it("a missing or failing template probe is refused", async () => {
    expect(await check(deps({ templateExists: async () => false }))).toEqual({ ok: false, missing: ["e2b template zavi-vite-pooled-starter"] });
    expect((await check(deps({ templateExists: async () => { throw new Error("e2b 500"); } }))).ok).toBe(false);
  });

  it("never probes the template while something local is missing", async () => {
    const templateExists = vi.fn(async () => true);
    await check(deps({ templateExists, env: () => ({}) }));
    await check(deps({ templateExists, pooledReasons: async () => ["signer_not_configured"] }));
    expect(templateExists).not.toHaveBeenCalled();
  });

  it("caches a found template for 10 minutes and a missing one for 1 minute", async () => {
    let t = 0;
    let found = false;
    const templateExists = vi.fn(async () => found);
    const c = createSiteBuildPrereqs(deps({ templateExists, now: () => t }));
    expect((await c.checkSiteBuildPrereqs()).ok).toBe(false);
    found = true;
    t = TEMPLATE_PROBE_MISS_TTL_MS - 1;
    expect((await c.checkSiteBuildPrereqs()).ok).toBe(false);
    t = TEMPLATE_PROBE_MISS_TTL_MS + 1;
    expect((await c.checkSiteBuildPrereqs()).ok).toBe(true);
    expect(templateExists).toHaveBeenCalledTimes(2);
    t += TEMPLATE_PROBE_OK_TTL_MS - 1;
    await c.checkSiteBuildPrereqs();
    expect(templateExists).toHaveBeenCalledTimes(2);
    t += 2;
    await c.checkSiteBuildPrereqs();
    expect(templateExists).toHaveBeenCalledTimes(3);
  });

  it("logs and alerts the missing key NAMES once per change, never their values; a recovery is logged", async () => {
    let env: Record<string, string> = { ...FULL_ENV, GITHUB_PROVISION_TOKEN: "", SITE_WAKE_HMAC_SECRET: "" };
    const d = deps({ env: () => env });
    const c = createSiteBuildPrereqs(d);
    await c.checkSiteBuildPrereqs();
    await c.checkSiteBuildPrereqs();
    await flush();
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.alert).toHaveBeenCalledTimes(1);
    const line = String(d.alert.mock.calls[0][0]);
    expect(line).toContain("GITHUB_PROVISION_TOKEN");
    expect(line).toContain("SITE_WAKE_HMAC_SECRET");
    expect(line).not.toContain("e2b_x");
    env = { ...FULL_ENV };
    await c.checkSiteBuildPrereqs();
    await flush();
    expect(d.log).toHaveBeenCalledTimes(2);
    expect(String(d.log.mock.calls[1][0])).toMatch(/ready again/);
    expect(d.alert).toHaveBeenCalledTimes(1);
  });

  it("an alert that fails never escapes into the build path", async () => {
    const d = deps({ env: () => ({}), alert: vi.fn(async () => { throw new Error("slack down"); }) });
    await expect(check(d)).resolves.toMatchObject({ ok: false });
    await flush();
  });

  it("a ready first state logs and alerts nothing", async () => {
    const d = deps();
    await check(d);
    await flush();
    expect(d.log).not.toHaveBeenCalled();
    expect(d.alert).not.toHaveBeenCalled();
  });
});

describe("e2bTemplateExists (REST probe, e2b 2.0.0 has no Template class)", () => {
  function fakeFetch(status: number, body: unknown) {
    return vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string> }) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
  }

  it("lists templates with the key in X-API-Key and matches an alias", async () => {
    const f = fakeFetch(200, [{ templateID: "abc", aliases: ["other"] }, { templateID: "def", aliases: ["zavi-vite"] }]);
    expect(await e2bTemplateExists("zavi-vite", "e2b_k", f)).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.e2b.dev/templates");
    expect(init.method).toBe("GET");
    expect(init.headers["X-API-Key"]).toBe("e2b_k");
  });

  it("is false when no template carries the alias", async () => {
    expect(await e2bTemplateExists("zavi-vite", "k", fakeFetch(200, [{ templateID: "abc" }, { aliases: ["x"] }]))).toBe(false);
  });

  it("throws on a non-2xx or a non-array body", async () => {
    await expect(e2bTemplateExists("a", "k", fakeFetch(401, {}))).rejects.toThrow(/401/);
    await expect(e2bTemplateExists("a", "k", fakeFetch(200, { templates: [] }))).rejects.toThrow();
  });

  it("passes an abort signal, so a stalled e2b response rejects instead of hanging build start", async () => {
    const stalled = vi.fn(
      (_url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(e2bTemplateExists("a", "k", stalled, 20)).rejects.toThrow(/abort/);
    expect(stalled.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
