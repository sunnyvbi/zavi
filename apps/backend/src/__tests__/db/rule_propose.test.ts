import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TENANT_RULES_PG_URL;
const MIG = resolve(__dirname, "../../../../../supabase/migrations");
const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000003";
const STAFF = "aaaaaaaa-0000-4000-8000-00000000000f";
const THREAD = "cccccccc-0000-4000-8000-000000000001";
const RUN = "dddddddd-0000-4000-8000-000000000001";
const MSG = "eeeeeeee-0000-4000-8000-000000000001";
const RULE_TEXT = "From now on, never schedule posts on weekends.";
const BODY = `Thanks. ${RULE_TEXT} Also what is our CAC?`;
const START = BODY.indexOf(RULE_TEXT);
const END = START + RULE_TEXT.length;

describe.skipIf(!url)("rule_propose on real Postgres", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let imported: Array<Record<string, unknown>> = [];
  const propose = async (kind: string, id: string, s = START, e = END, scope = "all", slug: string | null = null) =>
    (await db.query(`select public.rule_propose($1,$2,$3,$4,$5,$6,$7) as r`, [T, kind, id, s, e, scope, slug])).rows[0].r;

  beforeAll(async () => {
    const { Client } = await import("pg");
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`
      do $$ declare r text; begin foreach r in array array['anon', 'authenticated', 'service_role'] loop if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I', r); end if; end loop; end $$; create schema auth;
      create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function public.app_active_tenant() returns uuid language sql stable as $$ select null::uuid $$;
      create table public.tenants(id uuid primary key);
      create table public.tenant_users(user_id uuid, tenant_id uuid, role text);
      create table public.agent_runs(id uuid primary key, tenant_id uuid, agent_slug text, trigger text, payload jsonb, enqueued_by uuid);
      create table public.agent_threads(id uuid primary key, tenant_id uuid, user_id uuid);
      create table public.agent_thread_messages(id uuid primary key, thread_id uuid, tenant_id uuid, sender_role text,
        body text, agent_run_id uuid, meta jsonb default '{}', source text default 'chat', content_kind text default 'text');
      create table public.email_messages(id uuid primary key, tenant_id uuid, direction text, sender_verified_member boolean,
        from_address text, body_text text);
      create table public.channel_action_events(id bigint primary key, tenant_id uuid, event text, actor_kind text,
        actor_user_id uuid, note text);
      create table public.agent_feedback(id uuid primary key default gen_random_uuid(), tenant_id uuid, agent_slug text,
        comment text, kind text, created_by uuid, created_at timestamptz default now());
      -- The Slack author is resolved by the REAL team-aware resolver (20261031160000):
      -- the founder's Slack id is linked in workspace T_ACME of tenant T.
      create table public.slack_workspaces(tenant_id uuid, team_id text unique, primary key (tenant_id, team_id));
      create table public.team_members(id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
        display_name text not null, primary_email text, kind text not null default 'human',
        status text not null default 'active', merged_into_id uuid, deactivated_at timestamptz,
        last_active_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create table public.team_member_identities(id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
        member_id uuid not null, provider text not null, external_id text not null, team_id text, external_email text,
        external_display_name text, confidence numeric(3,2) not null default 1.00, source text not null default 'auto',
        linked_at timestamptz not null default now());
      insert into public.slack_workspaces values ('${T}', 'T_ACME');
      insert into public.team_members(id, tenant_id, display_name, primary_email)
        values ('bbbbbbbb-0000-4000-8000-000000000001', '${T}', 'Founder', 'founder@acme.com');
      insert into public.team_member_identities(tenant_id, member_id, provider, external_id, team_id)
        values ('${T}', 'bbbbbbbb-0000-4000-8000-000000000001', 'slack', 'U_OWNER', 'T_ACME');
      insert into public.tenants values ('${T}'), ('${T2}');
      insert into public.tenant_users values ('${OWNER}', '${T}', 'owner'), ('${MEMBER}', '${T}', 'member');
      insert into auth.users values ('${OWNER}', 'founder@acme.com');
      insert into public.agent_feedback(tenant_id, agent_slug, comment, kind, created_by) values
        ('${T}', 'operator', 'never auto-approve a refund over $500', 'rule', '${MEMBER}'),
        ('${T}', 'operator', 'card 4242 4242 4242 4242', 'rule', '${MEMBER}'),
        ('${T}', 'operator', 'a note, not a rule', 'note', '${MEMBER}');
    `);
    await db.query(readFileSync(resolve(MIG, "20261005120000_tenant_rules.sql"), "utf8"));
    await db.query(readFileSync(resolve(MIG, "20261005120200_rule_propose.sql"), "utf8"));
    await db.query(readFileSync(resolve(MIG, "20261031160000_slack_identity_link_on_use.sql"), "utf8"));
    imported = (await db.query(
      `select scope_kind, scope_slug, text, status, origin, created_by from public.tenant_rules`,
    )).rows;
  });
  afterAll(async () => { await db?.end(); });

  const resetSource = async (over: Record<string, unknown> = {}, run: Record<string, unknown> = {}) => {
    await db.query("truncate public.tenant_rules, public.tenant_rule_settings, public.agent_thread_messages, public.agent_threads, public.agent_runs, public.email_messages, public.channel_action_events");
    const r = { trigger: "chat", payload: {}, enqueued_by: OWNER, agent_slug: "operator", ...run };
    await db.query(`insert into public.agent_threads values ($1,$2,$3)`, [THREAD, T, OWNER]);
    await db.query(`insert into public.agent_runs values ($1,$2,$3,$4,$5,$6)`,
      [RUN, T, r.agent_slug, r.trigger, JSON.stringify(r.payload), r.enqueued_by]);
    const m = { sender_role: "user", body: BODY, meta: {}, source: "chat", content_kind: "text", agent_run_id: RUN, ...over };
    await db.query(`insert into public.agent_thread_messages values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [MSG, THREAD, T, m.sender_role, m.body, m.agent_run_id, JSON.stringify(m.meta), m.source, m.content_kind]);
  };

  beforeEach(async () => { await resetSource(); });

  it("the old Rules tab was imported as suggestions with its real author, skipping card numbers and notes", () => {
    expect(imported).toEqual([
      { scope_kind: "agent", scope_slug: "operator", text: "never auto-approve a refund over $500",
        status: "suggested", origin: "imported_rules_tab", created_by: MEMBER },
    ]);
  });

  it("an owner's typed chat message gives a SUGGESTION (never active) with the exact words", async () => {
    const r = await propose("chat_message", MSG);
    expect(r.status).toBe("suggested");
    expect(r.text).toBe(RULE_TEXT);
    const row = (await db.query(`select status, origin, created_by, source_start, source_end from public.tenant_rules`)).rows[0];
    expect(row).toEqual({ status: "suggested", origin: "chat_typed", created_by: OWNER, source_start: START, source_end: END });
  });

  it("the same span twice is one suggestion", async () => {
    await propose("chat_message", MSG);
    expect((await propose("chat_message", MSG)).status).toBe("exists");
  });

  it.each([
    ["an agent reply", { sender_role: "assistant" }, {}],
    ["an email mirrored into chat", { meta: { via: "email" } }, {}],
    ["a staff-console message (meta)", { meta: { actor_source: "staff" } }, {}],
    ["a staff-console run", {}, { payload: { origin: "staff_console" } }],
    ["a run someone else enqueued", {}, { enqueued_by: STAFF }],
    ["a voice transcript", { content_kind: "voice_transcript" }, {}],
    ["a clarification answer", { meta: { clarification_response: true } }, {}],
    ["a message the founder edited (superseded)", { meta: { superseded_by: "00000000-0000-0000-0000-0000000000aa" } }, {}],
    ["a cron-sourced row", { source: "cron" }, {}],
    ["a non-chat run", {}, { trigger: "email" }],
  ])("%s never becomes a suggestion", async (_label, msg, run) => {
    await resetSource(msg as Record<string, unknown>, run as Record<string, unknown>);
    expect((await propose("chat_message", MSG)).status).toBe("not_allowed");
    expect((await db.query(`select count(*)::int n from public.tenant_rules`)).rows[0].n).toBe(0);
  });

  it("a suggestion whose source message was edited away cannot be turned on", async () => {
    const r = await propose("chat_message", MSG);
    expect(r.status).toBe("suggested");
    await db.query(`update public.agent_thread_messages set meta = coalesce(meta, '{}'::jsonb) || '{"superseded_by": "x"}' where id = $1`, [MSG]);
    const act = (await db.query(`select public.rule_activate($1,$2,$3) as r`, [T, OWNER, r.rule_id])).rows[0].r;
    expect(act.status).toBe("source_edited");
  });

  it("a span outside the message, or empty, is refused", async () => {
    expect((await propose("chat_message", MSG, 0, BODY.length + 5)).status).toBe("bad_span");
    expect((await propose("chat_message", MSG, 5, 5)).status).toBe("bad_span");
  });

  it("another tenant cannot point at this tenant's message", async () => {
    const r = (await db.query(`select public.rule_propose($1,'chat_message',$2,$3,$4,'all',null) as r`, [T2, MSG, START, END])).rows[0].r;
    expect(r.status).toBe("not_allowed");
  });

  it("paused suggestions write nothing", async () => {
    await db.query(`insert into public.tenant_rule_settings(tenant_id, suggestions_paused) values ($1, true)`, [T]);
    expect((await propose("chat_message", MSG)).status).toBe("paused");
  });

  it("a card-number span is refused, not stored", async () => {
    const body = "From now on bill card 4242 4242 4242 4242 first";
    await resetSource({ body });
    const r = await propose("chat_message", MSG, 0, body.length);
    expect(r.status).toBe("refused");
    expect((await db.query(`select count(*)::int n from public.tenant_rules`)).rows[0].n).toBe(0);
  });

  it("slack: only when the Slack author resolves to a tenant member", async () => {
    const slackRun = "dddddddd-0000-4000-8000-000000000002";
    await db.query(`insert into public.agent_runs values ($1,$2,'operator','slack',$3,null)`,
      [slackRun, T, JSON.stringify({ slack: { text: BODY, user: "U_OWNER", team_id: "T_ACME" } })]);
    expect((await propose("slack_run", slackRun)).status).toBe("suggested");
    const stranger = "dddddddd-0000-4000-8000-000000000003";
    await db.query(`insert into public.agent_runs values ($1,$2,'operator','slack',$3,null)`,
      [stranger, T, JSON.stringify({ slack: { text: BODY, user: "U_GUEST", team_id: "T_ACME" } })]);
    expect((await propose("slack_run", stranger)).status).toBe("not_allowed");
  });

  it("slack: the founder's Slack id with no team_id, or another workspace's team_id, is not_allowed", async () => {
    const noTeam = "dddddddd-0000-4000-8000-000000000004";
    const otherTeam = "dddddddd-0000-4000-8000-000000000005";
    await db.query(`insert into public.agent_runs values ($1,$2,'operator','slack',$3,null), ($4,$2,'operator','slack',$5,null)`,
      [noTeam, T, JSON.stringify({ slack: { text: BODY, user: "U_OWNER" } }),
       otherTeam, JSON.stringify({ slack: { text: BODY, user: "U_OWNER", team_id: "T_ELSE" } })]);
    expect((await propose("slack_run", noTeam)).status).toBe("not_allowed");
    expect((await propose("slack_run", otherTeam)).status).toBe("not_allowed");
  });

  it("email: a verified member's inbound reply only", async () => {
    const e1 = "ffffffff-0000-4000-8000-000000000001";
    const e2 = "ffffffff-0000-4000-8000-000000000002";
    await db.query(`insert into public.email_messages values ($1,$2,'in',true,'Founder <founder@acme.com>',$3), ($4,$2,'in',false,'x@evil.com',$3)`,
      [e1, T, BODY, e2]);
    const ok = await propose("email_message", e1);
    expect(ok.status).toBe("suggested");
    expect(ok.origin).toBe("cgo_email_reply");
    expect((await propose("email_message", e2)).status).toBe("not_allowed");
  });

  it("reject reason: only from an owner/admin", async () => {
    await db.query(`insert into public.channel_action_events values (1,$1,'rejected','founder',$2,$3), (2,$1,'rejected','founder',$4,$3)`,
      [T, OWNER, BODY, MEMBER]);
    expect((await propose("channel_reject", "1")).status).toBe("suggested");
    expect((await propose("channel_reject", "2")).status).toBe("not_allowed");
  });
});

describe.skipIf(!url)("rule_propose excerpt privacy", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  beforeAll(async () => {
    const { Client } = await import("pg");
    db = new Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it("stores a bounded, redacted excerpt: no SSN or card number from elsewhere in the message", async () => {
    await db.query("truncate public.tenant_rules, public.agent_thread_messages, public.agent_runs, public.agent_threads");
    const body = "Never post on weekends. My SSN is 123 45 6789 and card 4242424242424242. " + "x".repeat(900);
    await db.query(`insert into public.agent_threads values ($1,$2,$3)`, [THREAD, T, OWNER]);
    await db.query(`insert into public.agent_runs values ($1,$2,'operator','chat','{}',$3)`, [RUN, T, OWNER]);
    await db.query(`insert into public.agent_thread_messages values ($1,$2,$3,'user',$4,$5,'{}','chat','text')`, [MSG, THREAD, T, body, RUN]);
    const r = (await db.query(`select public.rule_propose($1,'chat_message',$2,0,22,'all',null) as r`, [T, MSG])).rows[0].r;
    expect(r.status).toBe("suggested");
    const ex = (await db.query(`select excerpt from public.tenant_rules`)).rows[0].excerpt as string;
    expect(ex).not.toMatch(/123 45 6789|4242424242424242/);
    expect(ex).toContain("[number removed]");
    expect(ex.length).toBeLessThanOrEqual(22 + 240 + 20);
  });

  it("a plain nine-digit SSN in the rule itself is refused", async () => {
    await db.query("truncate public.tenant_rules");
    await expect(db.query(`select public._rules_clean_text('File my SSN 123456789 first')`)).rejects.toThrow(/card or ID number/);
  });
});
