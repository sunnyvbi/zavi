import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const FILE = "20261124110000_close_stranded_queued_card.sql";

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
  create table tenant_users (tenant_id uuid, user_id uuid, primary key (tenant_id, user_id));
  create table channel_actions (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null, channel_slug text not null default 'meta_ads',
    status text not null default 'pending', status_at timestamptz, note text, snoozed_until timestamptz,
    exec_class text default 'meta_ads.update_ad_set_budget', exec_status text, exec_payload jsonb, approved_by uuid,
    approved_by_source text, run_id uuid, exec_claim_id uuid, exec_claimed_at timestamptz, exec_result jsonb
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null, action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null, actor_kind text not null, actor_user_id uuid, run_id uuid, note text,
    snoozed_until timestamptz, event_key text not null, at timestamptz not null default now(),
    unique (action_id, event_key)
  );
`;

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const modules = process.env.SITES_SQL_TEST_MODULES;

describe(`${FILE} executed in Postgres (pglite)`, () => {
  let db: Db;
  const T = randomUUID();
  const U = randomUUID();
  const OTHER = randomUUID();

  const card = async (o: { exec_status?: string; claimed?: boolean; approvedAgo?: string | null; tenant?: string; status?: string; result?: unknown } = {}) => {
    const id = randomUUID();
    const tenant = o.tenant ?? T;
    await db.query(
      `insert into channel_actions (id, tenant_id, status, exec_status, approved_by, exec_claim_id, exec_claimed_at, exec_result)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenant, o.status ?? "pending", o.exec_status ?? "queued", U, o.claimed ? randomUUID() : null, o.claimed ? new Date().toISOString() : null, o.result ? JSON.stringify(o.result) : null],
    );
    if (o.approvedAgo !== null) {
      await db.query(
        `insert into channel_action_events (tenant_id, action_id, event, actor_kind, actor_user_id, event_key, at)
         values ($1, $2, 'approved', 'founder', $3, $4, now() - $5::interval)`,
        [tenant, id, U, randomUUID(), o.approvedAgo ?? "2 hours"],
      );
    }
    return id;
  };
  const close = async (id: string, o: { tenant?: string; actor?: string | null; source?: string | null; status?: string } = {}) =>
    (
      await db.query<{ r: Record<string, unknown> }>(
        "select set_channel_action($1, $2, $3, null, null, $4, $5, $6) r",
        [o.tenant ?? T, id, o.status ?? "rejected", randomUUID(), o.actor === undefined ? U : o.actor, o.source ?? null],
      )
    ).rows[0].r;
  const row = async (id: string) =>
    (await db.query<{ status: string; exec_status: string | null; note: string | null }>("select status, exec_status, note from channel_actions where id = $1", [id])).rows[0];

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(fn("20260919060402_channel_action_exec.sql", "claim_channel_action_exec"));
    await db.exec(read(FILE));
    await db.query("insert into tenant_users values ($1, $2), ($3, $2)", [T, U, OTHER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("closes a card approved over 30 minutes ago that no worker ever claimed, and logs the close", async () => {
    const id = await card();
    expect(await close(id)).toMatchObject({ ok: true, status: "rejected", stranded: true });
    expect(await row(id)).toEqual({ status: "rejected", exec_status: null, note: "Closed. Zavi never started this change, so nothing was sent." });
    const ev = (await db.query<{ event: string; actor_kind: string }>("select event, actor_kind from channel_action_events where action_id = $1 and event = 'rejected'", [id])).rows;
    expect(ev).toEqual([{ event: "rejected", actor_kind: "founder" }]);
  });

  it("a worker that arrives after the close claims nothing, so the change can never run", async () => {
    const id = await card();
    await close(id);
    const claim = (await db.query<{ r: Record<string, unknown> }>("select claim_channel_action_exec($1) r", [id])).rows[0].r;
    expect(claim).toMatchObject({ ok: false, code: "not_queued", exec_status: null });
  });

  it("refuses while the approval is under 30 minutes old", async () => {
    const id = await card({ approvedAgo: "10 minutes" });
    expect(await close(id)).toMatchObject({ ok: false, code: "exec_in_flight", exec_status: "queued" });
    expect((await row(id)).exec_status).toBe("queued");
  });

  it("refuses a card a worker has claimed, or one that is dispatching", async () => {
    expect(await close(await card({ claimed: true }))).toMatchObject({ ok: false, code: "exec_in_flight" });
    expect(await close(await card({ exec_status: "dispatching", claimed: true }))).toMatchObject({ ok: false, code: "exec_in_flight", exec_status: "dispatching" });
  });

  it("uses the LATEST approval: an old approval re-approved a minute ago stays refused", async () => {
    const id = await card({ approvedAgo: "3 hours" });
    await db.query(
      "insert into channel_action_events (tenant_id, action_id, event, actor_kind, event_key, at) values ($1, $2, 'approved', 'founder', $3, now() - interval '1 minute')",
      [T, id, randomUUID()],
    );
    expect(await close(id)).toMatchObject({ ok: false, code: "exec_in_flight" });
  });

  it("refuses with no recorded approval, a site PR held in Approvals, cgo as the closer, no actor, or any status but rejected", async () => {
    expect(await close(await card({ approvedAgo: null }))).toMatchObject({ ok: false, code: "exec_in_flight" });
    expect(await close(await card({ result: { site_pr_waiting: "approvals" } }))).toMatchObject({ ok: false, code: "exec_in_flight" });
    expect(await close(await card(), { actor: null, source: "cgo" })).toMatchObject({ ok: false, code: "exec_in_flight" });
    expect(await close(await card(), { actor: null })).toMatchObject({ ok: false, code: "exec_in_flight" });
    expect(await close(await card(), { status: "acted" })).toMatchObject({ ok: false, code: "exec_in_flight" });
  });

  it("never closes another tenant's card", async () => {
    const id = await card({ tenant: OTHER });
    expect(await close(id)).toMatchObject({ ok: false, code: "not_found" });
    expect((await row(id)).exec_status).toBe("queued");
  });

  it("a closed stranded card cannot be reopened (it carried an approval)", async () => {
    const id = await card();
    await close(id);
    expect(await close(id, { status: "open" })).toMatchObject({ ok: false, code: "not_reopenable" });
  });
});
