import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREDIT_USD, costToCredits } from "@/services/agents/credits";
import { resultTerminalStatus, type CompletionAssessment } from "@/services/agents/run-completion";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, any>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const MODULES = process.env.SITES_SQL_TEST_MODULES;
const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");
const MIGRATION = "20261119110300_write_it_miss_settles_usage.sql";
const TENANT = "11111111-1111-4111-8111-111111111111";
const FLAT = 460;

function triggerFn(): string {
  const src = read("20261007100000_ask_agent_paused_awaiting_child.sql");
  const start = src.indexOf("create or replace function _trg_finalize_run_credits()");
  const end = src.indexOf("end $$;", start) + "end $$;".length;
  return src.slice(start, end);
}

let db: Db;
let n = 0;

async function startRun(opts: { billed: number | null; held?: number }): Promise<string> {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const held = opts.held ?? FLAT;
  await db.query(`insert into agent_runs (id, tenant_id, status, billed_credits) values ($1, $2, 'running', $3)`, [id, TENANT, opts.billed]);
  await db.query(`insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, period_start, attempt) values ($1, $2, 'reserve', $3, current_date, 1)`, [TENANT, id, held]);
  await db.query(`update tenant_credit_balances set reserved = reserved + $2 where tenant_id = $1`, [TENANT, held]);
  return id;
}

async function finish(id: string, cost: number, status = "success", settleAtUsage: boolean | null = null): Promise<void> {
  await db.query(`update agent_runs set status = $2, cost_usd = $3, settle_at_usage = $4 where id = $1`, [id, status, cost, settleAtUsage]);
}

async function ledger(id: string): Promise<{ kind: string; amount: number; debited: number | null }[]> {
  const { rows } = await db.query<{ kind: string; amount: number; debited: number | null }>(
    `select kind, amount, debited from tenant_credit_ledger where run_id = $1 and kind in ('settle','refund')`,
    [id],
  );
  return rows;
}

async function balance(): Promise<{ reserved: number; used: number; purchased: number }> {
  const { rows } = await db.query<{ reserved: number; used: number; purchased: number }>(
    `select reserved, daily_used + included_used as used, purchased_balance as purchased from tenant_credit_balances where tenant_id = $1`,
    [TENANT],
  );
  return rows[0];
}

async function billed(id: string): Promise<number | null> {
  const { rows } = await db.query<{ billed_credits: number | null }>(`select billed_credits from agent_runs where id = $1`, [id]);
  return rows[0].billed_credits;
}

const d = MODULES ? describe : describe.skip;

d("20261119110300: a Write it run that filed no email settles at model usage, capped at the flat price", () => {
  it.each([
    ["terminal refusal", "refused", "refund"],
    ["useful prose fallback", "not_refused", "settle"],
    ["clarification", "not_refused", "settle"],
    ["successful partial work", "not_refused", "settle"],
    ["unavailable assessment", "unknown", "settle"],
  ] as const)("existing credit trigger handles %s without a billing change", async (_label, completion, kind) => {
    await fund();
    const id = await startRun({ billed: FLAT });
    await finish(id, 0.1, resultTerminalStatus(true, completion as CompletionAssessment));
    expect(await ledger(id)).toEqual([{kind, amount: FLAT, debited: kind === "refund" ? null : FLAT}]);
    expect(await balance()).toEqual({reserved: 0, used: kind === "refund" ? 0 : FLAT, purchased: 0});
  });
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(MODULES!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table agent_runs (id uuid primary key, tenant_id uuid not null, status text not null, cost_usd numeric, billed_credits int);
      create table system_config (id int primary key, blob jsonb);
      insert into system_config (id, blob) values (1, '{}'::jsonb);
      create table tenant_credit_balances (
        tenant_id uuid primary key, reserved int not null default 0,
        included_allowance int not null default 0, included_used int not null default 0,
        daily_allowance int not null default 0, daily_used int not null default 0,
        purchased_balance int not null default 0, included_gen bigint not null default 0, daily_gen bigint not null default 0,
        updated_at timestamptz
      );
      create table tenant_credit_ledger (
        id serial primary key, tenant_id uuid not null, run_id uuid, kind text not null, amount int not null,
        source text, agent_slug text, cost_usd numeric, period_start date, attempt int not null default 1,
        debited int, debited_daily int, debited_included int, debited_purchased int, included_gen bigint, daily_gen bigint
      );
      create unique index tcl_run_attempt_terminal_uq on tenant_credit_ledger (run_id, attempt) where kind in ('settle','refund');
      create or replace function _credits_enforced(t uuid) returns boolean language sql as 'select true';
    `);
    await db.exec(triggerFn());
    await db.exec(`create trigger trg_agent_runs_finalize_credits after update of status on agent_runs for each row execute function _trg_finalize_run_credits();`);
    await db.exec(read(MIGRATION));
  });

  afterAll(async () => {
    await db?.close();
  });

  async function fund(): Promise<void> {
    await db.query(`delete from tenant_credit_balances`);
    await db.query(`insert into tenant_credit_balances (tenant_id, included_allowance, daily_allowance, purchased_balance) values ($1, 100000, 0, 0)`, [TENANT]);
  }

  it("charges a flagged no-email Write it run only the credits its model work cost, releases the rest of the hold, and leaves it reading as metered", async () => {
    await fund();
    const id = await startRun({ billed: FLAT });
    const usage = costToCredits(0.1);
    expect(usage).toBeLessThan(FLAT);
    await finish(id, 0.1, "success", true);
    expect(await ledger(id)).toEqual([{ kind: "settle", amount: usage, debited: usage }]);
    expect(await balance()).toEqual({ reserved: 0, used: usage, purchased: 0 });
    expect(await billed(id)).toBeNull();
  });

  it("rounds a flagged miss's usage up to whole credits exactly as the TS credit peg does", async () => {
    for (const cost of [0.0174, 0.0176, 1.1476, CREDIT_USD * FLAT, CREDIT_USD * FLAT + 0.001, 0.0000001]) {
      await fund();
      const id = await startRun({ billed: FLAT });
      await finish(id, cost, "success", true);
      const want = Math.min(costToCredits(cost), FLAT);
      expect(await ledger(id)).toEqual([{ kind: "settle", amount: want, debited: want }]);
      expect(await balance()).toEqual({ reserved: 0, used: want, purchased: 0 });
    }
  });

  it("never charges a flagged miss more than the flat price, however much its model work cost", async () => {
    await fund();
    const id = await startRun({ billed: FLAT });
    expect(costToCredits(5)).toBeGreaterThan(FLAT);
    await finish(id, 5, "success", true);
    expect(await ledger(id)).toEqual([{ kind: "settle", amount: FLAT, debited: FLAT }]);
    expect(await balance()).toEqual({ reserved: 0, used: FLAT, purchased: 0 });
    expect(await billed(id)).toBe(FLAT);
  });

  it("keeps a flagged miss whose usage lands exactly on the flat price reading as flat priced", async () => {
    await fund();
    const id = await startRun({ billed: FLAT });
    await finish(id, CREDIT_USD * FLAT, "success", true);
    expect(await ledger(id)).toEqual([{ kind: "settle", amount: FLAT, debited: FLAT }]);
    expect(await billed(id)).toBe(FLAT);
  });

  it("refunds a flagged miss that did no model work", async () => {
    await fund();
    const id = await startRun({ billed: FLAT });
    await finish(id, 0, "success", true);
    expect(await ledger(id)).toEqual([{ kind: "refund", amount: FLAT, debited: null }]);
    expect(await balance()).toEqual({ reserved: 0, used: 0, purchased: 0 });
  });

  it("still charges a normal Write it run that filed its email the flat 460, however cheap its model work was", async () => {
    await fund();
    const id = await startRun({ billed: FLAT });
    await finish(id, 0.1, "success", false);
    expect(await ledger(id)).toEqual([{ kind: "settle", amount: FLAT, debited: FLAT }]);
    expect(await balance()).toEqual({ reserved: 0, used: FLAT, purchased: 0 });
    expect(await billed(id)).toBe(FLAT);
  });

  it("still charges a channel run whose only output repeats an open suggestion the flat 460 (never flagged)", async () => {
    await fund();
    const id = await startRun({ billed: FLAT });
    await finish(id, 0.05, "success", null);
    expect(await ledger(id)).toEqual([{ kind: "settle", amount: FLAT, debited: FLAT }]);
    expect(await balance()).toEqual({ reserved: 0, used: FLAT, purchased: 0 });
    expect(await billed(id)).toBe(FLAT);
  });

  it("charges a flagged run with no flat price its model usage, as before", async () => {
    await fund();
    const id = await startRun({ billed: null, held: 120 });
    await finish(id, 0.1, "success", true);
    expect(await ledger(id)).toEqual([{ kind: "settle", amount: costToCredits(0.1), debited: costToCredits(0.1) }]);
    expect(await balance()).toEqual({ reserved: 0, used: costToCredits(0.1), purchased: 0 });
  });

  it("still refunds a flagged run that failed", async () => {
    await fund();
    const id = await startRun({ billed: FLAT });
    await finish(id, 0.1, "failed", true);
    expect(await ledger(id)).toEqual([{ kind: "refund", amount: FLAT, debited: null }]);
    expect(await balance()).toEqual({ reserved: 0, used: 0, purchased: 0 });
  });
});
