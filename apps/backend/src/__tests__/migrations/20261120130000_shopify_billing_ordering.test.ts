import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const migration = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261120130000_fix_shopify_billing_ordering.sql"),
  "utf8",
);

describe("Shopify billing ordering migration", () => {
  const db = new PGlite();

  beforeAll(async () => {
    await db.exec(`
      create role service_role;
      create role anon;
      create role authenticated;
      create table tenant_subscriptions (
        tenant_id uuid primary key,
        plan text,
        status text,
        tier text,
        source text,
        shopify_shop text,
        shopify_subscription_id text,
        current_period_end timestamptz,
        cancel_at_period_end boolean default false,
        store_event_created bigint default 0,
        tier_event_created bigint default 0,
        updated_at timestamptz,
        grandfathered boolean default false,
        stripe_subscription_id text,
        credits_revoked_at timestamptz,
        store_app_user_id text,
        store_product_id text,
        comp_expires_at timestamptz
      );
      create table credit_calls (tenant_id uuid, event_created bigint);
      create function set_tenant_monthly_credits(uuid, int, int, bigint) returns void
      language plpgsql as $$
      begin
        if $4 = 9999 then raise exception 'credit refresh failed'; end if;
        insert into credit_calls values ($1, $4);
      end $$;
    `);
    await db.exec(migration);
  });

  afterAll(async () => { await db.close(); });

  async function seed(status: string, subscriptionId: string, eventMs: number) {
    await db.query("delete from credit_calls");
    await db.query("delete from tenant_subscriptions");
    await db.query(
      `insert into tenant_subscriptions
       (tenant_id, plan, status, tier, source, shopify_shop, shopify_subscription_id,
        store_event_created, tier_event_created, updated_at)
       values ($1, 'team', $2, 'pro', 'shopify', 'acme.myshopify.com', $3, $4::bigint, $4::bigint / 1000, now())`,
      [TENANT, status, subscriptionId, eventMs],
    );
  }

  async function apply(subscriptionId: string | null, tier: string | null, status: string, eventMs: number, shop = "acme.myshopify.com") {
    return db.query<{ outcome: string }>(
      `select apply_shopify_subscription_state(
        $1, $6, $2, $3, $4, null, false, $5
      ) as outcome`,
      [TENANT, subscriptionId, tier, status, eventMs, shop],
    );
  }

  it("does not let a late cancellation for an old ID clear the live replacement", async () => {
    await seed("active", "gid://shopify/AppSubscription/new", 2000);
    expect((await apply("gid://shopify/AppSubscription/old", null, "canceled", 3000)).rows[0].outcome).toBe("stale");
    const row = await db.query<{ tier: string; status: string; shopify_subscription_id: string }>(
      "select tier, status, shopify_subscription_id from tenant_subscriptions where tenant_id = $1",
      [TENANT],
    );
    expect(row.rows[0]).toEqual({ tier: "pro", status: "active", shopify_subscription_id: "gid://shopify/AppSubscription/new" });
  });

  it("applies state and credits in one transaction", async () => {
    await seed("canceled", "gid://shopify/AppSubscription/old", 2000);
    expect((await apply("gid://shopify/AppSubscription/new", "growth", "active", 3000)).rows[0].outcome).toBe("applied");
    expect((await db.query<{ event_created: number }>("select event_created from credit_calls")).rows).toEqual([{ event_created: 3 }]);

    await expect(apply("gid://shopify/AppSubscription/new", "pro", "active", 9_999_000)).rejects.toThrow("credit refresh failed");
    const row = await db.query<{ tier: string; store_event_created: number }>(
      "select tier, store_event_created from tenant_subscriptions where tenant_id = $1",
      [TENANT],
    );
    expect(row.rows[0]).toEqual({ tier: "growth", store_event_created: 3000 });
  });

  it("revives only against the exact canceled-row watermark", async () => {
    await seed("canceled", "gid://shopify/AppSubscription/canceled", 4000);
    const stale = await db.query<{ outcome: string }>(
      `select apply_verified_shopify_subscription_state(
        $1, 'acme.myshopify.com', 'gid://shopify/AppSubscription/current', 'pro', 'active', null, false, 3000, 5000
      ) as outcome`,
      [TENANT],
    );
    expect(stale.rows[0].outcome).toBe("stale");

    const applied = await db.query<{ outcome: string }>(
      `select apply_verified_shopify_subscription_state(
        $1, 'acme.myshopify.com', 'gid://shopify/AppSubscription/current', 'pro', 'active', null, false, 4000, 5000
      ) as outcome`,
      [TENANT],
    );
    expect(applied.rows[0].outcome).toBe("applied");
  });

  it("refuses cross-shop and already-live verified writes", async () => {
    await seed("active", "gid://shopify/AppSubscription/live", 4000);
    expect((await apply("gid://shopify/AppSubscription/other", "pro", "active", 5000, "other.myshopify.com")).rows[0].outcome)
      .toBe("other_shop_active");

    const live = await db.query<{ outcome: string }>(
      `select apply_verified_shopify_subscription_state(
        $1, 'acme.myshopify.com', 'gid://shopify/AppSubscription/live', 'pro', 'active', null, false, 4000, 5000
      ) as outcome`,
      [TENANT],
    );
    expect(live.rows[0].outcome).toBe("stale");

    const missing = await db.query<{ outcome: string }>(
      `select apply_verified_shopify_subscription_state(
        $1, 'acme.myshopify.com', 'gid://shopify/AppSubscription/live', 'pro', 'active', null, false, 4000, 5000
      ) as outcome`,
      [OTHER_TENANT],
    );
    expect(missing.rows[0].outcome).toBe("stale");
  });

  it("does not let one shop pay for two workspaces", async () => {
    await seed("canceled", "gid://shopify/AppSubscription/old", 2000);
    await db.query(
      `insert into tenant_subscriptions
       (tenant_id, plan, status, tier, source, shopify_shop, shopify_subscription_id,
        store_event_created, tier_event_created, updated_at)
       values ($1, 'team', 'active', 'pro', 'shopify', 'acme.myshopify.com',
        'gid://shopify/AppSubscription/other', 2000, 2, now())`,
      [OTHER_TENANT],
    );
    expect((await apply("gid://shopify/AppSubscription/new", "growth", "active", 3000)).rows[0].outcome)
      .toBe("shop_in_use");
  });
});
