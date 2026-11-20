import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const tenant = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const request = "10000000-0000-4000-8000-000000000001";
let db: PGlite;
let beforeMigration: unknown, afterMigration: unknown;
let resourceMigration: {before:unknown;after:unknown};
const migration = (file: string) => readFileSync(resolve("../../supabase/migrations", file), "utf8");
const scalar = async (sql: string, args: unknown[] = []) => (await db.query<Record<string, any>>(sql, args)).rows[0];
async function account(platform: string, accountId: string, owner = tenant, source = "wallet") {
  const a = await scalar(`insert into ads_provider_accounts(platform,provider_account_id,credential_source,credential_ref,credential_tenant_id,currency,verified_at)
    values ($1,$2,$3,'fixture',$4,'USD',now()) returning id`, [platform,accountId,source==="provider"?"tenant_connector":"platform",source==="provider"?owner:null]);
  return (await scalar("insert into ads_account_bindings(tenant_id,account_id,funding_source) values ($1,$2,$3) returning id", [owner, a.id, source])).id as string;
}
const campaign = async (binding: string, raw = "12345", owner = tenant) =>
  (await scalar("select ads_bind_campaign($1,$2,$3) as id", [owner,binding,raw])).id as string;
const reserve = (id: string, cents: number, owner = tenant, observed = 0) => db.query("select ads_wallet_reserve_bound($1,$2,$3,$4)",[owner,id,cents,observed]);
const balances = () => scalar("select balance_cents, (select coalesce(sum(reserved_cents),0) from ads_campaign_reservations where tenant_id=$1) as reserved from ads_wallets where tenant_id=$1",[tenant]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role; create table tenants(id uuid primary key);");
  for (const f of ["20260924183000_chatgpt_ads_wallet.sql","20260925083000_chatgpt_ads_wallet_controls.sql","20260925120000_chatgpt_ads_resource_bindings.sql","20260925121000_chatgpt_ads_daily_coverage.sql","20261005100050_ads_wallet_creator_consent.sql","20261017090000_chatgpt_ads_wallet_final_release.sql"]) await db.exec(migration(f));
  await db.query("insert into tenants values ($1)",[tenant]);
  await db.query("insert into ads_wallets(tenant_id,balance_cents,stripe_customer_id,payment_method_id) values ($1,10000,'cus_existing','pm_existing')",[tenant]);
  await db.query("insert into ads_wallet_orders(id,tenant_id,kind,amount_cents,payment_intent_id,credited_cents,status) values ($1,$2,'topup',10000,'pi_existing',10000,'paid')",[request,tenant]);
  await db.query("select ads_wallet_reserve($1,'legacy-campaign',6000,1000)",[tenant]);
  const snapshot = async () => ({ wallet: (await db.query("select * from ads_wallets")).rows, order: (await db.query("select * from ads_wallet_orders")).rows, funding: (await db.query("select * from ads_campaign_funding")).rows });
  beforeMigration = await snapshot();
  await db.exec(migration("20261101161000_shared_ads_wallet_bindings.sql"));
  afterMigration = await snapshot();
  await db.exec(migration("20261101162000_shared_ads_wallet_accounts.sql"));
  await db.exec(`create schema vault; create table vault.secrets(id uuid primary key default gen_random_uuid(), secret text);
    create function vault.create_secret(value text) returns uuid language sql as $$ insert into vault.secrets(secret) values(value) returning id $$;
    create table public.secrets(tenant_id uuid references tenants(id) on delete cascade,key text,vault_secret_id uuid references vault.secrets(id),primary key(tenant_id,key));`);
  await db.exec(migration("20261101164000_chatgpt_customer_accounts.sql"));
  await db.query("insert into ads_conversion_sources(source_id,tenant_id) values ('legacy-source',$1)",[tenant]);
  await db.query("insert into ads_resource_bindings(resource_id,tenant_id,kind,source_id) values ('legacy-event',$1,'conversion_event','legacy-source')",[tenant]);
  const resources=async()=>({sources:(await db.query("select source_id,tenant_id from ads_conversion_sources")).rows,bindings:(await db.query("select resource_id,tenant_id,kind,source_id,created_at from ads_resource_bindings")).rows});
  const beforeResources=await resources();
  await db.exec(migration("20261101165000_ads_resource_account_identity.sql"));
  resourceMigration={before:beforeResources,after:await resources()};
  await db.exec(migration("20261102141800_ads_wallet_review_fixes.sql"));
  await db.exec(migration("20261112190100_linkedin_launch_reserve_binding_lock.sql"));
  await db.exec(migration("20261121520000_ads_wallet_refill_free_balance.sql"));
  expect((await scalar("select a.legacy_key from ads_resource_bindings r join ads_provider_accounts a on a.id=r.account_id where r.resource_id='legacy-event'")).legacy_key).toBe("chatgpt_platform");
}, 15_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("delete from tenants; delete from ads_provider_accounts where legacy_key is null;");
  await db.query("insert into tenants values ($1),($2)",[tenant,other]);
  await db.query("insert into ads_wallets(tenant_id,balance_cents) values ($1,10000),($2,10000)",[tenant,other]);
});

describe("shared ads wallet migration and identity", () => {
  it("preserves every legacy wallet, order and funding field through migration", () => {
    expect(afterMigration).toEqual(beforeMigration);
  });
  it("preserves existing conversion resources when adding their account identity",()=>{expect(resourceMigration.after).toEqual(resourceMigration.before);});
  it("does not silently switch a disabled customer choice back to Zavi billing",async()=>{
    const b=await scalar("select ads_save_chatgpt_customer_account($1,'own-account','USD','synthetic-key') as id",[tenant]);
    await db.query("select ads_select_account_binding($1,$2)",[tenant,b.id]);
    await db.query("select ads_disable_account_binding($1,$2)",[tenant,b.id]);
    expect((await scalar("select account_binding_id from ads_account_selections where tenant_id=$1 and platform='chatgpt'",[tenant])).account_binding_id).toBe(b.id);
    await expect(db.query("select ads_select_account_binding($1,$2)",[tenant,b.id])).rejects.toThrow();
  });
  it("gives the same raw campaign ID on different platforms independent reservations against one balance", async () => {
    const c = await campaign(await account("chatgpt","openai-1"));
    const l = await campaign(await account("linkedin","li-1"));
    expect(c).not.toBe(l);
    await reserve(c,6000);
    await expect(reserve(l,6000)).rejects.toThrow("ads_balance_insufficient");
    await reserve(l,4000);
    expect(await balances()).toMatchObject({ balance_cents: 10000, reserved: "10000" });
    await db.query("select ads_wallet_settle_bound($1,$2,1000)",[tenant,c]);
    await db.query("select ads_wallet_settle_bound($1,$2,1000)",[tenant,c]);
    expect(await balances()).toMatchObject({ balance_cents: 9000, reserved: "9000" });
  });
  it("claims a refill when reserved money leaves the free balance under the threshold, and not when it is healthy", async () => {
    const c = await campaign(await account("linkedin","li-refill"));
    await db.query("update ads_wallets set auto_refill_enabled=true,payment_method_id='pm_x',stripe_customer_id='cus_x' where tenant_id=$1",[tenant]);
    expect((await scalar("select ads_wallet_claim_refill($1) as id",[tenant])).id).toBeNull();
    await reserve(c,8000);
    expect(await balances()).toMatchObject({ balance_cents: 10000, reserved: "8000" });
    const id = (await scalar("select ads_wallet_claim_refill($1) as id",[tenant])).id;
    expect(id).toBeTruthy();
    expect(await scalar("select kind,amount_cents,status from ads_wallet_orders where id=$1",[id])).toMatchObject({ kind: "refill", amount_cents: 10000, status: "pending" });
    expect((await scalar("select pending_refill_id from ads_wallets where tenant_id=$1",[tenant])).pending_refill_id).toBe(id);
    await db.query("update ads_wallets set pending_refill_id=null,auto_refill_enabled=true where tenant_id=$1",[tenant]);
    await db.query("update ads_wallets set balance_cents=20000 where tenant_id=$1",[tenant]);
    expect((await scalar("select ads_wallet_claim_refill($1) as id",[tenant])).id).toBeNull();
  });
  it("isolates identical campaign IDs in different accounts on the same platform", async () => {
    const a = await campaign(await account("chatgpt","synthetic-account-1"));
    const b = await campaign(await account("chatgpt","synthetic-account-2"));
    await reserve(a,3000); await reserve(b,2000);
    expect((await db.query("select * from ads_campaign_reservations")).rows).toHaveLength(2);
  });
  it("prevents assigning one provider campaign to two tenants", async () => {
    const a = await account("linkedin","li-1");
    await campaign(a);
    const b = await scalar("insert into ads_account_bindings(tenant_id,account_id,funding_source) select $1,account_id,'wallet' from ads_account_bindings where id=$2 returning id",[other,a]);
    await expect(campaign(b.id,"12345",other)).rejects.toThrow("campaign ownership conflict");
  });
  it("denies reservation against a foreign campaign without changing either wallet", async () => {
    const c = await campaign(await account("linkedin","li-1"));
    await expect(reserve(c,5000,other)).rejects.toThrow("wallet-funded campaign binding required");
    expect((await balances()).balance_cents).toBe(10000);
    expect((await db.query("select * from ads_campaign_reservations")).rows).toHaveLength(0);
  });
  it("never draws wallet funds for provider-billed campaigns", async () => {
    const c = await campaign(await account("linkedin","li-own",tenant,"provider"));
    await expect(reserve(c,5000)).rejects.toThrow("wallet-funded campaign binding required");
  });
  it("pins existing campaigns and uncertain create retries when the default account changes", async () => {
    const a = await account("linkedin","li-1"), b = await account("linkedin","li-2",tenant,"provider");
    await db.query("insert into ads_managed_account_grants(tenant_id,account_id,label,billing_verified_at) select tenant_id,account_id,'Managed',now() from ads_account_bindings where id in ($1,$2)",[a,b]);
    await db.query("select ads_set_wallet_consent($1,$1,'shared_ads_wallet_v1',true)",[tenant]);
    await db.query("select ads_select_account_binding($1,$2)",[tenant,a]);
    expect((await scalar("select ads_claim_campaign_account($1,'linkedin',$2) as id",[tenant,request])).id).toBe(a);
    const c = await campaign(a);
    await reserve(c,3000);
    await db.query("select ads_select_account_binding($1,$2)",[tenant,b]);
    expect((await scalar("select ads_claim_campaign_account($1,'linkedin',$2) as id",[tenant,request])).id).toBe(a);
    expect((await scalar("select ads_claim_campaign_account($1,'linkedin',$2) as id",[tenant,other])).id).toBe(b);
    expect((await scalar("select account_binding_id from ads_campaign_bindings where id=$1",[c])).account_binding_id).toBe(a);
    await db.query("select ads_wallet_settle_bound($1,$2,1000)",[tenant,c]);
    expect((await balances()).balance_cents).toBe(9000);
    await expect(db.query("update ads_campaign_bindings set account_binding_id=$1 where id=$2",[b,c])).rejects.toThrow("immutable");
    await expect(db.query("update ads_account_bindings set funding_source='provider' where id=$1",[a])).rejects.toThrow("immutable");
  });
  it("will not select or bind campaigns through another tenant's account binding", async () => {
    const a = await account("linkedin","li-1");
    await expect(db.query("select ads_select_account_binding($1,$2)",[other,a])).rejects.toThrow("verified account binding required");
    await expect(campaign(a,"12345",other)).rejects.toThrow("verified account binding required");
  });
  it("serializes competing reservations and retains the successful hold", async () => {
    const a = await campaign(await account("chatgpt","openai-1")), b = await campaign(await account("linkedin","li-1"));
    const results = await Promise.allSettled([reserve(a,6000),reserve(b,6000)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(Number((await balances()).reserved)).toBe(6000);
  });
  it("keeps legacy RPCs and the legacy view strictly on the original ChatGPT account", async () => {
    await db.query("select ads_wallet_reserve($1,'12345',3000,0)",[tenant]);
    const l = await campaign(await account("linkedin","li-1"));
    await reserve(l,3000);
    await db.query("select ads_wallet_settle_spend($1,'12345',1000)",[tenant]);
    expect((await db.query("select * from ads_campaign_funding")).rows).toHaveLength(1);
    expect((await scalar("select spent_cents from ads_campaign_reservations where campaign_binding_id=$1",[l])).spent_cents).toBe(0);
    expect((await balances()).balance_cents).toBe(9000);
  });
  it("finalizes only the chosen binding and charges late spend once", async () => {
    const a = await campaign(await account("chatgpt","openai-1")), b = await campaign(await account("linkedin","li-1"));
    await reserve(a,6000); await reserve(b,4000);
    await db.query("select ads_wallet_finalize_bound($1,$2,2000)",[tenant,a]);
    await db.query("select ads_wallet_finalize_bound($1,$2,2000)",[tenant,a]);
    expect(Number((await balances()).reserved)).toBe(4000);
    await db.query("select ads_wallet_settle_bound($1,$2,2500)",[tenant,a]);
    expect((await balances()).balance_cents).toBe(7500);
  });
  it("pins the legacy provider identity once and rejects credential drift", async () => {
    const a = (await scalar("select ads_legacy_account_binding($1) as id",[tenant])).id;
    await expect(campaign(a)).rejects.toThrow("verified account binding required");
    await db.query("select ads_verify_account_binding($1,$2,'actual-openai-id','USD')",[tenant,a]);
    await db.query("select ads_verify_account_binding($1,$2,'actual-openai-id','USD')",[tenant,a]);
    await expect(db.query("select ads_verify_account_binding($1,$2,'different-account','USD')",[tenant,a])).rejects.toThrow("identity changed");
    await expect(db.query("select ads_verify_account_binding($1,$2,'actual-openai-id','EUR')",[tenant,a])).rejects.toThrow("identity changed");
    expect(await campaign(a)).toBeTruthy();
  });
  it("requires an actual verified identity for non-legacy accounts", async () => {
    await expect(db.query("insert into ads_provider_accounts(platform,credential_source,credential_ref) values ('linkedin','platform','unverified')")).rejects.toThrow(/check constraint/);
  });
  it("cannot bind another tenant's connector credential", async () => {
    const a = await scalar("insert into ads_provider_accounts(platform,provider_account_id,credential_source,credential_ref,credential_tenant_id,currency,verified_at) values ('linkedin','own-account','tenant_connector','linkedin_ads',$1,'USD',now()) returning id",[other]);
    await expect(db.query("insert into ads_account_bindings(tenant_id,account_id,funding_source) values ($1,$2,'provider')",[tenant,a.id])).rejects.toThrow("credential tenant mismatch");
  });
  it("retains ChatGPT daily coverage through legacy RPCs without applying its policy to another provider", async () => {
    await db.query("update ads_wallets set balance_cents=1000000 where tenant_id=$1",[tenant]);
    await db.query("select ads_wallet_reserve_daily($1,'daily',25000000,1800000000,1800086400,0)",[tenant]);
    expect(Number((await balances()).reserved)).toBe(15000);
    await db.query("select ads_wallet_reserve_daily($1,'daily',50000000,1800000000,1800086400,0)",[tenant]);
    await db.query("select ads_wallet_reserve_daily($1,'daily',25000000,1800000000,1800086400,0)",[tenant]);
    expect(Number((await balances()).reserved)).toBe(30000);
    const li=await campaign(await account("linkedin","li-daily"));
    await expect(db.query("select ads_wallet_reserve_chatgpt_daily_bound($1,$2,25000000,1800000000,1800086400,0)",[tenant,li])).rejects.toThrow("ChatGPT campaign binding required");
  });
  it("denies browser access to account credentials, shared reservations and every new RPC", async () => {
    for (const role of ["anon","authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const table of ["ads_provider_accounts","ads_account_bindings","ads_account_selections","ads_campaign_bindings","ads_campaign_create_requests","ads_account_binding_details","ads_campaign_binding_details","ads_campaign_funding","ads_campaign_reservations","ads_wallet_consents","ads_managed_account_grants","ads_account_binding_status","ads_campaign_operations","ads_campaign_lifecycle","ads_campaign_final_settlements","ads_campaign_spend_stability","ads_campaign_pending_stops"]) {
        await expect(db.query(`select * from ${table}`)).rejects.toThrow("permission denied");
      }
      for (const sql of ["ads_observe_linkedin_spend($1,$1,0,true)","ads_reserve_linkedin_launch($1,$1,1000,0)","ads_legacy_account_binding($1)","ads_legacy_campaign_binding($1,'c')","ads_claim_campaign_account($1,'chatgpt',$1)","ads_select_account_binding($1,$1)","ads_verify_account_binding($1,$1,'a','USD')","ads_bind_campaign($1,$1,'c')","ads_wallet_reserve_bound($1,$1,100,0)","ads_wallet_reserve_chatgpt_daily_bound($1,$1,25000000,1800000000,1800086400,0)","ads_wallet_settle_bound($1,$1,0)","ads_wallet_finalize_bound($1,$1,0)","ads_release_unsent_linkedin_launch($1,$1,$1,0)"]) {
        await expect(db.query(`select ${sql}`,[tenant])).rejects.toThrow("permission denied");
      }
      await db.exec("reset role");
    }
  });
});

describe("shared wallet account onboarding", () => {
  it("keeps equal conversion and audience IDs isolated by advertiser account",async()=>{
    const first=await account("chatgpt","first-account");const second=await account("chatgpt","second-account");
    const a=(await scalar("select account_id from ads_account_bindings where id=$1",[first])).account_id;
    const b=(await scalar("select account_id from ads_account_bindings where id=$1",[second])).account_id;
    for(const id of [a,b]) {
      await db.query("insert into ads_conversion_sources(account_id,source_id,tenant_id) values($1,'same-source',$2)",[id,tenant]);
      await db.query("insert into ads_resource_bindings(account_id,resource_id,tenant_id,kind,source_id) values($1,'same-event',$2,'conversion_event','same-source')",[id,tenant]);
    }
    expect((await db.query("select * from ads_resource_bindings where resource_id='same-event'")).rows).toHaveLength(2);
    await expect(db.query("insert into ads_resource_bindings(account_id,resource_id,tenant_id,kind) values($1,'audience',$2,'audience')",[a,other])).rejects.toThrow("ownership mismatch");
    await db.query("insert into ads_resource_bindings(resource_id,tenant_id,kind) values('legacy-audience',$1,'audience')",[tenant]);
    expect((await scalar("select legacy_key from ads_resource_binding_details where resource_id='legacy-audience'")).legacy_key).toBe("chatgpt_platform");
  });
  it("stores customer keys per advertiser and preserves an older campaign's credential",async()=>{
    const a=await scalar("select ads_save_chatgpt_customer_account($1,'own-one','USD','synthetic-key-one') as id",[tenant]);
    const c=await campaign(a.id);
    const b=await scalar("select ads_save_chatgpt_customer_account($1,'own-two','USD','synthetic-key-two') as id",[tenant]);
    await db.query("select ads_select_account_binding($1,$2)",[tenant,b.id]);
    const keys=await db.query("select v.secret from secrets s join vault.secrets v on v.id=s.vault_secret_id where s.tenant_id=$1 order by v.secret",[tenant]);
    expect(keys.rows).toEqual([{secret:"synthetic-key-one"},{secret:"synthetic-key-two"}]);
    expect((await scalar("select account_binding_id from ads_campaign_bindings where id=$1",[c])).account_binding_id).toBe(a.id);
    await expect(db.query("select ads_save_chatgpt_customer_account($1,'own-one','USD','foreign-key-123')",[other])).rejects.toThrow("ownership conflict");
    await db.query("select ads_save_chatgpt_customer_account($1,'own-one','USD','rotated-key-one')",[tenant]);
    expect((await db.query("select * from secrets where tenant_id=$1",[tenant])).rows).toHaveLength(2);
    expect((await db.query("select * from vault.secrets where secret='synthetic-key-one'")).rows).toHaveLength(0);
  });
  it("requires explicit consent and an operator grant before using managed funding", async () => {
    const original = await account("linkedin","managed");
    const provider = await scalar("select account_id from ads_account_bindings where id=$1",[original]);
    await expect(db.query("select ads_use_managed_account($1,$2)",[other,provider.account_id])).rejects.toThrow("managed account unavailable");
    await db.query("insert into ads_managed_account_grants(tenant_id,account_id,label,billing_verified_at) values($1,$2,'Managed',now())",[other,provider.account_id]);
    await expect(db.query("select ads_use_managed_account($1,$2)",[other,provider.account_id])).rejects.toThrow("consent required");
    await db.query("select ads_set_wallet_consent($1,$1,'shared_ads_wallet_v1',true)",[other]);
    const b=await scalar("select ads_use_managed_account($1,$2) as id",[other,provider.account_id]);
    await db.query("select ads_select_account_binding($1,$2)",[other,b.id]);
    await db.query("select ads_disable_account_binding($1,$2)",[other,b.id]);
    expect((await scalar("select account_binding_id from ads_account_selections where tenant_id=$1",[other])).account_binding_id).toBe(b.id);
    await expect(db.query("select ads_select_account_binding($1,$2)",[other,b.id])).rejects.toThrow("selection unavailable");
    expect((await db.query("select * from ads_account_bindings where id=$1",[b.id])).rows).toHaveLength(1);
  });
  it("never retargets an account's customer credential or funding source", async () => {
    const args=[tenant,"linkedin","customer","USD","linkedin_ads.access_token"];
    const a=await scalar("select ads_register_customer_account($1,$2,$3,$4,$5) as id",args);
    const retry=await scalar("select ads_register_customer_account($1,$2,$3,$4,$5) as id",args);
    expect(retry.id).toBe(a.id);
    await expect(db.query("select ads_register_customer_account($1,$2,$3,$4,$5)",[other,...args.slice(1)])).rejects.toThrow("ownership conflict");
    await expect(reserve(await campaign(a.id),1000)).rejects.toThrow("wallet-funded campaign binding required");
  });
  it("revoking shared consent stops refill without deleting holds", async () => {
    const c=await campaign(await account("linkedin","managed")); await reserve(c,6000);
    await db.query("update ads_wallets set auto_refill_enabled=true where tenant_id=$1",[tenant]);
    await db.query("select ads_set_wallet_consent($1,$1,'shared_ads_wallet_v1',false)",[tenant]);
    await db.query("update ads_wallets set auto_refill_enabled=true where tenant_id=$1",[tenant]);
    expect(await balances()).toMatchObject({reserved:"6000"});
    expect((await scalar("select auto_refill_enabled from ads_wallets where tenant_id=$1",[tenant])).auto_refill_enabled).toBe(false);
  });
  it("serializes campaign operations, pins request payloads and isolates tenants", async () => {
    const c=await campaign(await account("linkedin","managed"));
    const args=[tenant,request,c,"activate",{budget:6000}];
    expect((await scalar("select ads_claim_campaign_operation($1,$2,$3,$4,$5) as claimed",args)).claimed).toBe(true);
    expect((await scalar("select ads_claim_campaign_operation($1,$2,$3,$4,$5) as claimed",args)).claimed).toBe(false);
    await expect(db.query("select ads_claim_campaign_operation($1,$2,$3,$4,$5)",[tenant,request,c,"activate",{budget:7000}])).rejects.toThrow("request conflict");
    await expect(db.query("select ads_claim_campaign_operation($1,gen_random_uuid(),$2,'activate','{}')",[tenant,c])).rejects.toThrow("ads_campaign_one_unresolved_operation");
    await expect(db.query("select ads_claim_campaign_operation($1,gen_random_uuid(),$2,'activate','{}')",[other,c])).rejects.toThrow("binding not found");
  });
});

describe("review settlement and durable stops",()=>{
 it("uses the facade conflict key and queues both wallet and customer LinkedIn stops, never ChatGPT",async()=>{
  const li=await campaign(await account("linkedin","managed"));
  const own=await campaign(await account("linkedin","own",tenant,"provider"));
  const chat=await campaign(await account("chatgpt","managed-chat"));
  await db.query("insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id,stop_requested_at) values($1,$2,now()) on conflict(tenant_id,campaign_binding_id) do update set stop_requested_at=excluded.stop_requested_at",[tenant,li]);
  await db.query("select ads_set_wallet_consent($1,$1,'shared_ads_wallet_v1',false)",[tenant]);
  const stops=(await db.query<{campaign_binding_id:string}>("select campaign_binding_id from ads_campaign_pending_stops")).rows.map(r=>r.campaign_binding_id);
  expect(stops.sort()).toEqual([li,own].sort());expect(stops).not.toContain(chat);
 });
 it("rolls back a new wallet reservation when the lifecycle write fails",async()=>{
  const li=await campaign(await account("linkedin","managed"));
  await expect(db.query("select ads_reserve_linkedin_launch($1,$2,6000,0)",[tenant,li])).rejects.toThrow("launch inventory required");
  expect(Number((await balances()).reserved)).toBe(0);
  await db.query("insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id) values($1,$2)",[tenant,li]);
  await db.query("select ads_reserve_linkedin_launch($1,$2,6000,0)",[tenant,li]);
  expect(Number((await balances()).reserved)).toBe(6000);
  expect((await scalar("select activation_attempted_at from ads_campaign_lifecycle where campaign_binding_id=$1",[li])).activation_attempted_at).not.toBeNull();
 });
 it("gives back exactly what an unsent launch reserved, only while that launch is unresolved",async()=>{
  const li=await campaign(await account("linkedin","managed"));await reserve(li,5000);
  await db.query("insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id) values($1,$2)",[tenant,li]);
  const op="20000000-0000-4000-8000-000000000001";
  await db.query("select ads_claim_campaign_operation($1,$2,$3,'activate','{}'::jsonb)",[tenant,op,li]);
  const prior=Number((await scalar("select ads_reserve_linkedin_launch($1,$2,6000,2000) as prior",[tenant,li])).prior);
  expect(prior).toBe(3000);expect(Number((await balances()).reserved)).toBe(4000);
  await expect(db.query("select ads_release_unsent_linkedin_launch($1,$2,$3,0)",[other,li,op])).rejects.toThrow("wallet-funded LinkedIn");
  await db.query("select ads_release_unsent_linkedin_launch($1,$2,$3,9000)",[tenant,li,op]);
  expect(Number((await balances()).reserved)).toBe(4000);
  await db.query("select ads_release_unsent_linkedin_launch($1,$2,$3,$4)",[tenant,li,op,prior]);
  expect(Number((await balances()).reserved)).toBe(3000);
  await db.query("update ads_campaign_operations set status='refused' where id=$1",[op]);
  await reserve(li,7000,tenant,2000);
  await db.query("select ads_release_unsent_linkedin_launch($1,$2,$3,0)",[tenant,li,op]);
  expect(Number((await balances()).reserved)).toBe(5000);
 });
 it("releases only after ended and unchanged for 72 hours, then charges late spend exactly once",async()=>{
  const li=await campaign(await account("linkedin","managed"));await reserve(li,6000);
  const observe=()=>scalar("select ads_observe_linkedin_spend($1,$2,2000,true) as released",[tenant,li]);
  await db.query("select ads_wallet_settle_bound($1,$2,2000)",[tenant,li]);
  expect((await observe()).released).toBe(false);
  await db.query("update ads_campaign_spend_stability set stable_since=now()-interval '73 hours',ended_since=now()-interval '71 hours' where campaign_binding_id=$1",[li]);
  expect((await observe()).released).toBe(false);
  await db.query("update ads_campaign_spend_stability set ended_since=now()-interval '73 hours' where campaign_binding_id=$1",[li]);
  expect((await observe()).released).toBe(true);expect(Number((await balances()).reserved)).toBe(0);
  await db.query("select ads_wallet_settle_bound($1,$2,2500)",[tenant,li]);await db.query("select ads_wallet_settle_bound($1,$2,2500)",[tenant,li]);
  expect((await balances()).balance_cents).toBe(7500);
 });
 it("resets stability on changed spend or resumed campaigns and rejects another tenant",async()=>{
  const li=await campaign(await account("linkedin","managed"));await reserve(li,6000);
  await db.query("select ads_observe_linkedin_spend($1,$2,2000,true)",[tenant,li]);
  await db.query("update ads_campaign_spend_stability set stable_since=now()-interval '73 hours',ended_since=now()-interval '73 hours' where campaign_binding_id=$1",[li]);
  expect((await scalar("select ads_observe_linkedin_spend($1,$2,2100,true) as released",[tenant,li])).released).toBe(false);
  await db.query("select ads_observe_linkedin_spend($1,$2,2100,false)",[tenant,li]);
  expect((await scalar("select ended_since from ads_campaign_spend_stability where campaign_binding_id=$1",[li])).ended_since).toBeNull();
  await expect(db.query("select ads_observe_linkedin_spend($1,$2,2100,true)",[other,li])).rejects.toThrow("verified wallet-funded");
  expect(Number((await balances()).reserved)).toBe(6000);
 });
});

it("requires one canonical managed LinkedIn advertiser shared by tenant grants",async()=>{
 const a=await account("linkedin","shared-zavi");
 await expect(account("linkedin","second-managed")).rejects.toThrow("ads_one_managed_linkedin_advertiser");
 const b=await scalar("insert into ads_account_bindings(tenant_id,account_id,funding_source) select $1,account_id,'wallet' from ads_account_bindings where id=$2 returning id",[other,a]);
 expect(b.id).toBeTruthy();expect(await account("linkedin","customer-account",tenant,"provider")).toBeTruthy();
});
