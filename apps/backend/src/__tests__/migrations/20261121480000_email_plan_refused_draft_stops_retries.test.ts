import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEmailPlanPass, type PassDeps, type PlanJob } from "@/services/email-plan/pass";
import type { DraftRun } from "@/services/email-plan/draft-blocker";
import { draftBlockedFix } from "@/services/email-plan/messages";
import { plannedReason } from "@/services/email-cards/cards";
import { EMAIL_FINAL_REFUSALS } from "@/services/channels/top-actions";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const TRANSIENT = new Set(["bulk_sending_paused", "email_card_cap_reached", "email_card_count_unavailable", "email_campaign_propose_unavailable", "top_action_cap", "email_audience_size_unknown"]);
const refused = (code: string) => ({
  name: "mcp__server__email__propose_campaign",
  status: "tool_error",
  output_preview: JSON.stringify(JSON.stringify({ message: `Not filed: ${code}.`, error: code })),
});

describe.skipIf(!PGLITE_MODULES)("Flow 54: a planned draft that ends with no card stops spending and says why (pglite, real pass and RPCs)", () => {
  let db: Db;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const r = async (q: string, p: unknown[] = []) => (await one(q, p)).r;

  const item = async () => {
    const list = randomUUID();
    const it = (await one(
      `insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz, angle, source, request_key, status)
       values ($1, 'sendgrid', $2, $3, 'New signups', now() + interval '20 hours', 'UTC', 'Welcome', 'founder', $4, 'planned') returning id, schedule_gen`,
      [T, list, `sendgrid:${list}`, randomUUID()],
    )) as { id: string; schedule_gen: number };
    await db.query("insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at) values ($1, $2, 'draft', $3, now() - interval '1 minute')", [T, it.id, `draft:${it.id}:v1:g${it.schedule_gen}`]);
    return it;
  };
  const row = (id: string) => one("select status, status_reason, draft_attempts, card_id from email_planned_sends where id = $1", [id]);
  const pending = async (id: string) => (await one("select count(*)::int n from email_plan_jobs where item_id = $1 and kind = 'draft' and state = 'pending'", [id])).n as number;

  function pass(itemId: string, toolCalls: unknown[]) {
    const runs: Array<DraftRun & { version: number; key: string }> = [];
    const deps: PassDeps = {
      now: () => new Date(),
      repair: async (limit) => Number(await r("select repair_email_plan_jobs($1) r", [limit])),
      alertStuckHolds: async () => 0,
      outboxPending: async () => [],
      claimJobs: async (limit, lease) => ((await db.query("select * from claim_email_plan_jobs($1, $2)", [limit, lease])).rows as PlanJob[]).filter((j) => j.item_id === itemId),
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
        runs.push({ status: "success", finished_at: new Date().toISOString(), payload: { email_plan: plan }, tool_calls: toolCalls, version: plan.version, key });
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
      "20261119150000_email_plan_sent_only_when_bulk_send_done.sql",
      "20261119110000_email_plan_draft_blocked_by_refusal.sql",
      "20261119150300_email_plan_keep_sender_block_reason.sql",
      "20261121200000_email_plan_redraft_and_angle_guards.sql",
      "20261121480000_email_plan_unblock_draft.sql",
    ]);
    await db.exec("create table if not exists agent_runs (id uuid primary key default gen_random_uuid(), tenant_id uuid, channel_slug text, status text, payload jsonb)");
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it.each([
    ["channel_card_already_done", "You already approved a similar email to this list, so Zavi did not draft this one. Change the topic, or skip it."],
    ["channel_card_already_rejected", "You turned down a similar email to this list, so Zavi did not draft this one. Change the topic, or skip it."],
  ])("must catch %s: one paid run ever, even after the repair pass and more ticks, then the plain reason and a way forward", async (code, words) => {
    const it = await item();
    const p = pass(it.id, [refused(code)]);
    await p.tick(8);
    expect(p.runs.map((x) => x.key)).toEqual([`email-plan-draft:${it.id}:v1:a1`]);
    const got = await row(it.id);
    expect(got).toEqual({ status: "blocked", status_reason: `draft_blocked:${code}`, draft_attempts: 1, card_id: null });
    expect(await pending(it.id)).toBe(0);
    expect(plannedReason(got.status_reason as string, "sendgrid")).toBe(words);
    expect(draftBlockedFix(got.status_reason as string)).toBe("change_topic");
    const changed = await r("select change_email_planned_angle($1, $2, $3, 'Winter hours', 1) r", [T, OWNER, it.id]);
    expect(changed).toMatchObject({ ok: true, content_version: 2 });
    await db.query("update email_plan_jobs set due_at = now() - interval '1 second' where item_id = $1 and state = 'pending'", [it.id]);
    await p.tick(3);
    expect(p.runs.map((x) => x.key)).toEqual([`email-plan-draft:${it.id}:v1:a1`, `email-plan-draft:${it.id}:v2:a2`]);
  });

  it("every final refusal that is not a passing condition costs one run and leaves words with no code in them", async () => {
    const finals = EMAIL_FINAL_REFUSALS.filter((c) => !TRANSIENT.has(c));
    expect(finals).toEqual(expect.arrayContaining(["channel_card_already_done", "channel_card_already_rejected", "email_campaign_body_invalid", "list_not_consented", "email_render_bad_font"]));
    for (const code of finals) {
      const it = await item();
      const p = pass(it.id, [refused(code)]);
      await p.tick(4);
      expect([code, p.runs.length]).toEqual([code, 1]);
      const got = await row(it.id);
      expect([code, got.status]).toEqual([code, "blocked"]);
      const shown = plannedReason(got.status_reason as string, "sendgrid");
      expect(shown).toBeTruthy();
      expect(shown).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});
