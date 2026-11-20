import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => {
  const sql = (fn: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    return { text: `select ${fn}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) as v`, values: keys.map((k) => args[k]) };
  };
  return {
    asTenantId: (t: string) => t,
    platformSecretRpc: async () => ({ data: null, error: { message: "unused" } }),
    tenantRpc: async (tid: string, fn: string, args: Record<string, unknown>) => {
      const q = sql(fn, { p_tenant_id: tid, ...args });
      try {
        return { data: (await db.query<{ v: unknown }>(q.text, q.values)).rows[0].v, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    tenantClient: (tid: string) => ({
      from: (table: string) => ({
        select: (cols: string) => {
          const where: Array<[string, unknown]> = [["tenant_id", tid]];
          const q = {
            eq: (k: string, v: unknown) => (where.push([k, v]), q),
            then: (ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              db.query(`select ${cols} from ${table} where ${where.map(([k], i) => `${k}=$${i + 1}`).join(" and ")}`, where.map(([, v]) => v))
                .then((r) => ({ data: r.rows, error: null }), (e: Error) => ({ data: null, error: { message: e.message } }))
                .then(ok, bad),
          };
          return q;
        },
      }),
    }),
  };
});
vi.mock("@/services/connectors/linkedin-ads/client", () => ({ withLinkedInAdsToken: vi.fn(), listLinkedInAdAccountsRaw: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({ LINKEDIN_ADS_BILLING_HOLD: "", linkedinAdsGet: vi.fn(), linkedinOnBillingHold: () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { linkedinAdsConnector } from "@/services/connectors/linkedin-ads/oauth";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const ACCOUNT = "508000111";
let db: PGlite;
const migration = (file: string) => readFileSync(resolve("../../supabase/migrations", file), "utf8");
const row = async (sql: string, args: unknown[] = []) => (await db.query<Record<string, any>>(sql, args)).rows[0];
const register = (tenant: string, account = ACCOUNT, currency = "USD") =>
  row("select ads_register_customer_account($1,'linkedin',$2,$3,'linkedin_ads.access_token') as id", [tenant, account, currency]).then((r) => r.id as string);
const release = (tenant: string, account: string | null = null) =>
  row("select ads_release_customer_account_claim($1,'linkedin',$2) as n", [tenant, account]).then((r) => r.n as number);
const connect = (tenant: string) => db.query("insert into connector_metadata(tenant_id,slug,team_id) values ($1,'linkedin_ads','x') on conflict do nothing", [tenant]);
const disconnect = (tenant: string) => db.query("delete from connector_metadata where tenant_id=$1 and slug='linkedin_ads'", [tenant]);
const owner = () => row("select credential_tenant_id, claim_released_at from ads_provider_accounts where platform='linkedin' and provider_account_id=$1", [ACCOUNT]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role; create table tenants(id uuid primary key);");
  for (const f of [
    "20260924183000_chatgpt_ads_wallet.sql",
    "20260925083000_chatgpt_ads_wallet_controls.sql",
    "20260925120000_chatgpt_ads_resource_bindings.sql",
    "20260925121000_chatgpt_ads_daily_coverage.sql",
    "20261005100050_ads_wallet_creator_consent.sql",
    "20261017090000_chatgpt_ads_wallet_final_release.sql",
    "20261101161000_shared_ads_wallet_bindings.sql",
    "20261101162000_shared_ads_wallet_accounts.sql",
  ]) await db.exec(migration(f));
  await db.exec(`create schema vault; create table vault.secrets(id uuid primary key default gen_random_uuid(), secret text);
    create function vault.create_secret(value text) returns uuid language sql as $$ insert into vault.secrets(secret) values(value) returning id $$;
    create table public.secrets(tenant_id uuid references tenants(id) on delete cascade,key text,vault_secret_id uuid references vault.secrets(id),primary key(tenant_id,key));`);
  for (const f of [
    "20261101164000_chatgpt_customer_accounts.sql",
    "20261101165000_ads_resource_account_identity.sql",
    "20261102141800_ads_wallet_review_fixes.sql",
  ]) await db.exec(migration(f));
  await db.exec("create table connector_metadata(tenant_id uuid not null references tenants(id) on delete cascade, slug text not null, team_id text, primary key(tenant_id,slug));");
  await db.exec(`create table ad_budget_reservations (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    platform text not null, object_id text, status text not null, idem_key text not null)`);
  await db.exec(migration("20261121100500_linkedin_ads_release_account_claim.sql"));
}, 20_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("delete from ad_budget_reservations; delete from ads_campaign_operations; delete from ads_campaign_lifecycle; delete from connector_metadata; delete from ads_campaign_bindings; delete from ads_account_selections; delete from ads_account_binding_status; delete from ads_account_bindings; delete from ads_provider_accounts where legacy_key is null; delete from tenants;");
  await db.query("insert into tenants values ($1),($2)", [A, B]);
  await connect(A);
  await connect(B);
});

describe("LinkedIn ad account exclusive claim", () => {
  it("keeps the account exclusive while the claiming workspace is still connected and has not released it", async () => {
    await register(A);
    await expect(register(B)).rejects.toThrow("account ownership conflict");
    expect((await owner()).credential_tenant_id).toBe(A);
  });

  it("lets another workspace claim the account once the claiming workspace disconnects LinkedIn Ads, keeping its campaign history", async () => {
    const aBinding = await register(A);
    const aCampaign = (await row("select ads_bind_campaign($1,$2,'777001') as id", [A, aBinding])).id;
    await disconnect(A);
    const bBinding = await register(B);
    expect(bBinding).not.toBe(aBinding);
    expect((await owner()).credential_tenant_id).toBe(B);
    const history = await row("select tenant_id, account_binding_id, provider_campaign_id from ads_campaign_bindings where id=$1", [aCampaign]);
    expect(history).toEqual({ tenant_id: A, account_binding_id: aBinding, provider_campaign_id: "777001" });
    expect((await row("select count(*)::int as n from ads_account_bindings where tenant_id=$1", [A])).n).toBe(1);
    expect((await row("select count(*)::int as n from ads_account_binding_details where tenant_id=$1 and credential_tenant_id=$1", [A])).n).toBe(0);
  });

  it("lets another workspace claim the account after an explicit release by the owner, even while the owner stays connected", async () => {
    await register(A);
    expect(await release(A, ACCOUNT)).toBe(1);
    await register(B);
    expect(await owner()).toEqual({ credential_tenant_id: B, claim_released_at: null });
    await expect(register(A)).rejects.toThrow("account ownership conflict");
  });

  it("never lets tenant B release tenant A's claim", async () => {
    await register(A);
    expect(await release(B)).toBe(0);
    expect(await release(B, ACCOUNT)).toBe(0);
    expect((await owner()).claim_released_at).toBeNull();
    await expect(register(B)).rejects.toThrow("account ownership conflict");
  });

  it("reasserts the owner's claim when the owner reconnects and claims again after its own release", async () => {
    await register(A);
    await release(A);
    await register(A);
    expect(await owner()).toEqual({ credential_tenant_id: A, claim_released_at: null });
    await expect(register(B)).rejects.toThrow("account ownership conflict");
  });

  it("does not transfer a released claim when the account currency no longer matches", async () => {
    await register(A);
    await disconnect(A);
    await expect(register(B, ACCOUNT, "EUR")).rejects.toThrow("account ownership conflict");
    expect((await owner()).credential_tenant_id).toBe(A);
  });

  it("still refuses any direct owner change of a held claim, and any provider account id change", async () => {
    await register(A);
    await expect(db.query("update ads_provider_accounts set credential_tenant_id=$1 where provider_account_id=$2", [B, ACCOUNT])).rejects.toThrow("ads account identity is immutable");
    await disconnect(A);
    await expect(db.query("update ads_provider_accounts set provider_account_id='999' where provider_account_id=$1", [ACCOUNT])).rejects.toThrow("ads account identity is immutable");
    await expect(db.query("update ads_provider_accounts set credential_tenant_id=null where provider_account_id=$1", [ACCOUNT])).rejects.toThrow();
  });

  describe("while the claiming workspace still has a live or held Zavi campaign on the account", () => {
    const OTHER_ACCOUNT = "508000222";
    const live = {
      "a committed launch hold": (c: string) => db.query("insert into ad_budget_reservations(tenant_id,platform,object_id,status,idem_key) values ($1,'linkedin',$2,'committed','x:resume')", [A, c]),
      "a reserved launch hold": (c: string) => db.query("insert into ad_budget_reservations(tenant_id,platform,object_id,status,idem_key) values ($1,'linkedin',$2,'reserved','x:resume')", [A, c]),
      "a launch still in flight": (c: string) => db.query("insert into ads_campaign_operations(id,tenant_id,campaign_binding_id,kind,payload) values (gen_random_uuid(),$1,$2,'activate','{}')", [A, c]),
      "an unconfirmed pause": (c: string) => db.query("insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id,stop_requested_at) values ($1,$2,now())", [A, c]),
    };
    async function liveCampaign(kind: keyof typeof live) {
      const binding = await register(A);
      const campaign = (await row("select ads_bind_campaign($1,$2,'777001') as id", [A, binding])).id as string;
      await live[kind](campaign);
      return campaign;
    }

    it.each(Object.keys(live) as Array<keyof typeof live>)("%s: no release (named or all), no takeover by B, even after A disconnects", async (kind) => {
      await liveCampaign(kind);
      expect(await release(A, ACCOUNT)).toBe(0);
      expect(await release(A)).toBe(0);
      expect(await owner()).toEqual({ credential_tenant_id: A, claim_released_at: null });
      await expect(register(B)).rejects.toThrow("account ownership conflict");
      await disconnect(A);
      await expect(register(B)).rejects.toThrow("account ownership conflict");
      await expect(db.query("update ads_provider_accounts set credential_tenant_id=$1 where provider_account_id=$2", [B, ACCOUNT])).rejects.toThrow("ads account identity is immutable");
      expect((await owner()).credential_tenant_id).toBe(A);
    });

    it("a claim released before a launch cannot be taken once that launch holds money", async () => {
      const binding = await register(A);
      expect(await release(A, ACCOUNT)).toBe(1);
      const campaign = (await row("select ads_bind_campaign($1,$2,'777001') as id", [A, binding])).id as string;
      await live["a committed launch hold"](campaign);
      await expect(register(B)).rejects.toThrow("account ownership conflict");
      expect((await owner()).credential_tenant_id).toBe(A);
    });

    it("released, paused or confirmed-stopped campaigns, and campaigns on another account, do not keep the claim", async () => {
      const campaign = await liveCampaign("a committed launch hold");
      await db.query("update ad_budget_reservations set status='released'");
      await db.query("insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id,stop_requested_at,stop_confirmed_at) values ($1,$2,now()-interval '1 hour',now())", [A, campaign]);
      await db.query("insert into ads_campaign_operations(id,tenant_id,campaign_binding_id,kind,payload,status) values (gen_random_uuid(),$1,$2,'activate','{}','succeeded')", [A, campaign]);
      const other = await register(A, OTHER_ACCOUNT);
      const otherCampaign = (await row("select ads_bind_campaign($1,$2,'777002') as id", [A, other])).id as string;
      await live["a committed launch hold"](otherCampaign);
      expect(await release(A, ACCOUNT)).toBe(1);
      expect(await release(A)).toBe(0);
      await register(B);
      expect((await owner()).credential_tenant_id).toBe(B);
    });
  });

  describe("Disconnect then Connect again through the real LinkedIn Ads connector hooks", () => {
    const disconnectA = async () => { await disconnect(A); await linkedinAdsConnector.onDisconnect!(A); };
    const reconnect = async (tenant: string) => { await connect(tenant); await linkedinAdsConnector.onConnect!(tenant); };

    it("reconnecting re-claims the account, so workspace B cannot take it and A's paused campaign stays on A's account", async () => {
      const aBinding = await register(A);
      const aCampaign = (await row("select ads_bind_campaign($1,$2,'777001') as id", [A, aBinding])).id;
      await disconnectA();
      expect((await owner()).claim_released_at).not.toBeNull();
      await reconnect(A);
      expect(await owner()).toEqual({ credential_tenant_id: A, claim_released_at: null });
      await expect(register(B)).rejects.toThrow("account ownership conflict");
      expect((await owner()).credential_tenant_id).toBe(A);
      expect((await row("select count(*)::int as n from ads_account_binding_details where id=$1 and credential_tenant_id=$2", [aBinding, A])).n).toBe(1);
      expect((await row("select account_binding_id from ads_campaign_bindings where id=$1", [aCampaign])).account_binding_id).toBe(aBinding);
    });

    it("reconnecting never takes back an account another workspace claimed while A was disconnected", async () => {
      await register(A);
      await disconnectA();
      const bBinding = await register(B);
      await reconnect(A);
      expect(await owner()).toEqual({ credential_tenant_id: B, claim_released_at: null });
      expect((await row("select count(*)::int as n from ads_account_binding_details where id=$1 and credential_tenant_id=$2", [bBinding, B])).n).toBe(1);
    });

    it("another workspace connecting never re-claims or touches A's released account", async () => {
      await register(A);
      await disconnectA();
      await reconnect(B);
      expect((await owner()).credential_tenant_id).toBe(A);
      expect((await owner()).claim_released_at).not.toBeNull();
      expect((await row("select count(*)::int as n from ads_account_bindings where tenant_id=$1", [B])).n).toBe(0);
    });
  });

  it("refuses a release for any platform other than LinkedIn", async () => {
    await expect(row("select ads_release_customer_account_claim($1,'chatgpt',null)", [A])).rejects.toThrow("unsupported account claim release");
  });
});
