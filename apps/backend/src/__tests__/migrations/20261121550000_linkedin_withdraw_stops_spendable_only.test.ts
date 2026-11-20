import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");
const REVIEW = read("20261102141800_ads_wallet_review_fixes.sql");
const ORIGINAL = REVIEW.slice(
  REVIEW.indexOf("create view public.ads_campaign_pending_stops"),
  REVIEW.indexOf("create table public.ads_campaign_spend_stability"),
);
const WALLET_ONLY = read("20261117100000_linkedin_consent_stop_wallet_only.sql");
const MINE = read("20261121550000_linkedin_withdraw_stops_spendable_only.sql");

const SCHEMA = `
  set timezone = 'UTC';
  create role anon; create role authenticated; create role service_role;
  create table tenants (id uuid primary key);
  create table ads_wallets (tenant_id uuid primary key references tenants(id), balance_cents bigint not null default 0);
  create table ads_provider_accounts (id uuid primary key default gen_random_uuid(), platform text not null);
  create table ads_account_bindings (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
    account_id uuid not null references ads_provider_accounts(id), funding_source text not null, unique(id,tenant_id));
  create table ads_campaign_bindings (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
    account_binding_id uuid not null, account_id uuid not null, provider_campaign_id text not null, unique(id,tenant_id));
  create view ads_campaign_binding_details as
    select c.id,c.tenant_id,c.account_binding_id,c.account_id,c.provider_campaign_id,a.platform,b.funding_source
    from ads_campaign_bindings c join ads_provider_accounts a on a.id=c.account_id join ads_account_bindings b on b.id=c.account_binding_id;
  create table ads_wallet_consents (tenant_id uuid primary key references tenants(id), accepted_at timestamptz not null default now(), revoked_at timestamptz);
  create table ads_campaign_lifecycle (tenant_id uuid not null, campaign_binding_id uuid primary key, created_paused boolean not null default false,
    activation_attempted_at timestamptz, stop_requested_at timestamptz, stop_confirmed_at timestamptz,
    unique(tenant_id,campaign_binding_id), foreign key(campaign_binding_id,tenant_id) references ads_campaign_bindings(id,tenant_id));
  create table ads_campaign_operations (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, campaign_binding_id uuid not null,
    kind text not null, status text not null, created_at timestamptz not null default now());
`;

describe("20261121550000 a withdrawal stops only the wallet campaigns that can spend", () => {
  let db: PGlite;
  const campaign = async (tenant: string, funding = "wallet") => {
    const account = (await db.query<{ id: string }>("insert into ads_provider_accounts(platform) values('linkedin') returning id")).rows[0]!.id;
    const binding = (await db.query<{ id: string }>("insert into ads_account_bindings(tenant_id,account_id,funding_source) values($1,$2,$3) returning id", [tenant, account, funding])).rows[0]!.id;
    return (await db.query<{ id: string }>("insert into ads_campaign_bindings(tenant_id,account_binding_id,account_id,provider_campaign_id) values($1,$2,$3,$4) returning id", [tenant, binding, account, randomUUID()])).rows[0]!.id;
  };
  const life = (tenant: string, id: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    return db.query(
      `insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id,${cols.join(",")}) values($1,$2,${cols.map((_, i) => `$${i + 3}`).join(",")})`,
      [tenant, id, ...cols.map((c) => row[c])],
    );
  };
  const op = (tenant: string, id: string, status: string) =>
    db.query("insert into ads_campaign_operations(tenant_id,campaign_binding_id,kind,status) values($1,$2,'activate',$3)", [tenant, id, status]);
  const stopOf = async (id: string) =>
    (await db.query<{ s: string | null }>("select stop_requested_at::text s from ads_campaign_lifecycle where campaign_binding_id=$1", [id])).rows[0]?.s ?? null;
  const autopilotFirstLaunch = async (id: string) =>
    (await db.query<{ ok: boolean }>(
      "select (created_paused and activation_attempted_at is null and stop_requested_at is null) ok from ads_campaign_lifecycle where campaign_binding_id=$1",
      [id],
    )).rows[0]!.ok;
  const consent = (tenant: string) => db.query("insert into ads_wallet_consents(tenant_id) values($1)", [tenant]);
  const withdraw = (tenant: string) => db.query("update ads_wallet_consents set revoked_at=now() where tenant_id=$1", [tenant]);
  const reauthorize = (tenant: string) => db.query("update ads_wallet_consents set revoked_at=null, accepted_at=now() where tenant_id=$1", [tenant]);
  const tenant = async () => {
    const t = randomUUID();
    await db.query("insert into tenants(id) values($1)", [t]);
    await db.query("insert into ads_wallets(tenant_id) values($1)", [t]);
    return t;
  };

  const OLD = randomUUID();
  let oldDraft: string, oldFounderDraft: string, oldClaimedDraft: string, oldRan: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(ORIGINAL);
    await db.exec(WALLET_ONLY);
    await db.query("insert into tenants(id) values($1)", [OLD]);
    await db.query("insert into ads_wallets(tenant_id) values($1)", [OLD]);
    oldDraft = await campaign(OLD);
    oldFounderDraft = await campaign(OLD);
    oldClaimedDraft = await campaign(OLD);
    oldRan = await campaign(OLD);
    await life(OLD, oldDraft, { created_paused: true });
    await life(OLD, oldFounderDraft, { created_paused: true });
    await life(OLD, oldClaimedDraft, { created_paused: true });
    await life(OLD, oldRan, { created_paused: true, activation_attempted_at: "2026-11-01 10:00:00+00" });
    await consent(OLD);
    await db.query("update ads_wallet_consents set revoked_at='2026-11-01 12:00:00.123456+00' where tenant_id=$1", [OLD]);
    await db.query("update ads_campaign_lifecycle set stop_requested_at='2026-11-02 08:00:00.250+00' where campaign_binding_id=$1", [oldFounderDraft]);
    await db.query("update ads_campaign_lifecycle set stop_requested_at='2026-11-02 08:00:01.500+00', stop_confirmed_at='2026-11-02 08:00:02+00' where campaign_binding_id=$1", [oldClaimedDraft]);
    await reauthorize(OLD);
    expect(await stopOf(oldDraft)).not.toBeNull();
    expect(await autopilotFirstLaunch(oldDraft)).toBe(false);
    await db.exec(MINE);
  }, 60_000);
  afterAll(async () => db?.close());

  it("money: after withdraw and re-authorize, Autopilot can make the first launch of an older draft, while a founder-paused live campaign stays stopped", async () => {
    const T = await tenant();
    const draft = await campaign(T);
    const live = await campaign(T);
    await life(T, draft, { created_paused: true });
    await life(T, live, { created_paused: true, activation_attempted_at: "2026-11-05 10:00:00+00", stop_requested_at: "2026-11-06 10:00:00.123+00" });
    await consent(T);
    await withdraw(T);
    expect(await stopOf(draft)).toBeNull();
    expect(await stopOf(live)).not.toBeNull();
    await reauthorize(T);
    expect(await autopilotFirstLaunch(draft)).toBe(true);
    expect(await stopOf(live)).not.toBeNull();
  });

  it("stops every wallet campaign that can still spend: a live one, one mid-launch, one whose launch is unresolved, one relaunched after a confirmed pause, and one with no launch record", async () => {
    const T = await tenant();
    const live = await campaign(T);
    const reserving = await campaign(T);
    const pendingOp = await campaign(T);
    const uncertainOp = await campaign(T);
    const relaunched = await campaign(T);
    const unknown = await campaign(T);
    const imported = await campaign(T);
    await life(T, live, { created_paused: true, activation_attempted_at: "2026-11-05 10:00:00+00" });
    await life(T, reserving, { created_paused: true, activation_attempted_at: "2026-11-07 10:00:00+00" });
    await life(T, pendingOp, { created_paused: true });
    await life(T, uncertainOp, { created_paused: true });
    await life(T, relaunched, { created_paused: true, activation_attempted_at: "2026-11-08 10:00:00+00", stop_requested_at: "2026-11-06 10:00:00+00", stop_confirmed_at: "2026-11-06 10:01:00+00" });
    await life(T, imported, { created_paused: false });
    await op(T, pendingOp, "pending");
    await op(T, uncertainOp, "uncertain");
    await consent(T);
    await withdraw(T);
    for (const id of [live, reserving, pendingOp, uncertainOp, relaunched, unknown, imported]) expect(await stopOf(id)).not.toBeNull();
  });

  it("leaves alone a draft that never ran, a draft whose only launch was refused, and a campaign whose pause LinkedIn already confirmed", async () => {
    const T = await tenant();
    const draft = await campaign(T);
    const refused = await campaign(T);
    const confirmed = await campaign(T);
    const own = await campaign(T, "provider");
    await life(T, draft, { created_paused: true });
    await life(T, refused, { created_paused: true });
    await op(T, refused, "refused");
    await life(T, confirmed, { created_paused: true, activation_attempted_at: "2026-11-01 10:00:00+00", stop_requested_at: "2026-11-02 10:00:00.500+00", stop_confirmed_at: "2026-11-02 10:01:00+00" });
    await consent(T);
    await withdraw(T);
    expect(await stopOf(draft)).toBeNull();
    expect(await stopOf(refused)).toBeNull();
    expect(await stopOf(confirmed)).toBe("2026-11-02 10:00:00.5+00");
    expect(await stopOf(own)).toBeNull();
    expect((await db.query("select campaign_binding_id from ads_campaign_pending_stops where tenant_id=$1", [T])).rows).toEqual([]);
  });

  it("lifts the stop an earlier withdrawal left on a never-run draft, and keeps a founder's stop, a carried-out pause and a campaign that ran", async () => {
    expect(await stopOf(oldDraft)).toBeNull();
    expect(await autopilotFirstLaunch(oldDraft)).toBe(true);
    expect(await stopOf(oldFounderDraft)).toBe("2026-11-02 08:00:00.25+00");
    expect(await stopOf(oldClaimedDraft)).toBe("2026-11-02 08:00:01.5+00");
    expect(await stopOf(oldRan)).not.toBeNull();
  });
});
