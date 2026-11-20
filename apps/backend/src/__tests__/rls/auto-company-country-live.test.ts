import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261030090000_auto_company_country.sql"),
  "utf8",
);

const PG_URL = process.env.ZAVI_TEST_PG_URL;
const host = (() => {
  try {
    return PG_URL ? new URL(PG_URL).hostname : null;
  } catch {
    return null;
  }
})();
const LOCAL = host === "127.0.0.1" || host === "localhost" || host === "::1";
const SHOULD_RUN = !!PG_URL && LOCAL;
if (process.env.REQUIRE_RLS_MATRIX === "1" && !SHOULD_RUN) {
  throw new Error(`[auto-company-country-live] REQUIRE_RLS_MATRIX=1 but the suite would skip (url=${!!PG_URL}, local=${LOCAL}).`);
}

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create type tenant_fact_key as enum ('domain', 'signup_url', 'what_we_sell', 'who_we_serve', 'pricing_page', 'competitors', 'company_name', 'markets', 'company_goals', 'industry', 'location', 'founded', 'linkedin_url', 'instagram_url', 'facebook_url', 'x_url', 'company_story', 'country');
  create type tenant_fact_source as enum ('human_confirmed','typed_column','connector','onboarding_enrichment','staff_reviewed','ai_estimated','provisioned');
  create function fact_source_rank(p_source tenant_fact_source) returns int language sql immutable as $f$
    select case p_source
      when 'human_confirmed' then 5 when 'staff_reviewed' then 4 when 'connector' then 3
      when 'typed_column' then 3 when 'provisioned' then 2 when 'onboarding_enrichment' then 1
      when 'ai_estimated' then 0 end
  $f$;
  create table tenant_fact (
    tenant_id uuid not null, key tenant_fact_key not null, value_text text not null,
    source tenant_fact_source not null, source_ref text, verified_at timestamptz, updated_at timestamptz,
    primary key (tenant_id, key),
    constraint tenant_fact_country_iso_check check (key <> 'country' or value_text ~ '^[A-Z]{2}$')
  );
  create table tenant_config_audit (
    tenant_id uuid, actor_user_id uuid, action text, target text, prev_value text, next_value text
  );
  create table connector_metadata (
    tenant_id uuid not null, slug text not null, team_id text, primary key (tenant_id, slug)
  );
`;

describe.skipIf(!SHOULD_RUN)("auto company country migration, live", () => {
  let admin: Client;
  let pool: Pool;
  let dbName = "";
  let tearingDown = false;

  const project = async (t: string, key: string, value: string, source: string) =>
    (await pool.query("select project_tenant_fact($1, $2::tenant_fact_key, $3, $4::tenant_fact_source, 'test') r", [t, key, value, source])).rows[0].r as boolean;
  const fact = async (t: string, key: string) =>
    (await pool.query("select value_text, source::text from tenant_fact where tenant_id = $1 and key = $2::tenant_fact_key", [t, key])).rows[0] as
      | { value_text: string; source: string }
      | undefined;

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    dbName = `zavi_auto_country_${randomBytes(6).toString("hex")}`;
    await admin.query(`create database ${dbName}`);
    const u = new URL(PG_URL!);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString(), max: 2 });
    pool.on("error", (err: Error & { code?: string }) => {
      if (!(tearingDown && err.code === "57P01")) throw err;
    });
    await pool.query(BOOTSTRAP);
    await pool.query(MIGRATION);
  });

  afterAll(async () => {
    tearingDown = true;
    await pool?.end();
    if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("a connector writes the country once; a later connector write never replaces it", async () => {
    const t = randomUUID();
    expect(await project(t, "country", "US", "connector")).toBe(true);
    expect(await project(t, "country", "CA", "connector")).toBe(false);
    expect(await fact(t, "country")).toEqual({ value_text: "US", source: "connector" });
  });

  it("never over a founder's country", async () => {
    const t = randomUUID();
    await pool.query("insert into tenant_fact values ($1, 'country', 'GB', 'human_confirmed', 'settings', now(), now())", [t]);
    expect(await project(t, "country", "US", "connector")).toBe(false);
    expect(await fact(t, "country")).toEqual({ value_text: "GB", source: "human_confirmed" });
  });

  it("only source connector may project a country", async () => {
    const t = randomUUID();
    await expect(project(t, "country", "US", "onboarding_enrichment")).rejects.toThrow(/only from connected accounts/);
    await expect(project(t, "country", "US", "ai_estimated")).rejects.toThrow(/only from connected accounts/);
  });

  it("other keys keep the equal-rank refresh they had", async () => {
    const t = randomUUID();
    expect(await project(t, "location", "Austin, TX", "connector")).toBe(true);
    expect(await project(t, "location", "Dallas, TX", "connector")).toBe(true);
    expect((await fact(t, "location"))?.value_text).toBe("Dallas, TX");
  });

  it("set_connector_account_geo writes only the row still on the account it read, and validates", async () => {
    const t = randomUUID();
    await pool.query("insert into connector_metadata values ($1, 'composio.tiktok_ads', 'ca_1')", [t]);
    const geo = (forId: string | null, countries: string[], subjects: string[] | null = null) =>
      pool.query("select set_connector_account_geo($1, 'composio.tiktok_ads', $2, $3, $4, $5) r", [t, forId, countries, ["America/New_York"], subjects]);
    expect((await geo("ca_OLD", ["US"])).rows[0].r).toBe(false);
    expect((await geo("ca_1", ["US", "CN"], ["1", "2"])).rows[0].r).toBe(true);
    const row = (await pool.query("select account_geo from connector_metadata where tenant_id = $1", [t])).rows[0].account_geo;
    expect(row).toMatchObject({ for: "ca_1", countries: ["US", "CN"], timezones: ["America/New_York"], subjects: ["1", "2"] });
    await expect(geo("ca_1", ["usa"])).rejects.toThrow(/ISO alpha-2/);
  });
});
