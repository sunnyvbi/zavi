import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const NEW_FILE = "20261110220000_founder_order_authority.sql";
const PRIOR: Record<string, string> = {
  emit_decision: "20261110160000_founder_order_emit_clamp_card_once.sql",
  decide_decision_as_cgo: "20260928200000_cgo_approval_source.sql",
  record_channel_exec_action: "20261020160000_uncertain_failed_twin_stays_open.sql",
};
const fnBody = (src: string, name: string): string => {
  const start = src.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("end $$;", start) + "end $$;".length);
};
const withoutAdded = (fn: string): string =>
  fn
    .replace(/ {2}-- \[founder-authority:begin\]\n[\s\S]*?-- \[founder-authority:end\]\n\n/g, "")
    .split("\n")
    .filter((l) => !l.includes("-- [founder-authority]"))
    .join("\n");

describe(`${NEW_FILE}: supersets`, () => {
  for (const [name, prior] of Object.entries(PRIOR)) {
    it(`${name} is its prior definition exactly, plus the founder-authority lines`, () => {
      const fn = fnBody(read(NEW_FILE), name);
      expect(fn).toContain("[founder-authority]");
      const priorFn = fnBody(read(prior), name);
      const restored = withoutAdded(fn)
        .replace("   where id = p_decision_id and status = 'proposed'\n", "   where id = p_decision_id and status = 'proposed';\n")
        .replace(/ {2}if v_status = 'proposed' and not coalesce\(v_founder, false\) then {2}-- \[founder-authority:edited\][^\n]*\n/, "  if v_status = 'proposed' then\n");
      expect(restored).toBe(priorFn);
    });

    it(`${name}: this is its latest definition`, () => {
      const later = readdirSync(DIR)
        .filter((f) => f.endsWith(".sql") && f > NEW_FILE)
        .filter((f) => new RegExp(`create or replace function (public\\.)?${name}\\(`).test(read(f)));
      expect(later).toEqual([]);
    });
  }
});

const T = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
let db: Pg | null = null;

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)(`${NEW_FILE} in Postgres`, () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role;
      create type decision_autonomy as enum ('auto', 'approval', 'forbidden');
      create table decision_classes (slug text primary key, dispatch_handler text, single_open_per_target boolean default false, target_key_paths text[]);
      create table tenant_agent_kill_switch (tenant_id uuid, agent_slug text, override_state text);
      create table tenant_users (user_id uuid, tenant_id uuid, role text);
      create table agent_runs (id uuid primary key, tenant_id uuid, agent_slug text, cron_dedupe_key text, channel_slug text);
      create table decision_suppressions (tenant_id uuid, decision_class text, suppression_key text, decision_id uuid, hit_count int default 0, last_hit_at timestamptz);
      create table decisions (
        id uuid primary key default gen_random_uuid(), tenant_id uuid, agent_run_id uuid, decision_class text, body jsonb,
        status text, autonomy_at_emit decision_autonomy, handler text, dispatch_error text, emitted_at timestamptz default clock_timestamp(),
        superseded_at timestamptz, superseded_by uuid, approved_by uuid, approved_at timestamptz, approved_by_source text
      );
      create table channel_actions (
        id uuid primary key default gen_random_uuid(), tenant_id uuid, channel_slug text, run_id uuid, position int, run_of int,
        blocking boolean, action_type text, title text, title_key text, body jsonb, exec_class text, exec_payload jsonb,
        score numeric, score_inputs jsonb, scored_at timestamptz, card_kind text, primary_label text, done_label text,
        how_to jsonb, repeat_of uuid, target_key text, status text default 'pending', status_at timestamptz, note text,
        snoozed_until timestamptz, exec_status text, exec_result jsonb, edited_body jsonb, steps_done jsonb default '[]'::jsonb,
        proposed_at timestamptz default clock_timestamp()
      );
      create table channel_action_events (tenant_id uuid, action_id uuid, event text, actor_kind text, run_id uuid, note text, event_key text, unique (action_id, event_key));
      create function effective_autonomy(uuid, text) returns decision_autonomy language sql as $$ select 'approval'::decision_autonomy $$;
      create function decision_content_fingerprint(jsonb) returns text language sql as $$ select md5($1::text) $$;
      create function decision_suppression_key(jsonb, text[]) returns text language sql as $$ select md5($1::text) $$;
      create function decision_target_key(jsonb, text[]) returns text language sql as $$ select null::text $$;
      create function _is_custom_agent_run(uuid, text, uuid, text) returns boolean language sql as $$ select false $$;
      insert into decision_classes (slug, dispatch_handler) values
        ('google_ads.update_campaign_budget', 'google_ads.update_campaign_budget'),
        ('google_ads.update_campaign_budget_review', 'google_ads.update_campaign_budget_review'),
        ('meta_ads.update_ad_set_budget', 'meta_ads.update_ad_set_budget'),
        ('meta_ads.update_ad_set_budget_review', 'meta_ads.update_ad_set_budget_review'),
        ('meta_ads.update_campaign_budget', 'meta_ads.update_campaign_budget'),
        ('meta_ads.update_campaign_budget_review', 'meta_ads.update_campaign_budget_review'),
        ('google_ads.set_status', 'google_ads.set_status'),
        ('google_ads.set_status_review', 'google_ads.set_status_review');
    `);
    await db!.exec(`insert into tenant_users values ('${OWNER}', '${T}', 'owner'); insert into agent_runs (id, tenant_id, agent_slug, channel_slug) values ('${RUN}', '${T}', 'google_ads', 'google_ads');`);
    await db!.exec(read(NEW_FILE));
    await db!.exec(read(NEW_FILE));
  }, 60_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db!.exec("delete from decisions; delete from decision_suppressions; delete from channel_actions; delete from channel_action_events;");
  });

  const emit = async (cls: string, body: Record<string, unknown>): Promise<string> =>
    (await db!.query("select emit_decision($1, null, $2, $3::jsonb) as id", [T, cls, JSON.stringify(body)])).rows[0].id as string;
  const emitAgent = async (cls: string, body: Record<string, unknown>): Promise<string> =>
    (await db!.query("select emit_decision($1, $2, $3, $4::jsonb) as id", [T, RUN, cls, JSON.stringify(body)])).rows[0].id as string;
  const row = async (id: string) => (await db!.query("select status, decision_class, body from decisions where id = $1", [id])).rows[0] as { status: string; decision_class: string; body: Record<string, unknown> };
  const open = async () => ((await db!.query("select id from decisions where status = 'proposed' order by emitted_at")).rows as Array<{ id: string }>).map((r) => r.id);
  const FOUNDER = { origin: "user_initiated_chat", founder_chat_order: true };
  const cut = (extra: Record<string, unknown> = {}) => ({ campaign_id: "243", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, rationale: "x", ...extra });
  const GR = "google_ads.update_campaign_budget_review";
  const GA = "google_ads.update_campaign_budget";

  it("must-catch (the incident): the founder's re-order of an agent's open cut files ONE founder card and retires the agent's", async () => {
    const agent = await emit(GR, cut());
    const founder = await emit(GR, cut({ ...FOUNDER, rationale: "Founder approved in chat." }));
    expect(founder).not.toBe(agent);
    expect(await open()).toEqual([founder]);
    expect((await row(agent)).status).toBe("superseded");
    expect((await row(agent)).body.origin).toBeUndefined();
  });

  it("must-catch: an agent's identical re-propose adopts the founder's card; a different one is filed already superseded by it", async () => {
    const founder = await emit(GR, cut(FOUNDER));
    expect(await emitAgent(GR, cut())).toBe(founder);
    const other = await emitAgent(GA, cut({ daily_budget_usd: 15 }));
    expect(other).not.toBe(founder);
    expect(await row(other)).toMatchObject({ status: "superseded", body: { daily_budget_usd: 15 } });
    expect(await open()).toEqual([founder]);
  });

  it("must-catch (security review): a human emit (no agent run, e.g. the Ads Manager ledger) is never handed the founder's card", async () => {
    const founder = await emit(GR, cut(FOUNDER));
    const ledger = await emit(GR, cut({ daily_budget_usd: 12, origin: "user_initiated_ledger" }));
    expect(ledger).not.toBe(founder);
    expect(await row(ledger)).toMatchObject({ status: "proposed", body: { daily_budget_usd: 12 } });
    expect((await row(founder)).status).toBe("proposed");
  });

  it("must-catch (security review): an UNVERIFIED founder mark waits for a tap but never skips suppression or supersedes", async () => {
    const UNV = { ...FOUNDER, founder_order_unverified: true };
    const agent = await emit(GR, cut({ campaign_id: "301" }));
    const unv = await emit(GR, cut({ campaign_id: "301", daily_budget_usd: 12, ...UNV }));
    expect((await row(agent)).status).toBe("superseded");
    const verified = await emit(GR, cut({ campaign_id: "301", daily_budget_usd: 13, ...FOUNDER }));
    expect((await row(unv)).status).toBe("superseded");
    const unv2 = await emit(GR, cut({ campaign_id: "301", daily_budget_usd: 14, ...UNV }));
    expect((await row(verified)).status).toBe("proposed");
    expect((await row(unv2)).status).toBe("proposed");
    const supp = "66666666-6666-4666-8666-666666666666";
    const body = cut({ campaign_id: "302", ...UNV });
    await db!.query("insert into decision_suppressions (tenant_id, decision_class, suppression_key, decision_id) values ($1, $2, md5($3::jsonb::text), $4)", [T, GR, JSON.stringify(body), supp]);
    expect(await emit(GR, body)).toBe(supp);
  });

  it("the same change still open is returned as it is; numbers compare by value", async () => {
    const a = await emit(GR, cut());
    expect(await emit(GR, cut({ daily_budget_usd: 10.0, rationale: "worded differently" }))).toBe(a);
    expect(await open()).toEqual([a]);
  });

  it("a different amount, or the twin class, is one family: newest wins, one open card per campaign", async () => {
    const a = await emit(GR, cut());
    const b = await emit(GA, cut({ daily_budget_usd: 12 }));
    expect(await open()).toEqual([b]);
    expect((await row(a)).status).toBe("superseded");
    const other = await emit(GR, cut({ campaign_id: "999" }));
    expect((await open()).sort()).toEqual([b, other].sort());
  });

  it("a newer founder order replaces an older founder order", async () => {
    const f1 = await emit(GR, cut(FOUNDER));
    const f2 = await emit(GR, cut({ ...FOUNDER, daily_budget_usd: 12 }));
    expect(await open()).toEqual([f2]);
    expect((await row(f1)).status).toBe("superseded");
  });

  it("a founder order is not swallowed by the suppression ledger; an agent's still is", async () => {
    const supp = "44444444-4444-4444-8444-444444444444";
    for (const body of [cut(), cut(FOUNDER)]) {
      await db!.query("insert into decision_suppressions (tenant_id, decision_class, suppression_key, decision_id) values ($1, $2, md5($3::jsonb::text), $4)", [T, GR, JSON.stringify(body), supp]);
    }
    expect(await emit(GR, cut())).toBe(supp);
    const f = await emit(GR, cut(FOUNDER));
    expect(f).not.toBe(supp);
    expect((await row(f)).status).toBe("proposed");
  });

  it("Meta: an agent's re-propose gets the founder's open card back, and its newest-wins never retires it", async () => {
    const MB = "meta_ads.update_ad_set_budget_review";
    const founder = await emit(MB, { ad_set_id: "a1", daily_budget_usd: 50, expected_current_daily_budget_usd: 40, ...FOUNDER });
    expect(await emitAgent(MB, { ad_set_id: "a1", daily_budget_usd: 50, expected_current_daily_budget_usd: 40 })).toBe(founder);
    const diff = await emitAgent("meta_ads.update_ad_set_budget", { ad_set_id: "a1", daily_budget_usd: 45, expected_current_daily_budget_usd: 40 });
    expect((await row(diff)).status).toBe("superseded");
    expect(await open()).toEqual([founder]);
    const x = await emit(MB, { ad_set_id: "b1", daily_budget_usd: 50, expected_current_daily_budget_usd: 40 });
    const y = await emit(MB, { ad_set_id: "b1", daily_budget_usd: 55, expected_current_daily_budget_usd: 40 });
    expect((await row(x)).status).toBe("superseded");
    expect((await row(y)).status).toBe("proposed");
  });

  it("must-catch (fix-delta 4): a Meta campaign budget is identified by its id, not its display name", async () => {
    const MC = "meta_ads.update_campaign_budget_review";
    const founder = await emit(MC, { campaign_id: "cc1", name: "Spring", daily_budget_usd: 60, expected_current_daily_budget_usd: 50, ...FOUNDER });
    const agent = await emitAgent("meta_ads.update_campaign_budget", { campaign_id: "cc1", daily_budget_usd: 70, expected_current_daily_budget_usd: 50 });
    expect((await row(agent)).status).toBe("superseded");
    expect(await emitAgent(MC, { campaign_id: "cc1", name: "Other label", daily_budget_usd: 60, expected_current_daily_budget_usd: 50 })).toBe(founder);
    expect(await open()).toEqual([founder]);
  });

  it("must-catch: a founder's Meta order supersedes the agent's open card of the OTHER twin class on the same object", async () => {
    const auto = await emit("meta_ads.update_ad_set_budget", { ad_set_id: "c1", daily_budget_usd: 45, expected_current_daily_budget_usd: 40 });
    const founder = await emit("meta_ads.update_ad_set_budget_review", { ad_set_id: "c1", daily_budget_usd: 50, expected_current_daily_budget_usd: 40, ...FOUNDER });
    expect(await open()).toEqual([founder]);
    expect((await row(auto)).status).toBe("superseded");
  });

  it("a founder's Meta order is not swallowed by the suppression ledger; an agent's is", async () => {
    const supp = "55555555-5555-4555-8555-555555555555";
    const MB = "meta_ads.update_ad_set_budget_review";
    const agentBody = { ad_set_id: "s1", daily_budget_usd: 50, expected_current_daily_budget_usd: 40 };
    const founderBody = { ...agentBody, ...FOUNDER };
    for (const body of [agentBody, founderBody]) {
      await db!.query("insert into decision_suppressions (tenant_id, decision_class, suppression_key, decision_id) values ($1, $2, md5($3::jsonb::text), $4)", [T, MB, JSON.stringify(body), supp]);
    }
    expect(await emit(MB, agentBody)).toBe(supp);
    expect(await emit(MB, founderBody)).not.toBe(supp);
  });

  it("Google on/off: an agent's emit gets the founder's open card back; a founder's order supersedes the other twin's card", async () => {
    const agent = await emit("google_ads.set_status", { campaign_id: "77", level: "campaign", status: "PAUSED" });
    const founder = await emit("google_ads.set_status_review", { campaign_id: "77", level: "campaign", status: "ENABLED", ...FOUNDER });
    expect(await open()).toEqual([founder]);
    expect((await row(agent)).status).toBe("superseded");
    const paused = await emitAgent("google_ads.set_status", { campaign_id: "77", level: "campaign", status: "PAUSED", rationale: "again" });
    expect((await row(paused)).status).toBe("superseded");
    expect(await emitAgent("google_ads.set_status", { campaign_id: "77", ad_id: "999", level: "campaign", status: "ENABLED" })).toBe(founder);
    expect(await open()).toEqual([founder]);
    const other = await emitAgent("google_ads.set_status", { campaign_id: "78", level: "campaign", status: "PAUSED" });
    expect((await open()).sort()).toEqual([founder, other].sort());
  });

  it("decide_decision_as_cgo refuses a founder-origin row at the CAS; an agent's row is approved", async () => {
    const f = await emit(GR, cut(FOUNDER));
    const r = (await db!.query("select decide_decision_as_cgo($1, $2, $3, 'approve') as r", [f, T, OWNER])).rows[0].r as { changed: boolean; status: string };
    expect(r).toEqual({ changed: false, status: "proposed" });
    expect((await row(f)).status).toBe("proposed");
    const a = await emit(GR, cut({ campaign_id: "555" }));
    expect(((await db!.query("select decide_decision_as_cgo($1, $2, $3, 'approve') as r", [a, T, OWNER])).rows[0].r as { changed: boolean }).changed).toBe(true);
  });

  const file = async (payload: Record<string, unknown>) =>
    (await db!.query("select record_channel_exec_action($1, $2, $3::jsonb) as r", [
      T,
      RUN,
      JSON.stringify({ exec_class: "google_ads.update_campaign_budget", title: "Cut it", action_type: "update_ad", exec_payload: payload, body: {} }),
    ])).rows[0].r as { ok: boolean; id: string; kept?: boolean };

  it("channel rail: an agent's file gets the founder's untapped card back (kept), never retires it", async () => {
    const founder = await file({ campaign_id: "243", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, ...FOUNDER });
    const again = await file({ campaign_id: "243", daily_budget_usd: 15, expected_current_daily_budget_usd: 20 });
    expect(again).toMatchObject({ ok: true, id: founder.id, kept: true });
    expect(((await db!.query("select status from channel_actions where id = $1", [founder.id])).rows[0] as { status: string }).status).toBe("pending");
  });

  it("channel rail (security review): an UNVERIFIED founder file never retires the founder's card", async () => {
    const founder = await file({ campaign_id: "243", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, ...FOUNDER });
    const unv = await file({ campaign_id: "243", daily_budget_usd: 12, expected_current_daily_budget_usd: 20, ...FOUNDER, founder_order_unverified: true });
    expect(unv).toMatchObject({ id: founder.id, kept: true });
  });

  it("channel rail must-not-touch: an agent's untapped card is still replaced, and a newer founder file replaces it too", async () => {
    const a = await file({ campaign_id: "243", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 });
    const b = await file({ campaign_id: "243", daily_budget_usd: 15, expected_current_daily_budget_usd: 20 });
    expect(b.id).not.toBe(a.id);
    const f = await file({ campaign_id: "243", daily_budget_usd: 12, expected_current_daily_budget_usd: 20, ...FOUNDER });
    expect(f.kept).toBeUndefined();
    const st = (await db!.query("select id, status from channel_actions order by proposed_at")).rows as Array<{ id: string; status: string }>;
    expect(st.map((r) => r.status)).toEqual(["stale", "stale", "pending"]);
  });
});
