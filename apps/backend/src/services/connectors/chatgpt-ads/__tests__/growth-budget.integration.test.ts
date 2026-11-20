import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const modules = process.env.ADS_SQL_TEST_MODULES;
const t = "11111111-1111-1111-1111-111111111111", t2 = "22222222-2222-2222-2222-222222222222", u = "99999999-9999-9999-9999-999999999999";
let db: any;
describe("ChatGPT shared Growth budget on real PostgreSQL", () => {
 beforeAll(async () => {
  const { PGlite } = createRequire(modules ? resolve(modules, "../package.json") : resolve("package.json"))("@electric-sql/pglite"); db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;\ncreate schema auth;\ncreate function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;\ncreate function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;\ncreate function public.app_active_tenant() returns uuid language sql stable as $$ select null::uuid $$;\ncreate table public.tenants (id uuid primary key);\ncreate table public.tenant_users (tenant_id uuid references public.tenants(id) on delete cascade, user_id uuid, role text);\ncreate table public.agent_runs (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, payload jsonb not null default '{}');\nalter table public.agent_runs add constraint agent_runs_id_tenant_uq unique (id, tenant_id);\ncreate table public.decisions (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade,\n  agent_run_id uuid references public.agent_runs(id) on delete cascade, decision_class text);\ncreate table public.channel_actions (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade,\n  run_id uuid not null references public.agent_runs(id) on delete cascade, unique (tenant_id, id));\ncreate table public.creator_offers (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, unique (tenant_id, id));\ncreate table public.creator_orders (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, unique (tenant_id, id));\ncreate table public.autopilot_goals (\n  id uuid primary key default gen_random_uuid(),\n  tenant_id uuid not null references public.tenants(id) on delete cascade,\n  objective text not null, target_metric text not null, target_value numeric not null,\n  baseline_value numeric, current_value numeric, due_date date,\n  status text not null default 'active', priority int not null default 50,\n  source text not null default 'founder',\n  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),\n  cgo_status_line text, cgo_status_at timestamptz, cgo_undo jsonb, count_rule jsonb);\ncreate table public.staff_users (user_id uuid primary key, revoked_at timestamptz);\ncreate function public._tenant_tier(p uuid) returns text language sql stable as $$ select 'pro'::text $$;\ncreate table tenant_channels(tenant_id uuid references tenants,channel_slug text,autorun boolean default false,autorun_set_by text,primary key(tenant_id,channel_slug));\ncreate table decision_classes(slug text primary key, description text, default_autonomy text, dispatch_handler text, never_auto boolean);\n");
  await db.exec("alter table decision_classes add column if not exists click_allowlistable boolean default false; alter table decision_classes add column if not exists severity text");
  for (const name of ["20260928210000_ad_budget_core", "20260928230000_ad_budget_setup_ledger", "20260928230100_ad_budget_reconcile", "20260928233000_ad_budget_end_pauses", "20260929010000_ad_budget_monthly", "20260929210000_ad_budget_events", "20260930010000_ad_ledger", "20260930020000_ad_ledger_removed_objects", "20260930030000_ad_budget_brake", "20260930193700_ad_object_changes", "20261005090000_creator_hire_budget", "20261005140000_autopilot_tracking_links", "20261012110000_cgo_spend_pace_holds", "20261012140000_cgo_spend_holds_cbo_and_freshness", "20261013110000_cgo_cbo_holds_ignore_stale_children", "20261016180000_cgo_holds_removed_objects_and_cbo_budget", "20261017100000_cgo_unknown_ad_holds", "20261021120000_cgo_inflight_ad_holds", "20261022140000_ad_budget_raise_holds_increase", "20260909200000_set_channel_autorun", "20261023125328_chatgpt_growth_autopilot", "20261009050108_growth_review_followups", "20261025120000_reddit_ads_execution", "20261025130000_x_ads_management_and_budget", "20261026100000_tiktok_ads_held_writes", "20260924183000_chatgpt_ads_wallet", "20260925083000_chatgpt_ads_wallet_controls", "20260925120000_chatgpt_ads_resource_bindings", "20260925121000_chatgpt_ads_daily_coverage", "20261005100050_ads_wallet_creator_consent", "20261017090000_chatgpt_ads_wallet_final_release", "20261101161000_shared_ads_wallet_bindings", "20261101162000_shared_ads_wallet_accounts", "20261101163000_linkedin_wallet_budget_gate"]) await db.exec(readFileSync(resolve("../../supabase/migrations", `${name}.sql`), "utf8"));
  await db.exec("create or replace function _ad_budget_today() returns date language sql stable as $$ select date '2026-10-10' $$;");
 });
 afterAll(async () => { await db?.close(); });
 beforeEach(async () => {
  await db.exec("truncate tenants cascade");
  await db.query("insert into tenants values ($1),($2)", [t,t2]);
  await db.query("insert into tenant_users values ($1,$2,'owner')",[t,u]);
  await db.query("insert into ad_budgets(tenant_id,monthly_usd,started_on,month_start,actual_read_at) values ($1,3000,'2026-09-01','2026-10-01',now()),($2,3000,'2026-09-01','2026-10-01',now())",[t,t2]);
 });
 async function reserve(tenant: string,key: string,platform: string,daily: number) {
  return (await db.query("select reserve_ad_spend($1,$2,$3,'create',null,$4) as r",[tenant,key,platform,daily])).rows[0].r;
 }
 it("holds LinkedIn in the same monthly cap at its unmultiplied rate",async()=>{
  expect((await reserve(t,"linkedin-request","linkedin",10)).status).toBe("held");
  const row=(await db.query("select daily_delta_usd,amount_usd from ad_budget_reservations where tenant_id=$1",[t])).rows[0];
  expect(Number(row.daily_delta_usd)).toBe(10);
  expect(Number(row.amount_usd)).toBe(220);
  expect((await reserve(t,"large-chatgpt","chatgpt",100)).status).toBe("refused");
 });
 it("reserves double the ChatGPT daily rate against the same cap as Meta and Google",async()=>{
  expect((await reserve(t,"chat","chatgpt",25)).status).toBe("held");
  const row=(await db.query("select daily_delta_usd,amount_usd from ad_budget_reservations where tenant_id=$1",[t])).rows[0];
  expect(Number(row.daily_delta_usd)).toBe(50); expect(Number(row.amount_usd)).toBe(1100);
  expect((await reserve(t,"meta","meta",50)).status).toBe("held");
  expect((await reserve(t,"google","google",50)).status).toBe("refused");
  expect((await reserve(t2,"google","google",50)).status).toBe("held");
 });
 it("a raise holds twice the increase it adds, also on a campaign the budget never held",async()=>{
  const r=(await db.query("select reserve_ad_spend($1,'raise1','chatgpt','raise','cmpn_old',30) as r",[t])).rows[0].r;
  expect(r.status).toBe("held");
  expect(Number((await db.query("select daily_delta_usd from ad_budget_reservations where idem_key='raise1'",[])).rows[0].daily_delta_usd)).toBe(60);
  await db.query("select settle_ad_spend($1,'raise1','committed','cmpn_old')",[t]);
  expect((await db.query("select reserve_ad_spend($1,'raise2','chatgpt','raise','cmpn_old',5) as r",[t])).rows[0].r.status).toBe("held");
  expect(Number((await db.query("select daily_delta_usd from ad_budget_reservations where idem_key='raise2'",[])).rows[0].daily_delta_usd)).toBe(10);
 });
 it("is retry-idempotent and accepts the ChatGPT recovery reference",async()=>{
  await reserve(t,"chat","chatgpt",25); expect((await reserve(t,"chat","chatgpt",25)).status).toBe("already_held");
  const r=(await db.query("select note_ad_spend_ref($1,'chat',$2::jsonb) as r",[t,JSON.stringify({kind:"chatgpt_campaign_name",name:"zv-acme--test"})])).rows[0].r;
  expect(r.status).toBe("noted");
  expect((await db.query("select count(*)::int n from ad_budget_reservations where tenant_id=$1",[t])).rows[0].n).toBe(1);
 });
 it("records only this tenant's ChatGPT daily spend",async()=>{
  const campaign={object_id:"cmpn_test",campaign_id:"cmpn_test",level:"campaign",name:"test",budget_kind:"daily",budget_usd:25,status:"ACTIVE",currency:"USD"};
  const spend={object_id:"cmpn_test",spend_date:"2026-10-09",amount_usd:40,provisional:false};
  const r=(await db.query("select record_ad_ledger_read($1,'chatgpt','chatgpt:test',$2::jsonb,$3::jsonb) as r",[t,JSON.stringify([campaign]),JSON.stringify([spend])])).rows[0].r;
  expect(r.status).toBe("recorded");
  expect((await db.query("select count(*)::int n from ad_spend_daily where tenant_id=$1",[t2])).rows[0].n).toBe(0);
 });
 it("legacy autorun is not paid consent; an owner can grant and revoke explicitly",async()=>{
  await db.query("select set_channel_autorun($1,'chatgpt_ads',true)",[t]);
  expect((await db.query("select chatgpt_autopilot_consent_at from tenant_channels where tenant_id=$1",[t])).rows[0].chatgpt_autopilot_consent_at).toBeNull();
  await db.query("select set_chatgpt_autopilot($1,$2,true)",[t,u]);
  expect((await db.query("select chatgpt_autopilot_consent_at from tenant_channels where tenant_id=$1",[t])).rows[0].chatgpt_autopilot_consent_at).toBeTruthy();
  await db.query("select set_chatgpt_autopilot($1,$2,false)",[t,u]);
  expect((await db.query("select autorun,chatgpt_autopilot_consent_at from tenant_channels where tenant_id=$1",[t])).rows[0]).toEqual({autorun:false,chatgpt_autopilot_consent_at:null});
 });
 it("refuses another tenant's owner and non-admin members",async()=>{
  expect((await db.query("select set_chatgpt_autopilot($1,$2,true) as allowed",[t2,u])).rows[0].allowed).toBe(false);
  await db.query("update tenant_users set role='member' where tenant_id=$1",[t]);
  expect((await db.query("select set_chatgpt_autopilot($1,$2,true) as allowed",[t,u])).rows[0].allowed).toBe(false);
 });
 it("partial spend raises the known floor without refreshing whole-read freshness or crossing tenants/months", async () => {
  const b=(await db.query("select id,actual_read_at from ad_budgets where tenant_id=$1",[t])).rows[0];
  await db.query("update ad_budgets set actual_read_at=now()-interval '1 day' where id=$1",[b.id]);
  const before=(await db.query("select actual_read_at from ad_budgets where id=$1",[b.id])).rows[0].actual_read_at;
  await db.query("select record_ad_budget_partial_actual($1,$2,125,'2026-10-01')",[t,b.id]);
  const after=(await db.query("select spent_usd,actual_read_at from ad_budgets where id=$1",[b.id])).rows[0];
  expect(Number(after.spent_usd)).toBe(125); expect(after.actual_read_at).toEqual(before);
  await db.query("select record_ad_budget_partial_actual($1,$2,10,'2026-10-01')",[t,b.id]);
  await db.query("select record_ad_budget_partial_actual($1,$2,999,'2026-10-01')",[t2,b.id]);
  await db.query("select record_ad_budget_partial_actual($1,$2,999,'2026-09-01')",[t,b.id]);
  expect(Number((await db.query("select spent_usd from ad_budgets where id=$1",[b.id])).rows[0].spent_usd)).toBe(125);
 });
 it("partial accounting adds fresh non-ChatGPT spend to the last verified ChatGPT amount", async () => {
  const b=(await db.query("select id from ad_budgets where tenant_id=$1",[t])).rows[0];
  await db.query("insert into ad_spend_daily(tenant_id,platform,account_id,object_id,spend_date,amount_usd,source) values ($1,'chatgpt','owned','cmpn_test','2026-10-09',100,'api'),($2,'chatgpt','other','cmpn_other','2026-10-09',999,'api')",[t,t2]);
  await db.query("update ad_budgets set spent_usd=200 where id=$1",[b.id]);
  await db.query("select record_ad_budget_partial_actual($1,$2,150,'2026-10-01')",[t,b.id]);
  expect(Number((await db.query("select spent_usd from ad_budgets where id=$1",[b.id])).rows[0].spent_usd)).toBe(250);
 });
 it("a UI hold saves its target once, only for the owning tenant and matching object", async () => {
  await db.query("select reserve_ad_spend($1,'ui','chatgpt','resume','cmpn_test',25)",[t]);
  const target={kind:"chatgpt_workspace",campaign_id:"cmpn_test",daily_budget_usd:25,status:"active"};
  const note=async(tenant:string,value:unknown)=>(await db.query("select note_chatgpt_workspace_hold($1,'ui',$2::jsonb) as ok",[tenant,JSON.stringify(value)])).rows[0].ok;
  expect(await note(t2,target)).toBe(false); expect(await note(t,{...target,campaign_id:"other"})).toBe(false);
  expect(await note(t,target)).toBe(true); expect(await note(t,target)).toBe(true);
  expect(await note(t,{...target,daily_budget_usd:50})).toBe(false);
 });
 it("members can revoke but cannot grant paid permission; outsiders cannot revoke", async () => {
  await db.query("select set_chatgpt_autopilot($1,$2,true)",[t,u]);
  await db.query("update tenant_users set role='member' where tenant_id=$1",[t]);
  expect((await db.query("select revoke_chatgpt_autopilot($1,$2) as ok",[t2,u])).rows[0].ok).toBe(false);
  expect((await db.query("select revoke_chatgpt_autopilot($1,$2) as ok",[t,u])).rows[0].ok).toBe(true);
  expect((await db.query("select set_chatgpt_autopilot($1,$2,true) as ok",[t,u])).rows[0].ok).toBe(false);
 });

});
