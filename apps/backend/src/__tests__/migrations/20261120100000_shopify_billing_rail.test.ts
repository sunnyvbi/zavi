import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const code = (f: string) =>
  readFileSync(join(dir, f), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

const sql = code("20261120100000_shopify_billing_rail.sql");
const repairSql = code("20261120130000_fix_shopify_billing_ordering.sql");
const fn = (source: string, name: string) => {
  const start = source.indexOf(`create or replace function ${name}(`);
  const end = source.indexOf("$$;", start);
  return source.slice(start, end);
};
const originalShopify = fn(sql, "apply_shopify_subscription_state");
const shopify = fn(repairSql, "apply_shopify_subscription_state");
const verifiedShopify = fn(repairSql, "apply_verified_shopify_subscription_state");
const stripe = fn(sql, "apply_subscription_state");
const store = fn(sql, "apply_store_subscription_state");

describe("the Shopify writer", () => {
  it("admits shopify as a source and keys the row on the Shopify subscription", () => {
    expect(sql).toMatch(/check \(source in \('stripe', 'app_store', 'play_store', 'test_store', 'shopify'\)\)/);
    expect(sql).toMatch(/create unique index if not exists tenant_subscriptions_shopify_subscription_id_key on tenant_subscriptions \(shopify_subscription_id\) where shopify_subscription_id is not null;/);
  });

  it("refuses to overwrite a live Stripe or store plan, a refund block, a grandfathered row, or a shop paying for another workspace", () => {
    expect(shopify).toMatch(/return 'stripe_active';/);
    expect(shopify).toMatch(/if v_row.source in \('app_store', 'play_store', 'test_store'\) and v_row.status in \('active', 'trialing', 'past_due'\) then return 'store_active';/);
    expect(shopify).toMatch(/if v_row.credits_revoked_at is not null and p_tier is not null then return 'refund_blocked';/);
    expect(shopify).toMatch(/if v_row.grandfathered then return 'grandfathered';/);
    expect(shopify).toMatch(/if v_row.source = 'shopify' and v_row.status in \('active', 'trialing', 'past_due'\) and v_row.shopify_shop is distinct from p_shop then return 'other_shop_active';/);
    expect(shopify).toMatch(/where shopify_shop = p_shop and tenant_id <> p_tenant_id and source = 'shopify' and status in \('active', 'trialing', 'past_due'\) \) then return 'shop_in_use';/);
  });

  it("keeps the applied migration immutable and replaces its writer in a new migration", () => {
    expect(originalShopify).not.toMatch(/other_shop_active|set_tenant_monthly_credits/);
    expect(shopify).toMatch(/return 'other_shop_active';/);
  });

  it("orders every event by the shared watermark and refreshes credits atomically", () => {
    expect(shopify).toMatch(/if p_event_ms < v_row.store_event_created then return 'stale';/);
    expect(shopify).toMatch(/if p_event_ms = v_row.store_event_created then return 'replay';/);
    expect(shopify).not.toMatch(/v_effective_event_ms|v_row.status = 'canceled'/);
    expect(shopify).toMatch(/perform set_tenant_monthly_credits\( p_tenant_id, null::int, null::int, p_event_ms \/ 1000 \);/);
    expect(verifiedShopify).toMatch(/v_row.store_event_created is distinct from p_expected_event_ms/);
  });

  it("stamps the source and clears the other rails' keys when it writes", () => {
    expect(shopify).toMatch(/source = excluded.source, shopify_shop = excluded.shopify_shop, shopify_subscription_id = excluded.shopify_subscription_id, stripe_subscription_id = null, store_app_user_id = null, store_product_id = null,/);
    expect(shopify).toMatch(/'shopify', p_shop, p_shopify_subscription_id,/);
  });

  it("is service-role only", () => {
    const sig = "apply_shopify_subscription_state\\(uuid, text, text, text, text, timestamptz, boolean, bigint\\)";
    expect(repairSql).toMatch(new RegExp(`revoke all on function ${sig} from public, anon, authenticated;`));
    expect(repairSql).toMatch(new RegExp(`grant execute on function ${sig} to service_role;`));
  });
});

describe("the other writers step aside for a live Shopify plan", () => {
  it("Stripe", () => {
    expect(stripe).toMatch(/and not \( coalesce\(tenant_subscriptions.source, 'stripe'\) in \('app_store', 'play_store', 'test_store', 'shopify'\) and tenant_subscriptions.status in \('active', 'trialing', 'past_due'\) \);/);
    expect(stripe).toMatch(/if v_source = 'shopify' and v_status in \('active', 'trialing', 'past_due'\) then return 'shopify_active';/);
    expect(stripe).toMatch(/source = 'stripe', store_app_user_id = null, shopify_shop = null, shopify_subscription_id = null,/);
  });

  it("the App Store and Play rail", () => {
    expect(store).toMatch(/if v_row.source = 'shopify' and v_row.status in \('active', 'trialing', 'past_due'\) then return 'shopify_active';/);
    expect(store).toMatch(/stripe_subscription_id = null, shopify_shop = null, shopify_subscription_id = null,/);
  });
});
