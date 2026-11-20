import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { NEW_CAMPAIGN_NOTES, classifyExecFailure, verdictFor } from "@/services/channels/exec-failure";
import { LINKEDIN_LAUNCH_NOT_REOPENED_CODE } from "@/services/ads-wallet/linkedin-growth";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const FILE = "20261121100300_linkedin_launch_not_reopened_closes_card.sql";

function fn(file: string, name: string): string {
  const sql = read(file);
  const start = sql.indexOf(`create or replace function ${name}(`);
  const body = sql.indexOf("$$", start);
  const end = sql.indexOf("$$;", body + 2) + 3;
  if (start < 0 || body < 0 || end < 3) throw new Error(`missing SQL function ${name} in ${file}`);
  return sql.slice(start, end);
}

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table channel_actions (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null, channel_slug text not null,
    run_id uuid not null, status text not null default 'pending', status_at timestamptz, note text,
    exec_class text, exec_status text, exec_result jsonb
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null, action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null, actor_kind text not null, actor_user_id uuid, run_id uuid, note text,
    event_key text not null, at timestamptz not null default now(),
    unique (action_id, event_key)
  );
  create table ops_alert_outbox (
    id bigint generated always as identity primary key,
    dedupe_key text not null unique, source text not null, code text not null, tenant_id uuid,
    msg text not null, created_at timestamptz not null default now()
  );
`;

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const modules = process.env.SITES_SQL_TEST_MODULES;
const LINKEDIN = "linkedin_ads.launch_campaign";

describe(`${FILE} executed in Postgres (pglite)`, () => {
  let db: Db;
  const T = randomUUID();

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(fn("20261009100000_channel_action_exec_bucket.sql", "enqueue_ops_alert"));
    await db.exec(fn("20261031190100_exec_blocked_note_sendgrid.sql", "exec_blocked_note"));
    await db.exec(read(FILE));
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });

  const classify = async (result: Record<string, unknown>) =>
    (await db.query<{ v: Record<string, unknown> | null }>("select classify_exec_failure($1::jsonb) v", [JSON.stringify(result)])).rows[0].v;
  const failedCard = async (result: Record<string, unknown>, exec_class = LINKEDIN, status = "pending") =>
    (await db.query<{ id: string }>(
      "insert into channel_actions (tenant_id, channel_slug, run_id, status, exec_class, exec_status, exec_result) values ($1, $2, $3, $4, $5, 'failed', $6::jsonb) returning id",
      [T, exec_class.split(".")[0], randomUUID(), status, exec_class, JSON.stringify(result)],
    )).rows[0].id;
  const apply = async (id: string) =>
    (await db.query<{ r: Record<string, unknown> }>("select apply_exec_failure_verdict($1, $2, null, '{}'::jsonb) r", [T, id])).rows[0].r;
  const card = async (id: string) =>
    (await db.query<{ status: string; note: string | null; exec_result: Record<string, unknown> }>(
      "select status, note, exec_result from channel_actions where id = $1", [id],
    )).rows[0];
  const events = async (id: string) =>
    (await db.query<{ event: string; note: string | null }>("select event, note from channel_action_events where action_id = $1", [id])).rows;
  const alerts = async (code: string) =>
    (await db.query<{ n: number }>("select count(*)::int n from ops_alert_outbox where dedupe_key like $1", [`blocked_code:${T}:${code}:%`])).rows[0].n;

  const NOT_REOPENED = {
    code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE,
    error: "LinkedIn did not accept this total budget or end date. Nothing changed in LinkedIn and nothing was held. Check both, then try again. Zavi could not reopen this launch request, so approving this card again would do nothing. Review the launch again to send a new one.",
  };

  it("classifies a launch Zavi could not reopen as blocked_on_us, the same verdict the backend gives", async () => {
    const v = await classify(NOT_REOPENED);
    expect(v).toEqual({ bucket: "blocked_on_us", fix: null, platform_code: NOT_REOPENED.code });
    expect(v).toEqual(classifyExecFailure({ ok: false, ...NOT_REOPENED }));
  });

  it("closes the open card with the backend's own note, one event and one alert, never the LinkedIn-refused note", async () => {
    const id = await failedCard(NOT_REOPENED);
    expect(await apply(id)).toEqual({ stamped: true, closed: true, bucket: "blocked_on_us" });
    const c = await card(id);
    expect(c.status).toBe("stale");
    expect(c.note).toBe(NEW_CAMPAIGN_NOTES[NOT_REOPENED.code]);
    expect(c.note).toBe(verdictFor({ ok: false, ...NOT_REOPENED }, LINKEDIN)!.note);
    expect(c.note).toMatch(/^Nothing was sent to LinkedIn/);
    expect(c.note).not.toMatch(/refused this change|may have reached|nothing for you to do/);
    expect(await events(id)).toEqual([{ event: "stale_flagged", note: c.note }]);
    expect(await alerts(NOT_REOPENED.code)).toBe(1);
  });

  it("the codes 20261119120000 added keep their verdicts and notes", async () => {
    for (const code of ["linkedin_ads_post_author_refused", "linkedin_ads_account_changed"]) {
      const id = await failedCard({ code, error: "x" }, "linkedin_ads.create_campaign_bundle");
      expect(await apply(id)).toEqual({ stamped: true, closed: true, bucket: "blocked_on_us" });
      expect((await card(id)).note).toBe(NEW_CAMPAIGN_NOTES[code]);
    }
    expect(await classify({ code: "exec_outcome_unknown", error: "x" })).toEqual({ bucket: "partial_risk", fix: null, platform_code: null });
  });

  it("the new definitions stay closed to the API roles", async () => {
    const grants = (
      await db.query<{ p: string; r: string }>(
        "select p.proname p, coalesce(array_to_string(p.proacl, ','), '') r from pg_proc p where p.proname in ('classify_exec_failure', 'apply_exec_failure_verdict')",
      )
    ).rows;
    expect(grants).toHaveLength(2);
    for (const g of grants) {
      expect(g.r, g.p).not.toMatch(/(^|,)(anon|authenticated)=/);
      expect(g.r, g.p).not.toMatch(/(^|,)=X/);
    }
    expect(grants.find((g) => g.p === "apply_exec_failure_verdict")!.r).not.toMatch(/service_role=/);
  });
});
