import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const dir = join(__dirname, "../../../../../supabase/migrations");
const MINE = readFileSync(join(dir, "20261121541000_system_config_atomic_writes.sql"), "utf8").replace(/^(begin|commit);$/gm, "");
const STAFF = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!PGLITE_MODULES)("20261121541000 system_config writes change only their own keys", () => {
  let db: Db;
  const blob = async () => (await db.query<{ blob: Record<string, unknown> }>("select blob from system_config where id=1")).rows[0]!.blob;
  const lock = async (slug: string, locked: boolean) =>
    (await db.query<{ r: { before: string[]; after: string[] } }>("select system_config_set_channel_lock($1,$2,$3) as r", [slug, locked, STAFF])).rows[0]!.r;

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(PGLITE_MODULES!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table system_config (id smallint primary key check (id = 1), blob jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now(), updated_by uuid);
      insert into system_config (id, blob) values (1, '{}'::jsonb);
    `);
    await db.exec(MINE);
  }, 60_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.query("update system_config set blob=$1, updated_by=null where id=1", [
      JSON.stringify({ fleet_halt: true, disabled_agent_slugs: ["x"], locked_channel_slugs: ["sms"], tier_credits: { pro: 96000 } }),
    ]);
  });

  it("the usage alert marker merges in and leaves every lock, the fleet halt and other settings alone", async () => {
    await db.query("select system_config_merge($1)", [JSON.stringify({ usage_limit_alert_sent_for: "Jun 13", usage_limit_alert_sent_at: "t" })]);
    expect(await blob()).toEqual({
      fleet_halt: true,
      disabled_agent_slugs: ["x"],
      locked_channel_slugs: ["sms"],
      tier_credits: { pro: 96000 },
      usage_limit_alert_sent_for: "Jun 13",
      usage_limit_alert_sent_at: "t",
    });
  });

  it("a lock written after another writer saved its keys keeps them, and a later marker merge keeps the lock", async () => {
    await db.query("update system_config set blob = blob || '{\"fleet_halt\":false,\"new_flag\":1}'::jsonb where id=1");
    expect(await lock("linkedin_ads", true)).toEqual({ before: ["sms"], after: ["sms", "linkedin_ads"] });
    await db.query("select system_config_merge($1)", [JSON.stringify({ usage_limit_alert_sent_for: "w" })]);
    const b = await blob();
    expect(b.locked_channel_slugs).toEqual(["sms", "linkedin_ads"]);
    expect(b.fleet_halt).toBe(false);
    expect(b.new_flag).toBe(1);
    expect(b.tier_credits).toEqual({ pro: 96000 });
    expect((await db.query("select updated_by from system_config where id=1")).rows[0]).toEqual({ updated_by: STAFF });
  });

  it("locking twice keeps one entry, and unlocking removes only that channel", async () => {
    await lock("linkedin_ads", true);
    expect(await lock("linkedin_ads", true)).toEqual({ before: ["sms", "linkedin_ads"], after: ["sms", "linkedin_ads"] });
    expect(await lock("sms", false)).toEqual({ before: ["sms", "linkedin_ads"], after: ["linkedin_ads"] });
    expect((await blob()).fleet_halt).toBe(true);
  });

  it("a missing or broken lock list starts empty instead of failing the lock", async () => {
    await db.query("update system_config set blob = (blob - 'locked_channel_slugs') || '{\"locked_channel_slugs\":\"oops\"}'::jsonb where id=1");
    expect(await lock("meta_ads", true)).toEqual({ before: [], after: ["meta_ads"] });
  });

  it("only the server can call either function", async () => {
    const grants = (await db.query<{ fn: string; anon: boolean; authed: boolean; svc: boolean }>(`
      select p.proname as fn,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as authed,
        has_function_privilege('service_role', p.oid, 'execute') as svc
      from pg_proc p where p.proname in ('system_config_merge','system_config_set_channel_lock') order by 1`)).rows;
    expect(grants).toEqual([
      { fn: "system_config_merge", anon: false, authed: false, svc: true },
      { fn: "system_config_set_channel_lock", anon: false, authed: false, svc: true },
    ]);
  });
});
