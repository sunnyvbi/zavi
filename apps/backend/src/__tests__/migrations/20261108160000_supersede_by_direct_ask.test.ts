import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SQL = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261108160000_supersede_by_direct_ask.sql"), "utf8");
const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table channel_actions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    channel_slug text not null, run_id uuid, exec_class text, title text not null default 't',
    target_key text, repeat_of uuid,
    status text not null default 'pending', status_at timestamptz, note text,
    exec_status text, exec_result jsonb, proposed_at timestamptz not null default now());
  create table channel_action_events (id bigint generated always as identity primary key, tenant_id uuid not null,
    action_id uuid not null, event text not null, actor_kind text not null, run_id uuid, note text,
    event_key text not null, unique (action_id, event_key));
`;

describe.skipIf(!PG_URL)("supersede by direct ask, live", () => {
  let admin: Client;
  let db: Client;
  const dbName = `zavi_sup_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const A = randomUUID();
  const B = randomUUID();
  const one = async <R = Record<string, unknown>>(q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0] as R;
  const card = async (o: { tenant?: string; channel?: string; cls?: string | null; status?: string; exec_status?: string | null; exec_result?: unknown; title?: string; target?: string | null; repeat_of?: string | null } = {}) =>
    (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, channel_slug, exec_class, status, exec_status, exec_result, title, target_key, repeat_of) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
      [o.tenant ?? A, o.channel ?? "chatgpt_ads", o.cls === undefined ? "chatgpt_ads.create_and_launch" : o.cls, o.status ?? "pending", o.exec_status ?? null, o.exec_result ? JSON.stringify(o.exec_result) : null, o.title ?? "card", o.target === undefined ? "campaign:dup" : o.target, o.repeat_of ?? null],
    )).id;
  const row = async (id: string) => one<{ status: string; note: string | null }>("select status, note from channel_actions where id = $1", [id]);
  const supersede = async (tenant: string, id: string) => (await one<{ r: Record<string, unknown> }>("select supersede_channel_actions_by_direct_ask($1, $2) r", [tenant, id])).r;

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(PG_URL!);
    url.pathname = `/${dbName}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    await db.query(BOOTSTRAP);
    await db.query(SQL);
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    }
  });

  it("closes every open create card on the channel, whatever its name, lists them, and one event each; leaves the rest", async () => {
    const pending = await card({ title: "Upcar - Renters 1-Day" });
    const named = await card({ title: "Spring sale", target: "campaign:spring sale" });
    const snoozed = await card({ status: "snoozed", title: "Snoozed one" });
    const retryable = await card({ exec_status: "failed", exec_result: { code: "provider_error", bucket: "blocked_on_us" }, title: "Retry me" });
    const partial = await card({ exec_status: "failed", exec_result: { code: "exec_partial" } });
    const acted = await card({ status: "acted", exec_status: "executed" });
    const otherChannel = await card({ channel: "meta_ads", cls: "meta_ads.launch_campaign" });
    const otherClass = await card({ cls: "chatgpt_ads.update_budget" });
    const otherTenant = await card({ tenant: B });
    const fresh = await card({ title: "Founder ask: $25 ChatGPT ad" });

    const r = await supersede(A, fresh);
    expect(r.ok).toBe(true);
    const closed = [pending, named, snoozed, retryable];
    expect(new Set(r.superseded as string[])).toEqual(new Set(closed));
    expect(new Set((r.closed as Array<{ id: string; title: string }>).map((c) => `${c.id}|${c.title}`))).toEqual(
      new Set([`${pending}|Upcar - Renters 1-Day`, `${named}|Spring sale`, `${snoozed}|Snoozed one`, `${retryable}|Retry me`]),
    );
    for (const id of closed) {
      expect(await row(id)).toEqual({ status: "stale", note: "Replaced by your direct ask: Founder ask: $25 ChatGPT ad" });
    }
    for (const id of [partial, otherChannel, otherClass, otherTenant, fresh]) {
      expect((await row(id)).status).not.toBe("stale");
    }
    expect((await row(acted)).status).toBe("acted");
    const events = await db.query("select action_id from channel_action_events where event = 'stale_flagged' and event_key = $1", [`direct_ask:${fresh}`]);
    expect(events.rows).toHaveLength(4);
    expect((await supersede(A, fresh)).superseded).toEqual([]);
  });

  it.each([
    ["queued", "pending"],
    ["dispatching", "pending"],
    ["executed", "pending"],
  ])("any same-channel create already approved and launching (%s) refuses: nothing is closed", async (exec_status, status) => {
    const channel = `ch_${exec_status}`;
    const flying = await card({ exec_status, status, channel, target: "campaign:a" });
    const open = await card({ channel, target: "campaign:b" });
    const fresh = await card({ channel, target: "campaign:c" });
    const r = await supersede(A, fresh);
    expect(r).toEqual({ ok: false, code: "duplicate_in_flight", holder: flying });
    expect((await row(open)).status).toBe("pending");
  });
  it("a create that already ran and settled (acted) does not block", async () => {
    await card({ exec_status: "executed", status: "acted", channel: "ch_settled" });
    const fresh = await card({ channel: "ch_settled" });
    expect((await supersede(A, fresh)).ok).toBe(true);
  });
  it("locks the candidate rows: an approval holding a card's row lock makes the call wait, then see it queued", async () => {
    const channel = "ch_race";
    const old = await card({ channel });
    const fresh = await card({ channel });
    const url = new URL(PG_URL!);
    url.pathname = `/${dbName}`;
    const other = new Client({ connectionString: url.toString() });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("select 1 from channel_actions where id = $1 for update", [old]);
      const pendingCall = supersede(A, fresh);
      await new Promise((r) => setTimeout(r, 300));
      await other.query("update channel_actions set exec_status = 'queued' where id = $1", [old]);
      await other.query("commit");
      expect(await pendingCall).toEqual({ ok: false, code: "duplicate_in_flight", holder: old });
      expect((await row(old)).status).toBe("pending");
    } finally {
      await other.end();
    }
  });

  it("is tenant-checked: another tenant's id finds nothing; the RPC is service-role only", async () => {
    const fresh = await card();
    expect(await supersede(B, fresh)).toEqual({ ok: false, code: "not_found" });
    const grants = await db.query("select grantee from information_schema.routine_privileges where routine_name = 'supersede_channel_actions_by_direct_ask'");
    const who = grants.rows.map((g: { grantee: string }) => g.grantee);
    expect(who).toContain("service_role");
    expect(who).not.toContain("anon");
    expect(who).not.toContain("authenticated");
  });
});

describe("20261108200000 redefinition of supersede_channel_actions_by_direct_ask", () => {
  const LATER = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261108200000_chatgpt_launch_undone_code.sql"), "utf8");
  const strip = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").replace(/\s+/g, " ").trim();
  const fn = (s: string) => {
    const i = s.indexOf("create or replace function supersede_channel_actions_by_direct_ask(");
    return s.slice(i, s.indexOf("$$;", s.indexOf("$$", i) + 2) + 3);
  };
  it("is the prior definition plus the uncertain_open refusal and nothing else", () => {
    const later = strip(fn(LATER));
    const block = later.slice(later.indexOf("select id into v_id from channel_actions where tenant_id = p_tenant_id and channel_slug = v_new.channel_slug and id <> p_new_id and regexp_replace(coalesce(exec_class, ''), '_review$', '') = any(v_classes) and status in ('pending', 'snoozed') and exec_status = 'failed'"), later.indexOf("'uncertain_open', 'holder', v_id); end if;") + "'uncertain_open', 'holder', v_id); end if;".length);
    expect(block).toContain("exec_outcome_unknown");
    expect(later.replace(` ${block}`, "")).toBe(strip(fn(SQL)));
    expect(LATER).toContain("revoke all on function supersede_channel_actions_by_direct_ask(uuid, uuid) from public, anon, authenticated;");
  });
});
