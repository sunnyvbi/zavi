import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PG_URL = process.env.ZAVI_TEST_PG_URL;
const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const files = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const noComments = (s: string) => s.replace(/--[^\n]*/g, "");
const noFks = (s: string) =>
  s
    .replace(/references\s+[a-z_.]+\s*(\([^)]*\))?(\s+on delete (cascade|set null|restrict))?/gi, "")
    .replace(/,\s*(constraint\s+\w+\s+)?foreign key\s*\([^)]*\)[^,)]*/gi, "");

function tableDdl(table: string): string[] {
  let create: string | null = null;
  const alters: string[] = [];
  for (const f of files()) {
    const s = noComments(read(f));
    const m = create === null ? new RegExp(`create table (if not exists )?(public\\.)?${table}\\s*\\(`).exec(s) : null;
    if (m) {
      let depth = 0;
      let j = m.index + m[0].length - 1;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      create = s.slice(m.index, j + 1);
    }
    for (const a of s.matchAll(new RegExp(`alter table (if exists )?(public\\.)?${table}\\b([\\s\\S]*?);`, "g"))) {
      if (/add column|add constraint|drop constraint|alter column/.test(a[3]) && !/%I|foreign key/i.test(a[3])) {
        alters.push(`alter table ${table} ${a[3].trim()};`);
      }
    }
  }
  if (!create) throw new Error(`${table}: no create table in migrations`);
  return [noFks(create), ...alters.map(noFks)].map((s) => s.replace(/\bpublic\./g, ""));
}

const SCHEMA = `zz_budget_${Math.random().toString(36).slice(2, 10)}`;

function latestFunction(name: string): string {
  const hit = files().filter((f) => read(f).includes(`create or replace function ${name}(`)).pop();
  if (!hit) throw new Error(`${name} defined in no migration`);
  const sql = read(hit);
  const s = sql.indexOf(`create or replace function ${name}(`);
  const a = sql.indexOf("$$", s);
  const b = sql.indexOf("$$", a + 2);
  return sql.slice(s, sql.indexOf(";", b) + 1).replace(/search_path = public, pg_temp/, `search_path = ${SCHEMA}, pg_temp`);
}

const T = "00000000-0000-4000-8000-000000000001";
const OTHER_T = "00000000-0000-4000-8000-000000000002";
const R0 = "00000000-0000-4000-8000-0000000000a0";
const GCLASS = "google_ads.update_campaign_budget_review";
const CAMPAIGN = "24109304360";

describe.skipIf(!PG_URL)("retire_stale_budget_proposals (live SQL)", () => {
  const db = new Client({ connectionString: PG_URL });

  beforeAll(async () => {
    await db.connect();
    await db.query("begin");
    await db.query(`create schema ${SCHEMA}`);
    await db.query(`set local search_path = ${SCHEMA}, public`);
    for (const r of ["anon", "authenticated", "service_role"]) {
      await db.query(`do $$ begin create role ${r}; exception when others then null; end $$;`);
    }
    for (const t of ["agent_runs", "channel_actions", "channel_action_events"]) {
      for (const stmt of tableDdl(t)) {
        await db.query("savepoint ddl");
        try {
          await db.query(stmt);
        } catch (e) {
          if (!["42P07", "42710"].includes((e as { code?: string }).code ?? "")) throw e;
          await db.query("rollback to savepoint ddl");
        }
      }
    }
    await db.query(`create table decisions (
      id uuid primary key default gen_random_uuid(), tenant_id uuid not null, agent_run_id uuid,
      decision_class text not null, body jsonb not null default '{}', status text not null default 'proposed',
      emitted_at timestamptz not null default now(), approved_at timestamptz, dispatched_at timestamptz,
      superseded_at timestamptz, superseded_by uuid)`);
    await db.query(latestFunction("budget_change_key"));
    await db.query(latestFunction("retire_stale_budget_proposals"));
    await db.query(
      `insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, channel_slug, status)
       values ($1, $2, 'google_ads', 'h', 'cron', 'google_ads', 'success')`,
      [R0, T],
    );
  });
  afterAll(async () => {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  });
  beforeEach(async () => {
    await db.query("delete from channel_action_events; delete from channel_actions; delete from decisions;");
  });

  let pos = 0;
  async function card(o: { tenant?: string; cls?: string; payload: Record<string, unknown>; status?: string; exec_status?: string | null; approved?: boolean; proposedAgo?: string; executedAgo?: string }): Promise<string> {
    pos += 1;
    const r = await db.query(
      `insert into channel_actions (tenant_id, channel_slug, run_id, position, run_of, action_type, title, title_key, body,
                                    status, exec_class, exec_payload, exec_status, approved_by, proposed_at, executed_at)
       values ($1, 'google_ads', $2, $3, 99, 'update_ad', 'Budget', 'budget', '{}'::jsonb, $4, $5, $6, $7,
               case when $8 then gen_random_uuid() end, now() - $9::interval, case when $10::text is null then null else now() - $10::interval end)
       returning id`,
      [o.tenant ?? T, R0, pos, o.status ?? "pending", o.cls ?? GCLASS, o.payload, o.exec_status ?? null, o.approved ?? false, o.proposedAgo ?? "2 days", o.executedAgo ?? null],
    );
    return r.rows[0].id as string;
  }
  async function decision(o: { cls?: string; body: Record<string, unknown>; status?: string; emittedAgo?: string; dispatchedAgo?: string | null }): Promise<string> {
    const r = await db.query(
      `insert into decisions (tenant_id, decision_class, body, status, emitted_at, dispatched_at)
       values ($1, $2, $3, $4, now() - $5::interval, case when $6::text is null then null else now() - $6::interval end) returning id`,
      [T, o.cls ?? GCLASS, o.body, o.status ?? "proposed", o.emittedAgo ?? "2 days", o.dispatchedAgo ?? null],
    );
    return r.rows[0].id as string;
  }
  const retire = async (kind: string, id: string) =>
    (await db.query(`select retire_stale_budget_proposals($1, $2, $3) r`, [T, kind, id])).rows[0].r as { ok: boolean; code?: string; stale: string[]; superseded: string[] };
  const statusOf = async (table: string, id: string) => (await db.query(`select status from ${table} where id = $1`, [id])).rows[0].status as string;
  const budget = (amount: number, expected?: number) => ({ campaign_id: CAMPAIGN, daily_budget_usd: amount, ...(expected !== undefined ? { expected_current_daily_budget_usd: expected } : {}) });

  it("closes the out-of-date card and decision on the same campaign, and nothing else", async () => {
    const done = await card({ payload: budget(120, 110), status: "acted", exec_status: "executed", proposedAgo: "1 day", executedAgo: "1 hour" });
    const staleCard = await card({ payload: budget(132, 110) });
    const staleDecision = await decision({ cls: "google_ads.update_campaign_budget", body: budget(132, 110) });
    const alreadyRight = await card({ payload: budget(130, 120) });
    const noExpected = await card({ payload: budget(140) });
    const otherCampaign = await card({ payload: { ...budget(50, 40), campaign_id: "999" } });
    const approved = await card({ payload: budget(132, 110), approved: true });
    const snoozed = await card({ payload: budget(132, 110), status: "snoozed" });
    const filedAfter = await card({ payload: budget(150, 125), proposedAgo: "10 minutes" });
    const otherTenant = await card({ tenant: OTHER_T, payload: budget(132, 110) });
    const otherFamily = await card({ cls: "google_ads.set_status_review", payload: { campaign_id: CAMPAIGN, expected_current_daily_budget_usd: 110, daily_budget_usd: 1 } });

    const out = await retire("channel_action", done);
    expect(out.ok).toBe(true);
    expect(out.stale).toEqual([staleCard]);
    expect(out.superseded).toEqual([staleDecision]);
    expect(await statusOf("channel_actions", staleCard)).toBe("stale");
    expect(await statusOf("decisions", staleDecision)).toBe("superseded");
    for (const id of [done, alreadyRight, noExpected, otherCampaign, approved, snoozed, filedAfter, otherTenant, otherFamily]) {
      expect(["pending", "snoozed", "acted"]).toContain(await statusOf("channel_actions", id));
    }
    const ev = await db.query(`select event, actor_kind, event_key from channel_action_events where action_id = $1`, [staleCard]);
    expect(ev.rows).toEqual([{ event: "stale_flagged", actor_kind: "system", event_key: `budget_moved:channel_action:${done}` }]);
    expect((await retire("channel_action", done)).stale).toEqual([]);
    expect((await db.query(`select count(*)::int n from channel_action_events`)).rows[0].n).toBe(1);
  });

  it("does nothing for a change that did not land or is not a budget change", async () => {
    const queued = await card({ payload: budget(120, 110), exec_status: "queued" });
    const open = await card({ payload: budget(132, 110) });
    expect((await retire("channel_action", queued)).code).toBe("not_executed");
    const create = await card({ cls: "google_ads.create_campaign", payload: { name: "x", daily_budget_usd: 5 }, status: "acted", exec_status: "executed", executedAgo: "1 hour" });
    expect(await retire("channel_action", create)).toMatchObject({ ok: true, skipped: "not_a_budget_change" });
    expect(await statusOf("channel_actions", open)).toBe("pending");
  });

  it("works from the decisions rail and across the review / plain variants", async () => {
    const acted = await decision({ cls: "google_ads.update_campaign_budget", body: budget(120, 110), status: "acted", dispatchedAgo: "1 hour" });
    const staleCard = await card({ payload: budget(132, 110) });
    const out = await retire("decision", acted);
    expect(out.stale).toEqual([staleCard]);
  });

  it("matches each platform's own budget subject", async () => {
    const meta = await card({ cls: "meta_ads.update_ad_set_budget_review", payload: { ad_set_id: "A1", daily_budget_usd: 60, expected_current_daily_budget_usd: 50 }, status: "acted", exec_status: "executed", executedAgo: "1 hour" });
    const metaStale = await card({ cls: "meta_ads.update_ad_set_budget", payload: { ad_set_id: "A1", daily_budget_usd: 70, expected_current_daily_budget_usd: 50 } });
    const metaCampaign = await card({ cls: "meta_ads.update_campaign_budget", payload: { campaign_id: "A1", daily_budget_usd: 70, expected_current_daily_budget_usd: 50 } });
    expect((await retire("channel_action", meta)).stale).toEqual([metaStale]);
    expect(await statusOf("channel_actions", metaCampaign)).toBe("pending");

    const tt = await card({ cls: "tiktok_ads.update_budget", payload: { advertiser_id: "adv", level: "campaign", object_id: "c9", daily_budget_usd: 30, expected_current_daily_budget_usd: 20 }, status: "acted", exec_status: "executed", executedAgo: "1 hour" });
    const ttStale = await card({ cls: "tiktok_ads.update_budget", payload: { advertiser_id: "adv", level: "campaign", object_id: "c9", daily_budget_usd: 25, expected_current_daily_budget_usd: 20 } });
    const ttAdGroup = await card({ cls: "tiktok_ads.update_budget", payload: { advertiser_id: "adv", level: "ad_group", object_id: "c9", daily_budget_usd: 25, expected_current_daily_budget_usd: 20 } });
    expect((await retire("channel_action", tt)).stale).toEqual([ttStale]);
    expect(await statusOf("channel_actions", ttAdGroup)).toBe("pending");

    const x = await card({ cls: "x_ads.update_campaign", payload: { account_id: "acc", campaign_id: "xc", changes: { daily_budget: 30 }, before: { daily_budget: 20 } }, status: "acted", exec_status: "executed", executedAgo: "1 hour" });
    const xStale = await card({ cls: "x_ads.update_campaign", payload: { account_id: "acc", campaign_id: "xc", changes: { daily_budget: 40 }, before: { daily_budget: 20 } } });
    const xName = await card({ cls: "x_ads.update_campaign", payload: { account_id: "acc", campaign_id: "xc", changes: { name: "n" }, before: {} } });
    expect((await retire("channel_action", x)).stale).toEqual([xStale]);
    expect(await statusOf("channel_actions", xName)).toBe("pending");
  });

  it("compares X budgets in micro-units, the others in cents", async () => {
    const x = await card({ cls: "x_ads.update_campaign", payload: { account_id: "acc", campaign_id: "xm", changes: { daily_budget: 10 }, before: { daily_budget: 10.004 } }, status: "acted", exec_status: "executed", executedAgo: "1 hour" });
    const xStale = await card({ cls: "x_ads.update_campaign", payload: { account_id: "acc", campaign_id: "xm", changes: { daily_budget: 12 }, before: { daily_budget: 10.004 } } });
    expect((await retire("channel_action", x)).stale).toEqual([xStale]);
    const g = await card({ payload: budget(120, 110), status: "acted", exec_status: "executed", executedAgo: "1 hour" });
    const sameCents = await card({ payload: budget(130, 120.004) });
    expect((await retire("channel_action", g)).stale).toEqual([]);
    expect(await statusOf("channel_actions", sameCents)).toBe("pending");
  });

  it("the migration has no backfill: only a change that just landed knows the live amount", () => {
    const sql = read(files().find((f) => f.includes("retire_stale_budget_proposals"))!);
    expect(noComments(sql)).not.toMatch(/\bdo \$\$/);
  });

  it("budget_change_key refuses a partial subject or a non-number amount", async () => {
    const key = async (cls: string, p: unknown) => (await db.query(`select budget_change_key($1, $2) k`, [cls, p])).rows[0].k;
    expect(await key(GCLASS, { daily_budget_usd: 5 })).toBeNull();
    expect(await key(GCLASS, { campaign_id: "1", daily_budget_usd: "lots" })).toBeNull();
    expect(await key("reddit_ads.update_budget", { ad_account_id: "a", daily_budget_usd: 5 })).toBeNull();
    expect(await key(GCLASS, { campaign_id: "1", daily_budget_usd: "12.5", expected_current_daily_budget_usd: 10 })).toEqual({
      family: "google_ads.update_campaign_budget", subject: { campaign_id: "1" }, amount: 12.5, expected: 10,
    });
  });
});
