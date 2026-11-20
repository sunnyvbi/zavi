import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const BUCKET = readFileSync(join(dir, "20261009100000_channel_action_exec_bucket.sql"), "utf8");
const VERIFY = readFileSync(join(dir, "20261031191400_email_content_verify_codes.sql"), "utf8").replace(/^(begin|commit);$/gm, "");

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenant_users (tenant_id uuid not null, user_id uuid not null, primary key (tenant_id, user_id));
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    channel_slug text not null,
    run_id uuid not null,
    title text not null default 't',
    body jsonb not null default '{}',
    status text not null default 'pending'
      check (status in ('pending','acted','rejected','snoozed','redone','stale','displaced')),
    status_at timestamptz,
    note text check (note is null or char_length(note) <= 1000),
    exec_class text,
    exec_payload jsonb,
    exec_status text check (exec_status in ('queued','dispatching','executed','failed')),
    exec_result jsonb,
    executed_at timestamptz,
    approved_by uuid,
    approved_by_source text,
    exec_claim_id uuid,
    exec_claimed_at timestamptz,
    unique (tenant_id, id)
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null,
    action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null,
    actor_kind text not null,
    actor_user_id uuid,
    run_id uuid,
    note text,
    event_key text not null,
    at timestamptz not null default now(),
    unique (action_id, event_key)
  );
`;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;

describe.skipIf(!PG_URL)("one email-content alert per tenant and tool per rolling hour, live", () => {
  let db: Client;
  const enqueue = async (tenant: string, tool: string): Promise<boolean> =>
    (
      await db.query<{ ok: boolean }>("select enqueue_ops_alert_windowed($1, 3600, 'email-content-verify', 'email_content_verify', $2, 'x') ok", [
        `email_content:${tenant}:${tool}`,
        tenant,
      ])
    ).rows[0].ok;
  const rows = async (tenant: string) =>
    (await db.query<{ dedupe_key: string }>("select dedupe_key from ops_alert_outbox where tenant_id = $1 order by id", [tenant])).rows;

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = (await db.query<{ t: string | null }>("select to_regclass('public.channel_actions')::text t")).rows[0];
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database (channel_actions already exists)");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query(BUCKET);
    await db.query(VERIFY);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("must catch: a second alert inside the hour is not enqueued; another tool or tenant is", async () => {
    const t1 = randomUUID();
    const t2 = randomUUID();
    expect(await enqueue(t1, "sendgrid")).toBe(true);
    expect(await enqueue(t1, "sendgrid")).toBe(false);
    expect(await enqueue(t1, "klaviyo")).toBe(true);
    expect(await enqueue(t2, "sendgrid")).toBe(true);
    expect(await rows(t1)).toHaveLength(2);
  });

  it("the window rolls: once the last alert is an hour old, the next one goes (a permanent key would never alert again)", async () => {
    const t = randomUUID();
    expect(await enqueue(t, "mailchimp")).toBe(true);
    await db.query("update ops_alert_outbox set created_at = now() - interval '61 minutes' where tenant_id = $1", [t]);
    expect(await enqueue(t, "mailchimp")).toBe(true);
    const keys = (await rows(t)).map((r) => r.dedupe_key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) expect(k.startsWith(`email_content:${t}:mailchimp:`)).toBe(true);
  });

  it("matches the exact key only: an alert under a longer key that starts with it does not hold it back", async () => {
    const t = randomUUID();
    const longer = (await db.query<{ ok: boolean }>("select enqueue_ops_alert_windowed($1, 3600, 'email-content-verify', 'email_content_verify', $2, 'x') ok", [`email_content:${t}:sendgrid:extra`, t])).rows[0].ok;
    expect(longer).toBe(true);
    expect(await enqueue(t, "sendgrid")).toBe(true);
    expect(await enqueue(t, "sendgrid")).toBe(false);
  });

  it("the window lookup uses the index", async () => {
    await db.query("set local enable_seqscan = off");
    const plan = (
      await db.query<{ "QUERY PLAN": string }>(
        "explain select 1 from ops_alert_outbox where source = 'email-content-verify' and code = 'email_content_verify' and tenant_id = $1 and created_at > now() - interval '1 hour'",
        [randomUUID()],
      )
    ).rows.map((r) => r["QUERY PLAN"]).join("\n");
    await db.query("set local enable_seqscan = on");
    expect(plan).toMatch(/ops_alert_outbox_window_idx/);
  });

  it("refuses a missing key or an out-of-range window; service role only", async () => {
    await db.query("savepoint s");
    await expect(db.query("select enqueue_ops_alert_windowed('', 3600, 's', 'c', gen_random_uuid(), 'x')")).rejects.toThrow(/key/);
    await db.query("rollback to savepoint s");
    await expect(db.query("select enqueue_ops_alert_windowed('k', 10, 's', 'c', gen_random_uuid(), 'x')")).rejects.toThrow(/window/);
    await db.query("rollback to savepoint s");
    await expect(db.query("select enqueue_ops_alert_windowed('k', 3600, 's', 'c', null, 'x')")).rejects.toThrow(/tenant/);
    await db.query("rollback to savepoint s");
    const grants = (
      await db.query<{ anon: boolean; svc: boolean }>(
        "select has_function_privilege('anon', 'enqueue_ops_alert_windowed(text,int,text,text,uuid,text)', 'execute') anon, has_function_privilege('service_role', 'enqueue_ops_alert_windowed(text,int,text,text,uuid,text)', 'execute') svc",
      )
    ).rows[0];
    expect(grants).toEqual({ anon: false, svc: true });
  });
});
