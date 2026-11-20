import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

const stripe = code(read("20260930152000_stripe_writes_respect_store_plans.sql"));
const store = code(read("20260930151000_store_subscription_write_path.sql"));
const stripeFn = stripe.slice(stripe.indexOf("create function apply_subscription_state("));
const storeFn = store.slice(store.indexOf("create or replace function apply_store_subscription_state("));

describe("C2: a Stripe plan releases the store account of the plan it replaced", () => {
  it("the Stripe takeover clears X's store_app_user_id", () => {
    const update = stripeFn.slice(stripeFn.indexOf("on conflict (tenant_id) do update set"), stripeFn.indexOf(" where tenant_subscriptions.grandfathered"));
    expect(update).toMatch(/source = 'stripe', store_app_user_id = null,/);
  });

  it("so Y's purchase no longer finds X as the store account's other live workspace", () => {
    expect(storeFn).toMatch(
      /if exists \( select 1 from tenant_subscriptions where store_app_user_id = p_store_app_user_id and tenant_id <> p_tenant_id and status in \('active', 'trialing', 'past_due'\) \) then return 'store_account_in_use';/,
    );
  });

  it("the takeover is still refused while a store plan is live", () => {
    expect(stripeFn).toMatch(
      /and not \( coalesce\(tenant_subscriptions.source, 'stripe'\) in \('app_store', 'play_store', 'test_store'\) and tenant_subscriptions.status in \('active', 'trialing', 'past_due'\) \);/,
    );
  });
});

describe("F2: a skipped Stripe write says why", () => {
  it("returns applied / store_active / skipped", () => {
    expect(stripe).toMatch(/drop function if exists apply_subscription_state\(uuid, text, text, text, text, timestamptz, boolean, bigint\);/);
    expect(stripeFn).toMatch(/\) returns text language plpgsql security definer set search_path = public, pg_temp as \$\$/);
    expect(stripeFn).toMatch(/if found then return 'applied'; end if;/);
    expect(stripeFn).toMatch(/return 'store_active';/);
    expect(stripeFn).toMatch(/return 'skipped';/);
  });

  it("keeps the grants after the drop", () => {
    const sig = "apply_subscription_state\\(uuid, text, text, text, text, timestamptz, boolean, bigint\\)";
    expect(stripe).toMatch(new RegExp(`revoke all on function ${sig} from public, anon, authenticated;`));
    expect(stripe).toMatch(new RegExp(`grant execute on function ${sig} to service_role;`));
  });
});

describe("F6: a reversed store refund restores the plan", () => {
  it("lifts the block only for the store customer whose refund set it", () => {
    expect(storeFn).toMatch(/p_refund_reversed boolean default false/);
    expect(storeFn).toMatch(
      /if v_row.credits_revoked_at is not null then if p_refund_reversed and v_row.store_app_user_id = p_store_app_user_id then v_unblock := true; elsif p_tier is not null or v_row.store_app_user_id is distinct from p_store_app_user_id then return 'refund_blocked'; end if; end if;/,
    );
    expect(storeFn).toMatch(
      /credits_revoked_at = case when p_refund then now\(\) when v_unblock then null else tenant_subscriptions.credits_revoked_at end/,
    );
    expect(storeFn).toMatch(
      /when v_unblock then least\(tenant_subscriptions.monthly_credits_event, p_event_ms \/ 1000 - 1\)/,
    );
  });

  it("is checked after the replay and stale watermarks, so a replay re-applies nothing", () => {
    expect(storeFn.indexOf("return 'replay'")).toBeLessThan(storeFn.indexOf("v_unblock := true"));
    expect(storeFn.indexOf("return 'stale'")).toBeLessThan(storeFn.indexOf("v_unblock := true"));
  });

  it("a reversal sharing its refund's millisecond is a new event, not a replay", () => {
    expect(storeFn).toMatch(
      /if p_event_ms = v_row.store_event_created and not \(p_refund_reversed and v_row.credits_revoked_at is not null\) then return 'replay'; end if;/,
    );
  });

  it("keeps the grants on the new signature", () => {
    const sig = "apply_store_subscription_state\\(uuid, text, text, text, text, text, timestamptz, boolean, bigint, boolean, boolean\\)";
    expect(store).toMatch(new RegExp(`revoke all on function ${sig} from public, anon, authenticated;`));
    expect(store).toMatch(new RegExp(`grant execute on function ${sig} to service_role;`));
  });

  it("a store refund is applied in the same locked write, with no separate revoke to be overtaken", () => {
    expect(storeFn).toMatch(/p_refund_reversed boolean default false, p_refund boolean default false \) returns text/);
    expect(storeFn).toMatch(/v_tier text := case when p_refund then null else p_tier end;/);
    expect(storeFn).toMatch(/v_status text := case when p_refund then 'canceled' else p_status end;/);
    expect(storeFn).toMatch(/monthly_credits = case when p_refund then 0 else tenant_subscriptions.monthly_credits end/);
    expect(storeFn).toMatch(/when p_refund then greatest\(tenant_subscriptions.monthly_credits_event, p_event_ms \/ 1000\)/);
    expect(storeFn).toMatch(/if p_refund then perform _credit_balance_touch\(p_tenant_id\); end if;/);
    expect(storeFn.indexOf("for update")).toBeLessThan(storeFn.indexOf("return 'stale'"));
    expect(store).not.toMatch(/revoke_store_credits/);
  });

  it("does not touch the Stripe refund path", () => {
    expect(stripe).not.toMatch(/revoke_tenant_credits|clear_credit_revocation/);
    expect(store).not.toMatch(/revoke_tenant_credits|clear_credit_revocation/);
  });
});
