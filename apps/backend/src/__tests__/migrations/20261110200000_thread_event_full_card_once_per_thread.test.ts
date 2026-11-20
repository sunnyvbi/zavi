import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const OLD = "20261110170000_thread_event_founder_card_once.sql";
const NEW = "20261110200000_thread_event_full_card_once_per_thread.sql";
const DROP = "20261110200100_drop_thread_event_founder_card_once.sql";
const T = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
let db: Pg | null = null;

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)(`${NEW} + ${DROP} in Postgres`, () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec("create table thread_event (id bigserial primary key, tenant_id uuid, agent_run_id uuid, agent_slug text, thread_id uuid, kind text, body jsonb, created_at timestamptz default now());");
    await db!.exec(read(OLD));
    await db!.exec(read(NEW) + "\n" + read(DROP));
    await db!.exec(read(NEW) + "\n" + read(DROP));
  }, 60_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db!.exec("delete from thread_event;");
  });
  const card = (thread: string, decision_id: string, full_card = true) =>
    db!.query("insert into thread_event (tenant_id, thread_id, kind, body) values ($1, $2, 'decision', $3::jsonb)", [T, thread, JSON.stringify({ decision_id, title: "x", ...(full_card ? { full_card: true } : {}) })]);

  it("must-catch: the same waiting card can be shown in a second chat", async () => {
    await card(A, "d-1");
    await card(B, "d-1");
    expect((await db!.query("select count(*)::int as n from thread_event")).rows[0].n).toBe(2);
  });

  it("must-not-touch: one chat never holds the same full card twice; plain cards are not touched", async () => {
    await card(A, "d-1");
    await expect(card(A, "d-1")).rejects.toThrow(/duplicate key/);
    await card(A, "d-2", false);
    await card(A, "d-2", false);
    expect((await db!.query("select indexname from pg_indexes where tablename = 'thread_event' order by 1")).rows.map((r) => r.indexname)).toEqual(["thread_event_full_card_once_per_thread", "thread_event_pkey"]);
  });
});
