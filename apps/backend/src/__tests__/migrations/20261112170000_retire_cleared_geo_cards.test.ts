import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261112170000_retire_cleared_geo_cards.sql";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, channel_slug text not null,
    status text not null default 'pending', status_at timestamptz, note text, snoozed_until timestamptz,
    proposed_at timestamptz not null default '2026-10-12T00:00:00Z',
    exec_class text, exec_status text, approved_by uuid, edited_body jsonb,
    steps_done jsonb not null default '[]'::jsonb
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null, action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null, actor_kind text not null, run_id uuid, note text,
    event_key text not null, at timestamptz not null default now(),
    unique (action_id, event_key)
  );
`;

const modules = process.env.SITES_SQL_TEST_MODULES;
const READ_AT = "2026-10-23T07:58:42Z";

describe(`${FILE} executed in Postgres (pglite)`, () => {
  let db: Db;
  const T = randomUUID();

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(readFileSync(join(MIGRATIONS, FILE), "utf-8"));
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });

  const card = async (cols: Record<string, unknown> = {}) => {
    const c = { tenant_id: T, channel_slug: "geo", ...cols };
    const keys = Object.keys(c);
    const { rows } = await db.query<{ id: string }>(
      `insert into channel_actions (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(c).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)),
    );
    return rows[0].id;
  };
  const retire = async (ids: string[], tenant = T) =>
    (
      await db.query<{ r: { stale: string[] } }>("select retire_cleared_geo_cards($1, $2::uuid[], $3) r", [tenant, ids, READ_AT])
    ).rows[0].r.stale;
  const statusOf = async (id: string) =>
    (await db.query<{ status: string; note: string | null }>("select status, note from channel_actions where id = $1", [id])).rows[0];

  it("closes an untouched open GEO card filed before the read, with a note and one event", async () => {
    const id = await card();
    expect(await retire([id])).toEqual([id]);
    const s = await statusOf(id);
    expect(s.status).toBe("stale");
    expect(s.note).toContain("no longer finds this problem");
    expect(await retire([id])).toEqual([]);
    const ev = await db.query("select event from channel_action_events where action_id = $1", [id]);
    expect(ev.rows).toEqual([{ event: "stale_flagged" }]);
  });

  it("leaves anything a person touched, anything executable, and anything filed after the read", async () => {
    const kept = [
      await card({ edited_body: { text: "mine" } }),
      await card({ steps_done: [0] }),
      await card({ approved_by: randomUUID() }),
      await card({ exec_class: "geo.create_pr.v1" }),
      await card({ exec_status: "queued" }),
      await card({ status: "snoozed", snoozed_until: "2026-12-01T00:00:00Z" }),
      await card({ proposed_at: "2026-10-24T00:00:00Z" }),
      await card({ channel_slug: "seo" }),
    ];
    expect(await retire(kept)).toEqual([]);
    for (const id of kept) expect((await statusOf(id)).status).not.toBe("stale");
  });

  it("never closes another tenant's card", async () => {
    const other = await card({ tenant_id: randomUUID() });
    expect(await retire([other])).toEqual([]);
    expect((await statusOf(other)).status).toBe("pending");
  });
});
