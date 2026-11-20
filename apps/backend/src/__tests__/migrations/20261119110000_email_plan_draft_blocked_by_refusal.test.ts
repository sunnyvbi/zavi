import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEmailPlanPass, type PassDeps, type PlanJob } from "@/services/email-plan/pass";
import type { DraftRun } from "@/services/email-plan/draft-blocker";
import { attempt, bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const LIST = "seed-new-signups";

const REPRO_CALLS = [
  {
    ms: 0,
    name: "ToolSearch",
    status: "ok",
    tool_use_id: "toolu_01BmsY7HhgmsgSw1eLCLQ1Z3",
    test_receipt: null,
    input_preview: '{"query":"select:mcp__server__email__propose_campaign,mcp__server__email_campaign__list_audiences,mcp__server__outbound__list_email_lists","max_results":5}',
    output_preview:
      '[{"type":"tool_reference","tool_name":"mcp__server__email__propose_campaign"},{"type":"tool_reference","tool_name":"mcp__server__email_campaign__list_audiences"},{"type":"tool_reference","tool_name":"mcp__server__outbound__list_email_lists"}]',
    typecheck_receipt: null,
  },
  {
    ms: 0,
    name: "mcp__server__email_campaign__list_audiences",
    status: "ok",
    tool_use_id: "toolu_012ej8TDa6H1Yp7x6fjMtD3B",
    test_receipt: null,
    input_preview: '{"tool":"mailchimp"}',
    output_preview: '[{"type":"text","text":"{\\"tool\\":\\"mailchimp\\",\\"audiences\\":[{\\"id\\":\\"81ac1df0cc\\",\\"name\\":\\"upcar.ai\\",\\"member_count\\":2}]}"}]',
    typecheck_receipt: null,
  },
];

describe.skipIf(!PGLITE_MODULES)("20261119110000 a planned draft blocked by a fixed refusal stops after one paid run (pglite, real pass)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;

  const item = async (route = "mailchimp", list = LIST) => {
    const it = (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status)
       values ($1, $2, $3, $4, 'New signups', now() + interval '20 hours', 'UTC', 'Welcome', 'founder', $5, 'planned') returning id, schedule_gen`,
      [T, route, list, `${route}:${list}`, randomUUID()],
    )) as { id: string; schedule_gen: number };
    await db.query(`insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at) values ($1, $2, 'draft', $3, now() - interval '1 minute')`, [
      T,
      it.id,
      `draft:${it.id}:v1:g${it.schedule_gen}`,
    ]);
    return it;
  };
  const row = async (id: string) => one("select status, status_reason, draft_attempts, card_id from email_planned_sends where id = $1", [id]);
  const pendingDrafts = async (id: string) => (await one("select count(*)::int n from email_plan_jobs where item_id = $1 and kind = 'draft' and state = 'pending'", [id])).n as number;

  function pass(itemId: string, toolCalls: unknown[], runStatus = "success") {
    const runs: Array<DraftRun & { version: number; key: string }> = [];
    const deps: PassDeps = {
      now: () => new Date(),
      repair: async () => 0,
      alertStuckHolds: async () => 0,
      outboxPending: async () => [],
      claimJobs: async (limit, lease) =>
        ((await db.query("select * from claim_email_plan_jobs($1, $2)", [limit, lease])).rows as PlanJob[]).filter((j) => j.item_id === itemId),
      completeJob: async (j, outcome, error, retry) => r("select complete_email_plan_job($1, $2, $3, $4, $5, $6) r", [j.tenant_id, j.id, j.lease_token, outcome, error, retry ?? null]),
      rpc: (async (tenant: string, name: string, args: Record<string, unknown>) => {
        const keys = Object.keys(args);
        const named = keys.map((k, i) => `${k} => $${i + 2}`).join(", ");
        return r(`select public.${name}(p_tenant_id => $1${named ? `, ${named}` : ""}) r`, [tenant, ...keys.map((k) => args[k])]);
      }) as PassDeps["rpc"],
      send: async () => {},
      unattended: async () => ({ allow: true, count: 0, reasons: [] }),
      startRun: async (_t, extra, key) => {
        const plan = (extra as { email_plan: { version: number } }).email_plan;
        runs.push({ status: runStatus, finished_at: new Date().toISOString(), payload: { email_plan: plan }, tool_calls: toolCalls, version: plan.version, key });
        return { ok: true, run_id: randomUUID() };
      },
      lastDraftRun: async (_t, id, version) => (id === itemId ? (runs.filter((x) => x.version === version).at(-1) ?? null) : null),
      schedulesMissing: async () => [],
      claimSchedules: async () => [],
      claimZoneChecks: async () => [],
      zoneOf: async () => "UTC",
      nextFire: () => new Date(Date.now() + 86_400_000),
      weeklyEligible: async () => false,
      log: () => {},
    };
    const tick = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await runEmailPlanPass(deps);
        await db.query("update email_plan_jobs set due_at = now() - interval '1 second' where item_id = $1 and state = 'pending'", [itemId]);
      }
    };
    return { runs, tick };
  }

  beforeAll(async () => {
    db = await bootEmailPipeline([
      "20261108100000_email_send_pause.sql",
      "20261117110000_email_plan_draft_spend_guards.sql",
      "20261119110000_email_plan_draft_blocked_by_refusal.sql",
    ]);
    await db.query("insert into tenants values ($1)", [T]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("must catch 8186: the repro run (list gone from Mailchimp, no card) is charged once, then the item waits on the founder with the reason", async () => {
    const it = await item();
    const p = pass(it.id, REPRO_CALLS);
    await p.tick(5);
    expect(p.runs.map((x) => x.key)).toEqual([`email-plan-draft:${it.id}:v1:a1`]);
    expect(await row(it.id)).toEqual({ status: "blocked", status_reason: "draft_blocked:email_audience_missing", draft_attempts: 1, card_id: null });
    expect(await pendingDrafts(it.id)).toBe(0);
    expect(await one("select state from email_plan_jobs where item_id = $1 and kind = 'draft'", [it.id])).toEqual({ state: "done" });
  });

  it("control: a transient miss (list present, nothing filed) still gets three runs and ends skipped no_draft", async () => {
    const it = await item();
    const present = [
      {
        name: "mcp__server__email_campaign__list_audiences",
        status: "ok",
        output_preview: JSON.stringify([{ type: "text", text: JSON.stringify({ tool: "mailchimp", audiences: [{ id: LIST, name: "New signups", member_count: 40 }] }) }]),
      },
    ];
    const p = pass(it.id, present);
    await p.tick(6);
    expect(p.runs).toHaveLength(3);
    expect(await row(it.id)).toMatchObject({ status: "skipped", status_reason: "no_draft", draft_attempts: 3 });
  });

  it("control: a run that failed is retried even with the repro trace", async () => {
    const it = await item();
    const p = pass(it.id, REPRO_CALLS, "failed");
    await p.tick(6);
    expect(p.runs).toHaveLength(3);
    expect((await row(it.id)).status).toBe("skipped");
  });

  describe("the block door refuses anything but the current lease, version and an unfiled drafting item", () => {
    const leased = async (it: { id: string; schedule_gen: number }, key?: string) => {
      const token = randomUUID();
      const id = (await one(
        `update email_plan_jobs set state = 'leased', lease_token = $3, lease_until = now() + interval '10 minutes'
          where tenant_id = $1 and item_id = $2 and kind = 'draft' and job_key = $4 returning id`,
        [T, it.id, token, key ?? `draft:${it.id}:v1:g${it.schedule_gen}`],
      )).id as string;
      return { id, token };
    };
    const started = async () => {
      const it = await item();
      const j = await leased(it);
      expect(await r("select begin_email_plan_draft($1, $2, $3, $4) r", [T, it.id, j.id, j.token])).toMatchObject({ attempt: 1 });
      return { it, j };
    };
    const block = (it: { id: string }, j: { id: string; token: string }, version = 1, code = "email_audience_missing", tenant = T) =>
      r("select block_email_plan_draft($1, $2, $3, $4, $5, $6) r", [tenant, it.id, j.id, j.token, version, code]);

    it("happy path blocks", async () => {
      const { it, j } = await started();
      expect(await block(it, j)).toEqual({ ok: true, blocked: true, status: "blocked", reason: "draft_blocked:email_audience_missing" });
    });

    it("a stale lease token does nothing", async () => {
      const { it, j } = await started();
      expect(await block(it, { id: j.id, token: randomUUID() })).toMatchObject({ blocked: false, reason: "superseded" });
      expect((await row(it.id)).status).toBe("drafting");
    });

    it("an expired lease does nothing", async () => {
      const { it, j } = await started();
      await db.query("update email_plan_jobs set lease_until = now() - interval '1 second' where id = $1", [j.id]);
      expect(await block(it, j)).toMatchObject({ blocked: false, reason: "superseded" });
    });

    it("a run for an older version does nothing once the email was changed", async () => {
      const { it, j } = await started();
      expect(await block(it, j, 2)).toMatchObject({ blocked: false, reason: "superseded" });
      await db.query("update email_planned_sends set content_version = 2 where id = $1", [it.id]);
      expect(await block(it, j, 1)).toMatchObject({ blocked: false, reason: "superseded" });
      expect((await row(it.id)).status).toBe("drafting");
    });

    it("an item with a card, or one never attempted, is not blocked", async () => {
      const { it, j } = await started();
      await db.query("update email_planned_sends set card_rail = 'channel_actions', card_id = $2 where id = $1", [it.id, randomUUID()]);
      expect(await block(it, j)).toMatchObject({ blocked: false });
      const fresh = await item();
      const fj = await leased(fresh);
      expect(await block(fresh, fj)).toMatchObject({ blocked: false, status: "planned" });
      expect((await row(fresh.id)).draft_attempts).toBe(0);
    });

    it("another tenant's call and a malformed code are refused", async () => {
      const { it, j } = await started();
      expect(await block(it, j, 1, "email_audience_missing", randomUUID())).toMatchObject({ ok: false, code: "not_found" });
      expect(await block(it, j, 1, "Drop table; --")).toMatchObject({ ok: false, code: "bad_request" });
      expect((await row(it.id)).status).toBe("drafting");
    });

    it("only the service role may call it", async () => {
      const grants = await db.query(
        "select grantee from information_schema.role_routine_grants where routine_name = 'block_email_plan_draft' and privilege_type = 'EXECUTE' order by grantee",
      );
      expect((grants.rows as Array<{ grantee: string }>).map((g) => g.grantee).filter((g) => g !== "postgres")).toEqual(["service_role"]);
      await db.query("set role anon");
      const denied = await attempt(db, "select block_email_plan_draft(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'x')");
      await db.query("reset role");
      expect(denied).toMatch(/permission denied/);
    });
  });
});
