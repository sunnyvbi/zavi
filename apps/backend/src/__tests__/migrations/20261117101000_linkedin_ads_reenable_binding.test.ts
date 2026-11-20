import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");
const ACCOUNTS = read("20261101162000_shared_ads_wallet_accounts.sql");
const between = (from: string, to: string) => ACCOUNTS.slice(ACCOUNTS.indexOf(from), ACCOUNTS.indexOf(to));
const STATUS = between("create table public.ads_account_binding_status", "create view public.ads_wallet_reservation_details");
const GUARD = between("create function public.ads_account_selection_guard()", "create function public.ads_claim_campaign_operation");
const MINE = read("20261117101000_linkedin_ads_reenable_binding.sql");

const SCHEMA = `
  set timezone = 'UTC';
  create role anon; create role authenticated; create role service_role;
  create table tenants (id uuid primary key);
  create table ads_provider_accounts (id uuid primary key default gen_random_uuid(), platform text not null,
    provider_account_id text, credential_source text not null, credential_tenant_id uuid, legacy_key text);
  create table ads_account_bindings (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
    account_id uuid not null references ads_provider_accounts(id), funding_source text not null check (funding_source in ('wallet','provider')),
    unique(tenant_id,account_id), unique(id,tenant_id));
  create table ads_account_selections (tenant_id uuid not null references tenants(id), platform text not null, account_binding_id uuid not null,
    primary key(tenant_id,platform), foreign key(account_binding_id,tenant_id) references ads_account_bindings(id,tenant_id));
  create table ads_managed_account_grants (tenant_id uuid not null, account_id uuid not null, disabled_at timestamptz, primary key(tenant_id,account_id));
  create table ads_wallet_consents (tenant_id uuid primary key, revoked_at timestamptz);
`;

describe.skipIf(!PGLITE_MODULES)("20261117101000 Use this account again turns back on only the founder's own turned-off ad account", () => {
  let db: Db;
  const A = randomUUID();
  const B = randomUUID();
  const binding = async (tenant: string, platform: string, funding: "provider" | "wallet", status = true) => {
    const own = funding === "provider";
    const account = (await db.query<{ id: string }>(
      "insert into ads_provider_accounts(platform,provider_account_id,credential_source,credential_tenant_id) values($1,$2,$3,$4) returning id",
      [platform, randomUUID(), own ? "tenant_connector" : "platform", own ? tenant : null],
    )).rows[0]!.id;
    const id = (await db.query<{ id: string }>(
      "insert into ads_account_bindings(tenant_id,account_id,funding_source) values($1,$2,$3) returning id", [tenant, account, funding],
    )).rows[0]!.id;
    if (!own) {
      await db.query("insert into ads_managed_account_grants(tenant_id,account_id) values($1,$2)", [tenant, account]);
      await db.query("insert into ads_wallet_consents(tenant_id) values($1) on conflict do nothing", [tenant]);
    }
    if (status) await db.query("insert into ads_account_binding_status(tenant_id,account_binding_id) values($1,$2)", [tenant, id]);
    return id;
  };
  const disable = (tenant: string, id: string) => db.query("select ads_disable_account_binding($1,$2)", [tenant, id]);
  const enable = async (tenant: string, id: string, platform = "linkedin") =>
    (await db.query<{ ok: boolean }>("select ads_enable_account_binding($1,$2,$3) as ok", [tenant, id, platform])).rows[0]!.ok;
  const off = async (id: string) =>
    (await db.query<{ off: boolean }>("select disabled_at is not null as off from ads_account_binding_status where account_binding_id=$1", [id])).rows[0]?.off;
  const choose = (tenant: string, platform: string, id: string) =>
    db.query("insert into ads_account_selections(tenant_id,platform,account_binding_id) values($1,$2,$3) on conflict(tenant_id,platform) do update set account_binding_id=excluded.account_binding_id", [tenant, platform, id]);

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(PGLITE_MODULES!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    await db.exec(SCHEMA);
    await db.exec(STATUS);
    await db.exec(GUARD);
    await db.query("insert into tenants(id) values($1),($2)", [A, B]);
    await db.exec(MINE);
  }, 60_000);
  afterAll(async () => db?.close());

  it("turns the founder's own LinkedIn account back on, and it can be chosen for new campaigns again", async () => {
    const own = await binding(A, "linkedin", "provider");
    await disable(A, own);
    await expect(choose(A, "linkedin", own)).rejects.toThrow(/account selection unavailable/);
    expect(await enable(A, own)).toBe(true);
    expect(await off(own)).toBe(false);
    await choose(A, "linkedin", own);
    expect((await db.query("select account_binding_id from ads_account_selections where tenant_id=$1 and platform='linkedin'", [A])).rows).toEqual([{ account_binding_id: own }]);
  });

  it("is safe to repeat, and a later Stop using this account turns it off again", async () => {
    const own = await binding(A, "linkedin", "provider");
    await disable(A, own);
    expect(await enable(A, own)).toBe(true);
    expect(await enable(A, own)).toBe(true);
    expect(await off(own)).toBe(false);
    await disable(A, own);
    expect(await off(own)).toBe(true);
  });

  it("writes a turned-on status for an own account that never had a status row", async () => {
    const own = await binding(A, "linkedin", "provider", false);
    expect(await enable(A, own)).toBe(true);
    expect(await off(own)).toBe(false);
  });

  it("never turns on another workspace's account, and leaves it off", async () => {
    const theirs = await binding(B, "linkedin", "provider");
    await disable(B, theirs);
    expect(await enable(A, theirs)).toBe(false);
    expect(await off(theirs)).toBe(true);
  });

  it("never turns on an account Zavi pays for, which has its own consent checks", async () => {
    const wallet = await binding(A, "linkedin", "wallet");
    await disable(A, wallet);
    expect(await enable(A, wallet)).toBe(false);
    expect(await off(wallet)).toBe(true);
  });

  it("never turns on an account of another channel from the LinkedIn route", async () => {
    const chatgpt = await binding(A, "chatgpt", "provider");
    await disable(A, chatgpt);
    expect(await enable(A, chatgpt, "linkedin")).toBe(false);
    expect(await off(chatgpt)).toBe(true);
  });

  it("returns false for an unknown account instead of creating anything", async () => {
    const unknown = randomUUID();
    expect(await enable(A, unknown)).toBe(false);
    expect(await off(unknown)).toBeUndefined();
  });

  it("only the server can run it", async () => {
    const can = async (role: string) =>
      (await db.query<{ ok: boolean }>("select has_function_privilege($1,'public.ads_enable_account_binding(uuid,uuid,text)','execute') as ok", [role])).rows[0]!.ok;
    expect(await can("anon")).toBe(false);
    expect(await can("authenticated")).toBe(false);
    expect(await can("service_role")).toBe(true);
  });
});
