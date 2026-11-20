import { describe, expect, it, vi } from "vitest";
import { createSiteDeployHandler, memoryCheckpoints, type SiteDeployDeps } from "../site-deploy";
import { SiteGateUnavailable, type SiteRow, type SiteSandbox, type SiteTestSites, type StagedDeploy } from "../contract";
import { fakeGenerations, fakeSiteStore, siteRow, T1 } from "./fake-site-store";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const SHA = "abcdef1234567";
const SHARD = "33333333-3333-4333-8333-333333333333";
const LINK = "https://shard.supabase.co/auth/v1/verify?token=owner-link-secret&type=magiclink";
const TEST_LINK = "https://validation.supabase.co/auth/v1/verify?token=test-owner-secret&type=magiclink";
const PREVIEW_HOST = "v-0123456789abcdef.preview.zaviagent.com";
const DEPLOY = "d000000001-00000001";

function activationState(site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">) {
  if (site.live_deploy_id === staged.deploy_id) return "live" as const;
  if (site.desired_sha !== staged.sha) return "superseded" as const;
  return "pending" as const;
}

function sandboxWith(files: { migrations?: string[]; manifest?: string | null; extra?: string[] }) {
  const run = vi.fn(async (cmd: string) => {
    if (cmd === `git ls-tree -r --name-only ${SHA}`) {
      const tree = ["package.json", "src/main.tsx", ...(files.extra ?? []), ...(files.migrations ?? []).map((n) => `supabase/migrations/${n}`)];
      return { exitCode: 0, stdout: tree.join("\n"), stderr: "" };
    }
    if (cmd.startsWith("git ls-tree --name-only") && cmd.includes("zavi-site.json")) {
      return { exitCode: 0, stdout: files.manifest == null ? "" : "zavi-site.json\n", stderr: "" };
    }
    if (cmd.startsWith(`git show ${SHA}:zavi-site.json`)) return { exitCode: 0, stdout: files.manifest ?? "", stderr: "" };
    if (cmd === `git ls-tree --name-only ${SHA} supabase/migrations/`) {
      return { exitCode: 0, stdout: (files.migrations ?? []).map((n) => `supabase/migrations/${n}`).join("\n"), stderr: "" };
    }
    if (cmd.startsWith(`git show ${SHA}:supabase/migrations/`)) return { exitCode: 0, stdout: "create table public.x (id int);", stderr: "" };
    if (cmd.startsWith("git ls-tree")) throw new Error(`unexpected ${cmd}`);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { sandbox: { run, readFile: vi.fn(), listFiles: vi.fn() } as SiteSandbox, run };
}

const ACTIVE = { kind: "active" as const, shard: { id: "s", project_ref: "r", url: "u" }, manifest_hash: "h", binding_version: 1, changes: [], plan: { add: [], change: [], archive: [], unchanged: [], reindex: [] }, index_building: [] as string[] };

type Pooled = NonNullable<SiteDeployDeps["pooled"]>;

function pooledFake(over: Partial<Pooled> = {}) {
  const order: string[] = [];
  const validate = vi.fn(async () => {
    order.push("validate");
    return { kind: "ok" as const, unchanged: false };
  });
  const apply = vi.fn(async () => {
    order.push("apply");
    return ACTIVE;
  });
  const ownerMagicLink = vi.fn(async () => LINK);
  const pooled: Pooled = { validate, apply, ownerMagicLink, ...over } as Pooled;
  return { pooled, validate: (over.validate ?? validate) as typeof validate, apply: (over.apply ?? apply) as typeof apply, ownerMagicLink, order };
}

function testSitesFake(order: string[], opts: { destroyFails?: number; owner_login?: string | null } = {}) {
  let failures = opts.destroyFails ?? 0;
  const live = new Set<string>();
  let n = 0;
  const testSites: SiteTestSites = {
    createTestSite: vi.fn(async () => {
      order.push("create-test-site");
      n += 1;
      const id = `ts-${n}`;
      live.add(id);
      return { test_site_id: id, preview_host: PREVIEW_HOST, owner_login: opts.owner_login === undefined ? TEST_LINK : opts.owner_login };
    }),
    destroyTestSite: vi.fn(async ({ test_site_id }) => {
      order.push(`destroy:${test_site_id}`);
      if (failures > 0) {
        failures -= 1;
        throw new Error("validation shard unreachable");
      }
      live.delete(test_site_id);
    }),
  };
  return { testSites, live };
}

function setup(opts: {
  site: Partial<SiteRow>;
  migrations?: string[];
  manifest?: string | null;
  pooled?: Pooled | null;
  order?: string[];
  testSites?: SiteTestSites | null;
}) {
  const { store, sites } = fakeSiteStore([siteRow({ id: A, label: "alpha", supabase_project_ref: null, supabase_url: null, ...opts.site })]);
  const { sandbox, run } = sandboxWith({ migrations: opts.migrations, manifest: opts.manifest });
  const order = opts.order ?? [];
  const kv: Record<string, string> = {};
  const applySql = vi.fn(async () => "applied" as const);
  const verifyCatalog = vi.fn(async () => [] as string[]);
  const supabaseOwnerLink = vi.fn(async () => LINK);
  const runGate = vi.fn(async (i: { owner_link: string | null; preview_url: string; allow_writes: boolean }) => {
    order.push("gate");
    return { ok: true, reason: "ok", evidence: "{}", owner_journey: i.owner_link ? ("passed" as const) : ("not_required" as const) };
  });
  const stage = vi.fn(async (i: { sha: string }) => {
    order.push("stage");
    return { deploy_id: DEPLOY, preview_url: "https://alpha.zaviagent.com/__zavi_preview/x/?t=tok-abcdefgh", sha: i.sha };
  });
  const previewUrl = vi.fn(async (i: { host: string; deploy_id: string }) => `https://${i.host}/__zavi_preview/${i.deploy_id}/?t=signed-for-test-host`);
  const gens = fakeGenerations(sites);
  const alertOps = vi.fn(async () => undefined);
  const requestActivate = vi.fn(async (i: { tenant_id: string; site_id: string; deploy_id: string; sha: string; generation?: number }) => {
    order.push("activate");
    const s = await store.get(i.tenant_id, i.site_id);
    if (await store.activateIfDesired(i.tenant_id, i.site_id, i.sha, i.deploy_id, `https://${s!.hostname}`, i.generation)) kv[`host:${s!.hostname}`] = i.deploy_id;
  });
  const checkpoints = memoryCheckpoints();
  const deps: SiteDeployDeps = {
    store,
    sandboxes: { forSite: async () => sandbox },
    supabase: { applySql, verifyCatalog },
    publisher: { stage, previewUrl },
    requestActivate,
    activationState,
    verifySiteDeploy: async (h, d) => (kv[`host:${h}`] === d ? { ok: true as const } : { ok: false as const, error: "no" }),
    generations: gens.generations,
    testSites: opts.testSites === undefined ? null : opts.testSites,
    alertOps,
    checkpoints,
    runGate: runGate as unknown as SiteDeployDeps["runGate"],
    sleep: async () => {},
    activationWaitMs: 0,
    pooled: opts.pooled === undefined ? null : opts.pooled,
  };
  const handler = createSiteDeployHandler(deps);
  return { handler, sites, run, applySql, verifyCatalog, supabaseOwnerLink, runGate, store, stage, previewUrl, gens, alertOps, requestActivate, kv, checkpoints, order, deps };
}

const step = (t: ReturnType<typeof setup>) => t.handler.step({ tenant_id: T1, conductor_run_id: "run-1", site_id: A, sha: SHA, attempt: 0 });
const KEY = `${T1}:run-1:${A}:${SHA}:0`;

const BOOKINGS = JSON.stringify({ schemaVersion: 1, collections: { bookings: { rules: { create: ["anyone"] } } } });

function pooledSite(over: { site?: Partial<SiteRow>; pooled?: Partial<Pooled>; destroyFails?: number; owner_login?: string | null } = {}) {
  const p = pooledFake(over.pooled);
  const ts = testSitesFake(p.order, { destroyFails: over.destroyFails, owner_login: over.owner_login });
  const t = setup({ site: { backend_mode: "pooled", shard_id: SHARD, ...over.site }, manifest: BOOKINGS, pooled: p.pooled, order: p.order, testSites: ts.testSites });
  return { ...t, p, ts };
}

describe("site deploy: static / pooled sites", () => {
  it("a static site with no collections goes live with NO SQL, NO catalog check, NO owner journey, NO test site", async () => {
    const p = pooledFake({ validate: vi.fn(async () => ({ kind: "static" as const })) });
    const ts = testSitesFake(p.order);
    const t = setup({ site: { backend_mode: "static" }, manifest: JSON.stringify({ smoke: { journeys: [] } }), pooled: p.pooled, testSites: ts.testSites });
    expect(await step(t)).toMatchObject({ kind: "live" });
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.verifyCatalog).not.toHaveBeenCalled();
    expect(ts.testSites.createTestSite).not.toHaveBeenCalled();
    expect(p.apply).not.toHaveBeenCalled();
    expect(t.runGate.mock.calls[0][0]).toMatchObject({ owner_link: null, allow_writes: false });
  });

  it("REFUSES supabase/migrations on a pooled-path site: repair, nothing validated, run or staged", async () => {
    for (const mode of ["static", "pooled"] as const) {
      const p = pooledFake();
      const t = setup({ site: { backend_mode: mode }, migrations: ["001_evil.sql"], manifest: BOOKINGS, pooled: p.pooled });
      const out = await step(t);
      expect(out).toMatchObject({ kind: "repair" });
      expect((out as { signal: string }).signal).toMatch(/SQL files, supabase\/ and the "raw_sql" capability are not allowed/);
      expect((out as { signal: string }).signal).toMatch(/Zavi data SDK/);
      expect(t.applySql).not.toHaveBeenCalled();
      expect(p.validate).not.toHaveBeenCalled();
      expect(p.apply).not.toHaveBeenCalled();
      expect(t.run.mock.calls.some(([c]) => String(c).startsWith(`git show ${SHA}:supabase`))).toBe(false);
    }
  });

  it("REFUSES any .sql file or supabase/ path anywhere in the repo (not only supabase/migrations)", async () => {
    for (const extra of [["db/seed.sql"], ["supabase/config.toml"], ["src/Evil.SQL"]]) {
      const p = pooledFake();
      const t = setup({ site: { backend_mode: "static" }, manifest: BOOKINGS, pooled: p.pooled });
      t.run.mockImplementation(async (cmd: string) =>
        cmd === `git ls-tree -r --name-only ${SHA}`
          ? { exitCode: 0, stdout: ["package.json", ...extra].join("\n"), stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" },
      );
      expect(await step(t)).toMatchObject({ kind: "repair" });
      expect(p.apply).not.toHaveBeenCalled();
    }
  });

  it("validate -> stage -> test site -> gate there -> destroy -> lease + live apply -> activate", async () => {
    const t = pooledSite();
    expect(await step(t)).toMatchObject({ kind: "live" });
    expect(t.order).toEqual(["validate", "stage", "create-test-site", "gate", "destroy:ts-1", "apply", "activate"]);
    expect(t.ts.testSites.createTestSite).toHaveBeenCalledWith({ tenant_id: T1, live_site_id: A, manifestRaw: JSON.parse(BOOKINGS), ttl: 1800, deploy_id: DEPLOY });
    expect(t.previewUrl).toHaveBeenCalledWith({ tenant_id: T1, site_id: A, deploy_id: DEPLOY, host: PREVIEW_HOST });
    expect(t.runGate.mock.calls[0][0]).toMatchObject({
      preview_url: `https://${PREVIEW_HOST}/__zavi_preview/${DEPLOY}/?t=signed-for-test-host`,
      owner_link: TEST_LINK,
      allow_writes: true,
      backend_mode: "pooled",
    });
    expect(t.p.ownerMagicLink).not.toHaveBeenCalled();
    expect(t.supabaseOwnerLink).not.toHaveBeenCalled();
    expect(t.p.apply).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1, manifestRaw: JSON.parse(BOOKINGS), additiveOnly: true }));
    expect(t.gens.calls).toEqual(["begin:1", "lease:1:leased", "lease:1:leased", "release:1"]);
    expect(t.ts.live.size).toBe(0);
    expect(await t.checkpoints.get(KEY)).toBeNull();
  });

  it("a gate failure on the test site: destroyed, the live site is never applied or activated", async () => {
    const t = pooledSite();
    t.runGate.mockImplementationOnce(async () => {
      t.order.push("gate");
      return { ok: false, reason: "journey write-create failed", evidence: "{}", owner_journey: "passed" as const };
    });
    const out = await step(t);
    expect(out).toMatchObject({ kind: "repair", signal: expect.stringContaining("write-create failed") });
    expect(t.order).toEqual(["validate", "stage", "create-test-site", "gate", "destroy:ts-1"]);
    expect(t.p.apply).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.ts.live.size).toBe(0);
  });

  it("a gate that throws still destroys the test site; the throw reaches the conductor", async () => {
    const t = pooledSite();
    t.runGate.mockImplementationOnce(async () => {
      throw new Error("runner sandbox died");
    });
    await expect(step(t)).rejects.toThrow(/runner sandbox died/);
    expect(t.ts.testSites.destroyTestSite).toHaveBeenCalledWith({ tenant_id: T1, test_site_id: "ts-1" });
    expect(t.p.apply).not.toHaveBeenCalled();
    expect(t.ts.live.size).toBe(0);
  });

  it("a test site that could not be destroyed pages ops, stays in the checkpoint and is destroyed first on the next tick", async () => {
    const t = pooledSite({ destroyFails: 1 });
    t.runGate.mockImplementationOnce(async () => {
      throw new Error("runner sandbox died");
    });
    await expect(step(t)).rejects.toThrow(/runner sandbox died/);
    expect(t.alertOps).toHaveBeenCalledWith(expect.objectContaining({ code: "site_test_site_not_destroyed" }));
    expect((await t.checkpoints.get(KEY))?.test_site_id).toBe("ts-1");
    expect(t.ts.live.has("ts-1")).toBe(true);
    expect(await step(t)).toMatchObject({ kind: "live" });
    expect(t.order.filter((o) => o.startsWith("destroy:"))).toEqual(["destroy:ts-1", "destroy:ts-1", "destroy:ts-2"]);
    expect(t.ts.live.size).toBe(0);
    expect(t.gens.calls.filter((c) => c.startsWith("begin"))).toEqual(["begin:1"]);
  });

  it("a leftover test site that still cannot be destroyed blocks a second one (retryable), its id kept", async () => {
    const t = pooledSite({ destroyFails: 2 });
    t.runGate.mockImplementationOnce(async () => {
      throw new Error("runner sandbox died");
    });
    await expect(step(t)).rejects.toThrow(/runner sandbox died/);
    await expect(step(t)).rejects.toBeInstanceOf(SiteGateUnavailable);
    expect(t.ts.testSites.createTestSite).toHaveBeenCalledTimes(1);
    expect((await t.checkpoints.get(KEY))?.test_site_id).toBe("ts-1");
  });

  it("a failed gate whose test site could not be destroyed retries the destroy before handing back the repair", async () => {
    const t = pooledSite({ destroyFails: 1 });
    t.runGate.mockImplementationOnce(async () => ({ ok: false, reason: "journey failed", evidence: "{}", owner_journey: "passed" as const }));
    expect(await step(t)).toMatchObject({ kind: "repair" });
    expect(t.ts.live.size).toBe(0);
    expect(await t.checkpoints.get(KEY)).toBeNull();
  });

  it("the kept journeys reach both kinds of gate, and a failed gate's journeys come back on the repair", async () => {
    const kept_journeys = { names: ["home", "open-times"], must_pass: ["open-times"] };
    const failed = { ok: false, reason: "journey failed", evidence: "{}", owner_journey: "passed" as const, journeys: ["home", "open-times"], failed_journeys: ["open-times"], fingerprints: { "open-times": "fp" } };
    const pooled = pooledSite();
    pooled.runGate.mockImplementationOnce(async () => failed);
    const out = await pooled.handler.step({ tenant_id: T1, conductor_run_id: "run-1", site_id: A, sha: SHA, attempt: 0, kept_journeys });
    expect(out).toMatchObject({ kind: "repair", journeys: { names: ["home", "open-times"], must_pass: ["open-times"], fingerprints: { "open-times": "fp" } } });
    expect(pooled.runGate.mock.calls[0][0]).toMatchObject({ allow_writes: true, kept_journeys });

    const p = pooledFake({ validate: vi.fn(async () => ({ kind: "static" as const })) });
    const live = setup({ site: { backend_mode: "static" }, manifest: JSON.stringify({ smoke: { journeys: [] } }), pooled: p.pooled, testSites: testSitesFake(p.order).testSites });
    live.runGate.mockImplementationOnce(async () => failed);
    const out2 = await live.handler.step({ tenant_id: T1, conductor_run_id: "run-1", site_id: A, sha: SHA, attempt: 0, kept_journeys });
    expect(out2).toMatchObject({ kind: "repair", journeys: { names: ["home", "open-times"], must_pass: ["open-times"], fingerprints: { "open-times": "fp" } } });
    expect(live.runGate.mock.calls[0][0]).toMatchObject({ allow_writes: false, kept_journeys });
  });

  it("a test site not destroyed after a PASSED gate stays recorded through the commit", async () => {
    const t = pooledSite({ destroyFails: 1 });
    t.requestActivate.mockImplementationOnce(async () => undefined);
    expect(await step(t)).toEqual({ kind: "waiting" });
    expect(t.p.apply).toHaveBeenCalledTimes(1);
    expect((await t.checkpoints.get(KEY))?.test_site_id).toBe("ts-1");
  });

  it("a publish that begins while another one is mid-commit waits (begin is busy), nothing bumped", async () => {
    const t = pooledSite();
    t.gens.leases.set(A, { gen: 99, until: Date.now() + 60_000 });
    expect(await step(t)).toEqual({ kind: "waiting" });
    expect(t.sites[0].publish_generation ?? 0).toBe(0);
    expect(t.stage).not.toHaveBeenCalled();
  });

  it("a test site that refuses the candidate's contract is a repair (no gate, nothing applied); unavailable is a retry", async () => {
    const t = pooledSite();
    const refused = Object.assign(new Error("test site refused: zavi-site.json is invalid"), { name: "TestSiteRefused", reason: "zavi-site.json is invalid", errors: ["collections.x: bad"] });
    (t.ts.testSites.createTestSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(refused);
    const out = await step(t);
    expect(out).toMatchObject({ kind: "repair", signal: expect.stringContaining("collections.x: bad") });
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.p.apply).not.toHaveBeenCalled();

    const u = pooledSite();
    (u.ts.testSites.createTestSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("no validation shard has room"), { name: "TestSiteUnavailable" }));
    await expect(step(u)).rejects.toThrow(/no validation shard/);
    expect(u.p.apply).not.toHaveBeenCalled();
  });

  it("the new generation RESERVES its fencing token on the site's shard before any work; a failed reservation is a retry with nothing staged", async () => {
    const reserve = vi.fn(async () => "reserved" as const);
    const t = pooledSite({ pooled: { reserve } });
    expect(await step(t)).toMatchObject({ kind: "live" });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1, generation: 1 }));
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(t.p.validate.mock.invocationCallOrder[0]);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(t.stage.mock.invocationCallOrder[0]);

    const failing = pooledSite({ pooled: { reserve: vi.fn(async () => { throw new Error("shard down"); }) } });
    await expect(step(failing)).rejects.toThrow(/shard down/);
    expect(failing.p.validate).not.toHaveBeenCalled();
    expect(failing.stage).not.toHaveBeenCalled();
    expect(failing.p.apply).not.toHaveBeenCalled();
  });

  it("no test-site backend: a retryable SiteGateUnavailable BEFORE staging; never a gate on the live site", async () => {
    const p = pooledFake();
    const t = setup({ site: { backend_mode: "pooled", shard_id: SHARD }, manifest: BOOKINGS, pooled: p.pooled, testSites: null });
    await expect(step(t)).rejects.toBeInstanceOf(SiteGateUnavailable);
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.runGate).not.toHaveBeenCalled();
    expect(p.apply).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("an owner required but the test site has no owner sign-in: retryable, test site destroyed, nothing applied", async () => {
    const t = pooledSite({ owner_login: null });
    await expect(step(t)).rejects.toBeInstanceOf(SiteGateUnavailable);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.ts.live.size).toBe(0);
    expect(t.p.apply).not.toHaveBeenCalled();
  });

  it("a NOT-ADDITIVE candidate is a repair with the reason at validate: nothing staged, no test site", async () => {
    const reason = "This change to zavi-site.json is not additive: it removes the field \"phone\". Nothing was changed.";
    const t = pooledSite({ pooled: { validate: vi.fn(async () => ({ kind: "refused" as const, code: "not_additive", reason })) } });
    const out = await step(t);
    expect(out).toMatchObject({ kind: "repair" });
    expect((out as { signal: string }).signal).toContain('removes the field "phone"');
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.ts.testSites.createTestSite).not.toHaveBeenCalled();
  });

  it("an invalid manifest / refused change at validate is a repair (nothing staged)", async () => {
    for (const out of [{ kind: "invalid" as const, errors: ["collections.bookings.rules.delete: anyone not allowed"] }, { kind: "refused" as const, reason: "kind change" }]) {
      const t = pooledSite({ pooled: { validate: vi.fn(async () => out) } });
      expect(await step(t)).toMatchObject({ kind: "repair" });
      expect(t.runGate).not.toHaveBeenCalled();
      expect(t.stage).not.toHaveBeenCalled();
    }
    const p = pooledFake();
    const bad = setup({ site: { backend_mode: "static" }, manifest: "{not json", pooled: p.pooled });
    expect(await step(bad)).toMatchObject({ kind: "repair" });
  });

  it("the live apply refused after the gate (the live site moved): repair, never activated, old version keeps serving", async () => {
    const t = pooledSite({ pooled: { apply: vi.fn(async () => ({ kind: "refused" as const, code: "not_additive", reason: "removes the collection \"rooms\"" })) } });
    const out = await step(t);
    expect(out).toMatchObject({ kind: "repair" });
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.gens.calls).toContain("release:1");
  });

  it("a live apply that throws keeps the passed gate: the next tick only commits (no re-stage, no re-gate)", async () => {
    let calls = 0;
    const t = pooledSite({
      pooled: {
        apply: vi.fn(async () => {
          calls += 1;
          if (calls === 1) throw new Error("shard statement timeout");
          return ACTIVE;
        }),
      },
    });
    await expect(step(t)).rejects.toThrow(/statement timeout/);
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.gens.leases.size).toBe(0);
    expect(await step(t)).toMatchObject({ kind: "live" });
    expect(t.stage).toHaveBeenCalledTimes(1);
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.ts.testSites.createTestSite).toHaveBeenCalledTimes(1);
  });

  it("a commit whose lease is lost mid-way never applies its contract: the apply is fenced, the gate is kept", async () => {
    const t = pooledSite({
      pooled: {
        apply: vi.fn(async (i: { fence?: () => Promise<boolean> }) =>
          i.fence && !(await i.fence()) ? { kind: "refused" as const, code: "lease_lost", reason: "lost" } : ACTIVE,
        ),
      },
    });
    const real = t.gens.generations.lease;
    let n = 0;
    t.deps.generations.lease = vi.fn(async (...a: Parameters<typeof real>) => (++n === 1 ? real(...a) : "busy"));
    expect(await step(t)).toEqual({ kind: "waiting" });
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect((await t.checkpoints.get(KEY))?.phase).toBe("gated");
    expect(t.gens.leases.size).toBe(0);

    await t.gens.generations.begin(T1, A, "fedcba9876543");
    t.deps.generations.lease = real;
    expect(await step(t)).toMatchObject({ kind: "failed", reason: expect.stringContaining("newer version") });
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("another generation's lease held: waiting; once released the commit goes through", async () => {
    const t = pooledSite();
    let held = true;
    const real = t.gens.generations.lease;
    t.deps.generations.lease = vi.fn(async (...a: Parameters<typeof real>) => (held ? "busy" : real(...a)));
    expect(await step(t)).toEqual({ kind: "waiting" });
    expect(t.p.apply).not.toHaveBeenCalled();
    held = false;
    expect(await step(t)).toMatchObject({ kind: "live" });
    expect(t.runGate).toHaveBeenCalledTimes(1);
  });

  it("the activation carries the generation; a newer generation (same commit) makes the queued one superseded", async () => {
    const t = pooledSite();
    t.requestActivate.mockImplementationOnce(async () => undefined);
    expect(await step(t)).toEqual({ kind: "waiting" });
    expect(t.requestActivate.mock.calls[0][0]).toMatchObject({ generation: 1 });
    await t.gens.generations.begin(T1, A, SHA);
    expect(await t.store.activateIfDesired(T1, A, SHA, DEPLOY, "https://alpha.zaviagent.com", 1)).toBe(false);
    expect(await step(t)).toMatchObject({ kind: "failed", reason: expect.stringContaining("newer version") });
  });

  it("a newer publish began while this one gated: superseded, its manifest is never applied", async () => {
    const t = pooledSite();
    t.runGate.mockImplementationOnce(async () => {
      await t.gens.generations.begin(T1, A, "fedcba9876543");
      return { ok: true, reason: "ok", evidence: "{}", owner_journey: "passed" as const };
    });
    expect(await step(t)).toMatchObject({ kind: "failed", reason: expect.stringContaining("newer version") });
    expect(t.p.apply).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("a still-running index rebuild goes live with a NOTE (not an error)", async () => {
    const t = pooledSite({ pooled: { apply: vi.fn(async () => ({ ...ACTIVE, index_building: ["bookings"] })) } });
    const out = await step(t);
    expect(out).toMatchObject({ kind: "live" });
    expect((out as { notes?: string[] }).notes?.[0]).toMatch(/bookings is still rebuilding.*index_building/);
  });

  it("without the pooled backend wired: collections or a pooled site FAIL (never a per-site project)", async () => {
    const t1 = setup({ site: { backend_mode: "static" }, manifest: BOOKINGS, pooled: null });
    expect(await step(t1)).toMatchObject({ kind: "failed" });
    const t2 = setup({ site: { backend_mode: "pooled", shard_id: SHARD }, manifest: JSON.stringify({}), pooled: null });
    expect(await step(t2)).toMatchObject({ kind: "failed" });
    for (const t of [t1, t2]) expect(t.applySql).not.toHaveBeenCalled();
  });

  it("a pooled-backend throw at validate (shard not reachable) propagates for the conductor's retry", async () => {
    const t = pooledSite({ pooled: { validate: vi.fn(async () => { throw new Error("shard unreachable"); }) } });
    await expect(step(t)).rejects.toThrow(/shard unreachable/);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.stage).not.toHaveBeenCalled();
  });

  it("a dedicated site (and a row with no backend_mode) keeps its path: migrations + catalog, never the pooled backend", async () => {
    const p = pooledFake();
    for (const site of [{ backend_mode: "dedicated" as const }, {}]) {
      const t = setup({ site: { ...site, supabase_project_ref: "ref" }, pooled: p.pooled });
      t.run.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      expect(await step(t)).toMatchObject({ kind: "live" });
      expect(t.verifyCatalog).toHaveBeenCalledTimes(1);
      expect(t.runGate.mock.calls[0][0]).toMatchObject({ allow_writes: false, owner_link: null });
    }
    expect(p.validate).not.toHaveBeenCalled();
    expect(p.apply).not.toHaveBeenCalled();
  });
});

describe("site deploy: dedicated capabilities (contract section 5)", () => {
  const PAYMENTS = JSON.stringify({ schemaVersion: 2, capabilities: ["payments"], collections: { bookings: { rules: { create: ["anyone"] } } } });

  it("STATIC + a declared capability: moved to dedicated BEFORE anything pooled, then this deploy runs the dedicated path", async () => {
    const moveToDedicated = vi.fn(async () => ({ kind: "dedicated" as const }));
    const p = pooledFake({ moveToDedicated });
    const t = setup({ site: { backend_mode: "static" }, manifest: PAYMENTS, migrations: ["001_orders.sql"], pooled: p.pooled });
    const out = await step(t);
    expect(moveToDedicated).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1, capabilities: ["payments"] }));
    expect(p.validate).not.toHaveBeenCalled();
    expect(p.apply).not.toHaveBeenCalled();
    expect(t.applySql).toHaveBeenCalledWith(expect.objectContaining({ migration_id: "001_orders" }));
    expect(t.verifyCatalog).toHaveBeenCalled();
    expect(out).toMatchObject({ kind: "live" });
    expect((out as { notes?: string[] }).notes?.[0]).toMatch(/now has its own database project/);
  });

  it("STATIC + SQL files only (or a declared raw_sql): REFUSED with the SDK message, never moved, nothing run", async () => {
    const RAW = JSON.stringify({ schemaVersion: 2, capabilities: ["raw_sql"], collections: { bookings: { rules: { create: ["anyone"] } } } });
    for (const c of [{ manifest: BOOKINGS, migrations: ["001_x.sql"] }, { manifest: RAW, migrations: [] as string[] }]) {
      const moveToDedicated = vi.fn(async () => ({ kind: "dedicated" as const }));
      const p = pooledFake({ moveToDedicated });
      const t = setup({ site: { backend_mode: "static" }, ...c, pooled: p.pooled });
      const out = await step(t);
      expect(out).toMatchObject({ kind: "repair" });
      expect((out as { signal: string }).signal).toMatch(/never runs SQL from a site/);
      expect(moveToDedicated).not.toHaveBeenCalled();
      expect(p.validate).not.toHaveBeenCalled();
      expect(p.apply).not.toHaveBeenCalled();
      expect(t.applySql).not.toHaveBeenCalled();
    }
  });

  it("a DECLARED raw_sql is refused before routing, even beside a real capability (never the legacy SQL path)", async () => {
    const BOTH = JSON.stringify({ schemaVersion: 2, capabilities: ["payments", "raw_sql"], collections: { bookings: { rules: { create: ["anyone"] } } } });
    const moveToDedicated = vi.fn(async () => ({ kind: "dedicated" as const }));
    const p = pooledFake({ moveToDedicated });
    const t = setup({ site: { backend_mode: "static" }, manifest: BOTH, migrations: ["001_x.sql"], pooled: p.pooled });
    const out = await step(t);
    expect(out).toMatchObject({ kind: "repair" });
    expect((out as { signal: string }).signal).toMatch(/"raw_sql" in zavi-site\.json capabilities/);
    expect(moveToDedicated).not.toHaveBeenCalled();
    expect(t.applySql).not.toHaveBeenCalled();
  });

  it("POOLED + a capability: graduation is requested, the deploy fails with a founder reason, nothing is applied", async () => {
    for (const available of [true, false]) {
      const moveToDedicated = vi.fn(async () => ({ kind: "graduating" as const, available }));
      const p = pooledFake({ moveToDedicated });
      const t = setup({ site: { backend_mode: "pooled", shard_id: SHARD }, manifest: PAYMENTS, pooled: p.pooled });
      const out = await step(t);
      expect(out).toMatchObject({ kind: "failed" });
      expect((out as { reason: string }).reason).toMatch(available ? /moving to its own database project/ : /move has been requested/);
      expect(t.applySql).not.toHaveBeenCalled();
      expect(p.apply).not.toHaveBeenCalled();
    }
  });

  it("a site WITHOUT any capability keeps the pooled path", async () => {
    const moveToDedicated = vi.fn();
    const t = pooledSite({ site: { backend_mode: "static", shard_id: null }, pooled: { moveToDedicated } });
    expect(await step(t)).toMatchObject({ kind: "live" });
    expect(moveToDedicated).not.toHaveBeenCalled();
    expect(t.p.apply).toHaveBeenCalled();
  });
});

describe("site deploy: a KERNEL site (dedicated, served by its own one-site kernel shard)", () => {
  const KERNEL = "55555555-5555-4555-8555-555555555555";
  const SITE_V = JSON.stringify({ schemaVersion: 2, capabilities: ["payments"], collections: { bookings: { rules: { create: ["anyone"] } } } });
  const PLAIN = JSON.stringify({ schemaVersion: 2, collections: { bookings: { rules: { create: ["anyone"] } } } });
  const kernelSite = { backend_mode: "dedicated", kernel_shard_id: KERNEL, supabase_project_ref: "ownprojectref0001", supabase_url: "https://ownprojectref0001.supabase.co" } as Partial<SiteRow>;

  it("GRADUATED: dedicated path (migrations + catalog), collections validated before and applied to its kernel after a READ-ONLY gate", async () => {
    const moveToDedicated = vi.fn();
    const kernelSqlAllowed = vi.fn(async () => true);
    const p = pooledFake({ moveToDedicated, kernelSqlAllowed });
    const ts = testSitesFake(p.order);
    const t = setup({ site: kernelSite, manifest: SITE_V, migrations: ["001_orders.sql"], pooled: p.pooled, order: p.order, testSites: ts.testSites });
    expect(await step(t)).toMatchObject({ kind: "live" });
    expect(kernelSqlAllowed).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1 }));
    expect(p.order).toEqual(["validate", "stage", "gate", "apply", "activate"]);
    expect(p.apply).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1, manifestRaw: JSON.parse(SITE_V), additiveOnly: true }));
    expect(moveToDedicated).not.toHaveBeenCalled();
    expect(t.applySql).toHaveBeenCalledWith(expect.objectContaining({ migration_id: "001_orders" }));
    expect(t.verifyCatalog).toHaveBeenCalled();
    expect(p.ownerMagicLink).not.toHaveBeenCalled();
    expect(t.runGate.mock.calls[0][0].owner_link).toBeNull();
    expect(ts.testSites.createTestSite).not.toHaveBeenCalled();
    expect(t.runGate.mock.calls[0][0].allow_writes).toBe(false);
  });

  it("BUILT as a kernel: manifest validated then applied to the kernel after a read-only gate; NO SQL, NO legacy catalog check", async () => {
    for (const kernelSqlAllowed of [vi.fn(async () => false), undefined]) {
      const p = pooledFake(kernelSqlAllowed ? { kernelSqlAllowed } : {});
      const t = setup({ site: kernelSite, manifest: PLAIN, pooled: p.pooled });
      expect(await step(t)).toMatchObject({ kind: "live" });
      expect(p.apply).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1, manifestRaw: JSON.parse(PLAIN), additiveOnly: true }));
      expect(t.applySql).not.toHaveBeenCalled();
      expect(t.verifyCatalog).not.toHaveBeenCalled();
      expect(t.run.mock.calls.some(([c]) => String(c).includes(" supabase/migrations/"))).toBe(false);
      expect(p.ownerMagicLink).not.toHaveBeenCalled();
      expect(t.runGate.mock.calls[0][0]).toMatchObject({ allow_writes: false, owner_link: null });
    }
  });

  it("BUILT as a kernel: a capability the kernel does not serve is REFUSED (typed, founder reason), never silently accepted", async () => {
    const moveToDedicated = vi.fn();
    const p = pooledFake({ moveToDedicated, kernelSqlAllowed: async () => false });
    const t = setup({ site: kernelSite, manifest: SITE_V, pooled: p.pooled });
    const out = await step(t);
    expect(out).toMatchObject({ kind: "failed" });
    expect((out as { reason: string }).reason).toMatch(/needs taking payments, which Zavi's database does not support yet/);
    expect(p.apply).not.toHaveBeenCalled();
    expect(moveToDedicated).not.toHaveBeenCalled();
    expect(t.applySql).not.toHaveBeenCalled();
  });

  it("BUILT as a kernel: SQL files are REFUSED (repair with the SDK message), nothing validated, applied or run", async () => {
    const p = pooledFake({ kernelSqlAllowed: async () => false });
    const t = setup({ site: kernelSite, manifest: PLAIN, migrations: ["001_x.sql"], pooled: p.pooled });
    const out = await step(t);
    expect(out).toMatchObject({ kind: "repair" });
    expect((out as { signal: string }).signal).toMatch(/Zavi data SDK/);
    expect(p.apply).not.toHaveBeenCalled();
    expect(t.applySql).not.toHaveBeenCalled();
  });

  it("an unreadable SQL policy never guesses: the step throws (the conductor retries)", async () => {
    const p = pooledFake({ kernelSqlAllowed: async () => { throw new Error("db down"); } });
    const t = setup({ site: kernelSite, manifest: PLAIN, pooled: p.pooled });
    await expect(step(t)).rejects.toThrow(/database policy/);
    expect(p.apply).not.toHaveBeenCalled();
    expect(t.applySql).not.toHaveBeenCalled();
  });

  it("a plain dedicated site (no kernel) never touches the pooled backend", async () => {
    const p = pooledFake();
    const t = setup({
      site: { backend_mode: "dedicated", supabase_project_ref: "ownprojectref0001", supabase_url: "https://ownprojectref0001.supabase.co" } as Partial<SiteRow>,
      manifest: SITE_V,
      pooled: p.pooled,
    });
    await step(t);
    expect(p.validate).not.toHaveBeenCalled();
    expect(p.apply).not.toHaveBeenCalled();
  });
});
