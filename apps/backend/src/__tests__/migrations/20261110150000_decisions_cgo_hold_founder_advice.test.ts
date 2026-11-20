import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const T1 = "11111111-1111-4111-8111-111111111111";
const ID = "dddddddd-0000-4000-8000-000000000001";
const HOLD = JSON.stringify({ reasons: ["objective_metric_mismatch"], words: ["it is not set up to get conversions"], evidence: "7-day spend $40, 0 conversions", at: "2026-10-17T00:00:00Z" });
const ADVICE = JSON.stringify({ warnings: ["it is not set up to get conversions"], at: "2026-10-17T00:00:00Z" });

let db: Pg | null = null;
const row = async () =>
  (await db!.query("select status, cgo_hold, founder_advice from decisions where id = $1", [ID])).rows[0] as {
    status: string;
    cgo_hold: unknown;
    founder_advice: unknown;
  };

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("20261110150000_decisions_cgo_hold_founder_advice.sql in Postgres", () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role;
      create table agent_runs (id uuid primary key, tenant_id uuid not null, channel_slug text, enqueued_by uuid, payload jsonb not null default '{}');
      create table decisions (
        id uuid primary key, tenant_id uuid not null, agent_run_id uuid, decision_class text not null,
        body jsonb not null default '{}', status text not null default 'proposed', autonomy_at_emit text not null default 'approval',
        snoozed_until timestamptz, emitted_at timestamptz not null default now()
      );
    `);
    await db!.exec(read("20261110140000_decisions_home.sql"));
    const sql = read("20261110150000_decisions_cgo_hold_founder_advice.sql");
    await db!.exec(sql);
    await db!.exec(sql);
  }, 60_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db!.exec("delete from decisions;");
    await db!.query(
      "insert into decisions (id, tenant_id, decision_class, body, cgo_hold, founder_advice) values ($1, $2, 'google_ads.update_campaign_budget_review', '{}'::jsonb, $3::jsonb, $4::jsonb)",
      [ID, T1, HOLD, ADVICE],
    );
  });

  for (const status of ["dispatching", "approved", "rejected", "superseded", "expired"]) {
    it(`a hold clears when the card moves to ${status}; the founder's warnings stay`, async () => {
      await db!.query("update decisions set status = $2 where id = $1", [ID, status]);
      const r = await row();
      expect(r.status).toBe(status);
      expect(r.cgo_hold).toBeNull();
      expect(r.founder_advice).toMatchObject({ warnings: ["it is not set up to get conversions"] });
    });
  }

  it("a hold stays while the card is still proposed (another column changes)", async () => {
    await db!.query("update decisions set body = '{\"x\":1}'::jsonb where id = $1", [ID]);
    expect((await row()).cgo_hold).toMatchObject({ words: ["it is not set up to get conversions"] });
  });

  it("the pending view carries cgo_hold and founder_advice, and still lists only waiting cards", async () => {
    const pending = await db!.query("select id, cgo_hold, founder_advice, home from customer_visible_pending_decisions");
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].cgo_hold).toMatchObject({ evidence: "7-day spend $40, 0 conversions" });
    await db!.query("update decisions set status = 'approved' where id = $1", [ID]);
    expect((await db!.query("select id from customer_visible_pending_decisions")).rows).toHaveLength(0);
  });
});
