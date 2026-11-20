import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const NEW_FILE = "20261110160000_founder_order_emit_clamp_card_once.sql";
const INDEX_FILE = "20261110170000_thread_event_founder_card_once.sql";
const PRIOR_FILE = "20260927230000_custom_agent_decisions_auto.sql";
const fnBody = (src: string): string => {
  const start = src.indexOf("create or replace function emit_decision(");
  return src.slice(start, src.indexOf("end $$;", start) + "end $$;".length);
};
const BLOCK_START = "  -- Founder-order cards (review G6";

describe(`${NEW_FILE}: emit_decision superset`, () => {
  it("is the prior emit_decision exactly, plus the founder-order block", () => {
    const fn = fnBody(read(NEW_FILE));
    const start = fn.indexOf(BLOCK_START);
    const end = fn.indexOf("  -- Registry read:", start);
    expect(start).toBeGreaterThan(-1);
    expect(fn.slice(0, start) + fn.slice(end)).toBe(fnBody(read(PRIOR_FILE)));
    expect(start).toBeGreaterThan(fn.indexOf("  -- Agent Builder S3b"));
  });

  it("is the latest definition of emit_decision", () => {
    const later = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f > NEW_FILE)
      .filter((f) => /create or replace function (public\.)?emit_decision\(/.test(read(f)));
    expect(later).toEqual(["20261110220000_founder_order_authority.sql"]);
  });
});

const T = "11111111-1111-4111-8111-111111111111";
let db: Pg | null = null;

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)(`${NEW_FILE} in Postgres`, () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role;
      create type decision_autonomy as enum ('auto', 'approval', 'forbidden');
      create table decision_classes (slug text primary key, dispatch_handler text, single_open_per_target boolean default false, target_key_paths text[]);
      create table tenant_agent_kill_switch (tenant_id uuid, agent_slug text, override_state text);
      create table agent_runs (id uuid primary key, tenant_id uuid, agent_slug text, cron_dedupe_key text);
      create table decision_suppressions (tenant_id uuid, decision_class text, suppression_key text, decision_id uuid, hit_count int default 0, last_hit_at timestamptz);
      create table decisions (
        id uuid primary key default gen_random_uuid(), tenant_id uuid, agent_run_id uuid, decision_class text, body jsonb,
        status text, autonomy_at_emit decision_autonomy, handler text, dispatch_error text, emitted_at timestamptz default now(),
        superseded_at timestamptz, superseded_by uuid
      );
      create table thread_event (id bigserial primary key, tenant_id uuid, agent_run_id uuid, agent_slug text, thread_id uuid, kind text, body jsonb, created_at timestamptz default now());
      -- The tenant set every class to run on its own (the override G6 must beat).
      create function effective_autonomy(uuid, text) returns decision_autonomy language sql as $$ select 'auto'::decision_autonomy $$;
      create function decision_content_fingerprint(jsonb) returns text language sql as $$ select md5($1::text) $$;
      create function decision_suppression_key(jsonb, text[]) returns text language sql as $$ select null::text $$;
      create function decision_target_key(jsonb, text[]) returns text language sql as $$ select null::text $$;
      create function _is_custom_agent_run(uuid, text, uuid, text) returns boolean language sql as $$ select false $$;
      insert into decision_classes (slug, dispatch_handler) values
        ('google_ads.update_campaign_budget_review', 'google_ads.update_campaign_budget_review'),
        ('meta_ads.update_ad_set_budget', 'meta_ads.update_ad_set_budget'),
        ('pm.ticket', null);
    `);
    const sql = read(NEW_FILE) + "\n" + read(INDEX_FILE);
    await db!.exec(sql);
    await db!.exec(sql);
  }, 60_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db!.exec("delete from decisions; delete from thread_event;");
  });

  const emit = async (cls: string, body: Record<string, unknown>) => {
    const id = (await db!.query("select emit_decision($1, null, $2, $3::jsonb) as id", [T, cls, JSON.stringify(body)])).rows[0].id as string;
    return (await db!.query("select autonomy_at_emit, status from decisions where id = $1", [id])).rows[0] as { autonomy_at_emit: string; status: string };
  };

  it("a founder-marked Meta/Google row waits for approval even when the tenant set the class to auto", async () => {
    expect(await emit("google_ads.update_campaign_budget_review", { campaign_id: "1", origin: "user_initiated_chat", founder_chat_order: true })).toEqual({ autonomy_at_emit: "approval", status: "proposed" });
    expect(await emit("meta_ads.update_ad_set_budget", { ad_set_id: "a", origin: "user_initiated_chat", founder_chat_order: true })).toMatchObject({ autonomy_at_emit: "approval" });
  });

  it("without the server mark (a member's chat or a verified email reply on the fast path) nothing changes", async () => {
    expect(await emit("meta_ads.update_ad_set_budget", { ad_set_id: "b", origin: "user_initiated_chat" })).toMatchObject({ autonomy_at_emit: "auto" });
    expect(await emit("meta_ads.update_ad_set_budget", { ad_set_id: "c", founder_chat_order: true })).toMatchObject({ autonomy_at_emit: "auto" });
    expect(await emit("pm.ticket", { origin: "user_initiated_chat", founder_chat_order: true, n: 1 })).toMatchObject({ autonomy_at_emit: "auto" });
  });

  const card = (decision_id: string, full_card: boolean) =>
    db!.query("insert into thread_event (tenant_id, kind, body) values ($1, 'decision', $2::jsonb)", [T, JSON.stringify({ decision_id, title: "x", ...(full_card ? { full_card: true } : {}) })]);

  it("a second founder card for the same decision is refused; other cards are not touched", async () => {
    await card("d-1", true);
    await expect(card("d-1", true)).rejects.toThrow(/duplicate key/);
    await card("d-2", true);
    await card("d-3", false);
    await card("d-3", false);
    expect((await db!.query("select count(*)::int as n from thread_event")).rows[0].n).toBe(4);
  });
});
