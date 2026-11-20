import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_NOTETAKER_CONSENT_MESSAGE } from "@/services/meetings/settings-defaults";
import { MEETING_NOTES_RETENTION_DAYS, RECAP_DESTINATIONS } from "@/services/meetings/recap-destination";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261115170000_notetaker_recap_destination.sql";
const SQL = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const OLD_DEFAULT =
  "Zavi Notetaker is recording and transcribing this meeting to brief your AI team. Important decisions and blockers are saved; the recording itself is deleted after transcription. Ask the host to disable Zavi in workspace settings to opt out.";

const UPCAR = "11111111-1111-4111-8111-111111111111";
const ZAVI = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const BARE = "44444444-4444-4444-8444-444444444444";
const MEMBER = "a1a1a1a1-0000-4000-8000-000000000001";

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  grant usage on schema auth to authenticated, anon;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function public.app_active_tenant() returns uuid language sql stable as $$ select nullif(current_setting('test.tenant', true), '')::uuid $$;
  create table public.tenants (id uuid primary key, slug text not null);
  create table public.tenant_users (tenant_id uuid not null, user_id uuid not null, role text not null default 'member');
  grant select on public.tenant_users to authenticated;
  create table public.meeting_bots (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id));
  create table public.tenant_meeting_settings (
    tenant_id uuid primary key references public.tenants(id) on delete cascade,
    enabled boolean not null default true,
    meeting_url text not null default '',
    consent_message text not null default '${OLD_DEFAULT}',
    slack_channel_id text,
    slack_channel_name text,
    updated_at timestamptz not null default now()
  );
`;

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, any>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};
let db: Db;

describe(FILE, () => {
  it("sorts after the migrations it builds on", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261115140000_meeting_bot_cancelled_status.sql"));
  });
});

describe(`${FILE} executed in Postgres (pglite)`, () => {
  const settings = async (tenant: string) =>
    (await db.query("select * from public.tenant_meeting_settings where tenant_id = $1", [tenant])).rows[0];
  const fails = async (q: string, p?: unknown[]) => {
    try {
      await db.query(q, p);
      return false;
    } catch {
      return true;
    }
  };
  const asMember = async (activeTenant: string | null) => {
    await db.exec(`select set_config('test.uid', '${MEMBER}', false), set_config('test.tenant', '${activeTenant ?? ""}', false)`);
    await db.exec("set role authenticated");
  };
  const asOwner = () => db.exec("reset role");

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(`
      insert into public.tenants values ('${UPCAR}', 'upcar-ai'), ('${ZAVI}', 'zavi-815d9300'), ('${OTHER}', 'acme'), ('${BARE}', 'bare');
      insert into public.tenant_users values ('${UPCAR}', '${MEMBER}', 'member');
      insert into public.tenant_meeting_settings (tenant_id, slack_channel_id, slack_channel_name) values
        ('${UPCAR}', 'C-STANDUPS', 'standups'),
        ('${ZAVI}', 'C-ZAVI', 'zavi-updates');
      insert into public.tenant_meeting_settings (tenant_id, slack_channel_id, slack_channel_name, consent_message) values
        ('${OTHER}', 'C-ACME', 'general', 'Our own words. Ask Dana to opt out.');
      insert into public.tenant_meeting_settings (tenant_id) values ('${BARE}');
    `);
    await db.exec(SQL);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => db?.close());

  it("upcar-ai keeps its channel as destination slack; every other tenant is not chosen and loses its saved channel", async () => {
    expect(await settings(UPCAR)).toMatchObject({ recap_destination: "slack", slack_channel_id: "C-STANDUPS", slack_channel_name: "standups" });
    for (const t of [ZAVI, OTHER, BARE]) {
      expect(await settings(t)).toMatchObject({ recap_destination: null, slack_channel_id: null, slack_channel_name: null, choose_destination_email_at: null });
    }
  });

  it("the default join message gains the summary sentence; a custom message is untouched; new rows get the new default", async () => {
    expect((await settings(UPCAR)).consent_message).toBe(DEFAULT_NOTETAKER_CONSENT_MESSAGE);
    expect((await settings(OTHER)).consent_message).toBe("Our own words. Ask Dana to opt out.");
    const fresh = "55555555-5555-4555-8555-555555555555";
    await db.query("insert into public.tenants values ($1, 'fresh')", [fresh]);
    await db.query("insert into public.tenant_meeting_settings (tenant_id) values ($1)", [fresh]);
    expect((await settings(fresh)).consent_message).toBe(DEFAULT_NOTETAKER_CONSENT_MESSAGE);
    expect((await settings(fresh)).recap_destination).toBeNull();
  });

  it("only slack, email or off is a choice, and slack always names a channel", async () => {
    for (const d of RECAP_DESTINATIONS) {
      expect(await fails("update public.tenant_meeting_settings set recap_destination = $1, slack_channel_id = 'C-X' where tenant_id = $2", [d, BARE])).toBe(false);
    }
    expect(await fails("update public.tenant_meeting_settings set recap_destination = 'everyone' where tenant_id = $1", [BARE])).toBe(true);
    expect(await fails("update public.tenant_meeting_settings set recap_destination = 'slack', slack_channel_id = null where tenant_id = $1", [BARE])).toBe(true);
    expect(await fails("update public.tenant_meeting_settings set recap_destination = 'email', slack_channel_id = null where tenant_id = $1", [BARE])).toBe(false);
  });

  it(`notes are kept ${MEETING_NOTES_RETENTION_DAYS} days by default and can never be kept longer`, async () => {
    const { rows } = await db.query<{ id: string }>("insert into public.meeting_bots (tenant_id) values ($1) returning id", [UPCAR]);
    const bot = rows[0].id;
    await db.query("insert into public.meeting_notes (bot_id, tenant_id, transcript) values ($1, $2, 'Asha: hi')", [bot, UPCAR]);
    const kept = (await db.query<{ days: number }>("select extract(epoch from delete_after - created_at) / 86400 as days from public.meeting_notes where bot_id = $1", [bot])).rows[0];
    expect(Number(kept.days)).toBe(MEETING_NOTES_RETENTION_DAYS);
    const { rows: r2 } = await db.query<{ id: string }>("insert into public.meeting_bots (tenant_id) values ($1) returning id", [UPCAR]);
    expect(
      await fails("insert into public.meeting_notes (bot_id, tenant_id, delete_after) values ($1, $2, now() + interval '31 days')", [r2[0].id, UPCAR]),
    ).toBe(true);
  });

  it("a member reads their active tenant's notes until they are due; never another tenant's; never writes", async () => {
    await asOwner();
    const bot = async (t: string) => (await db.query<{ id: string }>("insert into public.meeting_bots (tenant_id) values ($1) returning id", [t])).rows[0].id;
    const mine = await bot(UPCAR);
    const due = await bot(UPCAR);
    const theirs = await bot(ZAVI);
    await db.query("insert into public.meeting_notes (bot_id, tenant_id, transcript) values ($1, $2, 'mine')", [mine, UPCAR]);
    await db.query(
      "insert into public.meeting_notes (bot_id, tenant_id, transcript, created_at, delete_after) values ($1, $2, 'due', now() - interval '31 days', now() - interval '1 day')",
      [due, UPCAR],
    );
    await db.query("insert into public.meeting_notes (bot_id, tenant_id, transcript) values ($1, $2, 'theirs')", [theirs, ZAVI]);

    try {
      await asMember(UPCAR);
      const seen = (await db.query<{ transcript: string }>("select transcript from public.meeting_notes")).rows.map((r) => r.transcript);
      expect(seen).toContain("mine");
      expect(seen).not.toContain("due");
      expect(seen).not.toContain("theirs");
      expect(await fails("insert into public.meeting_notes (bot_id, tenant_id) values ($1, $2)", [mine, UPCAR])).toBe(true);
      expect(await fails("delete from public.meeting_notes")).toBe(true);

      await asOwner();
      await asMember(ZAVI);
      expect((await db.query("select transcript from public.meeting_notes")).rows).toHaveLength(0);
    } finally {
      await asOwner();
    }
    await db.exec("set role anon");
    try {
      expect(await fails("select 1 from public.meeting_notes")).toBe(true);
    } finally {
      await asOwner();
    }
  });
});
