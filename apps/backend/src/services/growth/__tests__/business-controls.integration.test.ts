import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { BUSINESS_CONTROL_DEFAULTS } from "../business-control-policy";
import { seedBudgetSchema } from "./budget-sql-fixture";
const modules = process.env.ADS_SQL_TEST_MODULES;
const t = "11111111-1111-1111-1111-111111111111",
  other = "22222222-2222-2222-2222-222222222222",
  u = "99999999-9999-9999-9999-999999999999";
let db: any;
const policy = {
  ...BUSINESS_CONTROL_DEFAULTS,
  enabled: true,
  automatic_stops: true,
};
describe("business controls on PostgreSQL", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(
      modules ? resolve(modules, "../package.json") : __filename,
    )("@electric-sql/pglite");
    db = new PGlite();
    await seedBudgetSchema(db);
    await db.exec(
      readFileSync(
        resolve(
          "../../supabase/migrations/20261009074317_growth_business_controls.sql",
        ),
        "utf8",
      ),
    );
  }, 30000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec("truncate tenants cascade");
    await db.query("insert into tenants values ($1),($2)", [t, other]);
    await db.query("insert into tenant_users values ($1,$2,'owner')", [t, u]);
    await db.query(
      "insert into ad_budgets(tenant_id,monthly_usd,started_on,month_start,actual_read_at) values ($1,3000,current_date-40,date_trunc('month',now()),now())",
      [t],
    );
    await save(policy, 0);
    const rows = [
      {
        object_id: "c1",
        campaign_id: "c1",
        level: "campaign",
        name: "test",
        budget_kind: "daily",
        budget_usd: 10,
        status: "ACTIVE",
        currency: "USD",
      },
      {
        object_id: "s1",
        campaign_id: "c1",
        level: "ad_set",
        name: "child",
        budget_kind: "campaign_level",
        budget_usd: null,
        status: "ACTIVE",
        currency: "USD",
      },
      {
        object_id: "c2",
        campaign_id: "c2",
        level: "campaign",
        name: "second",
        budget_kind: "daily",
        budget_usd: 10,
        status: "ACTIVE",
        currency: "USD",
      },
    ];
    await db.query(
      "select record_ad_ledger_read($1,'meta','act_1',$2::jsonb,'[]'::jsonb)",
      [t, JSON.stringify(rows)],
    );
  });
  async function save(p: unknown, revision = 1, tenant = t) {
    return (
      await db.query(
        "select save_growth_business_policy($1,$2,$3::jsonb,$4) r",
        [tenant, u, JSON.stringify(p), revision],
      )
    ).rows[0].r;
  }
  const input = (over: Record<string, unknown> = {}) => ({
    name: "test",
    hypothesis: "test",
    platform: "meta",
    account_id: "act_1",
    object_id: "c1",
    level: "campaign",
    budget_usd: 200,
    baseline: { date: new Date().toISOString().slice(0, 10), amounts: {} },
    ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    policy_revision: 1,
    stop_on_loss: false,
    ...over,
  });
  async function register(
    over: Record<string, unknown> = {},
    tenant = t,
    actor: string | null = u,
  ) {
    return (
      await db.query("select register_growth_experiment($1,$2,$3::jsonb) r", [
        tenant,
        actor,
        JSON.stringify(input(over)),
      ])
    ).rows[0].r;
  }
  async function record(id: string, check: Record<string, unknown>) {
    await db.query("select record_growth_experiment_check($1,$2,$3::jsonb)", [
      t,
      id,
      JSON.stringify({
        spent_usd: 10,
        exposure_usd: 30,
        state: "monitoring",
        ...check,
      }),
    ]);
  }
  it("requires a workspace manager even through the privileged RPC", async () => {
    await expect(save(policy, 0, other)).rejects.toThrow();
    await db.query("update tenant_users set role='member' where tenant_id=$1", [
      t,
    ]);
    await expect(save(policy)).rejects.toThrow();
  });
  it("edits saved defaults with optimistic concurrency", async () => {
    expect(await save({ ...policy, max_cpa_usd: 35 })).toMatchObject({
      status: "saved",
      revision: 2,
    });
    expect(await save(policy)).toEqual({ status: "conflict" });
  });
  it.each([
    { max_cpa_usd: null },
    { enabled: null },
    { min_results: 1.2 },
    { exploration_percent: 101 },
    { unknown: 1 },
  ])("refuses malformed values in SQL %j", async (o) => {
    await expect(save({ ...policy, ...o })).rejects.toThrow();
  });
  it("serializes allocation across concurrent experiment requests", async () => {
    const results = await Promise.allSettled([
      register(),
      register({ object_id: "c2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("keeps stopped tests allocated for the rest of their start month", async () => {
    const e = await register();
    await record(e.id, { state: "stopped", stop: true });
    await expect(register({ object_id: "c2" })).rejects.toThrow(/exploration/);
  });
  it("refuses overlapping parent/child experiments", async () => {
    await register({ budget_usd: 100 });
    await db.query(
      "update ad_campaigns set budget_kind='daily',budget_usd=10 where tenant_id=$1 and object_id='s1'",
      [t],
    );
    await expect(
      register({ object_id: "s1", level: "ad_set", budget_usd: 100 }),
    ).rejects.toThrow(/already belongs/);
  });
  it("rejects revoked consent and stale policy revisions", async () => {
    await save({ ...policy, automatic_stops: false });
    await expect(register()).rejects.toThrow(/permission/);
    await save(policy, 2);
    expect(await register()).toEqual({ status: "conflict" });
  });
  it("refuses an agent with no source test or a foreign decision", async () => {
    await expect(register({}, t, null)).rejects.toThrow(/source decision/);
    await expect(
      register({ decision_id: "aaaaaaaa-0000-0000-0000-000000000001" }),
    ).rejects.toThrow(/workspace CGO/);
  });
  it("does not release allocation on failed pauses or reduce recorded spend", async () => {
    const e = await register();
    await record(e.id, { state: "stop_failed", stop: true, spent_usd: 50 });
    await record(e.id, { state: "monitoring", spent_usd: 10 });
    const r = (
      await db.query(
        "select state,spent_usd,stopped_at,stop_requested_at from growth_experiment_controls where id=$1",
        [e.id],
      )
    ).rows[0];
    expect(r.state).toBe("stop_failed");
    expect(Number(r.spent_usd)).toBe(50);
    expect(r.stopped_at).toBeNull();
    expect(r.stop_requested_at).toBeTruthy();
  });
  it("does not update a different tenant's experiment", async () => {
    const e = await register();
    await db.query("select record_growth_experiment_check($1,$2,$3::jsonb)", [
      other,
      e.id,
      JSON.stringify({ state: "stopped", spent_usd: 200, exposure_usd: 200 }),
    ]);
    expect(
      (
        await db.query(
          "select state from growth_experiment_controls where id=$1",
          [e.id],
        )
      ).rows[0].state,
    ).toBe("monitoring");
  });
  it("cannot allocate one source test's budget twice, and registration retries are idempotent", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    await db.query(
      "insert into decisions(id,tenant_id,decision_class,body) values($1,$2,'cgo.dispatch-specialist',$3::jsonb)",
      [
        id,
        t,
        JSON.stringify({
          target_agent_slug: "meta_ads",
          test: {
            budget_usd: 100,
            readout_on: new Date(Date.now() + 8 * 86400000)
              .toISOString()
              .slice(0, 10),
          },
        }),
      ],
    );
    const first = await register({ decision_id: id, budget_usd: 70 }, t, null);
    expect(
      await register({ decision_id: id, budget_usd: 70 }, t, null),
    ).toEqual(first);
    await expect(
      register({ decision_id: id, budget_usd: 70, object_id: "c2" }, t, null),
    ).rejects.toThrow(/source budget/);
  });
  it("merges per-day high-water values atomically without losing new spend to a refund", async () => {
    const e = await register();
    await record(e.id, { spent_usd: 20, spend_highwater: { "s:day1": 20 } });
    await record(e.id, {
      spent_usd: 15,
      spend_highwater: { "s:day1": 5, "s:day2": 10 },
    });
    expect(
      Number(
        (
          await db.query(
            "select spent_usd from growth_experiment_controls where id=$1",
            [e.id],
          )
        ).rows[0].spent_usd,
      ),
    ).toBe(30);
  });
  it("ignores an outdated monitor result instead of overwriting a newer stop", async () => {
    const e = await register();
    await record(e.id, { state: "stopped", stop: true });
    await record(e.id, {
      state: "monitoring",
      expected_checked_at: null,
      spent_usd: 99,
    });
    const row = (
      await db.query(
        "select state,spent_usd from growth_experiment_controls where id=$1",
        [e.id],
      )
    ).rows[0];
    expect(row.state).toBe("stopped");
    expect(Number(row.spent_usd)).toBe(10);
  });
});
