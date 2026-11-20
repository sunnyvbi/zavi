import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAutoProvStore } from "../autoprovision";
import { provisionShard } from "../provision";
import { ShardNeedsStaff, ShardProvisionBusy, withProvisionGuard, type CreateGate } from "../provision-run";
import { SupabaseMgmtError } from "@/services/sites/supabase-mgmt";
import { world } from "./provision-world";

const ON = process.env.SITE_SHARDS_PG === "1";
const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const PORT = Number(process.env.SITE_SHARDS_PG_PORT ?? 55446);
const REPO = resolve(__dirname, "../../../../../..");
const MIG = join(REPO, "supabase/migrations");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgClient = any;
const req = createRequire(__filename);
let dir = "";
let admin: PgClient;

async function client(): Promise<PgClient> {
  const { Client } = req("pg");
  const c = new Client({ host: "localhost", port: PORT, user: "postgres", database: "zavi" });
  await c.connect();
  return c;
}

function rpcVia(c: PgClient) {
  return async (name: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    try {
      await c.query("begin; set local role service_role");
      const r = await c.query(`select to_jsonb(x) as j from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) x`, keys.map((k) => args[k]));
      await c.query("commit");
      const rows = r.rows.map((x: { j: unknown }) => x.j);
      return { data: rows.length === 1 ? rows[0] : rows, error: null };
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
    }
  };
}

const claimArgs = (over: Partial<Parameters<ReturnType<typeof createAutoProvStore>["claim"]>[0]> = {}) => ({
  env: "dev" as const, source: "auto" as const, maxPerDay: 10, override: false, actor: null, region: "us-west-1", minRetrySeconds: 0, ...over,
});

async function openIt(name: string) {
  await admin.query(
    "update public.site_shards set project_ref = $2, url = 'https://' || $2 || '.supabase.co', provision_step = 'done', state = 'open' where name = $1",
    [name, `ref${name.replace(/\D/g, "").padStart(8, "0")}`],
  );
}

describe.skipIf(!ON)("automatic shard provisioning SQL on a throwaway Postgres 17", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "autoprov-pg-"));
    execFileSync(join(PGBIN, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust"], { stdio: "ignore" });
    execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${PORT} -c listen_addresses=localhost -c max_connections=80`, "-l", join(dir, "log"), "-w", "start"], { stdio: "ignore" });
    const { Client } = req("pg");
    const root = new Client({ host: "localhost", port: PORT, user: "postgres", database: "postgres" });
    await root.connect();
    await root.query("create database zavi");
    await root.end();
    admin = await client();
    await admin.query(readFileSync(join(__dirname, "sql/zavi-db-stubs.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261008090000_sites.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261010090000_site_shards.sql"), "utf8"));
    await admin.query("alter table public.site_shards add column if not exists dedicated_site_id uuid");
    await admin.query("alter table public.site_shards drop constraint if exists site_shards_name_check");
    await admin.query(readFileSync(join(MIG, "20261010160000_site_shard_autoprovision.sql"), "utf8"));
    await admin.query(readFileSync(join(MIG, "20261010160000_site_shard_autoprovision.sql"), "utf8"));
  }, 60_000);

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    if (dir) {
      try {
        execFileSync(join(PGBIN, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
      } catch {
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await admin.query("truncate public.site_shard_autoprov_ledger, public.site_shard_autoprov, public.site_shard_provision_guards");
    await admin.query("delete from public.site_shards");
  });

  it("anon / authenticated can call none of it", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const q of [
        "select public.site_shard_autoprov_claim('dev','staff',10,true,'x','us-west-1',0)",
        "select public.site_shard_autoprov_set_paused('dev', false, 'x', null)",
        "select * from public.site_shard_autoprov_ledger",
      ]) {
        await admin.query(`begin; set local role ${role}`);
        await expect(admin.query(q)).rejects.toThrow(/permission denied/);
        await admin.query("rollback");
      }
    }
  });

  it("RACE: 12 backends claiming at once register exactly ONE shard; the rest see it in progress", async () => {
    const clients = await Promise.all(Array.from({ length: 12 }, () => client()));
    const rs = await Promise.all(clients.map((c) => createAutoProvStore(rpcVia(c)).claim(claimArgs({ minRetrySeconds: 3600 }))));
    await Promise.all(clients.map((c) => c.end()));
    expect(rs.filter((r) => r.action === "create")).toHaveLength(1);
    expect(rs.filter((r) => r.action !== "create").every((r) => r.action === "none" && r.reason === "backoff")).toBe(true);
    const shards = (await admin.query("select name, state, is_canary from public.site_shards")).rows;
    expect(shards).toEqual([{ name: "zavi-shard-dev-1", state: "provisioning", is_canary: true }]);
  });

  it("RACE + CAP: 30 concurrent claims over a day with shards opening in between never pass 10 creates", async () => {
    const store = createAutoProvStore(rpcVia(admin));
    for (let round = 0; round < 15; round++) {
      const clients = await Promise.all(Array.from({ length: 2 }, () => client()));
      const rs = await Promise.all(clients.map((c) => createAutoProvStore(rpcVia(c)).claim(claimArgs())));
      await Promise.all(clients.map((c) => c.end()));
      for (const r of rs) if (r.action === "create") await openIt(r.shard_name);
    }
    const created = (await admin.query("select count(*)::int as n from public.site_shard_autoprov_ledger where kind = 'create'")).rows[0].n;
    expect(created).toBe(10);
    expect((await admin.query("select count(*)::int as n from public.site_shards")).rows[0].n).toBe(10);
    expect(await store.claim(claimArgs({ maxPerDay: 1000 }))).toMatchObject({ action: "none", reason: "cap", cap: 10 });
    const o = await store.claim(claimArgs({ source: "staff", override: true, actor: "ops@zavi" }));
    expect(o).toMatchObject({ action: "create", shard_name: "zavi-shard-dev-11" });
    expect((await admin.query("select cap_override from public.site_shard_autoprov_ledger where shard_name = 'zavi-shard-dev-11'")).rows[0].cap_override).toBe(true);
  });

  it("names: next free number, retired names never reused, kernel shards ignored; only the first is the canary", async () => {
    await admin.query("insert into public.site_shards (env, name, region, state) values ('dev', 'zavi-shard-dev-7', 'us-west-1', 'retired')");
    const store = createAutoProvStore(rpcVia(admin));
    const r = await store.claim(claimArgs());
    expect(r).toMatchObject({ action: "create", shard_name: "zavi-shard-dev-8", n: 8, canary: true });
    await openIt("zavi-shard-dev-8");
    expect(await store.claim(claimArgs())).toMatchObject({ action: "create", shard_name: "zavi-shard-dev-9", canary: false });
  });

  it("in progress: auto resumes the SAME shard only after the backoff; a hand-provisioned shard is never touched", async () => {
    const store = createAutoProvStore(rpcVia(admin));
    expect(await store.claim(claimArgs({ minRetrySeconds: 3600 }))).toMatchObject({ action: "create" });
    expect(await store.claim(claimArgs({ minRetrySeconds: 3600 }))).toMatchObject({ action: "none", reason: "backoff" });
    expect(await store.claim(claimArgs({ minRetrySeconds: 0 }))).toMatchObject({ action: "resume", shard_name: "zavi-shard-dev-1" });
    expect((await admin.query("select count(*)::int as n from public.site_shards")).rows[0].n).toBe(1);

    await admin.query("delete from public.site_shard_autoprov_ledger");
    expect(await store.claim(claimArgs())).toMatchObject({ action: "none", reason: "in_progress_manual", shard_name: "zavi-shard-dev-1" });
  });

  it("breaker: 2 failures in a row pause auto (staff still can), finish is idempotent, resume re-arms", async () => {
    const store = createAutoProvStore(rpcVia(admin));
    const a = await store.claim(claimArgs());
    if (a.action !== "create") throw new Error("expected create");
    expect(await store.finish(a.ledger_id, "blocked", "auth_config: nope")).toMatchObject({ consecutive_failures: 1, tripped: false, paused: false });
    expect(await store.finish(a.ledger_id, "blocked", "again")).toMatchObject({ already: true, consecutive_failures: 1 });
    const b = await store.claim(claimArgs());
    if (b.action !== "resume") throw new Error("expected resume");
    expect(await store.finish(b.ledger_id, "failed", "boom")).toMatchObject({ consecutive_failures: 2, tripped: true, paused: true });
    expect(await store.claim(claimArgs())).toMatchObject({ action: "none", reason: "paused" });
    expect(await store.claim(claimArgs({ source: "staff", actor: "ops@zavi" }))).toMatchObject({ action: "resume" });
    const st = await store.setPaused("dev", false, "ops@zavi", null);
    expect(st).toMatchObject({ paused: false, consecutive_failures: 0 });
    expect(await store.claim(claimArgs())).toMatchObject({ action: "resume" });
    const status = await store.status("dev", 5);
    expect(status.created_today).toBe(1);
    expect(status.ledger.length).toBeGreaterThan(0);
  });

  const NAME = "zavi-shard-dev-1";
  type W = ReturnType<typeof world>;
  const run = (w: W, holder: string, gate: CreateGate = { source: "cli" }, c: PgClient = admin): Promise<{ status: string; step?: string; reason?: string }> =>
    withProvisionGuard(NAME, holder, gate, (guard) => provisionShard({ ...w.deps, createGuard: guard }, { env: "dev", n: 1, region: "us-west-1" }), rpcVia(c));
  const guardRow = async () => (await admin.query("select holder, create_state, create_attempts, needs_staff from public.site_shard_provision_guards where shard_name = $1", [NAME])).rows[0];
  const creates = (w: W) => w.log.filter((l) => l === "createProject").length;
  function createAs(w: W, mode: "lost_after_create" | "lost_nothing" | "refused_400") {
    w.deps.mgmt.createProject = async ({ name }) => {
      w.log.push("createProject");
      if (mode === "lost_after_create") w.projects.push({ ref: `lostref${w.projects.length}aa`, name, organization_id: "org", status: "COMING_UP" });
      if (mode === "refused_400") throw new SupabaseMgmtError("create project", 400);
      throw new SupabaseMgmtError("create project", 0);
    };
  }

  it("lease: busy while live; an EXPIRED lease is never taken over (needs_staff, no create); staff recover adopts by name", async () => {
    const rpc = rpcVia(admin);
    expect((await rpc("site_shard_guard_acquire", { p_name: NAME, p_holder: "job:a", p_seconds: 600 })).data).toMatchObject({ ok: true });
    expect((await rpc("site_shard_guard_acquire", { p_name: NAME, p_holder: "cli:b", p_seconds: 600 })).data).toMatchObject({ ok: false, reason: "busy" });
    await admin.query("update public.site_shard_provision_guards set until = now() - interval '1 second'");
    expect((await rpc("site_shard_guard_acquire", { p_name: NAME, p_holder: "cli:b", p_seconds: 600 })).data).toMatchObject({ ok: false, reason: "stale_lease" });
    expect((await guardRow()).holder).toBe("job:a");
    expect((await guardRow()).needs_staff).toMatch(/lease expired while held by job:a/);
    const clients = await Promise.all(Array.from({ length: 10 }, () => client()));
    const rs = await Promise.all(clients.map((c, i) => rpcVia(c)("site_shard_guard_acquire", { p_name: "zavi-shard-dev-2", p_holder: `h${i}`, p_seconds: 600 })));
    await Promise.all(clients.map((c) => c.end()));
    expect(rs.filter((r) => (r.data as { ok: boolean }).ok)).toHaveLength(1);
  });

  it("F1: the lease expires MID-CREATE: the second process does not take over or create; it is stopped for staff", async () => {
    const w = world();
    const w2 = world();
    let second: unknown = null;
    const realCreate = w.deps.mgmt.createProject;
    w.deps.mgmt.createProject = async (input) => {
      await admin.query("update public.site_shard_provision_guards set until = now() - interval '1 second'");
      second = await run(w2, "cli").catch((e) => e);
      return realCreate(input);
    };
    const first = await run(w, "job:L1");
    expect(first.status).toBe("open");
    expect(second).toBeInstanceOf(ShardNeedsStaff);
    expect(creates(w) + creates(w2)).toBe(1);
    expect((await guardRow())).toMatchObject({ create_state: "created", needs_staff: expect.stringMatching(/lease expired/) });
    await expect(run(w2, "cli")).rejects.toBeInstanceOf(ShardNeedsStaff);
    expect(creates(w2)).toBe(0);
  });

  it("F2: a lost response after Supabase created it: guard 'uncertain', lease released, the next run ADOPTS it, no second create", async () => {
    const w = world();
    createAs(w, "lost_after_create");
    const r1 = await run(w, "job:L1");
    expect(r1).toMatchObject({ status: "blocked", step: "project", reason: expect.stringMatching(/^guard:uncertain/) });
    expect(await guardRow()).toMatchObject({ holder: null, create_state: "uncertain", create_attempts: 1 });
    const r2 = await run(w, "job:L2");
    expect(r2.status).toBe("open");
    expect(w.row.project_ref).toBe("lostref0aa");
    expect(creates(w)).toBe(1);
    expect(w.projects).toHaveLength(1);
    expect((await guardRow()).create_state).toBe("created");
  });

  it("F2: a lost response and NOTHING was created: no create until the settle period, then exactly ONE retry; a second loss stops for staff", async () => {
    const w = world();
    createAs(w, "lost_nothing");
    expect((await run(w, "job:L1")).reason).toMatch(/^guard:uncertain/);
    expect((await run(w, "job:L2")).reason).toBe("guard:settling");
    expect((await run(w, "cli")).reason).toBe("guard:settling");
    expect(creates(w)).toBe(1);
    await admin.query("update public.site_shard_provision_guards set create_started_at = now() - interval '11 minutes'");
    expect((await run(w, "job:L3")).reason).toMatch(/^guard:uncertain/);
    expect(creates(w)).toBe(2);
    await admin.query("update public.site_shard_provision_guards set create_started_at = now() - interval '11 minutes'");
    expect((await run(w, "job:L4")).reason).toMatch(/^guard:needs_staff: retry exhausted/);
    await expect(run(w, "job:L5")).rejects.toBeInstanceOf(ShardNeedsStaff);
    expect(creates(w)).toBe(2);
    const rec = await rpcVia(admin)("site_shard_guard_staff_recover", { p_name: NAME, p_found: 0, p_actor: "ops@zavi" });
    expect(rec.data).toMatchObject({ create_state: "uncertain", create_attempts: 1, needs_staff: null });
    expect((await run(w, "job:L6")).reason).toBe("guard:settling");
    await admin.query("update public.site_shard_provision_guards set create_started_at = now() - interval '11 minutes'");
    const ok = world();
    w.deps.mgmt.createProject = async (i) => (w.log.push("createProject"), ok.deps.mgmt.createProject(i));
    expect((await run(w, "job:L7")).status).toBe("open");
    expect(creates(w)).toBe(3);
  });

  it("a definite 4xx refusal created nothing: guard back to 'none', lease released, the error surfaces", async () => {
    const w = world();
    createAs(w, "refused_400");
    await expect(run(w, "job:L1")).rejects.toThrow(/400/);
    expect(await guardRow()).toMatchObject({ holder: null, create_state: "none" });
  });

  it("two projects carry the shard's name: stop, never create, never adopt", async () => {
    const w = world({ existingProjects: 2 });
    const r = await run(w, "job:L1");
    expect(r).toMatchObject({ status: "blocked", reason: expect.stringMatching(/^guard:duplicates/) });
    expect(creates(w)).toBe(0);
    expect(w.row.project_ref).toBeNull();
    expect((await rpcVia(admin)("site_shard_guard_staff_recover", { p_name: NAME, p_found: 2, p_actor: "ops@zavi" })).error).not.toBeNull();
  });

  it("F3: a pause committed (on another backend) just before the create stops it; an un-paused auto run creates", async () => {
    const other = await client();
    const w = world();
    const list = w.deps.mgmt.listProjectsByName;
    w.deps.mgmt.listProjectsByName = async (n) => {
      await createAutoProvStore(rpcVia(other)).setPaused("dev", true, "ops@zavi", "stop");
      return list(n);
    };
    const gate: CreateGate = { source: "auto", enabled: async () => true, maxPerDay: async () => 10 };
    expect((await run(w, "job:L1", gate)).reason).toBe("guard:paused");
    expect(creates(w)).toBe(0);
    expect(await guardRow()).toMatchObject({ holder: null, create_state: "none" });
    w.deps.mgmt.listProjectsByName = list;
    await createAutoProvStore(rpcVia(other)).setPaused("dev", false, "ops@zavi", null);
    expect((await run(w, "job:L2", { ...gate, enabled: async () => false })).reason).toBe("guard:setting_off");
    expect(creates(w)).toBe(0);
    expect((await run(w, "job:L3", gate)).status).toBe("open");
    expect(creates(w)).toBe(1);
    await other.end();
  });

  it("the cap is re-checked at the create: 10 creates begun today stop an 11th auto create", async () => {
    for (let i = 2; i <= 11; i++) {
      await admin.query("insert into public.site_shard_provision_guards (shard_name, create_state, create_started_at, create_attempts) values ($1, 'created', now(), 1)", [`zavi-shard-dev-${i}`]);
    }
    const w = world();
    const r = await run(w, "job:L1", { source: "auto", enabled: async () => true, maxPerDay: async () => 10 });
    expect(r.reason).toBe("guard:cap");
    expect(creates(w)).toBe(0);
  });

  it("a live holder makes a concurrent run busy (ShardProvisionBusy), not stale", async () => {
    await rpcVia(admin)("site_shard_guard_acquire", { p_name: NAME, p_holder: "job:live", p_seconds: 600 });
    await expect(run(world(), "cli")).rejects.toBeInstanceOf(ShardProvisionBusy);
  });

  it("notice fires once per key", async () => {
    const store = createAutoProvStore(rpcVia(admin));
    expect(await store.notice("dev", "off:2026-10-01")).toBe(true);
    expect(await store.notice("dev", "off:2026-10-01")).toBe(false);
    expect(await store.notice("dev", "cap:2026-10-01")).toBe(true);
  });
});
