import { describe, it, expect, vi } from "vitest";
import { createSiteDeployHandler, memoryCheckpoints, type SiteDeployDeps, type SiteDeployTimingRow } from "../site-deploy";
import { runSiteLightGate, type SiteFetch } from "../site-light-gate";
import { SiteBuildFailed, type SiteRow, type SiteSandbox, type StagedDeploy } from "../contract";
import { fakeGenerations, fakeSiteStore, siteRow, T1 } from "./fake-site-store";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN = "c0ffee00-0000-4000-8000-000000000042";
const LIVE = "1111111aaaa";
const NEXT = "2222222bbbb";
const HOST = "alpha.zaviagent.com";
const OWNER_LINK = "https://ref.supabase.co/auth/v1/verify?token=owner-link-secret-123&type=magiclink";
const TEST_OWNER_LINK = "https://validation.supabase.co/auth/v1/verify?token=test-owner-secret-456&type=magiclink";

const HERO_BEFORE = `export default function Hero() {
  return (
    <section className="bg-white">
      <h1 className="text-4xl text-slate-900">Rent bikes</h1>
      <a href="/book" className="btn">Book now</a>
    </section>
  );
}
`;
const HERO_TEXT = HERO_BEFORE.replace("Rent bikes</h1>", "Rent e-bikes fast</h1>");
const HERO_COPY = HERO_TEXT.replace("text-4xl text-slate-900", "text-5xl text-rose-600");
const HERO_LOGIC = HERO_BEFORE.replace('href="/book"', 'href="/admin"');

function activationState(site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">) {
  if (site.live_deploy_id === staged.deploy_id) return "live" as const;
  if (site.desired_sha !== staged.sha) return "superseded" as const;
  return "pending" as const;
}

type Scenario = {
  diff: string;
  files?: Record<string, string>;
  site?: Partial<SiteRow>;
  bundle?: string;
  stageFails?: boolean;
  skipOn?: boolean;
  lightOn?: boolean;
  colorOn?: boolean | "throw";
  assetMissing?: boolean;
  fullFails?: boolean;
  manifest?: string;
  pooledValidate?: (manifestRaw: unknown) => unknown;
  applyOver?: Record<string, unknown>;
  moveToDedicated?: boolean;
  contentThrows?: boolean;
};

function setup(sc: Scenario) {
  const { store, sites } = fakeSiteStore([
    siteRow({ id: A, label: "alpha", status: "live", live_sha: LIVE, live_deploy_id: "d00000000a-live0001", desired_sha: LIVE, ...sc.site }),
  ]);
  const order: string[] = [];
  const files: Record<string, string> = sc.files ?? {};
  const run = vi.fn(async (cmd: string, _opts?: Parameters<SiteSandbox["run"]>[1]) => {
    if (cmd.startsWith("git diff")) {
      order.push("diff");
      return { exitCode: 0, stdout: sc.diff, stderr: "" };
    }
    if (sc.manifest !== undefined && cmd.startsWith("git ls-tree -r --name-only")) {
      order.push("repo-paths");
      return { exitCode: 0, stdout: "package.json\nzavi-site.json\nsrc/components/Hero.tsx", stderr: "" };
    }
    if (sc.manifest !== undefined && cmd.startsWith("git ls-tree --name-only") && cmd.endsWith("zavi-site.json")) {
      return { exitCode: 0, stdout: "zavi-site.json\n", stderr: "" };
    }
    if (sc.manifest !== undefined && /^git show [0-9a-f]+:zavi-site\.json$/.test(cmd)) {
      return { exitCode: 0, stdout: sc.manifest, stderr: "" };
    }
    if (cmd.startsWith("git ls-tree")) {
      order.push("ls-tree");
      return { exitCode: 0, stdout: "supabase/migrations/001_init.sql\nsupabase/migrations/002_prices.sql", stderr: "" };
    }
    const mig = /^git show [0-9a-f]+:supabase\/migrations\/(.+)$/.exec(cmd);
    if (mig) return { exitCode: 0, stdout: `create table if not exists t_${mig[1].slice(0, 3)}();`, stderr: "" };
    const f = /^git show '([0-9a-f]+):(.+)'$/.exec(cmd);
    if (f) {
      const v = files[`${f[1]}:${f[2]}`];
      return v === undefined ? { exitCode: 128, stdout: "", stderr: "missing" } : { exitCode: 0, stdout: v, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const sandbox = { run, readFile: vi.fn(), listFiles: vi.fn() } as SiteSandbox;
  const applySql = vi.fn(async (i: { migration_id: string }) => {
    order.push(`sql:${i.migration_id}`);
    return "applied" as const;
  });
  const verifyCatalog = vi.fn(async () => {
    order.push("catalog");
    return [] as string[];
  });
  const ownerMagicLink = vi.fn(async () => OWNER_LINK);
  const stage = vi.fn(async (i: { sha: string }) => {
    order.push("stage");
    if (sc.stageFails) throw new SiteBuildFailed("vite build failed: src/components/Hero.tsx: Unexpected token");
    return { deploy_id: "d00000000b-next0002", preview_url: `https://${HOST}/__zavi_preview/d00000000b-next0002/?t=99.sigsecret0123456789`, sha: i.sha };
  });
  const runGate = vi.fn(async (i: { owner_link: string | null; allow_writes: boolean }) => {
    order.push("full-gate");
    if (sc.fullFails) return { ok: false, reason: "the booking journey failed", evidence: "{}", owner_journey: "failed" as const };
    return { ok: true, reason: "ok", evidence: "{}", owner_journey: i.owner_link ? ("passed" as const) : ("not_required" as const) };
  });
  const html = `<html><head><script type="module" src="/assets/index-1.js"></script></head><body></body></html>`;
  const fetchFn: SiteFetch = async (url, init) => {
    order.push(`fetch:${new URL(url).pathname}`);
    const ok = (status: number, body = "", headers: Record<string, string> = {}, cookies: string[] = []) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null, getSetCookie: () => cookies },
      text: async () => body,
    });
    if (url.includes("/__zavi_preview/")) return ok(302, "", { location: "/" }, ["__zavi_preview=d00000000b-next0002.99.sigsecret0123456789; Path=/; HttpOnly"]);
    if (!init?.headers?.cookie) return ok(200, "<html>live site</html>");
    if (url === `https://${HOST}/`) return ok(200, html, { "x-zavi-preview": "1" });
    if (url === `https://${HOST}/assets/index-1.js`) return sc.assetMissing ? ok(404) : ok(200, sc.bundle ?? `const a="Rent e-bikes fast",b="text-5xl text-rose-600";`);
    return ok(404);
  };
  const lightGate = vi.fn((i: Parameters<typeof runSiteLightGate>[0]) => {
    order.push("light-gate");
    return runSiteLightGate({ ...i, fetchFn });
  });
  const kv: Record<string, string> = {};
  const requestActivate = vi.fn(async (i: { tenant_id: string; site_id: string; deploy_id: string; sha: string; conductor_run_id?: string }) => {
    order.push("activate");
    if (await store.activateIfDesired(i.tenant_id, i.site_id, i.sha, i.deploy_id, `https://${HOST}`)) kv[`host:${HOST}`] = i.deploy_id;
  });
  const timings: SiteDeployTimingRow[] = [];
  const pooledValidate = vi.fn(async (i: { manifestRaw: unknown }) => {
    order.push("pooled-validate");
    return sc.pooledValidate!(i.manifestRaw);
  });
  const pooledApply = vi.fn(async (_i: { manifestRaw: unknown; additiveOnly?: boolean }) => {
    order.push("pooled-apply");
    return { kind: "active", shard: { id: "s", project_ref: "r", url: "u" }, manifest_hash: "h", binding_version: 1, plan: { add: [], change: [], archive: [], unchanged: [], reindex: [] }, changes: [], index_building: [], ...sc.applyOver };
  });
  const createTestSite = vi.fn(async () => {
    order.push("create-test-site");
    return { test_site_id: "ts-1", preview_host: "v-1.preview.zaviagent.com", owner_login: TEST_OWNER_LINK };
  });
  const destroyTestSite = vi.fn(async () => {
    order.push("destroy-test-site");
  });
  const moveToDedicated = vi.fn(async () => {
    order.push("move-to-dedicated");
    return { kind: "dedicated" as const };
  });
  const pooledOwnerLink = vi.fn(async () => OWNER_LINK);
  const checkContent = vi.fn(async () => {
    order.push("content-check");
    if (sc.contentThrows) throw new Error("content check could not read the commit");
    return { ok: true as const };
  });
  const skipFlag = vi.fn(async (_t: string) => sc.skipOn ?? true);
  const lightFlag = vi.fn(async (_t: string) => sc.lightOn ?? true);
  const colorFlag = vi.fn(async (_t: string) => {
    if (sc.colorOn === "throw") throw new Error("settings read failed");
    return sc.colorOn ?? true;
  });
  let clock = 1_000_000;
  const deps: SiteDeployDeps = {
    store,
    sandboxes: { forSite: vi.fn(async () => sandbox) },
    supabase: { applySql, verifyCatalog },
    publisher: { stage, previewUrl: async (i) => `https://${i.host}/__zavi_preview/${i.deploy_id}/?t=1.testhostsig0123` },
    generations: fakeGenerations(sites).generations,
    testSites: { createTestSite, destroyTestSite },
    requestActivate,
    activationState,
    verifySiteDeploy: vi.fn(async (hostname: string, deploy_id: string) =>
      kv[`host:${hostname}`] === deploy_id ? ({ ok: true } as const) : ({ ok: false, error: "not yet" } as const),
    ),
    ownerAdminEnabled: async () => true,
    checkpoints: memoryCheckpoints(),
    runGate: runGate as unknown as SiteDeployDeps["runGate"],
    runLightGate: lightGate,
    skipUnchangedMigrations: skipFlag,
    lightGateEnabled: lightFlag,
    lightGateColorEdits: colorFlag,
    logDeployTiming: async (row) => {
      timings.push(row);
    },
    now: () => (clock += 250),
    sleep: async () => {},
    activationWaitMs: 0,
    ...(sc.pooledValidate
      ? {
          pooled: {
            validate: pooledValidate,
            apply: pooledApply,
            ownerMagicLink: pooledOwnerLink,
            ...(sc.moveToDedicated ? { moveToDedicated } : {}),
          } as unknown as SiteDeployDeps["pooled"],
        }
      : {}),
    ...(sc.contentThrows !== undefined
      ? { signedImageCheckEnabled: async () => true, checkContent: checkContent as unknown as SiteDeployDeps["checkContent"] }
      : {}),
  };
  const handler = createSiteDeployHandler(deps);
  const step = () => handler.step({ tenant_id: T1, conductor_run_id: RUN, site_id: A, sha: NEXT, attempt: 1 });
  const stepKept = (kept_journeys: { names: string[]; must_pass: string[]; fingerprints?: Record<string, string> }) =>
    handler.step({ tenant_id: T1, conductor_run_id: RUN, site_id: A, sha: NEXT, attempt: 1, kept_journeys });
  return { step, stepKept, order, sites, applySql, verifyCatalog, ownerMagicLink, runGate, lightGate, requestActivate, timings, kv, skipFlag, lightFlag, colorFlag, pooledApply, pooledValidate, pooledOwnerLink, moveToDedicated, checkContent, createTestSite, destroyTestSite };
}

const COPY_FILES = { [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE, [`${NEXT}:src/components/Hero.tsx`]: HERO_COPY };
const TEXT_FILES = { [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE, [`${NEXT}:src/components/Hero.tsx`]: HERO_TEXT };

describe("site deploy: copy-only edits take the light gate", () => {
  it("a copy-only diff skips migrations, keeps the catalog check, takes the light gate, activates and logs its timing", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES });
    const out = await t.step();
    expect(out).toMatchObject({ kind: "live", url: `https://${HOST}` });
    expect(t.order).toEqual([
      "diff",
      "stage",
      "catalog",
      "light-gate",
      "fetch:/__zavi_preview/d00000000b-next0002/",
      "fetch:/",
      "fetch:/assets/index-1.js",
      "activate",
    ]);
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.ownerMagicLink).not.toHaveBeenCalled();
    expect(t.lightGate.mock.calls[0][0].tokens).toEqual(["Rent e-bikes fast"]);
    expect(t.requestActivate.mock.calls[0][0]).toMatchObject({ site_id: A, sha: NEXT, conductor_run_id: RUN });
    expect(t.sites.find((s) => s.id === A)).toMatchObject({ live_sha: NEXT, live_deploy_id: "d00000000b-next0002" });
    expect(t.timings).toHaveLength(1);
    expect(t.timings[0]).toMatchObject({ tenant_id: T1, site_id: A, conductor_run_id: RUN, gate: "light", migrations_ms: null });
    expect(t.timings[0].stage_ms).toBeGreaterThan(0);
    expect(t.timings[0].activate_ms).toBeGreaterThan(0);
    expect(t.timings[0].total_ms).toBeGreaterThan(t.timings[0].stage_ms);
  });

  it("a copy-only fix after a failed journey takes the full gate, so the failed journey runs again", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES });
    const kept_journeys = { names: ["home", "open-times"], must_pass: ["open-times"], fingerprints: { "open-times": "f" } };
    expect(await t.stepKept(kept_journeys)).toMatchObject({ kind: "live" });
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.runGate.mock.calls[0]![0]).toMatchObject({ kept_journeys });
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it.each([
    ["a className change", "M\tsrc/components/Hero.tsx\n", COPY_FILES],
    ["a .css change", "M\tsrc/components/Hero.tsx\nM\tsrc/index.css\n", TEXT_FILES],
  ])("%s takes the full gate, whose runner checks phone width, and still skips unchanged migrations", async (_name, diff, files) => {
    const t = setup({ diff, files });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.timings[0]).toMatchObject({ gate: "full", migrations_ms: null });
  });

  const CSS_BEFORE = ":root { --primary: 221 83% 53%; }\n.btn { color: #fff; background: #e11d48; padding: 8px 16px; }\n";
  const COLOR_FILES = {
    [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE,
    [`${NEXT}:src/components/Hero.tsx`]: HERO_BEFORE.replace("text-4xl text-slate-900", "text-4xl text-rose-600"),
    [`${LIVE}:src/index.css`]: CSS_BEFORE,
    [`${NEXT}:src/index.css`]: CSS_BEFORE.replace("221 83% 53%", "142 71% 45%").replace("#e11d48", "rgb(37 99 235)"),
  };
  const COLOR_DIFF = "M\tsrc/components/Hero.tsx\nM\tsrc/index.css\n";

  it("DEL-1323 B30: a colour-only class and css edit takes the light gate, no owner sign-in, and goes live", async () => {
    const t = setup({ diff: COLOR_DIFF, files: COLOR_FILES });
    expect(await t.step()).toMatchObject({ kind: "live", url: `https://${HOST}` });
    expect(t.lightGate).toHaveBeenCalledTimes(1);
    expect(t.lightGate.mock.calls[0][0].tokens).toEqual(["text-rose-600"]);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.ownerMagicLink).not.toHaveBeenCalled();
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.colorFlag).toHaveBeenCalledWith(T1);
    expect(t.timings[0]).toMatchObject({ gate: "light", migrations_ms: null });
  });

  it.each([
    ["a layout class rides along with the colour swap", { [`${NEXT}:src/components/Hero.tsx`]: HERO_BEFORE.replace("text-4xl text-slate-900", "text-4xl text-rose-600 hidden") }],
    ["a text size swap rides along with the colour swap", { [`${NEXT}:src/components/Hero.tsx`]: HERO_BEFORE.replace("text-4xl text-slate-900", "text-5xl text-rose-600") }],
    ["the css also changes a padding", { [`${NEXT}:src/index.css`]: CSS_BEFORE.replace("#e11d48", "#2563eb").replace("8px 16px", "8px 32px") }],
    ["the css swaps a colour for a width", { [`${NEXT}:src/index.css`]: CSS_BEFORE.replace("--primary: 221 83% 53%", "--primary: 100vw") }],
  ])("%s: the full gate with its phone width check", async (_label, over) => {
    const t = setup({ diff: COLOR_DIFF, files: { ...COLOR_FILES, ...over } });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.ownerMagicLink).not.toHaveBeenCalled();
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it.each([
    ["off", false],
    ["unreadable", "throw"],
  ] as const)("colour setting %s: a colour-only edit keeps the full gate", async (_label, colorOn) => {
    const t = setup({ diff: COLOR_DIFF, files: COLOR_FILES, colorOn });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it("copy light gate off: a colour-only edit takes the full gate and never asks the colour setting", async () => {
    const t = setup({ diff: COLOR_DIFF, files: COLOR_FILES, lightOn: false });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.colorFlag).not.toHaveBeenCalled();
  });

  it("a colour-only edit whose new class is not in the bundle falls back to the full gate", async () => {
    const t = setup({ diff: COLOR_DIFF, files: COLOR_FILES, bundle: `const b="text-4xl text-slate-900";` });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.order.indexOf("light-gate")).toBeLessThan(t.order.indexOf("full-gate"));
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it("a colour-only edit whose light gate cannot reach the preview falls back to the full gate", async () => {
    const t = setup({ diff: COLOR_DIFF, files: COLOR_FILES });
    t.lightGate.mockImplementationOnce(async () => ({
      ok: false,
      reason: "the home page answered 503",
      evidence: "",
      owner_journey: "not_required" as const,
      infra: true as const,
    }));
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.lightGate).toHaveBeenCalledTimes(1);
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.ownerMagicLink).not.toHaveBeenCalled();
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it("a colour-only edit whose light gate finds a broken asset is a repair and never activates", async () => {
    const t = setup({ diff: COLOR_DIFF, files: COLOR_FILES, assetMissing: true });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.sites.find((s) => s.id === A)?.live_sha).toBe(LIVE);
  });

  it("a .ts diff takes the full (read-only, no owner sign-in) gate, but still skips unchanged migrations", async () => {
    const t = setup({ diff: "M\tsrc/lib/records.ts\n" });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate.mock.calls[0][0].owner_link).toBeNull();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.timings[0]).toMatchObject({ gate: "full", migrations_ms: null });
  });

  it("a migration diff applies migrations and takes the full gate", async () => {
    const t = setup({ diff: "A\tsupabase/migrations/002_prices.sql\nM\tsrc/components/Hero.tsx\n", files: COPY_FILES });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.order.slice(0, 6)).toEqual(["diff", "stage", "ls-tree", "sql:001_init", "sql:002_prices", "catalog"]);
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.timings[0].gate).toBe("full");
    expect(t.timings[0].migrations_ms).not.toBeNull();
  });

  it("a structural tsx edit takes the full gate", async () => {
    const t = setup({
      diff: "M\tsrc/components/Hero.tsx\n",
      files: { [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE, [`${NEXT}:src/components/Hero.tsx`]: HERO_LOGIC },
    });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.order[0]).toBe("diff");
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it("a site with no live commit takes migrations and the full gate, with no diff read", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: COPY_FILES, site: { status: "building", live_sha: null, live_deploy_id: null, desired_sha: null } });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.order).not.toContain("diff");
    expect(t.applySql).toHaveBeenCalledTimes(2);
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.lightGate).not.toHaveBeenCalled();
  });

  it("with both settings off a copy diff still takes migrations and the full gate", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: COPY_FILES, skipOn: false, lightOn: false });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.order).not.toContain("diff");
    expect(t.applySql).toHaveBeenCalledTimes(2);
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.skipFlag).toHaveBeenCalledWith(T1);
    expect(t.lightFlag).toHaveBeenCalledWith(T1);
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it("light gate cannot find a new text: the full gate decides, and its pass publishes", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, bundle: `const a="Rent bikes",b="text-4xl text-slate-900";` });
    const out = await t.step();
    expect(out).toMatchObject({ kind: "live", url: `https://${HOST}` });
    expect(t.order.indexOf("light-gate")).toBeLessThan(t.order.indexOf("full-gate"));
    expect(t.order.indexOf("full-gate")).toBeLessThan(t.order.indexOf("activate"));
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.runGate.mock.calls[0][0].owner_link).toBeNull();
    expect(t.timings).toHaveLength(1);
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it("light gate cannot find a new text and the full gate fails: a repair that never activates", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, bundle: `const a="Rent bikes",b="text-4xl text-slate-900";`, fullFails: true });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect((out as { signal: string }).signal).toContain("the booking journey failed");
    expect((out as { signal: string }).signal).not.toContain("sigsecret0123456789");
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.kv).toEqual({});
    expect(t.sites.find((s) => s.id === A)).toMatchObject({ live_sha: LIVE, live_deploy_id: "d00000000a-live0001" });
    expect(t.timings).toEqual([]);
  });

  it("light gate failure that is not missing text (a broken asset) is a repair, never the full gate, never activates", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, assetMissing: true });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect((out as { signal: string }).signal).toContain("/assets/index-1.js answered 404");
    expect((out as { signal: string }).signal).not.toContain("sigsecret0123456789");
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.kv).toEqual({});
    expect(t.sites.find((s) => s.id === A)).toMatchObject({ live_sha: LIVE, live_deploy_id: "d00000000a-live0001" });
    expect(t.timings).toEqual([]);
  });

  it("light lane build failure: the stage error is a repair, no gate runs and nothing activates", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: COPY_FILES, stageFails: true });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect((out as { signal: string }).signal).toContain("vite build failed");
    expect(t.order).toEqual(["diff", "stage"]);
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.sites.find((s) => s.id === A)?.live_sha).toBe(LIVE);
  });
});

const MANIFEST = JSON.stringify({ collections: { bookings: { rules: {}, schema: {} } } });
const unchanged = () => ({ kind: "ok", unchanged: true });
const changed = () => ({ kind: "ok", unchanged: false });

describe("site deploy: light gate on static and pooled sites", () => {
  it("a static site whose database step has nothing to apply takes the light gate and never lists migrations", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, site: { backend_mode: "static" }, manifest: "{}", pooledValidate: () => ({ kind: "static" }) });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.lightGate).toHaveBeenCalledTimes(1);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.order).not.toContain("ls-tree");
    expect(t.order).not.toContain("catalog");
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.pooledApply).not.toHaveBeenCalled();
    expect(t.timings[0]).toMatchObject({ gate: "light", migrations_ms: null });
  });

  it("a pooled copy edit whose collections are unchanged takes the light gate, then the (no-op) live apply", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, site: { backend_mode: "pooled" }, manifest: MANIFEST, pooledValidate: unchanged });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.order.indexOf("pooled-validate")).toBeLessThan(t.order.indexOf("light-gate"));
    expect(t.order.indexOf("light-gate")).toBeLessThan(t.order.indexOf("pooled-apply"));
    expect(t.pooledApply).toHaveBeenCalledWith(expect.objectContaining({ additiveOnly: true }));
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.createTestSite).not.toHaveBeenCalled();
    expect(t.pooledOwnerLink).not.toHaveBeenCalled();
    expect(t.timings[0]).toMatchObject({ gate: "light" });
  });

  it("a pooled copy edit whose collections changed takes the full gate on a test site with the TEST owner sign-in", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, site: { backend_mode: "pooled" }, manifest: MANIFEST, pooledValidate: changed });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.createTestSite).toHaveBeenCalledTimes(1);
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.runGate.mock.calls[0][0]).toMatchObject({ owner_link: TEST_OWNER_LINK, allow_writes: true });
    expect(t.destroyTestSite).toHaveBeenCalledTimes(1);
    expect(t.pooledOwnerLink).not.toHaveBeenCalled();
    expect(t.ownerMagicLink).not.toHaveBeenCalled();
    expect(t.timings[0]).toMatchObject({ gate: "full" });
  });

  it("an index still rebuilding after the live apply goes live with the rebuild note", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, site: { backend_mode: "pooled" }, manifest: MANIFEST, pooledValidate: changed, applyOver: { index_building: ["bookings"] } });
    const out = await t.step();
    expect(out).toMatchObject({ kind: "live" });
    expect((out as { notes?: string[] }).notes?.[0]).toMatch(/bookings is still rebuilding/);
  });

  it("a pooled light gate failure is a repair: nothing was applied to the live site and nothing activates", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, site: { backend_mode: "pooled" }, manifest: MANIFEST, pooledValidate: unchanged, assetMissing: true });
    expect(await t.step()).toMatchObject({ kind: "repair" });
    expect(t.lightGate).toHaveBeenCalledTimes(1);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.pooledApply).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.sites.find((s) => s.id === A)?.live_sha).toBe(LIVE);
  });

  it("a content check that throws on a pooled site propagates; nothing applied, no gate", async () => {
    const t = setup({ diff: "M\tsrc/components/Hero.tsx\n", files: TEXT_FILES, site: { backend_mode: "pooled" }, manifest: MANIFEST, pooledValidate: unchanged, contentThrows: true });
    await expect(t.step()).rejects.toThrow(/content check could not read the commit/);
    expect(t.checkContent).toHaveBeenCalledTimes(1);
    expect(t.pooledApply).not.toHaveBeenCalled();
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("a static site moved to its own database in this deploy runs every migration and the full gate, despite a copy-only diff", async () => {
    const t = setup({
      diff: "M\tsrc/components/Hero.tsx\n",
      files: TEXT_FILES,
      site: { backend_mode: "static" },
      manifest: JSON.stringify({ capabilities: ["payments"] }),
      pooledValidate: () => ({ kind: "static" }),
      moveToDedicated: true,
    });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.moveToDedicated).toHaveBeenCalledTimes(1);
    expect(t.order).toContain("ls-tree");
    expect(t.applySql).toHaveBeenCalledTimes(2);
    expect(t.verifyCatalog).toHaveBeenCalledTimes(1);
    expect(t.lightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.runGate.mock.calls[0][0].allow_writes).toBe(false);
  });
});
