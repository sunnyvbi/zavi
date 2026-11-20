import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_MODULES = process.env.SITES_SQL_TEST_MODULES;
const dir = join(__dirname, "../../../../../supabase/migrations");
const SAFETY = "20261116200000_account_purge_safety.sql";
type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, any>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const TABLES = [
  "auth.users",
  "vault.secrets",
  "storage.objects",
  "tenants",
  "tenant_users",
  "profiles",
  "secrets",
  "connector_metadata",
  "tenant_mcp_servers",
  "site_providers",
  "site_function_secrets",
  "site_function_retired_secrets",
  "site_backend_settings",
  "tenant_buffer_connection",
  "platform_secrets",
  "agent_runs",
  "agent_run_events",
  "tenant_agent_schedules",
  "agent_threads",
  "memory_note",
  "note_links",
  "autopilot_goals",
  "autopilot_goal_changes",
  "onboarding_step_events",
  "tenant_credit_ledger",
  "admin_action_log",
  "reddit_ad_operations",
  "ads_wallet_orders",
  "startup_offer_claim",
  "sdk_session_entries",
  "email_suppression",
  "human_members",
  "ads_provider_accounts",
  "ads_account_bindings",
  "partner_referrals",
  "staff_users",
  "growth_suggestions",
  "creator_notifications",
  "creator_reminders",
  "run_notes",
  "run_note_reads",
  "run_bookmarks",
  "run_artifacts",
  "tenant_member_invites",
  "account_deletions",
];

describe.skipIf(!PGLITE_MODULES)("20261115200000 account deletion purge (pglite)", () => {
  let db: Db;
  const U1 = randomUUID();
  const T1 = randomUUID();
  const D1 = randomUUID();
  const U2 = randomUUID();
  const T2 = randomUUID();
  const U3 = randomUUID();
  const T3 = randomUUID();
  const D3 = randomUUID();
  const U4 = randomUUID();
  const T4 = randomUUID();
  const D4 = randomUUID();
  const U5 = randomUUID();
  const T5 = randomUUID();
  const D5 = randomUUID();
  const U6 = randomUUID();
  const D6 = randomUUID();
  const M1 = randomUUID();
  const M2 = randomUUID();
  const M3 = randomUUID();
  const U7 = randomUUID();
  const U9 = randomUUID();
  const T9 = randomUUID();
  const D9 = randomUUID();
  const U10 = randomUUID();
  const T10 = randomUUID();
  const D10 = randomUUID();
  const T8 = randomUUID();

  const one = async <R = Record<string, any>>(q: string, p?: unknown[]) => (await db.query<R>(q, p)).rows[0];
  const count = async (q: string, p?: unknown[]) => Number((await one<{ n: string }>(`select count(*) as n from ${q}`, p))?.n ?? 0);

  const snapshotExcept = async (ids: string[]) => {
    const out: Record<string, string[]> = {};
    for (const t of TABLES) {
      const { rows } = await db.query<{ r: string }>(`select x::text as r from ${t} x order by 1`);
      out[t] = rows.map((r) => r.r).filter((r) => !ids.some((id) => r.includes(id)));
    }
    return out;
  };
  const snapshotAll = async () => snapshotExcept([]);

  const purge = async (id: string, execute: boolean) =>
    (await one<{ j: any }>("select purge_account_deletion($1, $2) as j", [id, execute]))!.j;
  const runBatch = async (id: string, limit: number) =>
    Number((await one<{ n: number }>("select account_purge_delete_runs($1, $2) as n", [id, limit]))!.n);
  const errorOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  const purgeError = async (id: string, execute: boolean): Promise<string> => {
    try {
      await purge(id, execute);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(PGLITE_MODULES!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create schema auth;
      -- deleted_at: GoTrue's soft delete sets it (20261116200000 refuses a live login).
      create table auth.users (id uuid primary key, email text, deleted_at timestamptz);
      create table auth.sessions (id uuid primary key, user_id uuid, created_at timestamptz not null default now());
      create function auth.uid() returns uuid language sql stable as $f$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
      create schema vault;
      create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, secret text);
      create schema storage;
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);

      create table tenants (
        id uuid primary key, slug text not null unique, display_name text not null,
        notification_phone text, sms_enabled boolean not null default false, product_url jsonb,
        settings jsonb not null default '{}'::jsonb, show_in_public_feed boolean not null default false,
        kind text not null default 'real');
      create table tenant_users (tenant_id uuid references tenants(id) on delete cascade,
        user_id uuid references auth.users(id) on delete cascade, role text);
      create table profiles (user_id uuid primary key references auth.users(id) on delete cascade,
        active_tenant_id uuid references tenants(id) on delete set null);
      create table secrets (tenant_id uuid references tenants(id) on delete cascade, key text, vault_secret_id uuid);
      create table connector_metadata (tenant_id uuid references tenants(id) on delete cascade, provider text);
      create table tenant_mcp_servers (tenant_id uuid references tenants(id) on delete cascade, enabled boolean default true);
      create table site_providers (tenant_id uuid references tenants(id) on delete cascade, site_id uuid, kind text, state text);
      create table site_function_secrets (tenant_id uuid, site_id uuid, vault_secret_id uuid);
      create table site_function_retired_secrets (tenant_id uuid, site_id uuid, vault_secret_id uuid);
      create table site_backend_settings (tenant_id uuid references tenants(id) on delete cascade, turnstile_secret_id uuid);
      create table tenant_buffer_connection (tenant_id uuid references tenants(id) on delete cascade, vault_secret_name text);
      create table platform_secrets (key text primary key, vault_secret_id uuid not null);
      create table site_shard_secrets (shard_id uuid, name text, vault_secret_id uuid not null);
      create table human_members (id uuid primary key default gen_random_uuid(),
        auth_user_id uuid references auth.users(id) on delete cascade,
        photo_path text, illustration_path text, intro_video_path text, sample_video_paths text[]);
    `);
    await db.exec(readFileSync(join(dir, "20260910120000_account_soft_delete.sql"), "utf8"));
    await db.exec(readFileSync(join(dir, "20261008100000_purge_credentials_keeps_site_keys.sql"), "utf8"));
    await db.exec(`
      -- Content: cascade from the workspace (delete), and from the person.
      create table agent_runs (id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants(id) on delete cascade,
        enqueued_by uuid references auth.users(id),
        actor_user_id uuid references auth.users(id) on delete set null,
        status text not null default 'success', enqueued_at timestamptz default now(),
        started_at timestamptz, last_progress_at timestamptz, finished_at timestamptz);
      create table tenant_agent_schedules (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade, enabled boolean not null default true);
      create table agent_run_events (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade,
        agent_run_id uuid references agent_runs(id) on delete cascade, body text);
      create table agent_threads (id uuid primary key default gen_random_uuid(),
        tenant_id uuid references tenants(id) on delete cascade,
        user_id uuid references auth.users(id) on delete cascade);
      -- A NO ACTION link between two purged tables, parent first in name order.
      create table memory_note (id uuid primary key default gen_random_uuid(),
        tenant_id uuid references tenants(id) on delete cascade, body text);
      create table note_links (id uuid primary key default gen_random_uuid(),
        tenant_id uuid references tenants(id) on delete cascade, note_id uuid references memory_note(id));
      -- A delete trigger that writes a history row the next pass must remove.
      create table autopilot_goals (id uuid primary key default gen_random_uuid(),
        tenant_id uuid references tenants(id) on delete cascade);
      create table autopilot_goal_changes (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade, goal_id uuid);
      create function _goal_history() returns trigger language plpgsql as $f$
      begin
        if exists (select 1 from tenants where id = old.tenant_id) then
          insert into autopilot_goal_changes (tenant_id, goal_id) values (old.tenant_id, old.id);
        end if;
        return old;
      end $f$;
      create trigger autopilot_goals_history after delete on autopilot_goals
        for each row execute function _goal_history();
      -- SET NULL: the row outlives the workspace.
      create table onboarding_step_events (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete set null, step text);
      -- Kept: billing (keep list), append-only audit (keep list + WORM trigger),
      -- NO ACTION to the workspace, keep-list table with no FK.
      create table tenant_credit_ledger (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade, amount int);
      create table admin_action_log (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade, action text,
        after_state jsonb, created_at timestamptz not null default now());
      create function _worm() returns trigger language plpgsql as $f$
      begin
        raise exception 'admin_action_log is append-only (WORM): % blocked', tg_op using errcode = '42501';
      end $f$;
      create trigger admin_action_log_worm before update or delete on admin_action_log
        for each row execute function _worm();
      create table reddit_ad_operations (id bigserial primary key,
        tenant_id uuid references tenants(id), op text);
      create table ads_wallet_orders (id bigserial primary key, tenant_id uuid, amount int);
      -- Keep-list billing table that (in this fixture) cascades from a run.
      create table startup_offer_claim (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade,
        run_id uuid references agent_runs(id) on delete cascade);
      -- Unlinked tables: one on the purge list, one not (kept).
      create table sdk_session_entries (id bigserial primary key, tenant_id uuid, entry jsonb);
      create table email_suppression (id bigserial primary key, tenant_id uuid, email_hash text);
      -- Owner column not named tenant_id (listed in account_purge_link_columns):
      -- the workspace's own ad account, and its binding (NO ACTION to the account).
      create table ads_provider_accounts (id uuid primary key default gen_random_uuid(),
        credential_tenant_id uuid references tenants(id) on delete cascade, credential_ref text);
      create table ads_account_bindings (id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants(id) on delete cascade,
        account_id uuid not null references ads_provider_accounts(id));
      -- A column nobody classified: the purge refuses while it holds the workspace.
      create table partner_referrals (id bigserial primary key,
        referred_tenant_id uuid references tenants(id) on delete cascade, note text);
      -- 20261116200000 (7): rows one hop past the person's own rows. A staff grant
      -- (no workspace) whose link a suggestion in some workspace clears, and a
      -- creator profile whose notifications carry the workspace that sent them.
      create table staff_users (user_id uuid primary key references auth.users(id) on delete cascade);
      create table growth_suggestions (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade,
        staff_user_id uuid references staff_users(user_id) on delete set null);
      create table creator_notifications (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade,
        human_member_id uuid references human_members(id) on delete cascade);
      -- Unclassified: a row here with no tenant_id is nobody's known data.
      create table creator_reminders (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade,
        human_member_id uuid references human_members(id) on delete cascade);
      -- 20261116200000 (5): rows below a workspace's runs. A table with no
      -- tenant_id (followed further), its child with one, and a cleared link.
      create table run_notes (id uuid primary key default gen_random_uuid(),
        run_id uuid references agent_runs(id) on delete cascade,
        parent_note_id uuid references run_notes(id) on delete cascade);
      create table run_note_reads (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade,
        note_id uuid references run_notes(id) on delete cascade);
      create table run_bookmarks (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade,
        run_id uuid references agent_runs(id) on delete set null);
    `);
    await db.exec(readFileSync(join(dir, "20261115200000_account_deletion_purge.sql"), "utf8"));
    await db.exec(readFileSync(join(dir, "20261115210000_account_purge_link_columns.sql"), "utf8"));
    await db.exec(`
      -- What 20261116200000 rebuilds or reads beyond the purge: invites (accept_invite).
      create table tenant_member_invites (id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants(id) on delete cascade, email text not null, role text not null,
        invited_by uuid, invited_at timestamptz default now(), accepted_at timestamptz, accepted_user_id uuid,
        revoked_at timestamptz, agent_slugs text[] not null default '{}');
      create table tenant_member_agents (tenant_id uuid, user_id uuid, agent_slug text, added_by uuid,
        unique (tenant_id, user_id, agent_slug));
      create table tenant_seat_limits (tier text primary key, max_seats int);
      insert into tenant_seat_limits values ('pro', 10);
      create function _tenant_tier(uuid) returns text language sql stable as $f$ select 'pro'::text $f$;
      alter table tenant_users add unique (user_id, tenant_id);
      -- A storage path column (account_purge_storage_ref_columns()).
      create table run_artifacts (id bigserial primary key,
        tenant_id uuid references tenants(id) on delete cascade, storage_path text);
    `);
    await db.exec(readFileSync(join(dir, SAFETY), "utf8"));

    const seedWorkspace = async (t: string, u: string, deleted: boolean, loginDeleted = deleted) => {
      await db.query("insert into auth.users (id, email, deleted_at) values ($1, $2, $3)", [
        u,
        `${u}@example.com`,
        loginDeleted ? new Date().toISOString() : null,
      ]);
      await db.query(
        "insert into tenants (id, slug, display_name, notification_phone, product_url, settings, deleted_at) values ($1, $2, 'Acme Fences', '+15551234567', '{\"url\":\"https://acme.example\"}', '{\"x\":1}', $3)",
        [t, `acme-${t.slice(0, 8)}`, deleted ? new Date().toISOString() : null],
      );
      await db.query("insert into profiles (user_id, active_tenant_id, deleted_at) values ($1, $2, $3)", [
        u,
        deleted ? null : t,
        deleted ? new Date().toISOString() : null,
      ]);
      if (!deleted) await db.query("insert into tenant_users values ($1, $2, 'owner')", [t, u]);
      const vs = (await one<{ id: string }>("insert into vault.secrets (name, secret) values ($1, 'tok') returning id", [`meta.${t}`]))!.id;
      await db.query("insert into secrets values ($1, 'meta_ads', $2)", [t, vs]);
      const fs = (await one<{ id: string }>("insert into vault.secrets (name, secret) values ($1, 'fn') returning id", [`fn.${t}`]))!.id;
      await db.query("insert into site_function_secrets values ($1, gen_random_uuid(), $2)", [t, fs]);
      await db.query("insert into vault.secrets (name, secret) values ($1, 'buf')", [`buffer.${t}`]);
      await db.query("insert into tenant_buffer_connection values ($1, $2)", [t, `buffer.${t}`]);
      await db.query("insert into connector_metadata values ($1, 'meta_ads')", [t]);
      await db.query("insert into tenant_mcp_servers values ($1, true)", [t]);
      const run = (await one<{ id: string }>(
        "insert into agent_runs (tenant_id, enqueued_by, actor_user_id) values ($1, $2, $2) returning id",
        [t, u],
      ))!.id;
      await db.query("insert into agent_run_events (tenant_id, agent_run_id, body) values ($1, $2, 'secret plan')", [t, run]);
      await db.query("insert into agent_threads (tenant_id, user_id) values ($1, $2)", [t, u]);
      const note = (await one<{ id: string }>("insert into memory_note (tenant_id, body) values ($1, 'notes') returning id", [t]))!.id;
      await db.query("insert into note_links (tenant_id, note_id) values ($1, $2)", [t, note]);
      await db.query("insert into autopilot_goals (tenant_id) values ($1)", [t]);
      await db.query("insert into onboarding_step_events (tenant_id, step) values ($1, $2)", [t, `company:${t}`]);
      await db.query("insert into tenant_credit_ledger (tenant_id, amount) values ($1, 500)", [t]);
      await db.query("insert into admin_action_log (tenant_id, action) values ($1, 'comp_grant')", [t]);
      await db.query("insert into reddit_ad_operations (tenant_id, op) values ($1, 'launch')", [t]);
      await db.query("insert into ads_wallet_orders (tenant_id, amount) values ($1, 2000)", [t]);
      await db.query("insert into sdk_session_entries (tenant_id, entry) values ($1, '{\"text\":\"hi\"}')", [t]);
      await db.query("insert into email_suppression (tenant_id, email_hash) values ($1, 'h')", [t]);
      await db.query("insert into storage.objects (bucket_id, name) values ('agent-chat-images', $1)", [`${t}/a.jpg`]);
      const acct = (await one<{ id: string }>(
        "insert into ads_provider_accounts (credential_tenant_id, credential_ref) values ($1, $2) returning id",
        [t, `linkedin:${t}`],
      ))!.id;
      await db.query("insert into ads_account_bindings (tenant_id, account_id) values ($1, $2)", [t, acct]);
      return run;
    };

    await seedWorkspace(T1, U1, true);
    for (let i = 0; i < 2; i++) {
      const run = (await one<{ id: string }>("insert into agent_runs (tenant_id, enqueued_by) values ($1, $2) returning id", [T1, U1]))!.id;
      await db.query("insert into agent_run_events (tenant_id, agent_run_id, body) values ($1, $2, 'more plans')", [T1, run]);
    }
    await seedWorkspace(T2, U2, false);
    await seedWorkspace(T3, U3, true);
    await seedWorkspace(T4, U4, true);
    const run5 = await seedWorkspace(T5, U5, true);
    await db.query("insert into startup_offer_claim (tenant_id, run_id) values ($1, $2)", [T5, run5]);
    await seedWorkspace(T9, U9, true, false);
    await seedWorkspace(T10, U10, true);
    const run1 = (await one<{ id: string }>("select id from agent_runs where tenant_id = $1 order by id limit 1", [T1]))!.id;
    const note1 = (await one<{ id: string }>("insert into run_notes (run_id) values ($1) returning id", [run1]))!.id;
    await db.query("insert into run_note_reads (tenant_id, note_id) values ($1, $2)", [T1, note1]);
    await db.query("insert into run_artifacts (tenant_id, storage_path) values ($1, $2), ($3, $4)", [
      T1,
      `${T1}/a.jpg`,
      T2,
      `${T1}/shared-asset.png`,
    ]);
    await db.query("insert into storage.objects (bucket_id, name) values ('agent-artifacts', $1)", [`${T1}/shared-asset.png`]);
    await db.query("insert into storage.objects (bucket_id, name) values ('agent-chat-images', $1)", [`${T1}/their-photo.jpg`]);

    await db.query(
      "insert into human_members (auth_user_id, photo_path, illustration_path, sample_video_paths) values ($1, $2, $3, $4)",
      [U1, `media/${M1}.jpg`, `media/${M3}.png`, [`${U2}/x.mp4`]],
    );
    await db.query("insert into storage.objects (bucket_id, name) values ('creator-media', $1), ('creator-media', $2)", [
      `media/${M1}.jpg`,
      `${U1}/clip.mp4`,
    ]);
    await db.query("insert into human_members (auth_user_id, photo_path, illustration_path, sample_video_paths) values ($1, $2, $3, $4)", [
      U2,
      `media/${M2}.jpg`,
      `${T1}/their-photo.jpg`,
      [`media/${M3}.png`, `${U1}/shared.mp4`, `${T1}/shared.mp4`],
    ]);
    await db.query(
      "insert into storage.objects (bucket_id, name) values ('creator-media', $1), ('creator-media', $2), ('creator-media', $3), ('creator-media', $4), ('creator-media', $5)",
      [`media/${M2}.jpg`, `media/${M3}.png`, `${U2}/x.mp4`, `${U1}/shared.mp4`, `${T1}/shared.mp4`],
    );
    await db.query("insert into auth.users (id, email) values ($1, $2)", [U7, `${U7}@example.com`]);
    await db.query("insert into profiles (user_id, active_tenant_id) values ($1, $2)", [U7, T1]);
    await db.query("insert into partner_referrals (referred_tenant_id, note) values ($1, 'live workspace')", [T2]);
    await db.query(
      "insert into site_function_secrets select $1, gen_random_uuid(), vault_secret_id from secrets where tenant_id = $2",
      [T1, T2],
    );
    await db.query("insert into secrets select $1, 'shared', vault_secret_id from secrets where tenant_id = $2", [T1, T2]);
    const platform = (await one<{ id: string }>("insert into vault.secrets (name, secret) values ('platform.openai', 'k') returning id"))!.id;
    await db.query("insert into platform_secrets values ('openai', $1)", [platform]);
    await db.query("insert into secrets values ($1, 'platform_copy', $2)", [T1, platform]);
    await db.query("insert into storage.objects (bucket_id, name) values ('agent-chat-images', $1)", [`${U1}/other.jpg`]);
    await db.query("insert into auth.users (id, email, deleted_at) values ($1, $2, now())", [U6, `${U6}@example.com`]);
    await db.query("insert into human_members (auth_user_id, intro_video_path) values ($1, $2)", [U6, `${U6}/intro.mp4`]);
    await db.query("insert into storage.objects (bucket_id, name) values ('creator-media', $1), ('creator-media', $2)", [
      `${U6}/intro.mp4`,
      `${U6}/photo.jpg`,
    ]);

    const addDeletion = async (id: string, u: string, t: string, dueOffset: string, status = "soft_deleted") =>
      db.query(
        `insert into account_deletions (id, user_id, source, purge_after, status, deleted_tenant_ids)
         values ($1, $2, 'mobile', now() + $3::interval, $4, array[$5]::uuid[])`,
        [id, u, dueOffset, status, t],
      );
    await addDeletion(D1, U1, T1, "-1 day");
    await addDeletion(D3, U3, T3, "1 day");
    await addDeletion(D4, U4, T4, "-1 day", "failed");
    await addDeletion(D5, U5, T5, "-1 day");
    await db.query(
      `insert into account_deletions (id, user_id, source, purge_after, status, deleted_tenant_ids)
       values ($1, $2, 'mobile', now() - interval '1 day', 'soft_deleted', '{}')`,
      [D6, U6],
    );
    await addDeletion(D9, U9, T9, "-1 day");
    await db.query(
      `insert into account_deletions (id, user_id, source, purge_after, deleted_tenant_ids)
       values ($1, $2, 'mobile', now() - interval '1 day', array[$3]::uuid[])`,
      [D10, U10, T10],
    );
  }, 120_000);
  afterAll(async () => db?.close());

  it("dry run reports what would go and what stays, and changes nothing", async () => {
    const before = await snapshotAll();
    const plan = await purge(D1, false);
    expect(plan.status).toBe("dry_run");
    expect(plan.workspaces).toBe(1);
    expect(plan.delete).toMatchObject({
      "agent_runs.tenant_id": 3,
      "agent_run_events.tenant_id": 3,
      "agent_threads.tenant_id": 1,
      "memory_note.tenant_id": 1,
      "note_links.tenant_id": 1,
      "sdk_session_entries.tenant_id": 1,
      "ads_provider_accounts.credential_tenant_id": 1,
      "ads_account_bindings.tenant_id": 1,
      "run_note_reads.tenant_id": 1,
      "run_artifacts.tenant_id": 1,
    });
    expect(plan.clear).toEqual({ "onboarding_step_events.tenant_id": 1 });
    expect(plan.other_links).toEqual({ "profiles.active_tenant_id": 1 });
    expect(plan.unclassified_links).toEqual({});
    expect(plan.cross_tenant_links).toEqual({});
    expect(plan.keep).toEqual({
      "tenant_credit_ledger.tenant_id": 1,
      "admin_action_log.tenant_id": 1,
      "reddit_ad_operations.tenant_id": 1,
      "ads_wallet_orders.tenant_id": 1,
    });
    expect(plan.storage_objects).toBe(4);
    expect(plan.storage_pending).toBe(true);
    expect(plan.auth_user.present).toBe(true);
    expect(plan.auth_user.blockers).toEqual({});
    expect(await snapshotAll()).toEqual(before);
  });

  it("classifies every foreign key to a workspace by whose row it is", async () => {
    const refs = async () =>
      (await db.query("select rel, col, action, bucket from _account_purge_tenant_refs() where col <> 'tenant_id' order by 1, 2")).rows;
    expect(await refs()).toEqual([
      { rel: "ads_provider_accounts", col: "credential_tenant_id", action: "c", bucket: "delete" },
      { rel: "partner_referrals", col: "referred_tenant_id", action: "c", bucket: "unclassified" },
      { rel: "profiles", col: "active_tenant_id", action: "n", bucket: "other" },
    ]);
    await db.exec(`begin;
      alter table ads_provider_accounts drop constraint ads_provider_accounts_credential_tenant_id_fkey,
        add foreign key (credential_tenant_id) references tenants(id) on delete set null;
      alter table profiles drop constraint profiles_active_tenant_id_fkey,
        add foreign key (active_tenant_id) references tenants(id) on delete cascade;
      alter table tenant_credit_ledger
        add column granted_by_tenant_id uuid references tenants(id) on delete set null,
        add column referrer_tenant_id uuid references tenants(id) on delete set null,
        add column sponsor_tenant_id uuid references tenants(id) on delete cascade;
      create or replace function account_purge_link_columns()
      returns table (rel text, col text, kind text) language sql immutable as $f$
        values ('ads_provider_accounts'::text, 'credential_tenant_id'::text, 'owner'::text),
               ('profiles', 'active_tenant_id', 'foreign'),
               ('tenant_credit_ledger', 'referrer_tenant_id', 'foreign'),
               ('tenant_credit_ledger', 'sponsor_tenant_id', 'foreign')
      $f$;`);
    try {
      expect(await refs()).toEqual([
        { rel: "ads_provider_accounts", col: "credential_tenant_id", action: "n", bucket: "clear" },
        { rel: "partner_referrals", col: "referred_tenant_id", action: "c", bucket: "unclassified" },
        { rel: "profiles", col: "active_tenant_id", action: "c", bucket: "unclassified" },
        { rel: "tenant_credit_ledger", col: "granted_by_tenant_id", action: "n", bucket: "unclassified" },
        { rel: "tenant_credit_ledger", col: "referrer_tenant_id", action: "n", bucket: "keep" },
        { rel: "tenant_credit_ledger", col: "sponsor_tenant_id", action: "c", bucket: "unclassified" },
      ]);
    } finally {
      await db.exec("rollback");
    }
    expect((await refs()).map((r: any) => r.bucket)).toEqual(["delete", "unclassified", "other"]);
  });

  it("refuses every removing call while a row of the workspace sits in an unclassified column", async () => {
    await db.query("insert into partner_referrals (referred_tenant_id, note) values ($1, 'deleted workspace')", [T1]);
    const before = await snapshotAll();
    const plan = await purge(D1, false);
    expect(plan.status).toBe("dry_run");
    expect(plan.unclassified_links).toEqual({ "partner_referrals.referred_tenant_id": 1 });
    expect(await purgeError(D1, true)).toMatch(/unclassified_links.*partner_referrals\.referred_tenant_id/);
    expect(await errorOf(() => runBatch(D1, 25))).toMatch(/unclassified_links/);
    expect(await snapshotAll()).toEqual(before);
    await db.query("delete from partner_referrals where referred_tenant_id = $1", [T1]);
  });

  it("never lists or confirms files before the database purge has committed", async () => {
    const before = await snapshotAll();
    expect(await errorOf(() => db.query("select * from account_purge_storage_objects($1)", [D1]))).toMatch(/storage_before_purge/);
    expect(await errorOf(() => db.query("select account_purge_storage_done($1)", [D1]))).toMatch(/storage_before_purge/);
    expect(await snapshotAll()).toEqual(before);
  });

  it("refuses a request that is not due, or whose auth kill failed, and changes nothing", async () => {
    const before = await snapshotAll();
    expect(await purgeError(D3, true)).toMatch(/not_due/);
    expect(await purgeError(D4, true)).toMatch(/status_failed/);
    expect(await purgeError(D3, false)).toMatch(/not_due/);
    expect(await errorOf(() => runBatch(D3, 25))).toMatch(/not_due/);
    expect(await errorOf(() => runBatch(D4, 25))).toMatch(/status_failed/);
    expect(await snapshotAll()).toEqual(before);
  });

  it("refuses a request whose login was never soft-deleted, whatever its status says", async () => {
    const before = await snapshotAll();
    expect((await one("select status from account_deletions where id = $1", [D9]))!.status).toBe("soft_deleted");
    expect(await purgeError(D9, false)).toMatch(/auth_user_live/);
    expect(await purgeError(D9, true)).toMatch(/auth_user_live/);
    expect(await errorOf(() => runBatch(D9, 25))).toMatch(/auth_user_live/);
    expect(await snapshotAll()).toEqual(before);
    expect(await count("agent_runs where tenant_id = $1", [T9])).toBe(1);
  });

  it("a request written without a status is pending and never purged", async () => {
    const before = await snapshotAll();
    expect((await one("select status from account_deletions where id = $1", [D10]))!.status).toBe("pending");
    expect(await purgeError(D10, false)).toMatch(/status_pending/);
    expect(await purgeError(D10, true)).toMatch(/status_pending/);
    expect(await errorOf(() => runBatch(D10, 25))).toMatch(/status_pending/);
    expect(await snapshotAll()).toEqual(before);
  });

  it("a held request is refused until it is released", async () => {
    await db.query("select account_purge_hold($1, 'customer asked us to wait')", [D1]);
    const row = (await one("select status, held_at, hold_reason from account_deletions where id = $1", [D1]))!;
    expect(row.status).toBe("held");
    expect(row.held_at).not.toBeNull();
    expect(row.hold_reason).toBe("customer asked us to wait");
    const before = await snapshotAll();
    expect(await purgeError(D1, false)).toMatch(/status_held/);
    expect(await purgeError(D1, true)).toMatch(/status_held/);
    expect(await errorOf(() => runBatch(D1, 25))).toMatch(/status_held/);
    expect(await snapshotAll()).toEqual(before);
    expect(await errorOf(() => db.query("select account_purge_hold($1, 'x')", [D1]))).toMatch(/only an unpurged soft_deleted/);
    expect(await errorOf(() => db.query("select account_purge_hold($1, 'x')", [D10]))).toMatch(/only an unpurged soft_deleted/);
    expect(await errorOf(() => db.query("select account_purge_hold($1, ' ')", [D5]))).toMatch(/reason are required/);
    await db.query("select account_purge_release($1)", [D1]);
    expect((await one("select status, held_at, hold_reason from account_deletions where id = $1", [D1]))).toEqual({
      status: "soft_deleted",
      held_at: null,
      hold_reason: null,
    });
    expect((await purge(D1, false)).status).toBe("dry_run");
    expect(await errorOf(() => db.query("select account_purge_release($1)", [D1]))).toMatch(/is not held/);
  });

  it("refuses while the person is a member of a workspace again", async () => {
    await db.query("insert into tenant_users values ($1, $2, 'member')", [T2, U1]);
    expect(await purgeError(D1, true)).toMatch(/user_still_member/);
    await db.query("delete from tenant_users where tenant_id = $1 and user_id = $2", [T2, U1]);
  });

  it("refuses while a site resource is still being torn down", async () => {
    await db.query("insert into site_providers values ($1, gen_random_uuid(), 'supabase_project', 'delete_scheduled')", [T1]);
    expect(await purgeError(D1, false)).toMatch(/sites_cleanup_pending/);
    await db.query("update site_providers set state = 'deleted' where tenant_id = $1", [T1]);
  });

  it("a failure leaves purged_at null and every row in place: the person is referenced from another workspace", async () => {
    await db.query("insert into agent_runs (tenant_id, enqueued_by) values ($1, $2)", [T2, U1]);
    await db.query("insert into agent_threads (tenant_id, user_id) values ($1, $2)", [T2, U1]);
    const plan = await purge(D1, false);
    expect(plan.auth_user.blockers).toEqual({
      "agent_runs.enqueued_by (other workspaces)": 1,
      "agent_threads.user_id (other workspaces)": 1,
    });
    const before = await snapshotAll();
    expect(await purgeError(D1, true)).toMatch(/user_rows_outside/);
    expect(await snapshotAll()).toEqual(before);
    expect((await one("select purged_at from account_deletions where id = $1", [D1]))!.purged_at).toBeNull();
    await db.query("delete from agent_runs where tenant_id = $1 and enqueued_by = $2", [T2, U1]);
    await db.query("delete from agent_threads where tenant_id = $1 and user_id = $2", [T2, U1]);
  });

  it("refuses when deleting the workspace's rows would reach a row of another workspace, at any depth", async () => {
    const run = (await one<{ id: string }>("select id from agent_runs where tenant_id = $1 order by id limit 1", [T1]))!.id;
    const cases: Array<{ seed: () => Promise<unknown>; key: string; undo: () => Promise<unknown> }> = [
      {
        seed: () => db.query("insert into agent_run_events (tenant_id, agent_run_id, body) values ($1, $2, 'not yours')", [T2, run]),
        key: "agent_run_events.agent_run_id <- agent_runs",
        undo: () => db.query("delete from agent_run_events where tenant_id = $1 and agent_run_id = $2", [T2, run]),
      },
      {
        seed: async () => {
          const n = (await one<{ id: string }>("insert into run_notes (run_id) values ($1) returning id", [run]))!.id;
          await db.query("insert into run_note_reads (tenant_id, note_id) values ($1, $2)", [T2, n]);
        },
        key: "run_note_reads.note_id <- run_notes",
        undo: async () => {
          await db.query("delete from run_note_reads where tenant_id = $1", [T2]);
          await db.query("delete from run_notes where id not in (select note_id from run_note_reads)");
        },
      },
      {
        seed: async () => {
          const a = (await one<{ id: string }>("insert into run_notes (run_id) values ($1) returning id", [run]))!.id;
          const b = (await one<{ id: string }>("insert into run_notes (parent_note_id) values ($1) returning id", [a]))!.id;
          await db.query("insert into run_note_reads (tenant_id, note_id) values ($1, $2)", [T2, b]);
        },
        key: "run_note_reads.note_id <- run_notes",
        undo: async () => {
          await db.query("delete from run_note_reads where tenant_id = $1", [T2]);
          await db.query("delete from run_notes where id not in (select note_id from run_note_reads)");
        },
      },
      {
        seed: () => db.query("insert into run_bookmarks (tenant_id, run_id) values ($1, $2)", [T2, run]),
        key: "run_bookmarks.run_id <- agent_runs",
        undo: () => db.query("delete from run_bookmarks where tenant_id = $1", [T2]),
      },
    ];
    for (const c of cases) {
      await c.seed();
      const before = await snapshotAll();
      const plan = await purge(D1, false);
      expect(plan.cross_tenant_links).toEqual({ [c.key]: 1 });
      expect(await purgeError(D1, true)).toMatch(/cross_tenant_rows/);
      expect(await errorOf(() => runBatch(D1, 25))).toMatch(/cross_tenant_rows/);
      expect(await snapshotAll()).toEqual(before);
      await c.undo();
    }
    expect((await purge(D1, false)).cross_tenant_links).toEqual({});
  });

  it("locks every row the walk starts from or follows when it is about to delete, and none in a dry run", async () => {
    const lockedBy = async (sql: string, p: unknown[]) =>
      Number((await one<{ n: string }>(
        `select count(*) as n from ${sql} and xmax::text = (txid_current() % 4294967296)::text`, p))!.n);
    const run = (await one<{ id: string }>("select id from agent_runs where tenant_id = $1 order by id limit 1", [T1]))!.id;
    await db.exec("begin");
    try {
      await db.query("select _account_purge_cross_tenant(array[$1]::uuid[], $2::uuid, null, 'workspace', false)", [T1, U1]);
      expect(await lockedBy("agent_runs where tenant_id = $1", [T1])).toBe(0);
      await db.query("select _account_purge_cross_tenant(array[$1]::uuid[], $2::uuid, null, 'workspace', true)", [T1, U1]);
      expect(await lockedBy("agent_runs where tenant_id = $1", [T1])).toBe(3);
      expect(await lockedBy("agent_run_events where tenant_id = $1", [T1])).toBe(3);
      expect(await lockedBy("run_notes where run_id = $1", [run])).toBe(1);
      expect(await lockedBy("agent_runs where tenant_id = $1", [T2])).toBe(0);
    } finally {
      await db.exec("rollback");
    }
    expect(
      await errorOf(() => db.query("select _account_purge_cross_tenant_report(array[$1]::uuid[], $2::uuid, null, 'workspace', true)", [T1, U1])),
    ).toMatch(/non-volatile/);
    expect(
      (await one<{ j: unknown }>("select _account_purge_cross_tenant_report(array[$1]::uuid[], $2::uuid, null, 'workspace', false) as j", [T1, U1]))!.j,
    ).toEqual({});
  });

  it("refuses while a run of the workspace is still in flight", async () => {
    const r = (await one<{ id: string }>(
      "insert into agent_runs (tenant_id, enqueued_by, status, started_at) values ($1, $2, 'running', now()) returning id",
      [T1, U1],
    ))!.id;
    const before = await snapshotAll();
    expect(await purgeError(D1, false)).toMatch(/runs_in_flight/);
    expect(await purgeError(D1, true)).toMatch(/runs_in_flight/);
    expect(await errorOf(() => runBatch(D1, 25))).toMatch(/runs_in_flight/);
    expect(await snapshotAll()).toEqual(before);
    await db.query("update agent_runs set started_at = now() - interval '3 days', enqueued_at = now() - interval '3 days' where id = $1", [r]);
    expect(await purgeError(D1, false)).toMatch(/runs_in_flight/);
    await db.query("update agent_runs set status = 'failed', finished_at = now() - interval '2 hours' where id = $1", [r]);
    expect(await purgeError(D1, true)).toMatch(/runs_recent/);
    await db.query("update agent_runs set finished_at = now() - interval '3 days' where id = $1", [r]);
    expect((await purge(D1, false)).status).toBe("dry_run");
    await db.query("delete from agent_runs where id = $1", [r]);
    await db.query("insert into tenant_agent_schedules (tenant_id, enabled) values ($1, true)", [T1]);
    expect(await purgeError(D1, false)).toMatch(/schedules_enabled/);
    expect(await errorOf(() => runBatch(D1, 25))).toMatch(/schedules_enabled/);
    await db.query("update tenant_agent_schedules set enabled = false where tenant_id = $1", [T1]);
    expect((await purge(D1, false)).status).toBe("dry_run");
  });

  it("refuses when deleting the person would reach a row of another workspace through their own rows", async () => {
    const hm = (await one<{ id: string }>("select id from human_members where auth_user_id = $1", [U1]))!.id;
    await db.query("insert into staff_users (user_id) values ($1)", [U1]);
    await db.query("insert into creator_notifications (tenant_id, human_member_id) values ($1, $2)", [T1, hm]);
    await db.query("insert into creator_notifications (tenant_id, human_member_id) values (null, $1)", [hm]);
    expect((await purge(D1, false)).cross_tenant_links).toEqual({});
    const cases: Array<{ seed: () => Promise<unknown>; key: string; undo: () => Promise<unknown> }> = [
      {
        seed: () => db.query("insert into creator_notifications (tenant_id, human_member_id) values ($1, $2)", [T2, hm]),
        key: "creator_notifications.human_member_id <- human_members",
        undo: () => db.query("delete from creator_notifications where tenant_id = $1", [T2]),
      },
      {
        seed: () => db.query("insert into creator_reminders (tenant_id, human_member_id) values (null, $1)", [hm]),
        key: "creator_reminders.human_member_id <- human_members (no workspace)",
        undo: () => db.query("delete from creator_reminders where human_member_id = $1", [hm]),
      },
      {
        seed: () => db.query("insert into growth_suggestions (tenant_id, staff_user_id) values ($1, $2)", [T2, U1]),
        key: "growth_suggestions.staff_user_id <- staff_users",
        undo: () => db.query("delete from growth_suggestions where tenant_id = $1", [T2]),
      },
    ];
    for (const c of cases) {
      await c.seed();
      const before = await snapshotAll();
      expect((await purge(D1, false)).cross_tenant_links).toEqual({ [c.key]: 1 });
      expect(await purgeError(D1, true)).toMatch(/cross_tenant_rows/);
      expect(await snapshotAll()).toEqual(before);
      await c.undo();
    }
  });

  it("rolls back when a delete would reach a kept billing row", async () => {
    const before = await snapshotAll();
    expect(await errorOf(() => runBatch(D5, 25))).toMatch(/kept_rows_changed/);
    expect(await purgeError(D5, true)).toMatch(/kept_rows_changed/);
    expect(await snapshotAll()).toEqual(before);
  });

  it("deletes the due workspace's runs in batches, and nothing else", async () => {
    const othersBefore = await snapshotExcept([T1]);
    expect(await count("run_notes")).toBe(1);
    expect(await runBatch(D1, 2)).toBe(2);
    expect(await runBatch(D1, 2)).toBe(1);
    expect(await runBatch(D1, 2)).toBe(0);
    expect(await count("agent_runs where tenant_id = $1", [T1])).toBe(0);
    expect(await count("agent_run_events where tenant_id = $1", [T1])).toBe(0);
    expect(await count("run_note_reads where tenant_id = $1", [T1])).toBe(0);
    expect(await count("run_notes")).toBe(0);
    const row = (await one("select purged_at, purge_summary from account_deletions where id = $1", [D1]))!;
    expect(row.purged_at).toBeNull();
    expect(row.purge_summary.batched_agent_runs).toBe(3);
    expect(row.purge_summary.planned_delete).toMatchObject({ "agent_runs.tenant_id": 3, "agent_run_events.tenant_id": 3 });
    const othersAfter = await snapshotExcept([T1]);
    for (const snap of [othersBefore, othersAfter]) {
      snap["account_deletions"] = snap["account_deletions"].filter((r) => !r.includes(D1));
      snap["run_notes"] = [];
    }
    expect(othersAfter).toEqual(othersBefore);
    expect(await count("storage.objects where name like $1", [`${T1}/%`])).toBe(4);
  });

  it("refuses when deleting the workspace's own ad account would reach another workspace", async () => {
    const acct = (await one<{ id: string }>("select id from ads_provider_accounts where credential_tenant_id = $1", [T1]))!.id;
    await db.query("insert into ads_account_bindings (tenant_id, account_id) values ($1, $2)", [T2, acct]);
    const before = await snapshotAll();
    expect(await purgeError(D1, true)).toMatch(/blocked.*ads_provider_accounts\.credential_tenant_id/);
    expect(await snapshotAll()).toEqual(before);
    await db.query("delete from ads_account_bindings where tenant_id = $1 and account_id = $2", [T2, acct]);
  });

  it("purges a due request: the workspace's rows, secrets and the person go, then its files; billing and audit rows stay", async () => {
    const hm1 = (await one<{ id: string }>("select id from human_members where auth_user_id = $1", [U1]))!.id;
    const othersBefore = await snapshotExcept([U1, T1, D1, M1, hm1]);
    const filesBefore = await db.query<{ name: string }>("select name from storage.objects order by 1");
    const out = await purge(D1, true);
    expect(out.status).toBe("purged");
    expect(out.storage_pending).toBe(true);
    expect(out.storage_objects).toBe(4);
    expect((await db.query<{ name: string }>("select name from storage.objects order by 1")).rows).toEqual(filesBefore.rows);

    for (const t of ["agent_runs", "agent_run_events", "agent_threads", "memory_note", "note_links", "autopilot_goals",
      "autopilot_goal_changes", "sdk_session_entries", "secrets", "connector_metadata", "tenant_mcp_servers",
      "site_function_secrets", "tenant_buffer_connection", "site_providers", "ads_account_bindings", "run_artifacts",
      "creator_notifications"]) {
      expect({ t, n: await count(`${t} where tenant_id = $1`, [T1]) }).toEqual({ t, n: 0 });
    }
    expect(await count("vault.secrets where name in ($1, $2, $3)", [`meta.${T1}`, `fn.${T1}`, `buffer.${T1}`])).toBe(0);
    expect(await count("ads_provider_accounts where credential_tenant_id = $1", [T1])).toBe(0);
    expect(await count("ads_provider_accounts where credential_ref = $1", [`linkedin:${T1}`])).toBe(0);
    expect(await count("onboarding_step_events where tenant_id = $1", [T1])).toBe(0);
    expect(await count("onboarding_step_events where tenant_id is null")).toBe(1);
    expect(await count("tenant_credit_ledger where tenant_id = $1", [T1])).toBe(1);
    expect(await count("admin_action_log where tenant_id = $1", [T1])).toBe(1);
    expect(await count("reddit_ad_operations where tenant_id = $1", [T1])).toBe(1);
    expect(await count("ads_wallet_orders where tenant_id = $1", [T1])).toBe(1);
    expect(await count("email_suppression where tenant_id = $1", [T1])).toBe(1);
    expect(await one("select slug, display_name, notification_phone, product_url, settings from tenants where id = $1", [T1])).toEqual({
      slug: `deleted-${T1}`,
      display_name: "Deleted workspace",
      notification_phone: null,
      product_url: null,
      settings: {},
    });
    expect(await count("auth.users where id = $1", [U1])).toBe(0);
    expect(await count("profiles where user_id = $1", [U1])).toBe(0);
    expect(await count("staff_users where user_id = $1", [U1])).toBe(0);
    const row = (await one(
      "select purged_at, status, purge_summary, purge_attempts, storage_purged_at, purge_storage_keys from account_deletions where id = $1",
      [D1],
    ))!;
    expect(row.purged_at).not.toBeNull();
    expect(row.status).toBe("purged");
    expect(row.purge_attempts).toBe(1);
    expect(row.storage_purged_at).toBeNull();
    expect([...row.purge_storage_keys].sort()).toEqual([`media/${M1}.jpg`, `media/${M3}.png`].sort());
    expect(row.purge_summary.batched_agent_runs).toBe(3);
    expect(row.purge_summary.planned_delete["agent_runs.tenant_id"]).toBe(3);
    expect(row.purge_summary.delete["memory_note.tenant_id"]).toBe(1);
    expect(row.purge_summary.delete["ads_provider_accounts.credential_tenant_id"]).toBe(1);
    expect(row.purge_summary.unclassified_links).toEqual({});
    expect(row.purge_summary.cross_tenant_links).toEqual({});
    expect(JSON.stringify(row.purge_summary)).not.toMatch(/secret plan|Acme|example\.com|\+1555/);
    expect(await count("creator_notifications where human_member_id = $1", [hm1])).toBe(0);
    expect(await snapshotExcept([U1, T1, D1, M1, hm1])).toEqual(othersBefore);

    await db.query("insert into tenant_users values ($1, $2, 'member')", [T1, U2]);
    expect(await errorOf(() => db.query("select * from account_purge_storage_objects($1)", [D1]))).toMatch(/workspace_has_members/);
    await db.query("delete from tenant_users where tenant_id = $1 and user_id = $2", [T1, U2]);
    const { rows } = await db.query<{ bucket_id: string; name: string }>("select * from account_purge_storage_objects($1)", [D1]);
    expect(rows).toEqual([
      { bucket_id: "agent-chat-images", name: `${T1}/a.jpg` },
      { bucket_id: "agent-chat-images", name: `${T1}/their-photo.jpg` },
      { bucket_id: "creator-media", name: `${U1}/clip.mp4` },
      { bucket_id: "creator-media", name: `media/${M1}.jpg` },
    ]);
    expect(await errorOf(() => db.query("select account_purge_storage_done($1)", [D1]))).toMatch(/storage_not_empty \(4 objects/);
    for (const r of rows) await db.query("delete from storage.objects where bucket_id = $1 and name = $2", [r.bucket_id, r.name]);
    expect((await one<{ d: string | null }>("select account_purge_storage_done($1) as d", [D1]))!.d).toBeNull();
    expect((await one("select storage_purged_at from account_deletions where id = $1", [D1]))!.storage_purged_at).toBeNull();
    await db.query("update account_deletions set purged_at = purged_at - interval '25 hours' where id = $1", [D1]);
    expect((await one<{ d: string | null }>("select account_purge_storage_done($1) as d", [D1]))!.d).not.toBeNull();
    const done = (await one("select storage_purged_at, purge_storage_keys, purge_summary from account_deletions where id = $1", [D1]))!;
    expect(done.purge_summary.storage_pending).toBe(false);
    expect(done.storage_purged_at).not.toBeNull();
    expect(done.purge_storage_keys).toBeNull();
    expect((await db.query("select * from account_purge_storage_objects($1)", [D1])).rows).toEqual([]);
    expect(await count("storage.objects where name like $1", [`${T2}/%`])).toBe(1);
    expect(await count("storage.objects where name = $1", [`${T1}/shared-asset.png`])).toBe(1);
    expect(await count("storage.objects where name = $1", [`${T1}/their-photo.jpg`])).toBe(0);
    expect(await count("storage.objects where name = $1", [`media/${M2}.jpg`])).toBe(1);
    expect(await count("storage.objects where name = $1", [`media/${M3}.png`])).toBe(1);
    expect(await count("storage.objects where name = $1", [`${U1}/other.jpg`])).toBe(1);
    expect(await count("storage.objects where name = $1", [`${U1}/shared.mp4`])).toBe(1);
    expect(await count("storage.objects where name = $1", [`${T1}/shared.mp4`])).toBe(1);
    expect(await count("storage.objects where name = $1", [`${U2}/x.mp4`])).toBe(1);
    expect((await one("select active_tenant_id from profiles where user_id = $1", [U7]))!.active_tenant_id).toBe(T1);
    expect(await count("vault.secrets where name = $1", [`meta.${T2}`])).toBe(1);
    expect(await count("vault.secrets where name = 'platform.openai'")).toBe(1);
    expect(await count("ads_provider_accounts where credential_tenant_id = $1", [T2])).toBe(1);
    expect(await count("partner_referrals where referred_tenant_id = $1", [T2])).toBe(1);
    expect(await count("run_artifacts where tenant_id = $1", [T2])).toBe(1);
    expect(await count("human_members where auth_user_id = $1", [U1])).toBe(0);
  });

  it("purges a person with no workspace; their uploads go after, and the request says so until they do", async () => {
    const plan = await purge(D6, false);
    expect(plan.workspaces).toBe(0);
    expect(plan.storage_objects).toBe(2);
    expect(await errorOf(() => db.query("select * from account_purge_storage_objects($1)", [D6]))).toMatch(/storage_before_purge/);
    const out = await purge(D6, true);
    expect(out.status).toBe("purged");
    expect(out.storage_pending).toBe(true);
    expect(await count("auth.users where id = $1", [U6])).toBe(0);
    expect(await count("human_members where auth_user_id = $1", [U6])).toBe(0);
    const { rows } = await db.query<{ name: string }>("select name from account_purge_storage_objects($1)", [D6]);
    expect(rows.map((r) => r.name)).toEqual([`${U6}/intro.mp4`, `${U6}/photo.jpg`]);
    expect((await purge(D6, false)).storage_pending).toBe(true);
    expect(await errorOf(() => db.query("select account_purge_storage_done($1)", [D6]))).toMatch(/storage_not_empty/);
    await db.query("delete from storage.objects where name like $1", [`${U6}/%`]);
    expect((await one<{ d: string | null }>("select account_purge_storage_done($1) as d", [D6]))!.d).toBeNull();
    expect((await purge(D6, false)).storage_pending).toBe(true);
    await db.query("update account_deletions set purged_at = purged_at - interval '25 hours' where id = $1", [D6]);
    await db.query("select account_purge_storage_done($1)", [D6]);
    expect((await purge(D6, false)).storage_pending).toBe(false);
  });

  it("is idempotent: a second run changes nothing and says already_purged", async () => {
    const before = await snapshotAll();
    const again = await purge(D1, true);
    expect(again.status).toBe("already_purged");
    expect(again.delete).toEqual({});
    expect(again.unclassified_links).toEqual({});
    expect(again.storage_objects).toBe(0);
    expect(again.storage_pending).toBe(false);
    expect(again.keep).toEqual({
      "tenant_credit_ledger.tenant_id": 1,
      "admin_action_log.tenant_id": 1,
      "reddit_ad_operations.tenant_id": 1,
      "ads_wallet_orders.tenant_id": 1,
    });
    expect((await purge(D1, false)).status).toBe("already_purged");
    const { rows } = await db.query("select * from account_purge_storage_objects($1)", [D1]);
    expect(rows).toEqual([]);
    expect(await snapshotAll()).toEqual(before);
    expect(await errorOf(() => db.query("select account_purge_hold($1, 'late')", [D1]))).toMatch(/only an unpurged/);
  });

  it("accept_invite refuses a workspace deleted with its last member; open invites there were revoked", async () => {
    const U11 = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [U11, `${U11}@example.com`]);
    const invite = async (t: string) =>
      (await one<{ id: string }>(
        "insert into tenant_member_invites (tenant_id, email, role, invited_by) values ($1, $2, 'member', $3) returning id",
        [t, `${U11}@example.com`, U2],
      ))!.id;
    const accept = (id: string) =>
      errorOf(() => db.exec(`begin; set local request.jwt.claim.sub = '${U11}'; select accept_invite('${id}'); commit;`).catch(async (e) => {
        await db.exec("rollback");
        throw e;
      }));
    const toDeleted = await invite(T3);
    expect(await accept(toDeleted)).toMatch(/invite revoked \(the workspace was deleted\)/);
    expect(await count("tenant_users where tenant_id = $1", [T3])).toBe(0);
    expect(await accept(await invite(T2))).toBe("");
    expect(await count("tenant_users where tenant_id = $1 and user_id = $2", [T2, U11])).toBe(1);
    await db.exec(readFileSync(join(dir, SAFETY), "utf8"));
    expect((await one("select revoked_at from tenant_member_invites where id = $1", [toDeleted]))!.revoked_at).not.toBeNull();
    expect(await count("tenant_member_invites where tenant_id = $1 and revoked_at is null", [T2])).toBe(1);
    await db.query("delete from tenant_users where user_id = $1", [U11]);
    await db.query("delete from profiles where user_id = $1", [U11]);
  });

  it("recognises a staff login-as session, and any deletion within 24 hours of one", async () => {
    const block = async (u: string, sid: string | null) =>
      (await one<{ b: string | null }>("select account_deletion_staff_block($1, $2) as b", [u, sid]))!.b;
    const P = randomUUID();
    const mine = randomUUID();
    const minted = randomUUID();
    const legacy = randomUUID();
    await db.query("insert into auth.sessions (id, user_id, created_at) values ($1, $2, now() - interval '10 days')", [mine, P]);
    expect(await block(P, mine)).toBeNull();
    expect(await block(P, null)).toBe("unknown_session");
    expect(await block(P, "not-a-uuid")).toBe("unknown_session");
    await db.query(
      `insert into admin_action_log (tenant_id, action, after_state, created_at)
       values ($1, 'login_as', jsonb_build_object('target_user_id', $2::text, 'session_id', $3::text), now() - interval '2 days')`,
      [T2, P, minted],
    );
    expect(await block(P, minted)).toBe("staff_session");
    expect(await block(P, mine)).toBeNull();
    await db.query("insert into auth.sessions (id, user_id, created_at) values ($1, $2, now() - interval '5 days')", [legacy, P]);
    await db.query(
      `insert into admin_action_log (tenant_id, action, after_state, created_at)
       values ($1, 'login_as', jsonb_build_object('target_user_id', $2::text), now() - interval '5 days' + interval '3 seconds')`,
      [T2, P],
    );
    expect(await block(P, legacy)).toBe("staff_session");
    expect(await block(P, mine)).toBeNull();
    await db.query(
      `insert into admin_action_log (tenant_id, action, after_state)
       values ($1, 'login_as', jsonb_build_object('target_user_id', $2::text, 'session_id', gen_random_uuid()::text))`,
      [T2, P],
    );
    expect(await block(P, mine)).toBe("recent_staff_login");
    expect(await block(randomUUID(), mine)).toBeNull();
  });

  it("purge_tenant_credentials keeps a Vault secret another workspace, the platform or a shard points at", async () => {
    await db.query("insert into tenants (id, slug, display_name) values ($1, $2, 'Creds Co')", [T8, `creds-${T8.slice(0, 8)}`]);
    const own = (await one<{ id: string }>("insert into vault.secrets (name, secret) values ($1, 'mine') returning id", [`own.${T8}`]))!.id;
    const shard = (await one<{ id: string }>("insert into vault.secrets (name, secret) values ('shard.key', 's') returning id"))!.id;
    await db.query("insert into site_shard_secrets values (gen_random_uuid(), 'k', $1)", [shard]);
    await db.query("insert into secrets values ($1, 'own', $2)", [T8, own]);
    await db.query("insert into secrets select $1, 'copy', vault_secret_id from secrets where tenant_id = $2 and key = 'meta_ads'", [T8, T2]);
    await db.query("insert into secrets select $1, 'platform', vault_secret_id from platform_secrets where key = 'openai'", [T8]);
    await db.query("insert into secrets values ($1, 'shard', $2)", [T8, shard]);
    const removed = Number((await one<{ n: number }>("select purge_tenant_credentials($1) as n", [T8]))!.n);
    expect(removed).toBe(1);
    expect(await count("vault.secrets where id = $1", [own])).toBe(0);
    expect(await count("vault.secrets where name = $1", [`meta.${T2}`])).toBe(1);
    expect(await count("vault.secrets where name = 'platform.openai'")).toBe(1);
    expect(await count("vault.secrets where id = $1", [shard])).toBe(1);
    expect(await count("secrets where tenant_id = $1", [T8])).toBe(0);
    expect(await count("secrets where tenant_id = $1 and key = 'meta_ads'", [T2])).toBe(1);
  });

  it("begins a deletion only while the person is the only member, once per person, and aborts it cleanly", async () => {
    const T11 = randomUUID();
    const U12 = randomUUID();
    const U13 = randomUUID();
    const U14 = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)", [
      U12, `${U12}@example.com`, U13, `${U13}@example.com`, U14, `${U14}@example.com`,
    ]);
    await db.query("insert into tenants (id, slug, display_name) values ($1, $2, 'Solo')", [T11, `solo-${T11.slice(0, 8)}`]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T11, U12]);
    const marked = async () => (await one("select deleted_at from tenants where id = $1", [T11]))!.deleted_at;
    const begin = (id: string, u = U12) =>
      errorOf(() =>
        db.query(
          "select account_deletion_begin($1, $2, 'h', 'mobile', now() + interval '30 days', array[$3]::uuid[], '{}'::uuid[])",
          [id, u, T11],
        ),
      );
    const status = async (id: string) => (await one<{ status: string }>("select status from account_deletions where id = $1", [id]))?.status;
    await db.query("insert into tenant_users values ($1, $2, 'member')", [T11, U13]);
    const X0 = randomUUID();
    expect(await begin(X0)).toMatch(/workspace_changed/);
    expect(await status(X0)).toBeUndefined();
    expect(await marked()).toBeNull();
    expect(await begin(randomUUID(), U14)).toMatch(/workspace_changed/);
    await db.query("delete from tenant_users where tenant_id = $1 and user_id = $2", [T11, U13]);
    const X1 = randomUUID();
    expect(await begin(X1)).toBe("");
    expect(await status(X1)).toBe("pending");
    expect(await marked()).not.toBeNull();
    expect(await begin(randomUUID())).toMatch(/already_in_progress/);
    const inv = (await one<{ id: string }>(
      "insert into tenant_member_invites (tenant_id, email, role, invited_by) values ($1, $2, 'member', $3) returning id",
      [T11, `${U13}@example.com`, U12],
    ))!.id;
    const joinErr = await errorOf(() =>
      db.exec(`begin; set local request.jwt.claim.sub = '${U13}'; select accept_invite('${inv}'); commit;`).catch(async (e) => {
        await db.exec("rollback");
        throw e;
      }),
    );
    expect(joinErr).toMatch(/workspace was deleted/);
    const abort = async (id: string) => (await one<{ r: string }>("select account_deletion_abort($1, true) as r", [id]))!.r;
    const abortByHand = async (id: string) => (await one<{ r: string }>("select account_deletion_abort($1) as r", [id]))!.r;
    expect(await abortByHand(X1)).toBe("too_early");
    expect(await status(X1)).toBe("pending");
    expect(await abort(X1)).toBe("failed");
    expect(await status(X1)).toBe("failed");
    expect(await marked()).toBeNull();
    expect(await abort(X1)).toBe("noop");
    expect(await abort(randomUUID())).toBe("noop");
    const X2 = randomUUID();
    expect(await begin(X2)).toBe("");
    await db.query("update account_deletions set status = 'soft_deleted' where id = $1", [X2]);
    expect(await abort(X2)).toBe("noop");
    expect(await status(X2)).toBe("soft_deleted");
    expect(await marked()).not.toBeNull();
    expect(await begin(randomUUID())).toMatch(/already_in_progress/);
    const X3 = randomUUID();
    await db.query(
      `insert into account_deletions (id, user_id, source, purge_after, status, deleted_tenant_ids)
       values ($1, $2, 'api', now() + interval '30 days', 'pending', array[$3]::uuid[])`,
      [X3, U12, T11],
    );
    expect(await abort(X3)).toBe("failed");
    expect(await status(X3)).toBe("failed");
    expect(await marked()).not.toBeNull();
    const X5 = randomUUID();
    await db.query(
      `insert into account_deletions (id, user_id, source, purge_after, status, deleted_tenant_ids)
       values ($1, $2, 'api', now() + interval '30 days', 'pending', array[$3]::uuid[])`,
      [X5, U13, T11],
    );
    await db.query("update auth.users set deleted_at = now() where id = $1", [U13]);
    expect(await abort(X5)).toBe("soft_deleted");
    expect(await status(X5)).toBe("soft_deleted");
    expect(await begin(randomUUID(), U13)).toMatch(/already_in_progress/);
    const U15 = randomUUID();
    const X8 = randomUUID();
    await db.query(
      `insert into account_deletions (id, user_id, source, purge_after, status, deleted_tenant_ids)
       values ($1, $2, 'api', now() + interval '30 days', 'pending', '{}')`,
      [X8, U15],
    );
    expect(await abort(X8)).toBe("failed");
    const mism = async () => (await db.query<{ id: string; kind: string }>("select * from account_deletion_mismatches(50)")).rows;
    expect((await mism()).map((r) => r.id)).not.toContain(X1);
    await db.query("update auth.users set deleted_at = now() where id = $1", [U12]);
    expect(await mism()).toEqual(expect.arrayContaining([{ id: X1, kind: "killed_after_fail" }]));
    await db.query("update auth.users set deleted_at = null where id = $1", [U12]);
    await db.query("update auth.users set deleted_at = null where id = $1", [U12]);
    await db.query("update account_deletions set status = 'failed' where $1 = any (deleted_tenant_ids)", [T11]);
    await db.query("update tenants set deleted_at = null where id = $1", [T11]);
    const X6 = randomUUID();
    expect(await begin(X6)).toBe("");
    await db.query("update account_deletions set requested_at = now() - interval '3 days' where id = $1", [X6]);
    expect(await begin(randomUUID())).toMatch(/already_in_progress/);
    expect(await status(X6)).toBe("pending");
    expect(await abort(X6)).toBe("failed");
    expect(await marked()).toBeNull();
    expect(await begin(randomUUID())).toBe("");
    const X4 = randomUUID();
    expect(
      await errorOf(() =>
        db.query("select account_deletion_begin($1, $2, null, 'api', now() + interval '30 days', '{}'::uuid[], '{}'::uuid[])", [X4, U14]),
      ),
    ).toBe("");
    expect(await status(X4)).toBe("pending");
  });

  it("purge_tenant_credentials keeps a Vault secret this workspace's kept site key or a site row still points at", async () => {
    const T12 = randomUUID();
    const site = randomUUID();
    await db.query("insert into tenants (id, slug, display_name) values ($1, $2, 'Site Co')", [T12, `site-${T12.slice(0, 8)}`]);
    await db.query("insert into site_providers values ($1, $2, 'supabase_project', 'delete_scheduled')", [T12, site]);
    const kept = (await one<{ id: string }>("insert into vault.secrets (name, secret) values ('kept', 'k') returning id"))!.id;
    const fnShared = (await one<{ id: string }>("insert into vault.secrets (name, secret) values ('fnshared', 'f') returning id"))!.id;
    const plain = (await one<{ id: string }>("insert into vault.secrets (name, secret) values ('plain', 'p') returning id"))!.id;
    await db.query("insert into secrets values ($1, $2, $3), ($1, 'alias', $3)", [T12, `site.${site}.sb_anon`, kept]);
    await db.query("insert into secrets values ($1, 'fn_alias', $2)", [T12, fnShared]);
    await db.query("insert into site_function_secrets values ($1, $2, $3)", [T12, site, fnShared]);
    await db.query("insert into secrets values ($1, 'plain', $2)", [T12, plain]);
    const removed = Number((await one<{ n: number }>("select purge_tenant_credentials($1) as n", [T12]))!.n);
    expect(removed).toBe(1);
    expect(await count("vault.secrets where id = $1", [plain])).toBe(0);
    expect(await count("vault.secrets where id = $1", [kept])).toBe(1);
    expect(await count("vault.secrets where id = $1", [fnShared])).toBe(1);
    expect((await db.query<{ key: string }>("select key from secrets where tenant_id = $1 order by key", [T12])).rows.map((r) => r.key)).toEqual([
      `site.${site}.sb_anon`,
    ]);
  });

  it("only the service role may call the purge", async () => {
    const grants = await db.query<{ grantee: string }>(
      `select grantee from information_schema.routine_privileges
        where routine_name in ('purge_account_deletion', 'account_purge_storage_objects', 'account_purge_delete_runs',
                               'account_purge_link_columns', '_account_purge_tenant_refs', '_account_purge_check',
                               '_account_purge_unclassified', '_account_purge_refuse_unclassified',
                               'account_purge_hold', 'account_purge_release', 'account_deletion_staff_block',
                               'account_deletion_begin', 'account_deletion_abort', '_account_purge_cross_tenant_report',
                               'account_deletion_mismatches',
                               'account_purge_person_links',
                               'account_purge_storage_done', 'account_purge_storage_ref_columns',
                               '_account_purge_cross_tenant', '_account_purge_covered_sql',
                               '_account_purge_storage_targets', '_account_purge_saved_media_keys',
                               'purge_tenant_credentials')
          and privilege_type = 'EXECUTE'`,
    );
    const who = new Set(grants.rows.map((r) => r.grantee));
    expect(who.has("service_role")).toBe(true);
    expect(who.has("anon")).toBe(false);
    expect(who.has("authenticated")).toBe(false);
    expect(who.has("PUBLIC")).toBe(false);
  });
});
