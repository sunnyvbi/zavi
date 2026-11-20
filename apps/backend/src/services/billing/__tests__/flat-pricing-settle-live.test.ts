import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.ZAVI_TEST_PG_URL;
const T = "f1a70000-0000-4000-8000-0000000000f1";
let db: Client;

async function q<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
  return (await db.query(sql, params)).rows as R[];
}

async function startRun(billed: number | null): Promise<string> {
  const [r] = await q<{ id: string }>(
    "insert into agent_runs (tenant_id, agent_slug, agent_definition_hash, trigger) values ($1, 'operator', 'h', 'manual') returning id",
    [T],
  );
  if (billed !== null) await q("update agent_runs set billed_credits = $2 where id = $1", [r.id, billed]);
  return r.id;
}

async function finishRun(id: string, status: string, costUsd: number): Promise<void> {
  await q("update agent_runs set status = 'running' where id = $1", [id]);
  await q("update agent_runs set status = $2, cost_usd = $3, finished_at = now() where id = $1", [id, status, costUsd]);
}

async function settled(id: string): Promise<number | null> {
  const rows = await q<{ amount: number }>("select amount from tenant_credit_ledger where run_id = $1 and kind = 'settle'", [id]);
  return rows.length ? Number(rows[0].amount) : null;
}

async function reserved(): Promise<number> {
  await q("select _credit_balance_touch($1)", [T]);
  return Number((await q<{ r: number }>("select reserved as r from tenant_credit_balances where tenant_id = $1", [T]))[0].r);
}

describe.skipIf(!url)("flat job pricing settles on real Postgres", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    await q("begin");
    await q("update system_config set blob = blob || $1::jsonb where id = 1", [
      JSON.stringify({ credits_enforced: true, credits_enforced_allowlist: [], tier_gate_enforced: false }),
    ]);
    await q("update system_config set blob = blob - 'flat_job_pricing' where id = 1");
    await q("insert into tenants (id, slug, display_name) values ($1, 'flat-price-test', 'flat price test')", [T]);
    await q("select _credit_balance_touch($1)", [T]);
    await q("update tenant_credit_balances set purchased_balance = 100000 where tenant_id = $1", [T]);
  });
  afterEach(async () => {
    await q("rollback");
  });

  it("a priced successful run settles its flat price, not real cost", async () => {
    const run = await startRun(450);
    await finishRun(run, "success", 2.43);
    expect(await settled(run)).toBe(450);
    expect(await reserved()).toBe(0);
    expect(Number((await q<{ b: number }>("select billed_credits as b from agent_runs where id = $1", [run]))[0].b)).toBe(450);
  });

  it("flat_job_pricing = false settles real cost", async () => {
    await q("update system_config set blob = blob || '{\"flat_job_pricing\": false}'::jsonb where id = 1");
    const run = await startRun(450);
    await finishRun(run, "success", 2.43);
    expect(await settled(run)).toBe(972);
    expect((await q<{ b: number | null }>("select billed_credits as b from agent_runs where id = $1", [run]))[0].b).toBeNull();
  });

  it("a priced run that errors is refunded (failed work stays free)", async () => {
    const run = await startRun(450);
    await finishRun(run, "error", 2.43);
    expect(await settled(run)).toBeNull();
    expect(await reserved()).toBe(0);
  });

  it("a priced run that cost nothing stays free", async () => {
    const run = await startRun(450);
    await finishRun(run, "success", 0);
    expect(await settled(run)).toBeNull();
  });

  it("a run with no price settles real cost (as before)", async () => {
    const run = await startRun(null);
    await finishRun(run, "success", 2.43);
    expect(await settled(run)).toBe(972);
  });
});
