import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const migration = readFileSync(join(dir, "20261113191527_x_organic_trials.sql"), "utf8");
const prior = readFileSync(join(dir, "20261009100200_channel_card_layered_dedupe.sql"), "utf8");
const start = prior.indexOf("create or replace function record_channel_run_actions(");
const writer = prior.slice(start, prior.indexOf("end $$;", start) + "end $$;".length);
const tenant = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const run = "33333333-3333-4333-8333-333333333333";
const otherRun = "44444444-4444-4444-8444-444444444444";
const source = "55555555-5555-4555-8555-555555555555";
const body = { step: { deliverable: { kind: "post", presentation: { type: "x_organic_trial" }, parts: ["A", "B", "C"] } } };
type Trial = { next_check_at: string; phase: string; receipts: unknown[]; proposal: Record<string, unknown> | null; budget_action_id: string | null; connection_action_id: string | null; final_action_id: string | null; result_action_id: string | null };
let db: PGlite;
async function save(phase: string, extras: { note?: string; tenant?: string; action?: string; receipts?: unknown; proposal?: unknown; result?: string } = {}): Promise<Trial> {
  const r = await db.query<{ trial: Trial }>("select update_x_organic_trial($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as trial", [extras.tenant ?? tenant, extras.action ?? source, phase, extras.note ?? `State: ${phase}`, extras.receipts === undefined ? null : JSON.stringify(extras.receipts), extras.proposal === undefined ? null : JSON.stringify(extras.proposal), extras.result ?? null]);
  return r.rows[0].trial;
}
async function insertSource(over: { id?: string; channel?: string; run?: string; tenant?: string; position?: number; body?: unknown; exec?: string } = {}) {
  await db.query("insert into channel_actions(id,tenant_id,run_id,channel_slug,position,body,status,exec_class) values($1,$2,$3,$4,$5,$6::jsonb,'acted',$7)", [over.id ?? source, over.tenant ?? tenant, over.run ?? run, over.channel ?? "x_ads", over.position ?? 1, JSON.stringify(over.body ?? body), over.exec ?? null]);
}
const schema = `
create role anon; create role authenticated; create role service_role;
create table tenants(id uuid primary key);
create table agent_runs(id uuid primary key,tenant_id uuid,channel_slug text);
create table channel_actions(
 id uuid primary key default gen_random_uuid(),tenant_id uuid,channel_slug text,run_id uuid,
 position int,run_of int,blocking boolean,action_type text,title text,title_key text,body jsonb,
 repeat_of uuid,redo_of uuid,baseline_metrics jsonb,impact int,impact_reason text,score numeric,
 score_inputs jsonb,score_version smallint,scored_at timestamptz,card_kind text,primary_label text,
 done_label text,how_to jsonb,target_key text,status text default 'pending',status_at timestamptz,
 note text,snoozed_until timestamptz,exec_class text,exec_payload jsonb,exec_status text,exec_result jsonb,
 edited_body jsonb,steps_done jsonb default '[]',proposed_at timestamptz default now(),unique(run_id,position)
);
create table channel_action_events(tenant_id uuid,action_id uuid,event text,actor_kind text,run_id uuid,event_key text,note text,unique(action_id,event_key));
`;

describe("Z-406 registry and durable outcomes (executed SQL)", () => {
  beforeAll(async () => { db = new PGlite(); await db.exec(schema); await db.exec(writer); await db.exec(migration); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.exec("truncate channel_action_events,channel_actions,agent_runs,tenants cascade");
    await db.query("insert into tenants values($1),($2)", [tenant, other]);
    await db.query("insert into agent_runs values($1,$2,'x_ads'),($3,$4,'x_ads')", [run, tenant, otherRun, other]);
    await insertSource();
  });
  it("registers the explicit three-post card only", async () => {
    for (const [index, changes] of [
      { channel: "x_organic" }, { body: {} },
      { body: { step: { deliverable: { ...body.step.deliverable, parts: {} } } } },
      { body: { step: { deliverable: { ...body.step.deliverable, parts: ["A", "B"] } } } },
      { exec: "x_ads.create_campaign" }, { run: otherRun },
    ].entries()) await insertSource({ id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`, position: index + 2, ...changes });
    expect((await db.query("select action_id from x_organic_trials")).rows).toEqual([{ action_id: source }]);
  });
  it("rejects tenant override and unknown trial without writing a card", async () => {
    await expect(save("waiting_budget", { tenant: other })).rejects.toThrow("trial not found");
    await expect(save("waiting_budget", { action: other })).rejects.toThrow("trial not found");
    expect((await db.query("select id from channel_actions")).rows).toHaveLength(1);
  });
  it("files a budget task once, even after rejection, and never reopens the posted source", async () => {
    const first = await save("waiting_budget");
    expect(first.budget_action_id).toBeTruthy();
    await db.query("update channel_actions set status='rejected' where id=$1", [first.budget_action_id]);
    expect((await save("waiting_budget")).budget_action_id).toBe(first.budget_action_id);
    const cards = (await db.query<{ id: string; status: string; position: number; card_kind: string | null; exec_class: string | null; body: Record<string, unknown> }>("select id,status,position,card_kind,exec_class,body from channel_actions order by position")).rows;
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ id: source, status: "acted", position: 1, body });
    expect(cards[1]).toMatchObject({ status: "rejected", position: 21, card_kind: "task", exec_class: null });
    expect(cards[1].body.link).toBe(`/workspace?company=${tenant}&tab=growth-strategy#ad-budget`);
    expect((cards[1].body.step as Record<string, unknown>).deliverable).toBeUndefined();
    expect((await db.query("select * from channel_action_events")).rows).toHaveLength(1);
  });
  it("files a separate terminal no-replies task without copying or publishing", async () => {
    const budget = await save("waiting_budget");
    const final = await save("no_replies", { receipts: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    expect(final.final_action_id).toBeTruthy();
    expect(final.final_action_id).not.toBe(budget.budget_action_id);
    const card = (await db.query<{ position: number; exec_class: null; body: { trial_outcome: string; link: string; step: { deliverable?: unknown } } }>("select position,exec_class,body from channel_actions where id=$1", [final.final_action_id])).rows[0];
    expect(card).toMatchObject({ position: 22, exec_class: null, body: { trial_outcome: "result", link: `/workspace?company=${tenant}&tab=channels&channel=x_organic` } });
    expect(card.body.step.deliverable).toBeUndefined();
    await db.query("update channel_actions set status='rejected' where id=$1", [final.final_action_id]);
    expect(await save("observing", { proposal: { altered: true } })).toEqual(final);
    expect(await save("no_replies")).toEqual(final);
    expect((await db.query("select id from channel_actions")).rows).toHaveLength(3);
  });
  it("allocates around other follow-ups without touching recipe or executable slots", async () => {
    await db.query("insert into channel_actions(tenant_id,run_id,position) values($1,$2,21),($1,$2,24),($1,$2,900)", [tenant, run]);
    const saved = await save("waiting_budget");
    expect((await db.query("select position from channel_actions where id=$1", [saved.budget_action_id])).rows).toEqual([{ position: 25 }]);
  });
  it("rolls back when slots are exhausted", async () => {
    await db.query("insert into channel_actions(tenant_id,run_id,position) values($1,$2,899)", [tenant, run]);
    await expect(save("waiting_budget")).rejects.toThrow("positions exhausted");
    expect((await db.query("select phase,budget_action_id from x_organic_trials")).rows).toEqual([{ phase: "awaiting_posts", budget_action_id: null }]);
  });
  it("returns the first proposal and receipts to competing callers", async () => {
    const a = { origin: "x_organic_trial", organic_trial_id: source, daily_budget: 5 };
    const b = { ...a, daily_budget: 9 };
    const results = await Promise.all([save("observing", { proposal: a, receipts: [{ id: "a" }] }), save("observing", { proposal: b, receipts: [{ id: "b" }] })]);
    expect(results[0].proposal).toEqual(a);
    expect(results[1]).toEqual({ ...results[0], next_check_at: results[1].next_check_at });
    const stale = await save("no_replies");
    expect(stale).toEqual({ ...results[0], next_check_at: stale.next_check_at });
    expect((await db.query("select id from channel_actions")).rows).toHaveLength(1);
  });
  it("backs off failed prepared-proposal retries without changing the stored outcome", async () => {
    const prepared = await save("observing", { proposal: { immutable: true }, receipts: [{ id: "saved" }] });
    await db.query("update x_organic_trials set next_check_at=now()-interval '1 day' where action_id=$1", [source]);
    const retried = await save("waiting_metrics", { proposal: { immutable: false }, receipts: [] });
    expect(retried).toEqual({ ...prepared, next_check_at: retried.next_check_at });
    const schedule = (await db.query("select next_check_at >= now()+interval '23 hours' as backed_off from x_organic_trials where action_id=$1", [source])).rows;
    expect(schedule).toEqual([{ backed_off: true }]);
  });
  it("accepts the stable result identity after a human edit and returns terminal state on replay", async () => {
    const proposal = { origin: "x_organic_trial", organic_trial_id: source, daily_budget: 5 };
    await save("observing", { proposal });
    const result = "77777777-7777-4777-8777-777777777777";
    await db.query("insert into channel_actions(id,tenant_id,run_id,channel_slug,position,exec_class,exec_payload) values($1,$2,$3,'x_ads',900,'x_ads.create_campaign',$4::jsonb)", [result, tenant, run, JSON.stringify({ ...proposal, daily_budget: 8 })]);
    const final = await save("proposed", { result });
    expect(final).toMatchObject({ phase: "proposed", proposal, result_action_id: result });
    expect(await save("awaiting_posts", { receipts: [] })).toEqual(final);
  });
  it("permits only one trial result even after edit, rejection or completion", async () => {
    const proposal = { origin: "x_organic_trial", organic_trial_id: source, daily_budget: 5 };
    await save("observing", { proposal });
    await db.query("insert into channel_actions(tenant_id,run_id,channel_slug,position,exec_class,exec_payload) values($1,$2,'x_ads',900,'x_ads.create_campaign',$3::jsonb)", [tenant, run, JSON.stringify(proposal)]);
    for (const status of ["pending", "rejected", "acted"]) {
      await db.query("update channel_actions set status=$1,exec_payload=$2::jsonb where position=900", [status, JSON.stringify({ ...proposal, daily_budget: 9 })]);
      await expect(db.query("insert into channel_actions(tenant_id,run_id,channel_slug,position,exec_class,exec_payload) values($1,$2,'x_ads',901,'x_ads.create_campaign',$3::jsonb)", [tenant, run, JSON.stringify(proposal)])).rejects.toThrow("channel_x_organic_trial_result_once");
    }
    expect((await db.query("select id from channel_actions where exec_class is not null")).rows).toHaveLength(1);
  });
  it("does not conflate other tenants or ordinary X create cards", async () => {
    const marked = { origin: "x_organic_trial", organic_trial_id: source };
    await db.query("insert into channel_actions(tenant_id,run_id,channel_slug,position,exec_class,exec_payload) values($1,$2,'x_ads',900,'x_ads.create_campaign',$3::jsonb),($4,$5,'x_ads',900,'x_ads.create_campaign',$3::jsonb),($1,$2,'x_ads',901,'x_ads.create_campaign','{}'),($1,$2,'x_ads',902,'x_ads.create_campaign','{}')", [tenant, run, JSON.stringify(marked), other, otherRun]);
    expect((await db.query("select id from channel_actions where exec_class is not null")).rows).toHaveLength(4);
  });
  it("refuses result binding to the wrong tenant, run or trial", async () => {
    const proposal = { origin: "x_organic_trial", organic_trial_id: source };
    await save("observing", { proposal });
    const result = "77777777-7777-4777-8777-777777777777";
    await db.query("insert into channel_actions(id,tenant_id,run_id,channel_slug,position,exec_class,exec_payload) values($1,$2,$3,'x_ads',900,'x_ads.create_campaign',$4::jsonb)", [result, other, otherRun, JSON.stringify(proposal)]);
    await expect(save("proposed", { result })).rejects.toThrow("mismatched trial result");
    await db.query("update channel_actions set tenant_id=$1 where id=$2", [tenant, result]);
    await expect(save("proposed", { result })).rejects.toThrow("mismatched trial result");
    await db.query("update channel_actions set run_id=$1,exec_payload=$2::jsonb where id=$3", [run, JSON.stringify({ ...proposal, organic_trial_id: other }), result]);
    await expect(save("proposed", { result })).rejects.toThrow("mismatched trial result");
  });
  it("requires both a proposal and matching result before marking proposed", async () => {
    await expect(save("proposed")).rejects.toThrow("proposal and result required");
    await save("observing", { proposal: { x: 1 } });
    await expect(save("proposed", { result: source })).rejects.toThrow("mismatched trial result");
  });
  it("rejects malformed state and keeps cancelled rows terminal", async () => {
    await expect(save("anything")).rejects.toThrow("invalid trial phase");
    await expect(save("observing", { receipts: {} })).rejects.toThrow("invalid trial receipts");
    await expect(save("observing", { proposal: [] })).rejects.toThrow("invalid trial proposal");
    const cancelled = await save("cancelled");
    expect(await save("waiting_budget")).toEqual(cancelled);
  });
  it("keeps a visible connection task separate and does not duplicate it after rejection", async () => {
    const budget = await save("waiting_budget");
    const note = "The winning post was not returned by this ad account. Check its linked X profile.";
    const connection = await save("waiting_connection", { note });
    expect(connection.connection_action_id).toBeTruthy();
    expect(connection.connection_action_id).not.toBe(budget.budget_action_id);
    const card = (await db.query<{ body: { link: string }; exec_class: null }>("select body,exec_class from channel_actions where id=$1", [connection.connection_action_id])).rows[0];
    expect(card).toMatchObject({ exec_class: null, body: { link: `/workspace?company=${tenant}&tab=channels&channel=x_ads`, step: { body: note } } });
    await db.query("update channel_actions set status='rejected' where id=$1", [connection.connection_action_id]);
    expect((await save("waiting_connection")).connection_action_id).toBe(connection.connection_action_id);
    expect((await db.query("select id from channel_actions")).rows).toHaveLength(3);
  });
  it("expires with one terminal follow-up, including a prepared but unfiled proposal", async () => {
    await save("observing", { proposal: { waitingToFile: true } });
    const expired = await save("expired");
    expect(expired).toMatchObject({ phase: "expired", proposal: { waitingToFile: true } });
    expect(expired.final_action_id).toBeTruthy();
    const card = (await db.query("select card_kind,exec_class,primary_label from channel_actions where id=$1", [expired.final_action_id])).rows[0];
    expect(card).toEqual({ card_kind: "task", exec_class: null, primary_label: "Review next posts" });
    expect(await save("expired")).toEqual(expired);
    expect(await save("proposed")).toEqual(expired);
    expect((await db.query("select id from channel_actions")).rows).toHaveLength(2);
  });
  it("cancellation remains silent when the founder closes the source or disables the workspace", async () => {
    const cancelled = await save("cancelled");
    expect(cancelled.final_action_id).toBeNull();
    expect(cancelled.connection_action_id).toBeNull();
    expect((await db.query("select id from channel_actions")).rows).toHaveLength(1);
  });
  it("only grants service-role RPC writes and enables RLS", async () => {
    const permissions = (await db.query("select has_function_privilege('authenticated','update_x_organic_trial(uuid,uuid,text,text,jsonb,jsonb,uuid)','EXECUTE') as user_write, has_function_privilege('service_role','update_x_organic_trial(uuid,uuid,text,text,jsonb,jsonb,uuid)','EXECUTE') as service_write, has_table_privilege('service_role','x_organic_trials','UPDATE') as direct_write, relrowsecurity as rls from pg_class where oid='x_organic_trials'::regclass")).rows;
    expect(permissions).toEqual([{ user_write: false, service_write: true, direct_write: false, rls: true }]);
  });
});
