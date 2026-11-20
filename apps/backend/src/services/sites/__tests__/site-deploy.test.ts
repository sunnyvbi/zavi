import { describe, it, expect, vi } from "vitest";
import { createSiteDeployHandler, memoryCheckpoints, type SiteDeployDeps } from "../site-deploy";
import { SiteBuildFailed, SiteCredentialsMissing, SitePublishPlatformError, SitePublishTransientError, type SiteRow, type SiteSandbox, type StagedDeploy } from "../contract";
import { fakeGenerations, fakeSiteStore, siteRow, T1 } from "./fake-site-store";
import { SiteSqlError, SupabaseMgmtError } from "../supabase-mgmt";
import { SiteMigrationChecksumMismatch } from "../supabase-site-provisioner";
import { runSiteGate } from "../site-gate";
import { createRequire } from "node:module";
import { fakeLaunch, type FakeSite } from "../gate-runner/__tests__/fake-browser";
import { GATE_CONFIG_PATH } from "../gate-runner/sandbox-runner";
import type { SiteKeptJourneys } from "../contract";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const SHA = "abcdef1234567";
const LINK = "https://ref.supabase.co/auth/v1/verify?token=owner-link-secret-123&type=magiclink";

function activationState(site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">) {
  if (site.live_deploy_id === staged.deploy_id) return "live" as const;
  if (site.desired_sha !== staged.sha) return "superseded" as const;
  return "pending" as const;
}

function makeSandbox(migrations: Record<string, string>) {
  const run = vi.fn(async (cmd: string, _opts?: Parameters<SiteSandbox["run"]>[1]) => {
    if (cmd.startsWith("git ls-tree")) {
      return { exitCode: 0, stdout: Object.keys(migrations).map((n) => `supabase/migrations/${n}`).join("\n"), stderr: "" };
    }
    const m = /^git show [0-9a-f]+:supabase\/migrations\/(.+)$/.exec(cmd);
    if (m) return { exitCode: 0, stdout: migrations[m[1]] ?? "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { sandbox: { run, readFile: vi.fn(), listFiles: vi.fn() } as SiteSandbox, run };
}

function setup(opts: {
  sites?: SiteRow[];
  gateOk?: boolean;
  migrations?: Record<string, string>;
  applySql?: SiteDeployDeps["supabase"]["applySql"];
  stage?: SiteDeployDeps["publisher"]["stage"];
  activateInline?: boolean;

  ownerJourney?: "passed" | "failed" | "not_required";
  catalogProblems?: string[];
} = {}) {
  const { store, sites } = fakeSiteStore(opts.sites ?? [siteRow({ id: A, label: "alpha" }), siteRow({ id: B, label: "beta" })]);
  const order: string[] = [];
  const gens = fakeGenerations(sites);
  const kv: Record<string, string> = {};
  const { sandbox, run } = makeSandbox(opts.migrations ?? { "001_a.sql": "create table a();", "002_b.sql": "create table b();" });
  const sandboxes = { forSite: vi.fn(async () => sandbox) };
  const applySql = vi.fn(
    opts.applySql ??
      (async (i: { migration_id: string }) => {
        order.push(`sql:${i.migration_id}`);
        return "applied" as const;
      }),
  );
  const ownerMagicLink = vi.fn(async () => LINK);
  const verifyCatalog = vi.fn(async () => {
    order.push("catalog");
    return opts.catalogProblems ?? [];
  });
  let n = 0;
  const stage = vi.fn(
    opts.stage ??
      (async (i: { site_id: string; sha: string }) => {
        order.push("stage");
        n += 1;
        return { deploy_id: `d00000000${n}-0000000${n}`, preview_url: `https://p/__zavi_preview/x/?t=tok-${n}-abcdefgh`, sha: i.sha };
      }),
  );
  const runGate = vi.fn(async (_i: { owner_link: string | null; allow_writes: boolean; preview_url: string }) => {
    order.push("gate");
    const owner_journey = _i.owner_link ? (opts.ownerJourney ?? "passed") : "not_required";
    return opts.gateOk === false
      ? { ok: false, reason: "journey home failed", evidence: "{}", owner_journey }
      : { ok: true, reason: "ok", evidence: "{}", owner_journey };
  });
  const requestActivate = vi.fn(async (i: { tenant_id: string; site_id: string; deploy_id: string; sha: string }) => {
    order.push("activate");
    if (opts.activateInline === false) return;
    const s = await store.get(i.tenant_id, i.site_id);
    if (await store.activateIfDesired(i.tenant_id, i.site_id, i.sha, i.deploy_id, `https://${s!.hostname}`)) {
      kv[`host:${s!.hostname}`] = i.deploy_id;
    }
  });
  const verifySiteDeploy = vi.fn(async (hostname: string, deploy_id: string) => {
    order.push("verify");
    return kv[`host:${hostname}`] === deploy_id ? ({ ok: true } as const) : ({ ok: false, error: "not yet" } as const);
  });
  const deps: SiteDeployDeps = {
    store,
    sandboxes,
    supabase: { applySql, verifyCatalog },
    publisher: { stage, previewUrl: async () => "https://unused.example/" },
    generations: gens.generations,
    requestActivate,
    activationState,
    verifySiteDeploy,
    checkpoints: memoryCheckpoints(),
    runGate: runGate as unknown as SiteDeployDeps["runGate"],
    sleep: async () => {},
    activationWaitMs: 0,
  };
  const handler = createSiteDeployHandler(deps);
  return { handler, deps, order, kv, sites, run, applySql, stage, runGate, requestActivate, ownerMagicLink, sandboxes, verifyCatalog };
}

const step = (h: ReturnType<typeof setup>["handler"], site_id = A, sha = SHA) =>
  h.step({ tenant_id: T1, conductor_run_id: "run-1", site_id, sha, attempt: 0 });

it("a serving dedicated site applies its new migrations automatically, row-guarded, never parks for review", async () => {
  const t = setup({ sites: [siteRow({ id: A, label: "alpha", status: "live", live_sha: "1111111", live_deploy_id: "d0-old" })] });
  expect(await step(t.handler)).toMatchObject({ kind: "live" });
  expect(t.applySql).toHaveBeenCalledTimes(2);
  for (const [arg] of t.applySql.mock.calls as unknown as Array<[{ preserveExistingRows?: boolean }]>) expect(arg.preserveExistingRows).toBe(true);
});

it("a real smoke-runner infrastructure failure escapes deploy as a retry, never a paid repair", async () => {
  const t = setup();
  t.runGate.mockImplementationOnce(async (input) => runSiteGate({
    ...input,
    sandbox: {
      run: async () => ({ exitCode: 0, stdout: JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }] } }), stderr: "" }),
      readFile: async () => "", listFiles: async () => [],
    },
    sha: SHA,
  }, { runner: async () => { throw new Error("runner capacity unavailable"); } }));
  await expect(step(t.handler)).rejects.toThrow("runner capacity unavailable");
  expect(t.requestActivate).not.toHaveBeenCalled();
  expect(t.kv).toEqual({});
});

describe("SiteDeployHandler.step", () => {
  it("runs migrations → stage → gate → activate → verify, then live", async () => {
    const t = setup();
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "live", url: "https://alpha.zaviagent.com" });
    expect(out.kind === "live" && out.deploy_id).toBe(t.sites.find((s) => s.id === A)!.live_deploy_id);
    expect(t.order).toEqual(["stage", "sql:001_a", "sql:002_b", "catalog", "gate", "activate", "verify"]);
    const a = t.sites.find((s) => s.id === A)!;
    expect(a.status).toBe("live");
    expect(a.desired_sha).toBe(SHA);
    expect(t.kv["host:alpha.zaviagent.com"]).toBe(a.live_deploy_id);
  });

  it("a gate failure never activates and leaves host: untouched", async () => {
    const t = setup({ gateOk: false });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "repair" });
    expect((out as { signal: string }).signal).toContain("journey home failed");
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.kv).toEqual({});
    expect(t.sites.find((s) => s.id === A)!.live_deploy_id).toBeNull();
  });

  it("a migration that hit a database connection or API outage is retried, never a repair", async () => {
    for (const err of [
      Object.assign(new Error("supabase database/query failed (503)"), { status: 503 }),
      new Error("supabase database/query failed (network)"),
      new SiteSqlError("remaining connection slots are reserved for non-replication superuser connections"),
      new SiteSqlError("terminating connection due to administrator command"),
      new SupabaseMgmtError("database query", 429),
      new SupabaseMgmtError("database query", 401),
      new Error("supabase mgmt: unexpected answer"),
    ]) {
      const t = setup({
        applySql: async (i) => {
          if (i.migration_id === "002_b") throw err;
          return "applied";
        },
      });
      await expect(step(t.handler)).rejects.toBe(err);
      expect(t.runGate).not.toHaveBeenCalled();
      expect(t.requestActivate).not.toHaveBeenCalled();
    }
  });

  it("a migration edited after it ran is a repair (put it back, add a new one)", async () => {
    const t = setup({
      applySql: async (i) => {
        if (i.migration_id === "002_b") throw new SiteMigrationChecksumMismatch("002_b");
        return "applied";
      },
    });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "repair", signal: expect.stringContaining("NEW migration file") });
  });

  it("a SQL error is a repair with the error; no gate runs and nothing activates", async () => {
    const t = setup({
      applySql: async (i) => {
        if (i.migration_id === "002_b") throw new SiteSqlError('relation "x" does not exist');
        return "applied";
      },
    });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "repair" });
    expect((out as { signal: string }).signal).toContain('002_b.sql failed: site SQL failed: relation "x" does not exist');
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("fetches the commit into the sandbox before listing migrations at it", async () => {
    const t = setup();
    let fetched = false;
    t.run.mockImplementation(async (cmd: string) => {
      if (/ fetch --quiet /.test(cmd)) {
        fetched = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("cat-file -e")) return { exitCode: fetched ? 0 : 1, stdout: "", stderr: "" };
      if (cmd.startsWith("git ls-tree")) {
        return fetched
          ? { exitCode: 0, stdout: "supabase/migrations/001_a.sql", stderr: "" }
          : { exitCode: 128, stdout: "", stderr: `fatal: not a tree object: ${SHA}` };
      }
      if (cmd.startsWith("git show")) return { exitCode: 0, stdout: "create table a();", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "live" });
    expect(t.order).toEqual(["stage", "sql:001_a", "catalog", "gate", "activate", "verify"]);
    const cmds = t.run.mock.calls.map((c) => c[0] as string);
    const fetchAt = cmds.findIndex((c) => / fetch --quiet /.test(c));
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(cmds.findIndex((c) => c.startsWith("git ls-tree")));
  });

  it("fetches with a fresh credential passed only through env, never the command", async () => {
    const t = setup();
    t.deps.repoFetchToken = async () => "ghp_SECRETTOKEN123";
    const handler = createSiteDeployHandler(t.deps);
    let seen: { cmd: string; opts?: Parameters<SiteSandbox["run"]>[1] } | null = null;
    t.run.mockImplementation(async (cmd: string, opts?: Parameters<SiteSandbox["run"]>[1]) => {
      if (/ fetch --quiet /.test(cmd) && opts?.user === "root") seen = { cmd, opts };
      if (cmd.startsWith("git cat-file -e")) return { exitCode: seen ? 0 : 1, stdout: "", stderr: "" };
      if (cmd.startsWith("git ls-tree")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await step(handler);
    expect(seen).not.toBeNull();
    const { cmd, opts } = seen!;
    expect(cmd).not.toContain("ghp_SECRETTOKEN123");
    expect(cmd).toContain("https://github.com/Praxis-build/alpha.git");
    expect(cmd).toContain(SHA);
    expect(opts?.user).toBe("root");
    const env = opts?.env ?? {};
    expect(Object.values(env).join(" ")).toContain(Buffer.from("x-access-token:ghp_SECRETTOKEN123").toString("base64"));
    expect(opts?.redact ?? []).toEqual(expect.arrayContaining(["ghp_SECRETTOKEN123"]));
  });

  it("a commit that cannot be fetched throws (retried by the conductor), nothing is applied", async () => {
    const t = setup();
    t.run.mockImplementation(async (cmd: string) =>
      cmd.includes("cat-file -e") || / fetch --quiet /.test(cmd)
        ? { exitCode: 128, stdout: "", stderr: "fatal: remote error: upload-pack: not our ref" }
        : { exitCode: 0, stdout: "", stderr: "" },
    );
    await expect(step(t.handler)).rejects.toThrow(/could not fetch commit/);
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("a migration the SQL policy refuses is a repair with the reason; nothing runs, no gate, nothing activates", async () => {
    const executed: string[] = [];
    const t = setup({
      migrations: {
        "001_a.sql": "create table if not exists public.a (id int); alter table public.a enable row level security;",
        "002_b.sql": "drop table public.a;",
      },
      applySql: async (i: { migration_id: string; sql: string; guard?: (sql: string) => void }) => {
        i.guard?.(i.sql);
        executed.push(i.migration_id);
        return "applied" as const;
      },
    });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "repair" });
    expect((out as { signal: string }).signal).toMatch(/002_b\.sql was refused/);
    expect((out as { signal: string }).signal).toMatch(/DROP/);
    expect(executed).toEqual(["001_a"]);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("a catalog violation after the migrations fails the deploy before the gate or activation", async () => {
    const t = setup({ catalogProblems: ["table without row level security: public.secrets", "anon has UPDATE on public.profiles"] });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "failed" });
    expect((out as { reason: string }).reason).toMatch(/security check/);
    expect((out as { reason: string }).reason).toContain("public.secrets");
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.order).toEqual(["stage", "sql:001_a", "sql:002_b", "catalog"]);
    expect(t.sites.find((s) => s.id === A)!.last_error).toMatch(/security check/);
  });

  it("a catalog that cannot be read throws (the conductor retries), no gate runs", async () => {
    const t = setup();
    t.verifyCatalog.mockRejectedValueOnce(new Error("management api 503"));
    await expect(step(t.handler)).rejects.toThrow(/503/);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("a migration the in-transaction catalog check rolled back is a repair naming the problem", async () => {
    const t = setup({
      applySql: async (i) => {
        if (i.migration_id === "002_b") throw new SiteSqlError("ERROR: zavi catalog check failed: table without row level security: public.b");
        return "applied" as const;
      },
    });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "repair" });
    const signal = (out as { signal: string }).signal;
    expect(signal).toContain("table without row level security: public.b");
    expect(signal).toMatch(/rolled back/);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("a migration that failed to apply asks for a fix IN that file (nothing of it ran)", async () => {
    const t = setup({
      applySql: async (i) => {
        if (i.migration_id === "002_b") throw new SiteSqlError('syntax error at or near "tabel"');
        return "applied" as const;
      },
    });
    const out = await step(t.handler);
    expect((out as { signal: string }).signal).toMatch(/Fix 002_b\.sql itself/);
  });

  it("migrations are read at the commit, not the working tree", async () => {
    const t = setup();
    await step(t.handler);
    const cmds = t.run.mock.calls.map((c) => c[0]);
    expect(cmds).toContain(`git ls-tree --name-only ${SHA} supabase/migrations/`);
    expect(cmds).toContain(`git show ${SHA}:supabase/migrations/001_a.sql`);
  });

  it("a build error in stage is a repair", async () => {
    const t = setup({ stage: async () => { throw new SiteBuildFailed("npm run build failed (exit 1)"); } });
    expect(await step(t.handler)).toMatchObject({ kind: "repair", signal: expect.stringContaining("npm run build failed") });
  });

  it("a PGRST002 from Zavi's database during stage is retried by the conductor, never a paid repair", async () => {
    const t = setup({
      stage: async () => {
        throw new Error("SiteStore: site_provider_set failed (PGRST002): Could not query the database for the schema cache. Retrying.");
      },
    });
    await expect(step(t.handler)).rejects.toThrow(/PGRST002/);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.sites.find((s) => s.id === A)!.last_error ?? "").not.toMatch(/did not build/);
  });

  it("any other non-build stage failure (routing, upload, git) is retried, never a repair", async () => {
    for (const msg of ["routing: cloudflare answered 400", "upload: r2 put failed (403)", "could not fetch commit abc1234: fatal: unable to access"]) {
      const t = setup({ stage: async () => { throw new Error(msg); } });
      await expect(step(t.handler)).rejects.toThrow(msg);
      expect(t.runGate).not.toHaveBeenCalled();
    }
  });

  it("a PLATFORM publish error (bundle without the site's Supabase config) fails the deploy, never a repair", async () => {
    const t = setup({ stage: async () => { throw new SitePublishPlatformError("the production bundle does not contain the site's Supabase project (x.supabase.co)"); } });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringContaining("Publishing hit a problem on our side") });
    expect(t.sites.find((s) => s.id === A)!.last_error).toMatch(/does not contain the site's Supabase project/);
    expect(t.runGate).not.toHaveBeenCalled();
  });

  it("a site left 'publishing' by a lost paused settle still publishes on Continue (recoverable)", async () => {
    const t = setup({ sites: [siteRow({ id: A, label: "alpha", status: "publishing", last_error: "old gate failure" })] });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "live", url: "https://alpha.zaviagent.com" });
  });

  it("a TRANSIENT publish error (Vault unreachable) is thrown for the conductor to retry, never a repair", async () => {
    const t = setup({ stage: async () => { throw new SitePublishTransientError("reading the anon key failed"); } });
    await expect(step(t.handler)).rejects.toBeInstanceOf(SitePublishTransientError);
    expect(t.runGate).not.toHaveBeenCalled();
  });

  it("missing hosting credentials fail plainly", async () => {
    const t = setup({ stage: async () => { throw new SiteCredentialsMissing(["X"]); } });
    expect(await step(t.handler)).toEqual({ kind: "failed", reason: "Site hosting is not configured." });
  });

  it("a gone sandbox fails with a plain reason", async () => {
    const t = setup();
    t.sandboxes.forSite.mockResolvedValueOnce(null as never);
    expect(await step(t.handler)).toEqual({ kind: "failed", reason: "The site's build sandbox is gone. Start the build again." });
  });

  it("a resolver recreation failure retries the deploy without staging or paid repairs", async () => {
    const t = setup();
    t.sandboxes.forSite.mockRejectedValueOnce(new Error("sandbox recreate unavailable"));
    await expect(step(t.handler)).rejects.toThrow("sandbox recreate unavailable");
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.applySql).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("returns waiting until the activation lands, and a re-tick does not re-stage", async () => {
    const t = setup({ activateInline: false });
    expect(await step(t.handler)).toEqual({ kind: "waiting" });
    expect(t.stage).toHaveBeenCalledTimes(1);
    const deploy_id = (await t.stage.mock.results[0].value).deploy_id as string;
    await t.deps.store.activateIfDesired(T1, A, SHA, deploy_id, "https://alpha.zaviagent.com");
    t.kv["host:alpha.zaviagent.com"] = deploy_id;
    expect(await step(t.handler)).toMatchObject({ kind: "live" });
    expect(t.stage).toHaveBeenCalledTimes(1);
    expect(t.runGate).toHaveBeenCalledTimes(1);
  });

  it("an activation send that failed is re-sent on the next tick, and the site still goes live (review F1)", async () => {
    const t = setup({ activateInline: false });
    t.requestActivate.mockRejectedValueOnce(new Error("inngest send failed (503)"));
    await expect(step(t.handler)).rejects.toThrow(/inngest send failed/);
    expect(t.requestActivate).toHaveBeenCalledTimes(1);
    expect(await step(t.handler)).toEqual({ kind: "waiting" });
    expect(t.requestActivate).toHaveBeenCalledTimes(2);
    expect(t.stage).toHaveBeenCalledTimes(1);
    const deploy_id = (await t.stage.mock.results[0].value).deploy_id as string;
    expect(t.requestActivate.mock.calls[1][0]).toMatchObject({ site_id: A, deploy_id, sha: SHA });
    await t.deps.store.activateIfDesired(T1, A, SHA, deploy_id, "https://alpha.zaviagent.com");
    t.kv["host:alpha.zaviagent.com"] = deploy_id;
    expect(await step(t.handler)).toMatchObject({ kind: "live" });
    expect(t.requestActivate).toHaveBeenCalledTimes(2);
  });

  it("an activation that can never be delivered keeps throwing, so the conductor's error limit fails it (re-review F1)", async () => {
    const t = setup({ activateInline: false });
    t.requestActivate.mockRejectedValue(new Error("inngest send failed (503)"));
    await expect(step(t.handler)).rejects.toThrow(/inngest send failed/);
    await expect(step(t.handler)).rejects.toThrow(/inngest send failed/);
    await expect(step(t.handler)).rejects.toThrow(/inngest send failed/);
    expect(t.stage).toHaveBeenCalledTimes(1);
  });

  it("a deploy in flight when the site is deleted never makes it live again (re-review F2)", async () => {
    const t = setup({ activateInline: false });
    expect(await step(t.handler)).toEqual({ kind: "waiting" });
    const deploy_id = (await t.stage.mock.results[0].value).deploy_id as string;
    await t.deps.store.transition(T1, A, ["provisioning", "building", "publishing", "live"], "deleting");
    await t.deps.store.transition(T1, A, ["deleting"], "deleted");
    expect(await t.deps.store.activateIfDesired(T1, A, SHA, deploy_id, "https://alpha.zaviagent.com")).toBe(false);
    expect(t.kv["host:alpha.zaviagent.com"]).toBeUndefined();
  });

  function unservedHost() {
    const clock = { t: 1_000_000 };
    const t = setup();
    const alertOps = vi.fn(async (_i: { tenant_id: string; code: string; msg: string }) => undefined);
    t.deps.alertOps = alertOps;
    t.deps.now = () => clock.t;
    const handler = createSiteDeployHandler(t.deps);
    const verify = t.deps.verifySiteDeploy as ReturnType<typeof vi.fn>;
    verify.mockImplementation(async () => ({ ok: false, error: "HTTP 522" }));
    return { t, clock, alertOps, handler, verify };
  }

  it("LIVE but the hostname does not serve it yet: re-checks with backoff, tells the founder + ops once, then goes live", async () => {
    const { t, clock, alertOps, handler, verify } = unservedHost();
    expect(await step(handler)).toEqual({ kind: "waiting" });
    expect(verify).toHaveBeenCalledTimes(1);
    clock.t += 30_000;
    expect(await step(handler)).toEqual({ kind: "waiting" });
    expect(verify).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      clock.t += 5 * 60_000;
      expect(await step(handler)).toEqual({ kind: "waiting" });
    }
    expect(verify).toHaveBeenCalledTimes(4);
    expect(alertOps).toHaveBeenCalledTimes(1);
    expect(alertOps.mock.calls[0][0]).toMatchObject({ tenant_id: T1, code: "site_live_unverified" });
    const a = t.sites.find((s) => s.id === A)!;
    expect(a.last_error).toMatch(/not serving the new version yet/);
    const deploy_id = (await t.stage.mock.results[0].value).deploy_id as string;
    expect(a.live_deploy_id).toBe(deploy_id);
    expect(t.kv["host:alpha.zaviagent.com"]).toBe(deploy_id);
    verify.mockImplementation(async () => ({ ok: true }));
    clock.t += 11 * 60_000;
    expect(await step(handler)).toMatchObject({ kind: "live" });
    expect(t.sites.find((s) => s.id === A)!.status).toBe("live");
    expect(t.sites.find((s) => s.id === A)!.last_error).toBeNull();
    expect(t.stage).toHaveBeenCalledTimes(1);
  });

  it("still unserved after the window: the run ends (freeing the build slot) with the site SETTLED live on this deploy, never stranded", async () => {
    const { t, clock, alertOps, handler } = unservedHost();
    let out = await step(handler);
    for (let i = 0; i < 20 && out.kind === "waiting"; i++) {
      clock.t += 11 * 60_000;
      out = await step(handler);
    }
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringMatching(/do not need to publish again/) });
    expect(clock.t - 1_000_000).toBeGreaterThanOrEqual(30 * 60_000);
    expect(clock.t - 1_000_000).toBeLessThan(45 * 60_000);
    const a = t.sites.find((s) => s.id === A)!;
    const deploy_id = (await t.stage.mock.results[0].value).deploy_id as string;
    expect(a.status).toBe("live");
    expect(a.live_deploy_id).toBe(deploy_id);
    expect(t.kv["host:alpha.zaviagent.com"]).toBe(deploy_id);
    expect(a.last_error).toMatch(/not serving the new version yet/);
    expect(alertOps.mock.calls.map((c) => (c as unknown as [{ code: string }])[0].code)).toEqual(["site_live_unverified", "site_live_unverified_released"]);
  });

  it("a newer desired sha supersedes: failed, and it never overwrites", async () => {
    const t = setup({ activateInline: false });
    expect(await step(t.handler)).toEqual({ kind: "waiting" });
    await t.deps.store.update(T1, A, { desired_sha: "fedcba9876543" });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringContaining("newer version") });
    expect(t.sites.find((s) => s.id === A)!.live_deploy_id).toBeNull();
  });

  it("every command in the site sandbox runs with replace refs OFF (the scan, build and gate read the same commit)", async () => {
    const t = setup();
    await step(t.handler);
    expect(t.run.mock.calls.length).toBeGreaterThan(0);
    for (const [, opts] of t.run.mock.calls) expect(opts?.env?.GIT_NO_REPLACE_OBJECTS).toBe("1");
  });

  it("a live-host gate never signs the owner in (that would write the live Auth)", async () => {
    const t = setup();
    expect(await step(t.handler)).toMatchObject({ kind: "live" });
    expect(t.ownerMagicLink).not.toHaveBeenCalled();
    expect(t.runGate.mock.calls[0][0].owner_link).toBeNull();
  });

  it("the link never appears in the outcome, the site row or logs", async () => {
    const t = setup({ gateOk: false });
    const warn = vi.spyOn(console, "warn");
    const log = vi.spyOn(console, "log");
    const out = await step(t.handler);
    expect(JSON.stringify(out)).not.toContain("owner-link-secret");
    expect(JSON.stringify(t.sites)).not.toContain("owner-link-secret");
    for (const c of [...warn.mock.calls, ...log.mock.calls]) expect(JSON.stringify(c)).not.toContain("owner-link-secret");
    warn.mockRestore();
    log.mockRestore();
  });

  it("a dedicated site's gate never writes: its preview talks to the LIVE database", async () => {
    const first = setup();
    await step(first.handler);
    expect(first.runGate.mock.calls[0][0].allow_writes).toBe(false);

    const refine = setup({ sites: [siteRow({ id: A, label: "alpha", status: "live", live_sha: "1111111", live_deploy_id: "d0-old" })] });
    await step(refine.handler);
    expect(refine.runGate.mock.calls[0][0].allow_writes).toBe(false);
  });

  it("every attempt takes a publish generation first, and the commit becomes the desired one", async () => {
    const t = setup();
    await step(t.handler);
    const a = t.sites.find((s) => s.id === A)!;
    expect(a.publish_generation).toBe(1);
    expect(a.desired_sha).toBe(SHA);
  });

  it("a newer publish that began after the gate passed wins: the older one never activates", async () => {
    const t = setup({ activateInline: false });
    t.runGate.mockImplementationOnce(async () => {
      await t.deps.generations.begin(T1, A, SHA);
      return { ok: true, reason: "ok", evidence: "{}", owner_journey: "passed" };
    });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringContaining("newer version") });
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("two sites deploy independently: activating A never touches B", async () => {
    const t = setup();
    await step(t.handler, A);
    await step(t.handler, B, "1234567abcdef");
    const a = t.sites.find((s) => s.id === A)!;
    const b = t.sites.find((s) => s.id === B)!;
    expect(a.live_sha).toBe(SHA);
    expect(b.live_sha).toBe("1234567abcdef");
    expect(t.kv["host:alpha.zaviagent.com"]).toBe(a.live_deploy_id);
    expect(t.kv["host:beta.zaviagent.com"]).toBe(b.live_deploy_id);
    expect(a.live_deploy_id).not.toBe(b.live_deploy_id);
  });

  it("a paused site is woken and waits", async () => {
    const t = setup({ sites: [siteRow({ id: A, label: "alpha", status: "paused" })] });
    const wakeSite = vi.fn(async () => ({}));
    const h = createSiteDeployHandler({ ...t.deps, wakeSite });
    expect(await step(h)).toEqual({ kind: "waiting" });
    expect(wakeSite).toHaveBeenCalledWith("alpha.zaviagent.com");
    expect(t.stage).not.toHaveBeenCalled();
  });

  it("a site of another tenant is not found", async () => {
    const t = setup();
    const out = await t.handler.step({ tenant_id: "22222222-2222-4222-8222-222222222222", conductor_run_id: "r", site_id: A, sha: SHA, attempt: 0 });
    expect(out).toEqual({ kind: "failed", reason: "The site no longer exists." });
    expect(t.sandboxes.forSite).not.toHaveBeenCalled();
  });

  it("an invalid sha fails before anything runs", async () => {
    const t = setup();
    expect(await step(t.handler, A, "main; rm -rf /")).toMatchObject({ kind: "failed" });
    expect(t.sandboxes.forSite).not.toHaveBeenCalled();
  });
});

describe("visible error text: at most one fix pass per publish", () => {
  const SHA2 = "abcdef7654321";
  const SHA3 = "abcdef0000001";
  const MANIFEST = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { name: "menu", path: "/menu" }] } });
  const ERROR_LINE = "Something went wrong on our side. Please try again.";
  const pages = (o: { homeError?: boolean; menuDown?: boolean } = {}): FakeSite => ({
    origin: "https://p",
    routes: {
      "/": { status: 200, text: o.homeError ? `Alpha Bakery\n${ERROR_LINE}` : "Alpha Bakery" },
      "/menu": { status: o.menuDown ? 404 : 200, text: "Menu" },
    },
  });
  const realGate = (t: ReturnType<typeof setup>, site: () => FakeSite) => {
    const mod = createRequire(__filename)("../gate-runner/runner.cjs") as { runGate: (o: unknown) => Promise<{ ok: boolean }> };
    t.runGate.mockImplementation(async (input) =>
      runSiteGate(
        {
          ...(input as Parameters<typeof runSiteGate>[0]),
          sandbox: { run: async () => ({ exitCode: 0, stdout: MANIFEST, stderr: "" }), readFile: async () => MANIFEST, listFiles: async () => [] },
        },
        {
          env: {},
          runner: async (r) => {
            const out = await mod.runGate({ baseUrl: r.env.GATE_BASE_URL, ownerLink: null, customerLink: null, config: JSON.parse(r.files[GATE_CONFIG_PATH]), launch: fakeLaunch(site()).launch });
            return { exitCode: out.ok ? 0 : 1, stdout: JSON.stringify(out) + "\n", stderr: "" };
          },
        },
      ),
    );
  };
  const attempt = (t: ReturnType<typeof setup>, sha: string, n: number, kept?: SiteKeptJourneys) =>
    t.handler.step({ tenant_id: T1, conductor_run_id: "run-1", site_id: A, sha, attempt: n, ...(kept ? { kept_journeys: kept } : {}) });
  const merge = (prev: SiteKeptJourneys | undefined, next: SiteKeptJourneys | undefined): SiteKeptJourneys | undefined =>
    next
      ? { names: [...new Set([...(prev?.names ?? []), ...next.names])], must_pass: [...new Set([...(prev?.must_pass ?? []), ...next.must_pass])], fingerprints: { ...(next.fingerprints ?? {}), ...(prev?.fingerprints ?? {}) } }
      : prev;
  const quiet = () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((l: unknown) => {
      lines.push(String(l));
    });
    return { lines, spy };
  };

  it("the first error-text failure buys a fix pass naming the route and the text; the same text after that fix publishes with a warning", async () => {
    const t = setup({ sites: [siteRow({ id: A, label: "alpha", name: "Alpha Bakery" })] });
    realGate(t, () => pages({ homeError: true }));
    const { lines, spy } = quiet();
    const first = await attempt(t, SHA, 1);
    expect(first).toMatchObject({ kind: "repair" });
    if (first.kind !== "repair") throw new Error("unreachable");
    expect(first.signal).toContain(`visible error text on /: "${ERROR_LINE}"`);
    expect(first.journeys?.must_pass).toContain("zavi:error-text");
    expect(t.requestActivate).not.toHaveBeenCalled();

    const second = await attempt(t, SHA2, 2, merge(undefined, first.journeys));
    spy.mockRestore();
    expect(second).toMatchObject({ kind: "live" });
    expect(t.requestActivate).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.startsWith("[site-gate] error-text still present after one fix pass site=" + A))).toHaveLength(1);
    expect(t.runGate.mock.calls.map((c) => (c[0] as { site_name?: string }).site_name)).toEqual(["Alpha Bakery", "Alpha Bakery"]);
  });

  it("after the error-text fix pass, a different failure on the next attempt still buys a fix pass", async () => {
    const t = setup();
    let state: { homeError?: boolean; menuDown?: boolean } = { homeError: true };
    realGate(t, () => pages(state));
    const { spy } = quiet();
    const first = await attempt(t, SHA, 1);
    if (first.kind !== "repair") throw new Error(`expected a repair, got ${first.kind}`);
    state = { homeError: true, menuDown: true };
    const withRoute = await attempt(t, SHA2, 2, merge(undefined, first.journeys));
    state = { menuDown: true };
    const routeOnly = await attempt(t, SHA3, 3, merge(undefined, first.journeys));
    spy.mockRestore();
    expect(withRoute).toMatchObject({ kind: "repair", signal: expect.stringContaining("HTTP 404 for /menu") });
    expect(routeOnly).toMatchObject({ kind: "repair", signal: expect.stringContaining("HTTP 404 for /menu") });
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("an earlier fix pass for something else does not use up the error-text fix pass", async () => {
    const t = setup();
    realGate(t, () => pages({ homeError: true }));
    const { spy } = quiet();
    const out = await attempt(t, SHA2, 2, { names: ["home", "menu"], must_pass: ["menu"], fingerprints: {} });
    spy.mockRestore();
    expect(out).toMatchObject({ kind: "repair", signal: expect.stringContaining("visible error text on /") });
    expect(t.requestActivate).not.toHaveBeenCalled();
  });
});
