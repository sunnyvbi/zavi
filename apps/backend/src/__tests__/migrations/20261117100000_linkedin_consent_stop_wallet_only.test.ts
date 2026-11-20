import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");
const REVIEW = read("20261102141800_ads_wallet_review_fixes.sql");
const BEFORE = REVIEW.slice(
  REVIEW.indexOf("create view public.ads_campaign_pending_stops"),
  REVIEW.indexOf("create table public.ads_campaign_spend_stability"),
);
const MINE = read("20261117100000_linkedin_consent_stop_wallet_only.sql");

const SCHEMA = `
  set timezone = 'UTC';
  create role anon; create role authenticated; create role service_role;
  create table tenants (id uuid primary key);
  create table ads_provider_accounts (id uuid primary key default gen_random_uuid(), platform text not null);
  create table ads_account_bindings (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
    account_id uuid not null references ads_provider_accounts(id), funding_source text not null check (funding_source in ('wallet','provider')),
    unique(id,tenant_id));
  create table ads_campaign_bindings (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
    account_binding_id uuid not null, account_id uuid not null, provider_campaign_id text not null, unique(id,tenant_id));
  create view ads_campaign_binding_details as
    select c.id,c.tenant_id,c.account_binding_id,c.account_id,c.provider_campaign_id,a.platform,b.funding_source
    from ads_campaign_bindings c join ads_provider_accounts a on a.id=c.account_id join ads_account_bindings b on b.id=c.account_binding_id;
  create table ads_wallet_consents (tenant_id uuid primary key references tenants(id), accepted_at timestamptz not null default now(), revoked_at timestamptz);
  create table ads_campaign_lifecycle (tenant_id uuid not null, campaign_binding_id uuid primary key, stop_requested_at timestamptz,
    stop_confirmed_at timestamptz, unique(tenant_id,campaign_binding_id), foreign key(campaign_binding_id,tenant_id) references ads_campaign_bindings(id,tenant_id));
`;

describe.skipIf(!PGLITE_MODULES)("20261117100000 a withdrawn wallet consent stops only wallet-paid LinkedIn campaigns", () => {
  let db: Db;
  const campaign = async (tenant: string, platform: string, funding: string) => {
    const account = (await db.query<{ id: string }>("insert into ads_provider_accounts(platform) values($1) returning id", [platform])).rows[0]!.id;
    const binding = (await db.query<{ id: string }>("insert into ads_account_bindings(tenant_id,account_id,funding_source) values($1,$2,$3) returning id", [tenant, account, funding])).rows[0]!.id;
    return (await db.query<{ id: string }>("insert into ads_campaign_bindings(tenant_id,account_binding_id,account_id,provider_campaign_id) values($1,$2,$3,$4) returning id", [tenant, binding, account, randomUUID()])).rows[0]!.id;
  };
  const stops = async (tenant: string) =>
    Object.fromEntries(
      (await db.query<{ campaign_binding_id: string; stop_requested_at: string | null; stop_confirmed_at: string | null }>(
        "select campaign_binding_id, stop_requested_at::text, stop_confirmed_at::text from ads_campaign_lifecycle where tenant_id=$1", [tenant],
      )).rows.map((r) => [r.campaign_binding_id, { requested: r.stop_requested_at, confirmed: r.stop_confirmed_at }]),
    );
  const pending = async (tenant: string) =>
    (await db.query("select campaign_binding_id, funding_source from ads_campaign_pending_stops where tenant_id=$1 order by funding_source", [tenant])).rows;
  const withdraw = (tenant: string, at: string) =>
    db.query("insert into ads_wallet_consents(tenant_id,revoked_at) values($1,$2) on conflict(tenant_id) do update set revoked_at=excluded.revoked_at", [tenant, at]);

  const A = randomUUID();
  const B = randomUUID();
  const R = randomUUID();
  const REVOKED = "2026-11-10 09:00:00+00";
  let ownStopped: string, ownConfirmed: string, ownFounderStop: string, walletStopped: string, otherTenantOwn: string;
  let reOwn: string, reOwnConfirmed: string, reWallet: string, reFounderWhileOff: string, reFounderAfter: string;

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(PGLITE_MODULES!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    await db.exec(SCHEMA);
    await db.exec(BEFORE);
    await db.query("insert into tenants(id) values($1),($2),($3)", [A, B, R]);
    ownStopped = await campaign(A, "linkedin", "provider");
    ownConfirmed = await campaign(A, "linkedin", "provider");
    ownFounderStop = await campaign(A, "linkedin", "provider");
    walletStopped = await campaign(A, "linkedin", "wallet");
    otherTenantOwn = await campaign(B, "linkedin", "provider");
    await withdraw(A, REVOKED);
    await db.query("update ads_campaign_lifecycle set stop_confirmed_at='2026-11-10 09:05:00+00' where campaign_binding_id=$1", [ownConfirmed]);
    await db.query("update ads_campaign_lifecycle set stop_requested_at='2026-11-10 08:00:00+00' where campaign_binding_id=$1", [ownFounderStop]);
    await db.query("insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id,stop_requested_at) values($1,$2,$3)", [B, otherTenantOwn, REVOKED]);
    expect((await db.query("select campaign_binding_id from ads_campaign_pending_stops where tenant_id=$1", [A])).rows).toHaveLength(3);
    reOwn = await campaign(R, "linkedin", "provider");
    reOwnConfirmed = await campaign(R, "linkedin", "provider");
    reWallet = await campaign(R, "linkedin", "wallet");
    reFounderWhileOff = await campaign(R, "linkedin", "provider");
    reFounderAfter = await campaign(R, "linkedin", "provider");
    await db.query("insert into ads_wallet_consents(tenant_id,accepted_at) values($1,'2026-11-01 00:00:00+00')", [R]);
    await db.query("update ads_wallet_consents set revoked_at='2026-11-09 09:00:00.123456+00' where tenant_id=$1", [R]);
    await db.query("update ads_campaign_lifecycle set stop_confirmed_at='2026-11-09 09:05:00+00' where campaign_binding_id=$1", [reOwnConfirmed]);
    await db.query("update ads_campaign_lifecycle set stop_requested_at='2026-11-09 10:00:00.250+00' where campaign_binding_id=$1", [reFounderWhileOff]);
    await db.query("update ads_wallet_consents set revoked_at=null, accepted_at='2026-11-09 12:00:00.654321+00' where tenant_id=$1", [R]);
    await db.query("update ads_campaign_lifecycle set stop_requested_at='2026-11-09 13:00:00.500+00' where campaign_binding_id=$1", [reFounderAfter]);
    expect((await db.query("select campaign_binding_id from ads_campaign_pending_stops where tenant_id=$1", [R])).rows).toHaveLength(4);
    await db.exec(MINE);
  }, 60_000);
  afterAll(async () => db?.close());

  it("lifts only the own-billing stops the withdrawal itself wrote that were never carried out", async () => {
    const s = await stops(A);
    expect(s[ownStopped]).toEqual({ requested: null, confirmed: null });
    expect(s[walletStopped]!.requested).toMatch(/^2026-11-10 09:00:00/);
    expect(s[ownConfirmed]!.requested).toMatch(/^2026-11-10 09:00:00/);
    expect(s[ownConfirmed]!.confirmed).toMatch(/^2026-11-10 09:05:00/);
    expect(s[ownFounderStop]!.requested).toMatch(/^2026-11-10 08:00:00/);
    expect((await stops(B))[otherTenantOwn]!.requested).toMatch(/^2026-11-10 09:00:00/);
    expect(await pending(A)).toEqual([
      { campaign_binding_id: ownFounderStop, funding_source: "provider" },
      { campaign_binding_id: walletStopped, funding_source: "wallet" },
    ]);
  });

  it("lifts the own-billing stops a withdrawal wrote even after the founder accepted the wallet again, and keeps every stop a person asked for", async () => {
    const s = await stops(R);
    expect(s[reOwn]).toEqual({ requested: null, confirmed: null });
    expect(s[reOwnConfirmed]!.requested).toMatch(/^2026-11-09 09:00:00\.123456/);
    expect(s[reWallet]!.requested).toMatch(/^2026-11-09 09:00:00\.123456/);
    expect(s[reFounderWhileOff]!.requested).toMatch(/^2026-11-09 10:00:00\.25/);
    expect(s[reFounderAfter]!.requested).toMatch(/^2026-11-09 13:00:00\.5/);
    expect(new Set((await pending(R)).map((r: any) => r.campaign_binding_id))).toEqual(new Set([reWallet, reFounderWhileOff, reFounderAfter]));
  });

  it("a later withdrawal stops the wallet-paid campaign and leaves own-billing and non-LinkedIn campaigns running", async () => {
    const T = randomUUID();
    await db.query("insert into tenants(id) values($1)", [T]);
    const own = await campaign(T, "linkedin", "provider");
    const wallet = await campaign(T, "linkedin", "wallet");
    const meta = await campaign(T, "meta", "wallet");
    await db.query("insert into ads_wallet_consents(tenant_id) values($1)", [T]);
    expect(await stops(T)).toEqual({});
    await withdraw(T, "2026-11-12 10:00:00+00");
    const s = await stops(T);
    expect(Object.keys(s)).toEqual([wallet]);
    expect(s[wallet]!.requested).toMatch(/^2026-11-12 10:00:00/);
    expect(s[own]).toBeUndefined();
    expect(s[meta]).toBeUndefined();
    expect(await pending(T)).toEqual([{ campaign_binding_id: wallet, funding_source: "wallet" }]);
  });

  it("adds funding_source as the last column of the pending-stops view, and runs again without changing anything", async () => {
    const cols = (await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='ads_campaign_pending_stops' order by ordinal_position",
    )).rows.map((r) => r.column_name);
    expect(cols).toEqual(["tenant_id", "campaign_binding_id", "stop_requested_at", "funding_source"]);
    const before = await stops(A);
    await db.exec(MINE);
    expect(await stops(A)).toEqual(before);
    const grants = (await db.query<{ grantee: string; privilege_type: string }>(
      "select grantee, privilege_type from information_schema.role_table_grants where table_name='ads_campaign_pending_stops' and grantee in ('anon','authenticated','service_role')",
    )).rows;
    expect(grants).toEqual([{ grantee: "service_role", privilege_type: "SELECT" }]);
  });
});
