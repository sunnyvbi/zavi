import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

let db: PGlite;
const T="11111111-1111-4111-8111-111111111111", U="22222222-2222-4222-8222-222222222222", R="33333333-3333-4333-8333-333333333333";
const artifact={title:"Plan",body:"A researched plan",fingerprint:"fp",spine:"customers::activation",goal_limit:20,measurement_mode:"unmapped",
 north_star_anchor:"customers",gtm_anchor:"activation",strategy:{north_star:{metric:"customers"},constraint:{statement:"activation",confidence:"medium"},channel_bets:[{channel_slug:"seo",intent:"Improve pages",falsifier:"No improvement",autorun:true}],goal:{objective:"Reach 50 customers",target_metric:"customers",target_value:50,due_date:"2026-12-01"},basis_evidence:[]}};
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 create table staff_users(user_id uuid,revoked_at timestamptz);
 create table tenants(id uuid primary key);
 create table tenant_users(tenant_id uuid,user_id uuid);
 create table agent_runs(id uuid primary key,tenant_id uuid,agent_slug text,payload jsonb,enqueued_at timestamptz default now());
 create table memory_note(id uuid primary key default gen_random_uuid(),tenant_id uuid,note_type text,title text,body_markdown text,source text,source_ref text,tags text[],metadata jsonb default '{}',superseded_by uuid,updated_at timestamptz default now(),enrichment_state text,content_hash text,slug text);
 create table memory_chunk(tenant_id uuid,note_id uuid);
 create table autopilot_goals(id uuid primary key default gen_random_uuid(),tenant_id uuid,status text default 'active',objective text,target_metric text,target_value numeric,baseline_value numeric,current_value numeric,due_date date,priority int,source text,measurement_mode text);
 create table growth_plan(id uuid primary key default gen_random_uuid(),tenant_id uuid,status text default 'live',objective text,north_star_metric text,constraint_statement text,constraint_confidence text,basis_evidence jsonb,version int default 1,created_at timestamptz default now(),updated_at timestamptz default now());
 create unique index one_live_plan on growth_plan(tenant_id) where status='live';
 create table growth_plan_bets(id uuid primary key default gen_random_uuid(),tenant_id uuid,plan_id uuid,channel_slug text,intent text,rationale text,expected_effect text,falsifier text,status text,rejected_reason text,sort_order int,updated_at timestamptz default now());
 create table growth_plan_changes(id uuid primary key default gen_random_uuid(),tenant_id uuid,plan_id uuid,entity text,entity_id uuid,field text,old_value text,new_value text,actor_kind text,actor_ref text,note text);
 create unique index active_anchor on memory_note(tenant_id,slug) where slug is not null and superseded_by is null;
 create table tenant_channels(tenant_id uuid,channel_slug text,plan_selected boolean default false,plan_selected_set_by text,plan_sort_order int,autorun boolean default false,autorun_set_by text,cgo_reason text,cgo_set_at timestamptz,cgo_run_id uuid,primary key(tenant_id,channel_slug));
 create table cgo_hypotheses(tenant_id uuid,restates_plan_constraint boolean);
 create table injected_failure(enabled boolean);insert into injected_failure values(false);
 create function fail_plan_write() returns trigger language plpgsql as $$begin if (select enabled from injected_failure) then raise exception 'injected commit failure'; end if; return new; end$$;
 create trigger fail_plan_write before insert or update on growth_plan for each row execute function fail_plan_write();
 `);
 await db.exec(readFileSync(resolve(__dirname, '../../../../../../supabase/migrations/20261013131821_cgo_strategy_delivery.sql'),'utf8'));
 const functions = [
  ['20261005140000_autopilot_tracking_links.sql', 'public.write_autopilot_goal'],
  ['0071_memory_note_metadata.sql', 'memory_note_upsert_anchor'],
  ['20260906191500_growth_plan_tables.sql', 'log_growth_plan_change'],
  ['20260919035833_growth_plan_north_star_and_retire_company_goals.sql', 'set_growth_plan'],
  ['20260909160000_growth_plan_bet_rationale.sql', 'set_growth_plan_bet'],
  ['20260911203038_founder_channel_in_plan.sql', 'commit_growth_plan'],
  ['20260911203038_founder_channel_in_plan.sql', 'retire_growth_plan'],
 ];
 for (const [file, name] of functions) {
  const sql = readFileSync(resolve(__dirname, `../../../../../../supabase/migrations/${file}`), 'utf8');
  const start = sql.indexOf(`create or replace function ${name}(`);
  const body = sql.indexOf('$$', start);
  const end = sql.indexOf('$$;', body + 2) + 3;
  if (start < 0 || body < 0 || end < 3) throw new Error(`missing SQL function ${name}`);
  await db.exec(sql.slice(start, end));
 }
},30000);
afterAll(async()=>{await db?.close()});
beforeEach(async()=>{
 await db.exec('truncate tenants,agent_runs,memory_note,memory_chunk,autopilot_goals,growth_plan,growth_plan_bets,growth_plan_changes,tenant_channels,cgo_hypotheses,growth_strategy_delivery,growth_strategy_generation cascade;update injected_failure set enabled=false');
 await db.query('insert into tenants values($1),($2)',[T,U]);
 await db.query("insert into agent_runs(id,tenant_id,agent_slug,payload,enqueued_at) values($1,$2,'cgo','{\"stage\":\"draft_strategy\"}',now()-interval '1 minute')",[R,T]);
});
async function advance(phase:string,a:unknown=null,tenant=T){return (await db.query<{result:{phase:string;plan_id?:string}}>('select advance_growth_strategy($1,$2,$3,$4::jsonb) result',[tenant,R,phase,a===null?null:JSON.stringify(a)])).rows[0].result}
async function count(table:string){return Number((await db.query<{n:number}>(`select count(*) n from ${table}`)).rows[0].n)}
describe('strategy transaction',()=>{
 it('rolls back goal and anchors when plan commit fails, then retries the saved draft once',async()=>{
  await advance('saving',artifact);await db.exec('update injected_failure set enabled=true');
  await expect(advance('apply')).rejects.toThrow('injected commit failure');
  expect(await count('autopilot_goals')).toBe(0);expect(await count('memory_note')).toBe(0);
  await db.exec('update injected_failure set enabled=false');
  const receipt=await advance('apply');expect(receipt.phase).toBe('applied');
  expect(await advance('apply')).toEqual(receipt);expect(await count('growth_plan')).toBe(1);expect(await count('autopilot_goals')).toBe(1);
  expect((await db.query('select autorun from tenant_channels')).rows).toEqual([{autorun:false}]);
 });
 it('reset prevents an already saved old draft from creating anything',async()=>{
  await advance('saving',artifact);await db.query('select reset_growth_strategy_delivery($1)',[T]);
  expect((await advance('apply')).phase).toBe('superseded');expect(await count('growth_plan')).toBe(0);expect(await count('autopilot_goals')).toBe(0);
 });
 it('reset before the first note also fences the old run',async()=>{
  await db.query('select reset_growth_strategy_delivery($1)',[T]);expect((await advance('checking')).phase).toBe('superseded');
 });
 it('reset after commit retires the plan and prevents replay',async()=>{
  await advance('saving',artifact);await advance('apply');await db.query('select reset_growth_strategy_delivery($1)',[T]);
  expect((await advance('apply')).phase).toBe('superseded');expect((await db.query("select id from growth_plan where status='live'")).rows).toHaveLength(0);
 });
 it('rejects another tenant and authenticated callers',async()=>{
  await expect(advance('saving',artifact,U)).rejects.toThrow('strategy run not found');
  await db.exec('set role authenticated');try{await expect(advance('saving',artifact)).rejects.toThrow('permission denied')}finally{await db.exec('reset role')}
 });
 it('newer run after reset can save; old run cannot overwrite it',async()=>{
  await db.query('select reset_growth_strategy_delivery($1)',[T]);
  await db.query("update agent_runs set enqueued_at=clock_timestamp()+interval '1 second' where id=$1",[R]);
  await advance('saving',artifact);expect((await advance('apply')).phase).toBe('applied');
 });
});

describe('delivery consistency', () => {
 it('keeps the first reviewed artifact if saving is retried with a different answer', async () => {
  await advance('saving', artifact); await advance('saving', { ...artifact, body: 'Changed answer' });
  await advance('apply');
  expect((await db.query<{body_markdown:string}>("select body_markdown from memory_note where note_type='growth_strategy'")).rows[0].body_markdown).toBe(artifact.body);
 });
 it('does not create another plan version or goal for an identical new run', async () => {
  await advance('saving', artifact); const first = await advance('apply');
  const next = '44444444-4444-4444-8444-444444444444';
  await db.query("insert into agent_runs(id,tenant_id,agent_slug,payload) values($1,$2,'cgo','{\"stage\":\"draft_strategy\"}')",[next,T]);
  await db.query("select advance_growth_strategy($1,$2,'saving',$3::jsonb)",[T,next,JSON.stringify(artifact)]);
  const receipt = (await db.query<{r:{plan_id:string}}>("select advance_growth_strategy($1,$2,'apply') r",[T,next])).rows[0].r;
  expect(receipt.plan_id).toBe(first.plan_id); expect(await count('growth_plan')).toBe(1); expect(await count('autopilot_goals')).toBe(1);
  expect((await advance('apply')).phase).toBe('superseded');
 });
 it('delivers the strategy at the active-goal cap and replay does not create a goal later', async () => {
  await db.query("insert into autopilot_goals(tenant_id,objective) select $1,'Existing ' || n from generate_series(1,20) n", [T]);
  await advance('saving',artifact);
  const receipt = await advance('apply');
  expect(receipt).toMatchObject({phase:'applied',goal_id:null});
  expect(await count('autopilot_goals')).toBe(20);
  expect(await count('memory_note')).toBe(3); expect(await count('growth_plan')).toBe(1);
  expect((await db.query<{issue:string}>("select metadata->>'goal_save_issue' issue from memory_note where note_type='growth_strategy'")).rows[0].issue).toBe('limit_reached');
  await db.exec("update autopilot_goals set status='paused'");
  expect(await advance('apply')).toEqual(receipt);
  expect(await count('autopilot_goals')).toBe(20);
 });
 it('delivers the strategy without a goal when the database rejects its date', async () => {
  await advance('saving',{...artifact,strategy:{...artifact.strategy,goal:{...artifact.strategy.goal,due_date:'not a date'}}});
  expect(await advance('apply')).toMatchObject({phase:'applied',goal_id:null});
  expect(await count('autopilot_goals')).toBe(0); expect(await count('growth_plan')).toBe(1);
  expect((await db.query<{issue:string}>("select metadata->>'goal_save_issue' issue from memory_note where note_type='growth_strategy'")).rows[0].issue).toBe('write_failed');
 });
 it('rolls back partial goal writes but still commits the plan and note', async () => {
  await db.exec(`create function fail_goal_write() returns trigger language plpgsql as $$begin
    insert into memory_note(tenant_id,note_type,title) values(new.tenant_id,'goal_partial','must roll back');
    raise exception 'injected goal failure'; end$$;
    create trigger fail_goal_write after insert on autopilot_goals for each row execute function fail_goal_write();`);
  try {
   await advance('saving',artifact);
   expect(await advance('apply')).toMatchObject({phase:'applied',goal_id:null});
   expect(await count('autopilot_goals')).toBe(0); expect(await count('growth_plan')).toBe(1);
   expect((await db.query("select id from memory_note where note_type='goal_partial'")).rows).toEqual([]);
   expect(await count('memory_note')).toBe(3);
  } finally { await db.exec('drop trigger fail_goal_write on autopilot_goals;drop function fail_goal_write()'); }
 });
 it('reset preserves unrelated metadata while clearing strategy and delivery identities', async () => {
  await advance('saving',artifact); await advance('apply');
  await db.exec(`update memory_note set metadata=metadata || '{"research":{"source":"kept"},"custom_flag":true}'::jsonb where note_type='growth_strategy'`);
  await db.query('select reset_growth_strategy_delivery($1)',[T]);
  const {metadata}= (await db.query<{metadata:Record<string,unknown>}>("select metadata from memory_note where note_type='growth_strategy'")).rows[0];
  expect(metadata).toMatchObject({research:{source:'kept'},custom_flag:true,accepted:false,interview:{}});
  for(const key of ['strategy','applied_fingerprint','applied_spine','applied_goal_id','applied_run_id','applied_plan_id','generation','goal_save_issue']) expect(metadata).not.toHaveProperty(key);
 });
 it('retired plan receipts cannot be replayed as successful', async () => {
  await advance('saving',artifact);await advance('apply');await db.exec("update growth_plan set status='superseded'");
  expect((await advance('apply')).phase).toBe('superseded');
 });
});

it('rolls back the whole reset if plan retirement fails', async () => {
 await advance('saving',artifact); const receipt=await advance('apply');
 await db.exec('update injected_failure set enabled=true');
 await expect(db.query('select reset_growth_strategy_delivery($1)',[T])).rejects.toThrow('injected commit failure');
 expect((await db.query('select phase,plan_id from growth_strategy_delivery')).rows[0]).toEqual({phase:'applied',plan_id:receipt.plan_id});
 expect((await db.query<{generation:number}>('select generation from growth_strategy_generation')).rows[0].generation).toBe(0);
 expect((await db.query<{accepted:string}>("select metadata->>'accepted' accepted from memory_note where note_type='growth_strategy'")).rows[0].accepted).toBe('true');
});

describe('a newer strategy saved outside the receipt path', () => {
 const B = '55555555-5555-4555-8555-555555555555';
 const bets = JSON.stringify([{channel_slug:'reddit',intent:'Answer threads',falsifier:'No signups'}]);
 const commit = () => db.query<{id:string}>("select commit_growth_plan($1,'Chat plan','signups','awareness','medium',$2::jsonb,'[]'::jsonb,'agent','cgo') id",[T,bets]);
 const live = async () => (await db.query<{id:string;objective:string}>("select id,objective from growth_plan where status='live'")).rows;
 it('a plan committed after the draft began is not replaced by the saved draft', async () => {
  await advance('saving',artifact);
  const chat = (await commit()).rows[0].id;
  expect((await advance('apply')).phase).toBe('superseded');
  expect(await live()).toEqual([{id:chat,objective:'Chat plan'}]);
  expect((await db.query('select phase from growth_strategy_delivery')).rows).toEqual([{phase:'superseded'}]);
  expect(await count('autopilot_goals')).toBe(0);
 });
 it('an accepted strategy note from a later run fences the saved draft', async () => {
  await advance('saving',artifact);
  await db.query("insert into agent_runs(id,tenant_id,agent_slug,payload) values($1,$2,'cgo','{}')",[B,T]);
  await db.query(`insert into memory_note(tenant_id,note_type,title,body_markdown,source,source_ref,tags,metadata)
   values($1,'growth_strategy','Chat strategy','Newer','agent_run',$2,array['current-growth-strategy'],'{"accepted":true}')`,[T,B]);
  expect((await advance('apply')).phase).toBe('superseded');
  expect((await db.query<{body_markdown:string}>("select body_markdown from memory_note where note_type='growth_strategy'")).rows[0].body_markdown).toBe('Newer');
  expect(await count('growth_plan')).toBe(0);
 });
 it('a plan and note from before the draft do not block it', async () => {
  const old = (await commit()).rows[0].id;
  await db.query("update growth_plan set created_at=now()-interval '1 hour' where id=$1",[old]);
  await db.query("insert into agent_runs(id,tenant_id,agent_slug,payload,enqueued_at) values($1,$2,'cgo','{}',now()-interval '1 hour')",[B,T]);
  await db.query(`insert into memory_note(tenant_id,note_type,title,body_markdown,source,source_ref,tags,metadata)
   values($1,'growth_strategy','Old strategy','Older','agent_run',$2,array['current-growth-strategy'],'{"accepted":true}')`,[T,B]);
  await advance('saving',artifact);
  const receipt = await advance('apply');
  expect(receipt.phase).toBe('applied');
  expect((await live()).map(p => p.id)).toEqual([receipt.plan_id]);
 });
 it('another tenant\'s newer plan does not fence this draft', async () => {
  await advance('saving',artifact);
  await db.query("select commit_growth_plan($1,'Other','signups','awareness','medium',$2::jsonb,'[]'::jsonb,'agent','cgo')",[U,bets]);
  expect((await advance('apply')).phase).toBe('applied');
 });
 it('a draft fenced before its first receipt still records that it was set aside', async () => {
  await commit();
  expect((await advance('checking')).phase).toBe('superseded');
  expect((await db.query('select run_id,tenant_id,phase from growth_strategy_delivery')).rows).toEqual([{run_id:R,tenant_id:T,phase:'superseded'}]);
  await db.exec('truncate growth_plan,growth_strategy_delivery');
  await db.query('select reset_growth_strategy_delivery($1)',[T]);
  expect((await advance('checking')).phase).toBe('superseded');
  expect((await db.query('select phase from growth_strategy_delivery')).rows).toEqual([{phase:'superseded'}]);
 });
 it('an applied receipt stays applied when a newer draft is applied after it', async () => {
  await advance('saving',artifact); await advance('apply');
  await db.query("insert into agent_runs(id,tenant_id,agent_slug,payload) values($1,$2,'cgo','{\"stage\":\"draft_strategy\"}')",[B,T]);
  await db.query("select advance_growth_strategy($1,$2,'saving',$3::jsonb)",[T,B,JSON.stringify({...artifact,fingerprint:'fp2'})]);
  await db.query("select advance_growth_strategy($1,$2,'apply')",[T,B]);
  expect((await advance('apply')).phase).toBe('superseded');
  expect((await db.query('select phase from growth_strategy_delivery where run_id=$1',[R])).rows).toEqual([{phase:'applied'}]);
 });
 it('an applied receipt stays applied when a later plan replaces its plan', async () => {
  await advance('saving',artifact); await advance('apply');
  await commit();
  expect((await advance('apply')).phase).toBe('superseded');
  expect((await db.query('select phase from growth_strategy_delivery')).rows).toEqual([{phase:'applied'}]);
 });
});
