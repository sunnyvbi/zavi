import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.SLACK_LINK_PG_URL;
const MIG = resolve(__dirname, "../../../../../supabase/migrations");
const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const FOUNDER = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAMMATE = "aaaaaaaa-0000-4000-8000-000000000002";
const OUTSIDER = "aaaaaaaa-0000-4000-8000-000000000003";
const DUP_A = "aaaaaaaa-0000-4000-8000-000000000004";
const DUP_B = "aaaaaaaa-0000-4000-8000-000000000005";
const VIEWER = "aaaaaaaa-0000-4000-8000-000000000006";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000007";
const TEAM = "T_ACME";
const TEAM2 = "T_OTHER";

describe.skipIf(!url)("slack identity link-on-use on real Postgres", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0];
  const approver3 = async (tenant: string, team: string, user: string) =>
    (await one(`select public.resolve_slack_approver($1::uuid,$2::text,$3::text) as r`, [tenant, team, user])).r;
  const approver2 = async (tenant: string, user: string) =>
    (await one(`select public.resolve_slack_approver($1::uuid,$2::text) as r`, [tenant, user])).r;
  const linkEmail = async (tenant: string, team: string, user: string, email: string) =>
    (await one(`select public.link_slack_identity_if_member($1,$2,$3,$4,$5) as r`, [tenant, team, user, email, "Some Person"])).r;
  const EMAIL_OF: Record<string, string> = {};
  const linkInstaller = async (tenant: string, team: string, user: string, uid: string, slackEmail?: string) =>
    (await one(`select public.link_slack_installer_identity($1,$2,$3,$4,$5,$6) as r`,
      [tenant, team, user, uid, slackEmail ?? EMAIL_OF[uid] ?? null, null])).r;
  const count = async (sql: string) => (await one(sql)).n as number;

  beforeAll(async () => {
    const { Client } = await import("pg");
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`
      do $$ declare r text; begin foreach r in array array['anon', 'authenticated', 'service_role'] loop if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I', r); end if; end loop; end $$;
      create schema auth;
      create table auth.users(id uuid primary key, email text);
      create table public.tenants(id uuid primary key);
      create table public.tenant_users(user_id uuid, tenant_id uuid, role text);
      create table public.slack_workspaces(tenant_id uuid, team_id text unique, primary key (tenant_id, team_id));
      create table public.team_members(
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null, display_name text not null,
        primary_email text, kind text not null default 'human', status text not null default 'active',
        merged_into_id uuid, deactivated_at timestamptz, last_active_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create unique index team_members_tenant_email_lower_uniq on public.team_members (tenant_id, lower(primary_email))
        where primary_email is not null and status = 'active';
      create table public.team_member_identities(
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
        member_id uuid not null references public.team_members(id) on delete cascade,
        provider text not null, external_id text not null, team_id text, external_email text,
        external_display_name text, confidence numeric(3,2) not null default 1.00,
        source text not null default 'auto' check (source in ('auto','admin','oauth_self')),
        linked_at timestamptz not null default now());
      create unique index team_member_identities_tenant_provider_team_external_uniq
        on public.team_member_identities (tenant_id, provider, coalesce(team_id, ''), external_id);
      -- rule_propose is redefined by the same migration; its tables are not exercised here.
      create table public.agent_runs(id uuid primary key);
    `);
    await db.query(readFileSync(resolve(MIG, "20261031160000_slack_identity_link_on_use.sql"), "utf8"));
  });
  afterAll(async () => { await db?.end(); });

  Object.assign(EMAIL_OF, {
    [FOUNDER]: "founder@acme.com", [TEAMMATE]: "ana@acme.com", [OUTSIDER]: "stranger@else.com",
    [DUP_A]: "shared@acme.com", [VIEWER]: "vee@acme.com", [ADMIN]: "adi@acme.com",
  });

  beforeEach(async () => {
    await db.query(`truncate public.team_member_identities, public.team_members, public.tenant_users, public.tenants, public.slack_workspaces, auth.users cascade`);
    await db.query(`
      insert into public.tenants values ('${T}'), ('${T2}');
      insert into public.slack_workspaces values ('${T}', '${TEAM}'), ('${T2}', '${TEAM2}');
      insert into auth.users values
        ('${FOUNDER}', 'Founder@Acme.com'), ('${TEAMMATE}', 'ana@acme.com'), ('${OUTSIDER}', 'stranger@else.com'),
        ('${DUP_A}', 'shared@acme.com'), ('${DUP_B}', 'SHARED@acme.com'),
        ('${VIEWER}', 'vee@acme.com'), ('${ADMIN}', 'adi@acme.com');
      insert into public.tenant_users values
        ('${FOUNDER}', '${T}', 'owner'), ('${TEAMMATE}', '${T}', 'member'), ('${OUTSIDER}', '${T2}', 'owner'),
        ('${DUP_A}', '${T}', 'member'), ('${DUP_B}', '${T}', 'member'),
        ('${VIEWER}', '${T}', 'viewer'), ('${ADMIN}', '${T}', 'admin');
    `);
  });

  it("must-catch: founder linked at OAuth connect -> a click resolves to the founder (empty roster)", async () => {
    expect(await approver3(T, TEAM, "U_FOUNDER")).toBeNull();
    expect(await linkInstaller(T, TEAM, "U_FOUNDER", FOUNDER)).toBe(FOUNDER);
    expect(await approver3(T, TEAM, "U_FOUNDER")).toBe(FOUNDER);
    const idn = await one(`select source, team_id from public.team_member_identities where external_id = 'U_FOUNDER'`);
    expect(idn).toEqual({ source: "oauth_self", team_id: TEAM });
    const m = await one(`select status, primary_email, display_name, last_active_at is not null as seen from public.team_members`);
    expect(m).toEqual({ status: "active", primary_email: "Founder@Acme.com", display_name: "Founder", seen: true });
  });

  it("must-catch: a teammate whose Slack email matches a same-tenant login is linked, then resolves", async () => {
    expect(await linkEmail(T, TEAM, "U_ANA", "ANA@acme.com")).toBe(TEAMMATE);
    expect(await approver3(T, TEAM, "U_ANA")).toBe(TEAMMATE);
    expect(await linkEmail(T, TEAM, "U_ANA", "ana@acme.com")).toBe(TEAMMATE);
    expect(await count(`select count(*)::int n from public.team_member_identities`)).toBe(1);
  });

  it("reuses an existing active member row and reactivates a deactivated one in place", async () => {
    await db.query(`insert into public.team_members(tenant_id, display_name, primary_email, status, deactivated_at)
                    values ('${T}', 'Ana Old', 'ana@acme.com', 'deactivated', now())`);
    expect(await linkEmail(T, TEAM, "U_ANA", "ana@acme.com")).toBe(TEAMMATE);
    expect(await one(`select count(*)::int n, min(status) s from public.team_members`)).toEqual({ n: 1, s: "active" });
  });

  it("must-not: an email of a login NOT in this tenant links nothing", async () => {
    expect(await linkEmail(T, TEAM, "U_X", "stranger@else.com")).toBeNull();
    expect(await linkEmail(T, TEAM, "U_X", "nobody@acme.com")).toBeNull();
    expect(await count(`select count(*)::int n from public.team_member_identities`)).toBe(0);
    expect(await count(`select count(*)::int n from public.team_members`)).toBe(0);
  });

  it("must-not: the installer path refuses a user who is not a login of this tenant", async () => {
    expect(await linkInstaller(T, TEAM, "U_X", OUTSIDER)).toBeNull();
    expect(await count(`select count(*)::int n from public.team_member_identities`)).toBe(0);
  });

  it("must-not: two logins in the tenant sharing the email -> no link", async () => {
    expect(await linkEmail(T, TEAM, "U_DUP", "shared@acme.com")).toBeNull();
    expect(await linkInstaller(T, TEAM, "U_DUP", DUP_A)).toBeNull();
    expect(await count(`select count(*)::int n from public.team_member_identities`)).toBe(0);
  });

  it("must-not: an identity already pointing at another member is not overwritten, and the link returns null", async () => {
    expect(await linkInstaller(T, TEAM, "U_SAME", FOUNDER)).toBe(FOUNDER);
    expect(await linkEmail(T, TEAM, "U_SAME", "ana@acme.com")).toBeNull();
    expect(await approver3(T, TEAM, "U_SAME")).toBe(FOUNDER);
    const row = await one(`select tm.primary_email from public.team_member_identities i join public.team_members tm on tm.id = i.member_id where i.external_id = 'U_SAME'`);
    expect(row.primary_email).toBe("Founder@Acme.com");
  });

  it("must-not: a team_id that belongs to another tenant links nothing and never resolves", async () => {
    expect(await linkEmail(T, TEAM2, "U_ANA", "ana@acme.com")).toBeNull();
    expect(await linkInstaller(T, TEAM2, "U_FOUNDER", FOUNDER)).toBeNull();
    await linkInstaller(T, TEAM, "U_FOUNDER", FOUNDER);
    expect(await approver3(T, TEAM2, "U_FOUNDER")).toBeNull();
    expect(await approver3(T2, TEAM, "U_FOUNDER")).toBeNull();
  });

  it("must-not: a member that exists only as merged_into is not resurrected", async () => {
    await db.query(`insert into public.team_members(tenant_id, display_name, primary_email, status)
                    values ('${T}', 'Ana', 'ana@acme.com', 'merged_into')`);
    expect(await linkEmail(T, TEAM, "U_ANA", "ana@acme.com")).toBeNull();
  });

  it("must-not: the 2-arg resolver returns null when the Slack id matches identities in two workspaces", async () => {
    await db.query(`insert into public.slack_workspaces values ('${T}', 'T_SECOND')`);
    await linkInstaller(T, TEAM, "U_COLLIDE", FOUNDER);
    expect(await approver2(T, "U_COLLIDE")).toBe(FOUNDER);
    await linkEmail(T, "T_SECOND", "U_COLLIDE", "ana@acme.com");
    expect(await approver2(T, "U_COLLIDE")).toBeNull();
    expect(await approver3(T, TEAM, "U_COLLIDE")).toBe(FOUNDER);
    expect(await approver3(T, "T_SECOND", "U_COLLIDE")).toBe(TEAMMATE);
  });

  it("an existing roster (discovered) identity still resolves exactly as before", async () => {
    const m = await one(`insert into public.team_members(tenant_id, display_name, primary_email) values ('${T}', 'Ana', 'ana@acme.com') returning id`);
    await db.query(`insert into public.team_member_identities(tenant_id, member_id, provider, external_id, team_id, source)
                    values ('${T}', $1, 'slack', 'U_ROSTER', '${TEAM}', 'auto')`, [m.id]);
    expect(await approver3(T, TEAM, "U_ROSTER")).toBe(TEAMMATE);
    expect(await approver2(T, "U_ROSTER")).toBe(TEAMMATE);
  });

  it("only service_role may call the link RPCs; the internal helpers are callable by nobody", async () => {
    const can = async (role: string, fn: string) =>
      (await one(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn])).ok;
    for (const role of ["anon", "authenticated"]) {
      expect(await can(role, "public.link_slack_identity_if_member(uuid,text,text,text,text)")).toBe(false);
      expect(await can(role, "public.link_slack_installer_identity(uuid,text,text,uuid,text,text)")).toBe(false);
      expect(await can(role, "public.resolve_slack_approver(uuid,text,text)")).toBe(false);
    }
    expect(await can("service_role", "public.link_slack_identity_if_member(uuid,text,text,text,text)")).toBe(true);
    expect(await can("service_role", "public.link_slack_installer_identity(uuid,text,text,uuid,text,text)")).toBe(true);
    expect(await can("service_role", "public.resolve_slack_approver(uuid,text,text)")).toBe(true);
    expect(await can("service_role", "public._link_slack_identity(uuid,text,text,uuid,text,text)")).toBe(false);
    expect(await can("service_role", "public._slack_tenant_login_by_email(uuid,text)")).toBe(false);
    expect(await can("service_role", "public._slack_approver_login(uuid,text)")).toBe(false);
  });

  it("must-not: a linked viewer never resolves as an approver (both resolvers); member/admin/owner unchanged", async () => {
    expect(await linkEmail(T, TEAM, "U_VEE", "vee@acme.com")).toBe(VIEWER);
    expect(await approver3(T, TEAM, "U_VEE")).toBeNull();
    expect(await approver2(T, "U_VEE")).toBeNull();
    await linkEmail(T, TEAM, "U_ANA", "ana@acme.com");
    await linkEmail(T, TEAM, "U_ADI", "adi@acme.com");
    await linkInstaller(T, TEAM, "U_FOUNDER", FOUNDER);
    expect(await approver3(T, TEAM, "U_ANA")).toBe(TEAMMATE);
    expect(await approver3(T, TEAM, "U_ADI")).toBe(ADMIN);
    expect(await approver3(T, TEAM, "U_FOUNDER")).toBe(FOUNDER);
    expect(await approver2(T, "U_ADI")).toBe(ADMIN);
  });

  it("must-not: a refused link writes nothing (a deactivated row is not reactivated or stamped)", async () => {
    expect(await linkInstaller(T, TEAM, "U1", FOUNDER)).toBe(FOUNDER);
    const a = await one(`insert into public.team_members(tenant_id, display_name, primary_email, status, deactivated_at)
                         values ('${T}', 'Ana', 'ana@acme.com', 'deactivated', now()) returning id`);
    expect(await linkEmail(T, TEAM, "U1", "ana@acme.com")).toBeNull();
    const row = await one(`select status, last_active_at from public.team_members where id = $1`, [a.id]);
    expect(row).toEqual({ status: "deactivated", last_active_at: null });
    expect(await count(`select count(*)::int n from public.team_members`)).toBe(2);
  });

  it("must-not: a refused link for a login with no member row creates no member row", async () => {
    expect(await linkInstaller(T, TEAM, "U1", FOUNDER)).toBe(FOUNDER);
    expect(await linkEmail(T, TEAM, "U1", "ana@acme.com")).toBeNull();
    expect(await count(`select count(*)::int n from public.team_members where lower(primary_email) = 'ana@acme.com'`)).toBe(0);
  });

  it("must-not: the installer link needs the installer's Slack email to be the connecting user's login email", async () => {
    expect(await linkInstaller(T, TEAM, "U_ANA", FOUNDER, "ana@acme.com")).toBeNull();
    expect(await linkInstaller(T, TEAM, "U_ANA", FOUNDER, "")).toBeNull();
    expect(await count(`select count(*)::int n from public.team_member_identities`)).toBe(0);
    expect(await linkInstaller(T, TEAM, "U_FOUNDER", FOUNDER, "FOUNDER@acme.com")).toBe(FOUNDER);
  });
});
