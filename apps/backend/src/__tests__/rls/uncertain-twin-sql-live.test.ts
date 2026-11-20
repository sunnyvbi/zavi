import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contradictingCards, type OpenCardRow } from "@/services/growth/open-advice";

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

function latestFunction(name: string): string {
  const hit = files().filter((f) => read(f).includes(`create or replace function ${name}(`)).pop();
  if (!hit) throw new Error(`${name} defined in no migration`);
  const sql = read(hit);
  const s = sql.indexOf(`create or replace function ${name}(`);
  const a = sql.indexOf("$$", s);
  const b = sql.indexOf("$$", a + 2);
  return sql.slice(s, sql.indexOf(";", b) + 1).replace(/search_path = public, pg_temp/, `search_path = ${SCHEMA}, pg_temp`);
}

const SCHEMA = `zz_twin_${Math.random().toString(36).slice(2, 10)}`;
const T = "00000000-0000-4000-8000-000000000001";
const R0 = "00000000-0000-4000-8000-0000000000a0";
const R1 = "00000000-0000-4000-8000-0000000000a1";
const CLASS = "meta_ads.duplicate_ad_set";
const PAYLOAD = { ad_set_id: "120000000000002", name: "Spring (copy)", daily_budget_usd: 40 };

describe.skipIf(!PG_URL)("an uncertain failed twin stays open (live SQL)", () => {
  const db = new Client({ connectionString: PG_URL });

  beforeAll(async () => {
    await db.connect();
    await db.query("begin");
    await db.query(`create schema ${SCHEMA}`);
    await db.query(`set local search_path = ${SCHEMA}, public`);
    for (const r of ["anon", "authenticated", "service_role"]) {
      await db.query(`do $$ begin create role ${r}; exception when others then null; end $$;`);
    }
    for (const t of ["agent_runs", "channel_actions", "channel_action_events", "channel_metrics"]) {
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
    await db.query(latestFunction("record_channel_exec_action"));
    await db.query(latestFunction("displace_channel_actions"));
    for (const r of [R0, R1]) {
      await db.query(
        `insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, channel_slug, status)
         values ($1, $2, 'meta_ads', 'h', 'cron', 'meta_ads', 'success')`,
        [r, T],
      );
    }
  });
  afterAll(async () => {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  });

  async function oldTwin(exec_result: unknown): Promise<string> {
    await db.query("delete from channel_action_events; delete from channel_actions;");
    const r = await db.query(
      `insert into channel_actions (tenant_id, channel_slug, run_id, position, run_of, action_type, title, title_key, body,
                                    status, exec_class, exec_payload, exec_status, exec_result)
       values ($1, 'meta_ads', $2, 1, 1, 'create_ad', 'Copy Spring', 'copy spring', '{}'::jsonb, 'pending', $3, $4, 'failed', $5)
       returning id`,
      [T, R0, CLASS, PAYLOAD, exec_result],
    );
    return r.rows[0].id as string;
  }
  const refile = async () =>
    (await db.query(`select record_channel_exec_action($1, $2, $3) r`, [T, R1, { exec_class: CLASS, title: "Copy Spring", action_type: "create_ad", exec_payload: PAYLOAD, body: {} }])).rows[0].r as {
      ok: boolean;
      id: string;
      kept?: boolean;
    };
  const pending = async (): Promise<OpenCardRow[]> =>
    (await db.query(`select id, run_id, channel_slug, title, exec_class, exec_payload, exec_status, exec_result, body from channel_actions where status = 'pending'`)).rows;
  const approvalSees = async (ownId: string) =>
    contradictingCards(await pending(), { object: { ids: [PAYLOAD.ad_set_id], name: "Spring" }, exclude: { action_id: ownId, run_id: R1 }, exec: { exec_class: CLASS, exec_payload: PAYLOAD } });

  for (const [label, exec_result] of [
    ["temporary (a write timeout)", { bucket: "temporary" }],
    ["unclassified", null],
    ["partial risk", { bucket: "partial_risk" }],
  ] as const) {
    it(`${label}: the re-file keeps the old twin open and files nothing; approval of the retry sees the conflict`, async () => {
      const old = await oldTwin(exec_result);
      const res = await refile();
      expect(res).toMatchObject({ ok: true, id: old, kept: true });
      expect((await db.query("select status from channel_actions where id = $1", [old])).rows[0].status).toBe("pending");
      expect((await pending()).map((r) => r.id)).toEqual([old]);
      expect((await approvalSees("some-new-card")).map((c) => c.id)).toEqual([old]);
    });
  }

  for (const bucket of ["blocked_on_us", "needs_founder"]) {
    it(`a definite failure (${bucket}) still retires: the retry is filed and approval is clear`, async () => {
      const old = await oldTwin({ bucket });
      const res = await refile();
      expect(res.ok).toBe(true);
      expect(res.kept).toBeFalsy();
      expect((await db.query("select status from channel_actions where id = $1", [old])).rows[0].status).toBe("stale");
      expect(await approvalSees(res.id)).toEqual([]);
    });
  }

  it("a ChatGPT launch Zavi archived (chatgpt_ads_launch_undone) retires: the founder's retry is filed", async () => {
    const old = await oldTwin({ code: "chatgpt_ads_launch_undone", bucket: "blocked_on_us", error: "so it was archived" });
    const res = await refile();
    expect(res.kept).toBeFalsy();
    expect(res.id).not.toBe(old);
    expect((await db.query("select status from channel_actions where id = $1", [old])).rows[0].status).toBe("stale");
  });

  it("the backfill closes an archived ChatGPT launch and leaves one Zavi could not archive open", async () => {
    const sql = read("20261108200000_chatgpt_launch_undone_code.sql");
    const backfill = sql.slice(sql.indexOf("do $$"), sql.lastIndexOf("commit;"));
    await db.query("delete from channel_action_events; delete from channel_actions;");
    const ins = async (error: string, position: number) =>
      (await db.query(
        `insert into channel_actions (tenant_id, channel_slug, run_id, position, run_of, action_type, title, title_key, body,
                                      status, exec_class, exec_payload, exec_status, exec_result)
         values ($1, 'chatgpt_ads', $2, $5, 3, 'create_ad', $3, $3, '{}'::jsonb, 'pending', 'chatgpt_ads.create_and_launch', '{}'::jsonb, 'failed', $4)
         returning id`,
        [T, R0, error.slice(0, 40), { code: "exec_partial", bucket: "partial_risk", error }, position],
      )).rows[0].id as string;
    const archived = await ins("Zavi created ChatGPT campaign cmpn_1 but could not launch it, so it was archived and its budget hold released. Nothing is running.", 1);
    const stuck = await ins("Zavi created ChatGPT campaign cmpn_2 but could not launch it, and could not archive it either, so it may be partly on.", 2);
    const touched = await ins("Zavi created ChatGPT campaign cmpn_3 but could not launch it, so it was archived. It is not running.", 3);
    await db.query(`update channel_actions set steps_done = '["1"]'::jsonb where id = $1`, [touched]);
    await db.query(backfill);
    await db.query(backfill);
    const row = async (id: string) => (await db.query("select status, exec_result from channel_actions where id = $1", [id])).rows[0];
    expect(await row(archived)).toMatchObject({ status: "stale", exec_result: { code: "chatgpt_ads_launch_undone", bucket: "blocked_on_us" } });
    expect(await row(stuck)).toMatchObject({ status: "pending", exec_result: { code: "exec_partial", bucket: "partial_risk" } });
    expect(await row(touched)).toMatchObject({ status: "pending", exec_result: { code: "exec_partial" } });
    expect((await db.query("select count(*)::int n from channel_action_events where action_id = $1 and event = 'stale_flagged'", [archived])).rows[0].n).toBe(1);
  });

  it("a direct ask refuses beside an open partial create (uncertain_open) and closes nothing", async () => {
    await db.query(latestFunction("supersede_channel_actions_by_direct_ask"));
    const sup = async (newId: string) => (await db.query(`select supersede_channel_actions_by_direct_ask($1, $2) r`, [T, newId])).rows[0].r as { ok: boolean; code?: string; holder?: string };
    const card = async (position: number, over: { exec_status?: string | null; exec_result?: unknown; title?: string }) =>
      (await db.query(
        `insert into channel_actions (tenant_id, channel_slug, run_id, position, run_of, action_type, title, title_key, body,
                                      status, exec_class, exec_payload, exec_status, exec_result)
         values ($1, 'chatgpt_ads', $2, $3, 3, 'create_ad', $4, $4, '{}'::jsonb, 'pending', 'chatgpt_ads.create_and_launch', '{}'::jsonb, $5, $6)
         returning id`,
        [T, R1, position, over.title ?? `card ${position}`, over.exec_status ?? null, over.exec_result ?? null],
      )).rows[0].id as string;
    await db.query("delete from channel_action_events; delete from channel_actions;");
    const partial = await card(1, { exec_status: "failed", exec_result: { code: "exec_partial", bucket: "partial_risk" } });
    const plain = await card(2, {});
    const ask = await card(3, { title: "a differently worded ask" });
    expect(await sup(ask)).toMatchObject({ ok: false, code: "uncertain_open", holder: partial });
    for (const id of [partial, plain]) expect((await db.query("select status from channel_actions where id = $1", [id])).rows[0].status).toBe("pending");
    await db.query(`update channel_actions set exec_result = '{"code":"chatgpt_ads_launch_undone","bucket":"blocked_on_us"}'::jsonb where id = $1`, [partial]);
    expect(await sup(ask)).toMatchObject({ ok: true });
    for (const id of [partial, plain]) expect((await db.query("select status from channel_actions where id = $1", [id])).rows[0].status).toBe("stale");
  });

  it("settling a launch Zavi archived closes the card with the archived note, never 'refused'", async () => {
    await db.query(`create table ops_alert_outbox (dedupe_key text, created_at timestamptz default now())`);
    await db.query(`create function enqueue_ops_alert(p_dedupe_key text, p_source text, p_code text, p_tenant_id uuid, p_msg text) returns boolean
                    language sql as $f$ insert into ops_alert_outbox (dedupe_key) values (p_dedupe_key) returning true $f$`);
    await db.query(latestFunction("exec_blocked_note"));
    await db.query(latestFunction("classify_exec_failure"));
    await db.query(latestFunction("apply_exec_failure_verdict"));
    const undone = await oldTwin({ code: "chatgpt_ads_launch_undone", error: "Zavi created ChatGPT campaign cmpn_1 but could not launch it, so it was archived" });
    await db.query(`select apply_exec_failure_verdict($1, $2, $3, '{}'::jsonb)`, [T, undone, R0]);
    const r = (await db.query("select status, note from channel_actions where id = $1", [undone])).rows[0];
    expect(r.status).toBe("stale");
    expect(r.note).toContain("Zavi archived this campaign");
    expect(r.note).not.toContain("refused");
    const ev = (await db.query("select note from channel_action_events where action_id = $1 and event = 'stale_flagged'", [undone])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].note).toContain("Zavi archived this campaign");
    const other = await oldTwin({ code: "meta_ads_bid_unavailable", error: "no bid" });
    await db.query(`select apply_exec_failure_verdict($1, $2, $3, '{}'::jsonb)`, [T, other, R0]);
    expect((await db.query("select note from channel_actions where id = $1", [other])).rows[0].note).toContain("refused");
  });

  it("displacement skips an uncertain failed card and still displaces a definite one", async () => {
    const uncertain = await oldTwin({ bucket: "temporary" });
    const r1 = await db.query(`select displace_channel_actions($1, 'meta_ads', $2, array[$3::uuid], 'a better card') r`, [T, R1, uncertain]);
    expect((await db.query("select status from channel_actions where id = $1", [uncertain])).rows[0].status).toBe("pending");
    const definite = await oldTwin({ bucket: "blocked_on_us" });
    await db.query(`select displace_channel_actions($1, 'meta_ads', $2, array[$3::uuid], 'a better card') r`, [T, R1, definite]);
    expect((await db.query("select status from channel_actions where id = $1", [definite])).rows[0].status).toBe("displaced");
    expect(r1.rows[0].r).toBeDefined();
  });
});
