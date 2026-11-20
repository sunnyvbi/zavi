import type Stripe from "stripe";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ record: vi.fn(), tier: vi.fn(), locked: vi.fn(), checkout: vi.fn(), insertError: null as { code: string } | null, rpc: vi.fn(), from: vi.fn(), retrieve: vi.fn(), create: vi.fn(), setup: vi.fn(), disputes: vi.fn(), refunds: vi.fn(), owned: vi.fn(), get: vi.fn(), post: vi.fn(), setupCreate: vi.fn(), listPms: vi.fn(), pmRetrieve: vi.fn(), cancel: vi.fn(), piList: vi.fn(), ins: [] as Array<{ table: string; key: string; values: unknown[] }>, updates: [] as Array<{ table: string; value: Record<string, unknown> }>, others: [] as Array<Record<string, unknown>> }));
vi.mock("@/services/decisions/ad-changes", () => ({ recordAdObjectChanges: m.record }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: m.locked }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/services/ads-wallet/stripe-client", () => {
  const stripe = { checkout: { sessions: { create: m.checkout } }, paymentIntents: { retrieve: m.retrieve, create: m.create, cancel: m.cancel, list: m.piList }, setupIntents: { retrieve: m.setup, create: m.setupCreate }, customers: { listPaymentMethods: m.listPms }, paymentMethods: { retrieve: m.pmRetrieve }, disputes: { list: m.disputes }, refunds: { list: m.refunds } };
  return { adsStripe: () => stripe, requireAdsStripe: () => stripe };
});
vi.mock("@/services/connectors/chatgpt-ads/workspace", () => ({ ownedCampaign: m.owned, fundingArgument: () => 5_000_000 }));
vi.mock("@/services/connectors/chatgpt-ads/http", () => ({ chatgptAdsGet: m.get, chatgptAdsPost: m.post }));
import { applyWalletEvent, completeSetup, createSetup, CREATOR_CONSENT_VERSION, fundingEnabled, listCards, orderStatus, payWithCard, selectCard, lifetimeSpend, settleCampaign, refillWallet, REFILL_APPROVAL_MESSAGE, REFILL_DECLINED_MESSAGE, REFILL_PAUSED_MESSAGE, REFILL_UNFINISHED_MESSAGE, reserveCampaign, startFunding } from "../wallet";
let wallet: Record<string, unknown>, order: Record<string, unknown>;
const event = (type: string, object: unknown) => ({ type, data: { object }, created: 100 }) as Stripe.Event;
beforeEach(() => {
  vi.resetAllMocks(); m.post.mockResolvedValue({ id: "c1", status: "paused" }); m.record.mockResolvedValue(1); m.others = []; m.tier.mockResolvedValue({ allowed: true, enforced: true }); m.locked.mockResolvedValue(false); m.updates.length = 0; m.ins.length = 0; m.insertError = null;
  m.checkout.mockResolvedValue({ url: "https://checkout.example/session" });
  vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "true"); vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", "test");
  wallet = { tenant_id: "t1", stripe_customer_id: "cus1", payment_method_id: "pm1", auto_refill_enabled: true, setup_request_id: null };
  order = { id: "order1", tenant_id: "t1", kind: "topup", amount_cents: 10000, status: "pending", created_at: new Date().toISOString() };
  m.from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    let inserted = false;
    let tenantScope: unknown;
    let list = false;
    chain.range = () => { list = true; return chain; };
    chain.neq = () => { list = true; return chain; };
    for (const method of ["not", "gte", "order"]) chain[method] = () => chain;
    chain.in = (key: string, values: unknown[]) => { m.ins.push({ table, key, values }); return chain; };
    chain.insert = () => { inserted = true; return chain; };
    for (const method of ["select", "eq", "is", "upsert"]) chain[method] = () => chain;
    chain.update = (value: Record<string, unknown>) => { m.updates.push({ table, value }); return chain; };
    chain.eq = (key: string, value: unknown) => { if (key === "tenant_id") tenantScope = value; return chain; };
    const result = () => list ? { data: m.others, error: null } : ({ data: table === "ads_wallets" ? wallet : tenantScope && tenantScope !== order.tenant_id ? null : order, error: inserted ? m.insertError : null });
    chain.single = async () => result();
    chain.maybeSingle = async () => result();
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return chain;
  });
  m.refunds.mockImplementation(async () => ({ data: [{ id: "re1", amount: (await m.retrieve()).latest_charge.amount_refunded, currency: "usd", status: "succeeded" }], has_more: false }));
  m.rpc.mockResolvedValue({ data: null, error: null });
  m.retrieve.mockResolvedValue({ id: "pi1", customer: "cus1", status: "succeeded", currency: "usd", amount: 10000, amount_received: 10000, metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" }, latest_charge: { id: "ch1", disputed: false, amount_refunded: 0 } });
});
afterEach(() => { vi.unstubAllEnvs(); });
it("credits only a matched payment's net amount through the atomic ledger", async () => {
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi1" }));
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_apply_payment", { p_order_id: "order1", p_payment_intent_id: "pi1", p_net_cents: 10000, p_event_created: 100 });
});
it("a credited manual top-up clears only the auto-refill decline, unfinished-refill and bank-approval errors", async () => {
  await applyWalletEvent(event("payment_intent.succeeded", { id: "pi1" }));
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: { last_error: null } });
  expect(m.ins).toContainEqual({ table: "ads_wallets", key: "last_error", values: [REFILL_DECLINED_MESSAGE, REFILL_UNFINISHED_MESSAGE, REFILL_APPROVAL_MESSAGE] });
});
it.each([
  ["a refill's own payment", () => { order.kind = "refill"; }, "payment_intent.succeeded"],
  ["a fully refunded top-up", () => { m.retrieve.mockResolvedValue({ id: "pi1", customer: "cus1", status: "succeeded", currency: "usd", amount: 10000, amount_received: 10000, metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" }, latest_charge: { id: "ch1", disputed: false, amount_refunded: 10000 } }); }, "charge.refunded"],
])("%s leaves the founder's error in place", async (_label, arrange, type) => {
  arrange();
  await applyWalletEvent(event(type, type === "charge.refunded" ? { payment_intent: "pi1" } : { id: "pi1" }));
  expect(m.updates).not.toContainEqual({ table: "ads_wallets", value: { last_error: null } });
});
it("refuses a paid order belonging to a different Stripe customer", async () => {
  wallet.stripe_customer_id = "different";
  await expect(applyWalletEvent(event("payment_intent.succeeded", { id: "pi1" }))).rejects.toThrow("does not match");
  expect(m.rpc).not.toHaveBeenCalled();
});
it("reconciles refunds using the current Stripe charge, not the old event payload", async () => {
  const pi = await m.retrieve(); pi.latest_charge.amount_refunded = 2500;
  m.retrieve.mockResolvedValue(pi);
  await applyWalletEvent(event("charge.refunded", { payment_intent: "pi1", amount_refunded: 100 }));
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_apply_payment", expect.objectContaining({ p_net_cents: 7500 }));
});
it("does not re-enable a mandate after the user disabled it", async () => {
  order.kind = "setup";
  await applyWalletEvent(event("checkout.session.completed", { mode: "setup", customer: "cus1", setup_intent: "seti1", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } }));
  expect(m.setup).not.toHaveBeenCalled(); expect(m.updates).toEqual([]);
});
it("reuses the durable refill id and never optimistically credits a successful charge", async () => {
  order.kind = "refill"; m.rpc.mockResolvedValue({ data: "order1", error: null });
  m.create.mockResolvedValue({ id: "pi1", status: "succeeded" });
  await refillWallet("t1"); await refillWallet("t1");
  expect(m.create).toHaveBeenCalledTimes(2);
  for (const call of m.create.mock.calls) expect(call[1]).toEqual({ idempotencyKey: "ads_refill_order1" });
  expect(m.rpc.mock.calls.every(([name]) => name === "ads_wallet_claim_refill")).toBe(true);
});
it("disables refills after an ambiguous Stripe failure without discarding the pending order", async () => {
  m.rpc.mockResolvedValue({ data: "order1", error: null }); m.create.mockRejectedValue(Object.assign(new Error("timeout"), { type: "StripeConnectionError" }));
  await refillWallet("t1");
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: expect.objectContaining({ auto_refill_enabled: false }) });
  expect(m.updates.some(u => "pending_refill_id" in u.value)).toBe(false);
});
it("never treats missing lifetime metrics as zero available spend", async () => {
  m.owned.mockResolvedValue({ binding: { id: "binding-c1" }, key: "key", campaign: { id: "c1", created_at: Math.floor(Date.now() / 1000) } });
  m.get.mockImplementation(async (_key,path)=>path==="/ad_account"?{currency_code:"USD"}:{data:[]});
  await expect(reserveCampaign("t1", "c1", 100000000)).rejects.toThrow("could not be confirmed");
  expect(m.rpc).not.toHaveBeenCalled();
});
it("requests a window spanning an account-timezone midnight for a campaign created this hour", async () => {
  const created = Math.floor(Date.now() / 1000);
  m.owned.mockResolvedValue({ binding: { id: "binding-c1" }, key: "key", campaign: { id: "c1", created_at: created } });
  m.get.mockResolvedValue({ data: [{ campaign_id: "c1", spend: 0 }] });
  expect((await lifetimeSpend("t1", "c1")).cents).toBe(0);
  const query = m.get.mock.calls[0][2]; const range = JSON.parse(query.time_ranges[0]);
  expect(range.start).toBeLessThanOrEqual(created - 2 * 86400);
  expect(range.start % 3600).toBe(0); expect(range.end % 3600).toBe(0);
  expect(query.includes).toEqual(["zero_impression_items"]);
});

it("starts checkout for a new tenant-scoped order", async () => {
  expect(await startFunding("t1", "u1", 10000, "topup", "order1")).toEqual({ url: "https://checkout.example/session" });
  expect(m.checkout).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus1" }), { idempotencyKey: "ads_checkout_order1" });
});
it("reuses checkout on a duplicate request belonging to the same tenant", async () => {
  m.insertError = { code: "23505" };
  await startFunding("t1", "u1", 10000, "topup", "order1");
  expect(m.checkout).toHaveBeenCalledTimes(1);
});
it("does not start checkout for a duplicate order owned by another tenant", async () => {
  m.insertError = { code: "23505" }; order.tenant_id = "t2";
  await expect(startFunding("t1", "u1", 10000, "topup", "order1")).rejects.toThrow();
  expect(m.checkout).not.toHaveBeenCalled();
});
it("does not start checkout when order storage fails", async () => {
  m.insertError = { code: "08006" };
  await expect(startFunding("t1", "u1", 10000, "topup", "order1")).rejects.toThrow("storage is unavailable");
  expect(m.checkout).not.toHaveBeenCalled();
});

it("deducts only a $10 disputed amount from a $100 top-up and turns refill off", async () => {
  const pi = await m.retrieve(); pi.latest_charge.disputed = true;
  m.disputes.mockResolvedValue({ data: [{ id: "dp1", amount: 1000, currency: "usd", status: "needs_response" }], has_more: false });
  await applyWalletEvent(event("charge.dispute.created", { payment_intent: "pi1" }));
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_apply_payment", expect.objectContaining({ p_net_cents: 9000 }));
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: expect.objectContaining({ auto_refill_enabled: false, setup_request_id: null }) });
});
it("restores a won dispute's credit without re-enabling refills", async () => {
  const pi = await m.retrieve(); pi.latest_charge.disputed = true;
  m.disputes.mockResolvedValue({ data: [{ id: "dp1", amount: 1000, currency: "usd", status: "won" }] });
  await applyWalletEvent(event("charge.dispute.closed", { payment_intent: "pi1" }));
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_apply_payment", expect.objectContaining({ p_net_cents: 10000 }));
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: expect.objectContaining({ auto_refill_enabled: false }) });
});
it("revokes refill on a refund even when the event is a replay", async () => {
  const pi = await m.retrieve(); pi.latest_charge.amount_refunded = 10000;
  await applyWalletEvent(event("charge.refunded", { payment_intent: "pi1" }));
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_apply_payment", expect.objectContaining({ p_net_cents: 0 }));
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: expect.objectContaining({ auto_refill_enabled: false }) });
});
it("revokes refill after a downgrade without a claim or Stripe charge", async () => {
  m.tier.mockResolvedValue({ allowed: false, enforced: true });
  await refillWallet("t1");
  expect(m.create).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: expect.objectContaining({ auto_refill_enabled: false }) });
});
it("only pauses refill during a global channel lock: no claim, no charge, mandate kept, founder told", async () => {
  m.locked.mockResolvedValue(true);
  await refillWallet("t1");
  expect(m.create).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  expect(m.updates).toEqual([{ table: "ads_wallets", value: { last_error: REFILL_PAUSED_MESSAGE } }]);
});
it.each([
  ["a tier read error", () => m.tier.mockRejectedValue(new Error("db unavailable"))],
  ["an unreadable gate config (enforced:false)", () => m.tier.mockResolvedValue({ allowed: true, enforced: false })],
  ["an unreadable channel lock", () => m.locked.mockRejectedValue(new Error("config unavailable"))],
])("fails closed on %s: no claim, no charge, mandate kept", async (_label, arrange) => {
  arrange();
  await refillWallet("t1");
  expect(m.create).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  expect(m.updates).toEqual([]);
});
const stuckRefill = (extra: Record<string, unknown>) => {
  wallet = { ...wallet, pending_refill_id: "order1", balance_cents: 50000, threshold_cents: 5000, payment_method_id: "pm2" };
  order = { ...order, kind: "refill", ...extra };
  m.rpc.mockResolvedValue({ data: "order1", error: null });
};
const writes = () => m.updates.filter(u => JSON.stringify(u.value) !== JSON.stringify({ last_error: null }));
const claimed = () => m.rpc.mock.calls.some(([name]) => name === "ads_wallet_claim_refill");
it("keeps a refill whose charge is still processing: no new charge, no re-claim, auto-refill stays on", async () => {
  stuckRefill({ payment_intent_id: "pi1" });
  m.retrieve.mockResolvedValue({ id: "pi1", status: "processing", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } });
  await refillWallet("t1");
  expect(m.create).not.toHaveBeenCalled(); expect(claimed()).toBe(false); expect(m.cancel).not.toHaveBeenCalled();
  expect(writes()).toEqual([]);
});
it("re-enabled after a 3-D Secure refill: cancels the unfinished charge, releases it, and never replays the old order", async () => {
  stuckRefill({ payment_intent_id: "pi1" });
  m.retrieve.mockResolvedValue({ id: "pi1", status: "requires_action", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } });
  m.cancel.mockResolvedValue({ id: "pi1", status: "canceled" });
  m.rpc.mockResolvedValue({ data: null, error: null });
  await refillWallet("t1");
  expect(m.cancel).toHaveBeenCalledWith("pi1");
  expect(writes()).toEqual([{ table: "ads_wallets", value: { pending_refill_id: null } }, { table: "ads_wallet_orders", value: { status: "failed" } }]);
  expect(claimed()).toBe(true);
  expect(m.create).not.toHaveBeenCalled();
});
it("keeps a 3-D Secure refill pending when Stripe would not cancel it", async () => {
  stuckRefill({ payment_intent_id: "pi1" });
  m.retrieve.mockResolvedValue({ id: "pi1", status: "requires_action", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } });
  m.cancel.mockRejectedValue(new Error("timeout"));
  await refillWallet("t1");
  expect(writes()).toEqual([]); expect(claimed()).toBe(false); expect(m.create).not.toHaveBeenCalled();
});
it("after a Stripe timeout, finds the charge Stripe did make and waits for its webhook instead of charging again", async () => {
  stuckRefill({ payment_intent_id: null, created_at: new Date(Date.now() - 3600_000).toISOString() });
  m.piList.mockResolvedValue({ data: [{ id: "pi_other", status: "succeeded", metadata: { kind: "chatgpt_ads_wallet", order_id: "topup9" } }, { id: "pi1", status: "succeeded", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } }], has_more: false });
  await refillWallet("t1");
  expect(m.piList).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus1" }));
  expect(writes()).toEqual([{ table: "ads_wallet_orders", value: { payment_intent_id: "pi1" } }]);
  expect(claimed()).toBe(false); expect(m.create).not.toHaveBeenCalled();
});
it("after a Stripe timeout that made no charge, releases the order so a new card can refill", async () => {
  stuckRefill({ payment_intent_id: null, created_at: new Date(Date.now() - 3600_000).toISOString() });
  m.piList.mockResolvedValue({ data: [], has_more: false });
  m.rpc.mockResolvedValue({ data: null, error: null });
  await refillWallet("t1");
  expect(writes()).toEqual([{ table: "ads_wallets", value: { pending_refill_id: null } }, { table: "ads_wallet_orders", value: { status: "failed" } }]);
  expect(claimed()).toBe(true); expect(m.create).not.toHaveBeenCalled();
});
it("does not release a timed-out refill while Stripe's charge list cannot be fully read", async () => {
  stuckRefill({ payment_intent_id: null, created_at: new Date(Date.now() - 3600_000).toISOString() });
  m.piList.mockResolvedValue({ data: [], has_more: true });
  await refillWallet("t1");
  expect(writes()).toEqual([]); expect(claimed()).toBe(false); expect(m.create).not.toHaveBeenCalled();
});
it("does not look up or release a refill created minutes ago, which may still be in flight", async () => {
  stuckRefill({ payment_intent_id: null, created_at: new Date(Date.now() - 60_000).toISOString() });
  await refillWallet("t1");
  expect(m.piList).not.toHaveBeenCalled(); expect(writes()).toEqual([]); expect(claimed()).toBe(false); expect(m.create).not.toHaveBeenCalled();
});
it("a fresh refill still processing at Stripe is left for its webhook without switching auto-refill off", async () => {
  order.kind = "refill"; m.rpc.mockResolvedValue({ data: "order1", error: null });
  m.create.mockResolvedValue({ id: "pi1", status: "processing" });
  await refillWallet("t1");
  expect(writes()).toEqual([{ table: "ads_wallet_orders", value: { payment_intent_id: "pi1" } }]);
});
it("fails a definitively declined refill and releases the pending pointer", async () => {
  order.kind = "refill"; m.rpc.mockResolvedValue({ data: "order1", error: null });
  m.create.mockRejectedValue(Object.assign(new Error("card_declined"), { type: "StripeCardError", payment_intent: { status: "requires_payment_method" } }));
  await refillWallet("t1");
  expect(m.updates).toContainEqual({ table: "ads_wallet_orders", value: { status: "failed" } });
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: expect.objectContaining({ pending_refill_id: null, auto_refill_enabled: false }) });
});
it("does not apply a new refill amount until the setup is confirmed by Stripe", async () => {
  order = { ...order, kind: "setup", amount_cents: 20000 };
  await startFunding("t1", "u1", 20000, "setup", "order1");
  expect(m.updates.some(u => u.table === "ads_wallets" && "refill_cents" in u.value)).toBe(false);
  wallet.setup_request_id = "order1";
  m.setup.mockResolvedValue({ status: "succeeded", customer: "cus1", payment_method: "pm2" });
  await applyWalletEvent(event("checkout.session.completed", { mode: "setup", customer: "cus1", setup_intent: "seti1", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } }));
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: expect.objectContaining({ refill_cents: 20000, payment_method_id: "pm2", auto_refill_enabled: true }) });
});
it.each([
  [{ code: "P0001", message: "ads_balance_insufficient" }, "ads_balance_insufficient"],
  [{ code: "08006", message: "connection failure" }, "ads_reservation_unavailable"],
  [{ code: "P0001", message: "campaign ownership conflict" }, "ads_reservation_unavailable"],
])("distinguishes insufficient balance from storage failures %j", async (error, code) => {
  m.owned.mockResolvedValue({ binding: { id: "binding-c1" }, key: "key", campaign: { id: "c1", created_at: Math.floor(Date.now() / 1000) } });
  m.get.mockImplementation(async (_key, path) => path === "/ad_account" ? { currency_code: "USD" } : { data: [{ campaign_id: "c1", spend: 0 }] });
  m.rpc.mockResolvedValue({ error });
  await expect(reserveCampaign("t1", "c1", 100000000)).rejects.toMatchObject({ code });
});

it.each(["failed", "canceled"])("restores a %s refund without renewing the refill mandate", async status => {
  const pi = await m.retrieve(); pi.latest_charge.amount_refunded = 10000;
  m.refunds.mockResolvedValue({ data: [{ id: "re1", amount: 10000, currency: "usd", status }], has_more: false });
  await applyWalletEvent(event("refund.failed", { payment_intent: "pi1" }));
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_apply_payment", expect.objectContaining({ p_net_cents: 10000 }));
  expect(m.updates).toContainEqual({ table: "ads_wallets", value: expect.objectContaining({ auto_refill_enabled: false }) });
});
it("holds pending refunds and reconciles every refund page", async () => {
  m.refunds.mockResolvedValueOnce({ data: [{ id: "re1", amount: 1000, currency: "usd", status: "pending" }], has_more: true }).mockResolvedValueOnce({ data: [{ id: "re2", amount: 2000, currency: "usd", status: "succeeded" }], has_more: false });
  await applyWalletEvent(event("refund.created", { payment_intent: "pi1" }));
  expect(m.refunds).toHaveBeenLastCalledWith({ charge: "ch1", limit: 100, starting_after: "re1" });
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_apply_payment", expect.objectContaining({ p_net_cents: 7000 }));
});
it("does not restore credit when refund inventory cannot be read completely", async () => {
  m.refunds.mockResolvedValue({ data: [], has_more: true });
  await expect(applyWalletEvent(event("refund.updated", { payment_intent: "pi1" }))).rejects.toThrow("completely read");
  expect(m.rpc).not.toHaveBeenCalled();
});

it.each([{ balance: 5000, pause: true }, { balance: 10000, pause: false }])("reporting failure preserves settlement failure and pauses only known underfunded exposure: %j", async ({ balance, pause }) => {
  wallet.balance_cents = balance;
  m.from.mockImplementation((table: string) => {
    const q: any = { select: () => q, eq: () => q, order: () => q, range: () => q, upsert: () => q, single: async () => ({ data: wallet, error: null }), then: (done: any) => Promise.resolve({ data: table === "ads_campaign_reservations" ? [{ reserved_cents: 10000 }] : wallet, error: null }).then(done) };
    return q;
  });
  m.owned.mockResolvedValue({ binding: { id: "binding-c1" }, key: "key", campaign: { id: "c1", status: "active", created_at: Math.floor(Date.now() / 1000) } });
  m.get.mockRejectedValue(new Error("Reporting unavailable"));
  await expect(settleCampaign("t1", "c1")).rejects.toThrow("Reporting unavailable");
  expect(m.rpc).not.toHaveBeenCalled();
  if (pause) { expect(m.post).toHaveBeenCalledWith("key", "/campaigns/c1", { status: "paused" }); expect(m.record).toHaveBeenCalledWith("t1", [expect.objectContaining({ source: "zavi", after_status: "PAUSED" })]); }
  else expect(m.post).not.toHaveBeenCalled();
});
const insights = (spend: number) => ({ data: [{ campaign_id: "c1", spend }], has_more: false });
const campaignRow = (over: Partial<Record<string, unknown>>) => ({ binding: { id: "binding-c1" }, key: "key", campaign: { id: "c1", status: "paused", created_at: Math.floor(Date.now() / 1000) - 10 * 86400, ...over } });
it("a campaign past its end date plus the reporting grace finalizes: settle AND release, no plain settle", async () => {
  m.owned.mockResolvedValue(campaignRow({ end_time: Math.floor(Date.now() / 1000) - 3 * 86400 }));
  m.get.mockResolvedValue(insights(40.18));
  m.rpc.mockResolvedValue({ data: null, error: null });
  await settleCampaign("t1", "c1");
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_finalize_bound", expect.objectContaining({ p_campaign_binding_id: "binding-c1", p_final_spend_cents: 4018 }));
  expect(m.rpc).not.toHaveBeenCalledWith("ads_wallet_settle_bound", expect.anything());
});
it("a campaign archived at least the grace ago finalizes too, whatever its schedule", async () => {
  m.owned.mockResolvedValue(campaignRow({ status: "archived", updated_at: Math.floor(Date.now() / 1000) - 3 * 86400 }));
  m.get.mockResolvedValue(insights(10));
  m.rpc.mockResolvedValue({ data: null, error: null });
  await settleCampaign("t1", "c1");
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_finalize_bound", expect.objectContaining({ p_final_spend_cents: 1000 }));
});
it("a campaign archived minutes ago keeps its hold: the spend read stops at the last whole hour", async () => {
  wallet.balance_cents = 10_000; walletWithFunding();
  m.owned.mockResolvedValue(campaignRow({ status: "archived", updated_at: Math.floor(Date.now() / 1000) - 600 }));
  m.get.mockResolvedValue(insights(10));
  m.rpc.mockResolvedValue({ data: null, error: null });
  await settleCampaign("t1", "c1");
  expect(m.rpc).not.toHaveBeenCalledWith("ads_wallet_finalize_bound", expect.anything());
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_settle_bound", expect.objectContaining({ p_spend_cents: 1000 }));
});
const walletWithFunding = () => m.from.mockImplementation((table: string) => {
  const q: any = { select: () => q, eq: () => q, order: () => q, range: () => q, upsert: () => q, single: async () => ({ data: wallet, error: null }), then: (done: any) => Promise.resolve({ data: table === "ads_campaign_reservations" ? [{ reserved_cents: 1000 }] : wallet, error: null }).then(done) };
  return q;
});
it("inside the schedule, or ended less than the grace ago, settles normally and keeps the hold", async () => {
  wallet.balance_cents = 10_000; walletWithFunding();
  for (const end_time of [Math.floor(Date.now() / 1000) + 86400, Math.floor(Date.now() / 1000) - 3600]) {
    m.rpc.mockClear();
    m.owned.mockResolvedValue(campaignRow({ end_time }));
    m.get.mockResolvedValue(insights(5));
    m.rpc.mockResolvedValue({ data: null, error: null });
    await settleCampaign("t1", "c1");
    expect(m.rpc).toHaveBeenCalledWith("ads_wallet_settle_bound", expect.objectContaining({ p_spend_cents: 500 }));
    expect(m.rpc).not.toHaveBeenCalledWith("ads_wallet_finalize_bound", expect.anything());
  }
});
it("an active campaign whose hold was released is reserved again from its live budget", async () => {
  wallet.balance_cents = 10_000;
  m.from.mockImplementation((table: string) => {
    const q: any = { select: () => q, eq: () => q, order: () => q, range: () => q, upsert: () => q, single: async () => ({ data: wallet, error: null }), maybeSingle: async () => ({ data: table === "ads_campaign_reservations" ? { reserved_cents: 0 } : wallet, error: null }), then: (done: any) => Promise.resolve({ data: table === "ads_campaign_reservations" ? [{ reserved_cents: 500 }] : wallet, error: null }).then(done) };
    return q;
  });
  m.owned.mockResolvedValue(campaignRow({ status: "active", end_time: Math.floor(Date.now() / 1000) + 5 * 86400 }));
  m.get.mockImplementation(async (_k: string, path: string) => path === "/ad_account" ? { currency_code: "USD" } : insights(5));
  m.rpc.mockResolvedValue({ data: null, error: null });
  await settleCampaign("t1", "c1");
  expect(m.rpc).toHaveBeenCalledWith("ads_wallet_reserve_bound", expect.objectContaining({ p_campaign_binding_id: "binding-c1", p_lifetime_cents: 500 }));
  expect(m.post).not.toHaveBeenCalled();
});
it("an active campaign with no hold is paused when it cannot be reserved again, whatever the error", async () => {
  wallet.balance_cents = 10_000;
  m.from.mockImplementation((table: string) => {
    const q: any = { select: () => q, eq: () => q, order: () => q, range: () => q, upsert: () => q, single: async () => ({ data: wallet, error: null }), maybeSingle: async () => ({ data: table === "ads_campaign_reservations" ? { reserved_cents: 0 } : wallet, error: null }), then: (done: any) => Promise.resolve({ data: wallet, error: null }).then(done) };
    return q;
  });
  m.owned.mockResolvedValue(campaignRow({ status: "active", end_time: Math.floor(Date.now() / 1000) + 5 * 86400 }));
  m.get.mockImplementation(async (_k: string, path: string) => { if (path === "/ad_account") throw new Error("HTTP 500"); return insights(5); });
  m.rpc.mockResolvedValue({ data: null, error: null });
  await expect(settleCampaign("t1", "c1")).rejects.toThrow("HTTP 500");
  expect(m.post).toHaveBeenCalledWith("key", "/campaigns/c1", { status: "paused" });
});
it("an unreadable final report never releases: unknown spend is not zero", async () => {
  wallet.balance_cents = 10_000; walletWithFunding();
  m.owned.mockResolvedValue(campaignRow({ end_time: Math.floor(Date.now() / 1000) - 3 * 86400 }));
  m.get.mockRejectedValue(new Error("Reporting unavailable"));
  await expect(settleCampaign("t1", "c1")).rejects.toThrow("Reporting unavailable");
  expect(m.rpc).not.toHaveBeenCalled();
});
it("funding is on by default and only an explicit false or 0 turns it off", () => {
  vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "");
  expect(fundingEnabled()).toBe(true);
  vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "false");
  expect(fundingEnabled()).toBe(false);
  vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "0");
  expect(fundingEnabled()).toBe(false);
  vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "true");
  vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", "");
  expect(fundingEnabled()).toBe(false);
  vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", "   ");
  expect(fundingEnabled()).toBe(false);
});
it("never claims or charges a refill while funding is disabled", async () => {
  vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "false");
  await refillWallet("t1");
  expect(m.rpc).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled();
});
it("unticked refill: the setup page asks consent for creator hires only", async () => {
  order = { ...order, kind: "setup", amount_cents: 20000 };
  await startFunding("t1", "u1", 20000, "setup", "order1");
  const params = m.checkout.mock.calls[0][0];
  expect(params.custom_text.submit.message).toBe("Authorize Zavi to charge this card for creator hires Autopilot books within its caps.");
  expect(params.metadata).toEqual({ kind: "chatgpt_ads_wallet", order_id: "order1", creator_consent: CREATOR_CONSENT_VERSION, enable_refill: "0" });
  expect(params.setup_intent_data.metadata.creator_consent).toBe(CREATOR_CONSENT_VERSION);
});
it("ticked refill: the setup page asks consent for hires and refills, with the refill terms", async () => {
  order = { ...order, kind: "setup", amount_cents: 20000 };
  await startFunding("t1", "u1", 20000, "setup", "order1", true);
  const params = m.checkout.mock.calls[0][0];
  expect(params.custom_text.submit.message).toBe("Authorize Zavi to charge this card for ChatGPT ads refills and for creator hires Autopilot books within its caps. Refills are $200.00 whenever your ads balance falls below $50, up to $1,000 per UTC day. Disable auto-refill in the ChatGPT Ads channel at any time.");
  expect(params.metadata.enable_refill).toBe("1");
});
const confirmSetup = (meta: Record<string, string>) => applyWalletEvent(event("checkout.session.completed", { mode: "setup", customer: "cus1", setup_intent: "seti1", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1", creator_consent: CREATOR_CONSENT_VERSION, ...meta } }));
it("unticked refill: the card and consent are saved, refill is off", async () => {
  order = { ...order, kind: "setup", amount_cents: 20000 }; wallet.setup_request_id = "order1"; wallet.auto_refill_enabled = false;
  m.setup.mockResolvedValue({ status: "succeeded", customer: "cus1", payment_method: "pm2" });
  await confirmSetup({ enable_refill: "0" });
  const v = m.updates.find(u => u.table === "ads_wallets")!.value;
  expect(v.payment_method_id).toBe("pm2");
  expect(typeof v.creator_consent_at).toBe("string");
  expect(v.auto_refill_enabled).toBe(false);
  expect("refill_cents" in v).toBe(false);
});
it("ticked refill: refill turns on at the chosen amount, as before", async () => {
  order = { ...order, kind: "setup", amount_cents: 20000 }; wallet.setup_request_id = "order1";
  m.setup.mockResolvedValue({ status: "succeeded", customer: "cus1", payment_method: "pm2" });
  await confirmSetup({ enable_refill: "1" });
  expect(m.updates.find(u => u.table === "ads_wallets")!.value).toMatchObject({ payment_method_id: "pm2", auto_refill_enabled: true, refill_cents: 20000 });
});
it("a tenant whose refill is on re-saves unticked: refill turns off (the new card's consent excludes it)", async () => {
  order = { ...order, kind: "setup", amount_cents: 20000 }; wallet.setup_request_id = "order1"; wallet.auto_refill_enabled = true;
  m.setup.mockResolvedValue({ status: "succeeded", customer: "cus1", payment_method: "pm2" });
  await confirmSetup({ enable_refill: "0" });
  expect(m.updates.find(u => u.table === "ads_wallets")!.value.auto_refill_enabled).toBe(false);
});
it("records creator consent only for a setup whose page showed the widened text", async () => {
  order.kind = "setup"; wallet.setup_request_id = "order1";
  m.setup.mockResolvedValue({ status: "succeeded", customer: "cus1", payment_method: "pm2" });
  await confirmSetup({ enable_refill: "0" });
  expect(typeof m.updates.find(u => u.table === "ads_wallets")!.value.creator_consent_at).toBe("string");
  m.updates.length = 0;
  await applyWalletEvent(event("checkout.session.completed", { mode: "setup", customer: "cus1", setup_intent: "seti1", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } }));
  expect(m.updates.find(u => u.table === "ads_wallets")!.value.creator_consent_at).toBeNull();
});

const setupIntent = (over: Record<string, unknown> = {}) => ({ id: "seti1", status: "succeeded", customer: "cus1", payment_method: "pm2", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1", enable_refill: "0" }, ...over });
const walletUpdates = () => m.updates.filter(u => u.table === "ads_wallets").map(u => u.value);
const orderUpdates = () => m.updates.filter(u => u.table === "ads_wallet_orders").map(u => u.value);

it("lists only the wallet customer's cards with the server's consent version", async () => {
  m.listPms.mockResolvedValue({ data: [{ id: "pm1", card: { brand: "visa", last4: "5556", funding: "debit", exp_month: 1, exp_year: 2030 }, billing_details: { address: { city: "San Francisco", state: "CA" } } }] });
  const r = await listCards("t1");
  expect(m.listPms).toHaveBeenCalledWith("cus1", { type: "card", limit: 100 });
  expect(r.cards).toEqual([{ id: "pm1", brand: "visa", last4: "5556", funding: "debit", exp_month: 1, exp_year: 2030, city: "San Francisco", state: "CA" }]);
  expect(r).toMatchObject({ tenant_id: "t1", selected_id: "pm1", consent: { version: CREATOR_CONSENT_VERSION } });
});
it("refuses in-app card calls when the in-app flag is off", async () => {
  vi.stubEnv("CHATGPT_ADS_INAPP_PAYMENTS", "0");
  await expect(listCards("t1")).rejects.toMatchObject({ code: "ads_funding_unavailable" });
  await expect(payWithCard("t1", 10000, "order1", "pm1")).rejects.toMatchObject({ code: "ads_funding_unavailable" });
  expect(m.create).not.toHaveBeenCalled();
});
it("opens a setup order and marks creator consent only when the founder ticked it", async () => {
  order.kind = "setup"; order.amount_cents = 5000;
  m.setupCreate.mockResolvedValue({ id: "seti1", client_secret: "seti1_secret" });
  expect(await createSetup("t1", "u1", "order1", { amount: 5000, enableRefill: false, allowCreators: false })).toEqual({ client_secret: "seti1_secret", setup_intent_id: "seti1" });
  const [params, opts] = m.setupCreate.mock.calls[0];
  expect(params).toMatchObject({ customer: "cus1", usage: "off_session", payment_method_types: ["card"], metadata: { kind: "chatgpt_ads_wallet", order_id: "order1", enable_refill: "0" } });
  expect(params.metadata.creator_consent).toBeUndefined(); expect(opts).toEqual({ idempotencyKey: "ads_setup_order1" });
  expect(walletUpdates()).toContainEqual(expect.objectContaining({ setup_request_id: "order1", consent_user_id: "u1" }));
  await createSetup("t1", "u1", "order1", { amount: 5000, enableRefill: true, allowCreators: true });
  expect(m.setupCreate.mock.calls[1][0].metadata).toMatchObject({ creator_consent: CREATOR_CONSENT_VERSION, enable_refill: "1" });
});
it("completes a confirmed setup once and reports a superseded one as not applied", async () => {
  order.kind = "setup"; wallet.setup_request_id = "order1"; m.setup.mockResolvedValue(setupIntent());
  expect(await completeSetup("t1", "seti1")).toEqual({ applied: true });
  expect(walletUpdates()).toContainEqual(expect.objectContaining({ payment_method_id: "pm2", creator_consent_at: null, auto_refill_enabled: false, setup_request_id: null }));
  wallet.setup_request_id = null; m.updates.length = 0;
  expect(await completeSetup("t1", "seti1")).toEqual({ applied: false });
  expect(m.updates).toEqual([]);
});
it("rejects completing an unconfirmed or foreign setup", async () => {
  order.kind = "setup"; wallet.setup_request_id = "order1";
  m.setup.mockResolvedValue(setupIntent({ status: "requires_action" }));
  await expect(completeSetup("t1", "seti1")).rejects.toMatchObject({ code: "chatgpt_ads_card_not_ready" });
  m.setup.mockResolvedValue(setupIntent({ customer: "cus_other" }));
  await expect(completeSetup("t1", "seti1")).rejects.toMatchObject({ code: "chatgpt_ads_not_found" });
  expect(m.updates).toEqual([]);
});
it("saves an in-app card from setup_intent.succeeded and ignores the replay", async () => {
  order.kind = "setup"; wallet.setup_request_id = "order1";
  m.setup.mockResolvedValue(setupIntent({ metadata: { kind: "chatgpt_ads_wallet", order_id: "order1", enable_refill: "1", creator_consent: CREATOR_CONSENT_VERSION } }));
  await applyWalletEvent(event("setup_intent.succeeded", { id: "seti1", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } }));
  expect(walletUpdates()).toContainEqual(expect.objectContaining({ payment_method_id: "pm2", auto_refill_enabled: true, refill_cents: 10000, creator_consent_at: expect.any(String) }));
  wallet.setup_request_id = null; m.updates.length = 0; m.setup.mockClear();
  await applyWalletEvent(event("setup_intent.succeeded", { id: "seti1", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } }));
  expect(m.setup).not.toHaveBeenCalled(); expect(m.updates).toEqual([]);
});
it("ignores setup_intent.succeeded from other products", async () => {
  await applyWalletEvent(event("setup_intent.succeeded", { id: "seti9", metadata: { kind: "billing" } }));
  expect(m.from).not.toHaveBeenCalled();
});
it("selecting a saved card re-consents, clears a pending setup, and rejects a foreign card", async () => {
  m.pmRetrieve.mockResolvedValue({ id: "pm2", customer: "cus1" });
  await selectCard("t1", "u1", "pm2", { amount: 5000, enableRefill: true, allowCreators: false });
  expect(walletUpdates()).toContainEqual(expect.objectContaining({ payment_method_id: "pm2", setup_request_id: null, creator_consent_at: null, refill_cents: 5000, auto_refill_enabled: true, consent_user_id: "u1" }));
  m.updates.length = 0; m.pmRetrieve.mockResolvedValue({ id: "pm9", customer: "cus_other" });
  await expect(selectCard("t1", "u1", "pm9", { amount: 5000, enableRefill: false, allowCreators: true })).rejects.toMatchObject({ code: "chatgpt_ads_card_unknown" });
  expect(m.updates).toEqual([]);
});
it("a late setup confirmation cannot switch the card back after a selection", async () => {
  order.kind = "setup"; wallet.setup_request_id = null;
  m.setup.mockResolvedValue(setupIntent());
  await applyWalletEvent(event("setup_intent.succeeded", { id: "seti1", metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } }));
  expect(m.updates).toEqual([]);
});
it("pays with the shown card, stores the PaymentIntent, and never credits optimistically", async () => {
  m.create.mockResolvedValue({ id: "pi1", status: "succeeded" });
  expect(await payWithCard("t1", 10000, "order1", "pm1")).toEqual({ order_id: "order1", status: "pending" });
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 10000, customer: "cus1", payment_method: "pm1", confirm: true, use_stripe_sdk: true, metadata: { kind: "chatgpt_ads_wallet", order_id: "order1" } }), { idempotencyKey: "ads_pay_order1" });
  expect(orderUpdates()).toContainEqual({ payment_intent_id: "pi1" });
  expect(m.rpc).not.toHaveBeenCalled();
});
it("refuses a second card payment while another tab's payment is in flight", async () => {
  m.others = [{ ...order, id: "order0", payment_intent_id: "pi0" }];
  m.retrieve.mockResolvedValue({ id: "pi0", status: "processing" });
  await expect(payWithCard("t1", 10000, "order1", "pm1")).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
  m.retrieve.mockResolvedValue({ id: "pi0", status: "requires_action", client_secret: "s" });
  await expect(payWithCard("t1", 10000, "order1", "pm1")).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
  expect(m.create).not.toHaveBeenCalled();
  m.others = [{ ...order, id: "order0", payment_intent_id: "pi0", created_at: new Date(Date.now() - 2 * 3600_000).toISOString() }];
  m.cancel.mockRejectedValue(new Error("already succeeded"));
  await expect(payWithCard("t1", 10000, "order1", "pm1")).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
  expect(m.create).not.toHaveBeenCalled();
  m.cancel.mockResolvedValue({ id: "pi0", status: "canceled" });
  m.create.mockResolvedValue({ id: "pi1", status: "succeeded" });
  expect((await payWithCard("t1", 10000, "order1", "pm1")).status).toBe("pending");
  expect(m.cancel).toHaveBeenCalledWith("pi0");
  m.others = [{ ...order, id: "order0", payment_intent_id: "pi0" }]; m.retrieve.mockResolvedValue({ id: "pi0", status: "requires_payment_method" });
  expect((await payWithCard("t1", 10000, "order1", "pm1")).status).toBe("pending");
  expect(orderUpdates()).toContainEqual({ status: "failed" });
});
it("refuses to pay when the saved card changed in another tab", async () => {
  await expect(payWithCard("t1", 10000, "order1", "pm_old")).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
  expect(m.create).not.toHaveBeenCalled();
});
it("returns the 3DS client secret and reuses the same PaymentIntent on retry", async () => {
  m.create.mockResolvedValue({ id: "pi1", status: "requires_action", client_secret: "pi1_secret" });
  expect(await payWithCard("t1", 10000, "order1", "pm1")).toEqual({ order_id: "order1", status: "requires_action", client_secret: "pi1_secret" });
  order.payment_intent_id = "pi1"; m.retrieve.mockResolvedValue({ id: "pi1", status: "requires_action", client_secret: "pi1_secret" });
  expect((await payWithCard("t1", 10000, "order1", "pm1")).status).toBe("requires_action");
  expect(m.create).toHaveBeenCalledTimes(1);
});
it("fails the order on a decline and keeps the PaymentIntent id", async () => {
  m.create.mockRejectedValue(Object.assign(new Error("Your card was declined."), { type: "StripeCardError", payment_intent: { id: "pi_dec", status: "requires_payment_method" } }));
  await expect(payWithCard("t1", 10000, "order1", "pm1")).rejects.toMatchObject({ code: "chatgpt_ads_card_declined" });
  expect(orderUpdates()).toEqual([{ payment_intent_id: "pi_dec" }, { status: "failed" }]);
});
it("keeps the order pending on an ambiguous Stripe failure", async () => {
  m.create.mockRejectedValue(new Error("socket hang up"));
  await expect(payWithCard("t1", 10000, "order1", "pm1")).rejects.toThrow("socket hang up");
  expect(orderUpdates()).toEqual([]);
});
it("order status resolves a failed 3DS challenge to failed", async () => {
  order.payment_intent_id = "pi1"; m.retrieve.mockResolvedValue({ id: "pi1", status: "requires_payment_method" });
  expect(await orderStatus("t1", "order1")).toEqual({ order_id: "order1", status: "failed" });
  expect(orderUpdates()).toContainEqual({ status: "failed" });
  order.status = "paid";
  expect(await orderStatus("t1", "order1")).toEqual({ order_id: "order1", status: "paid" });
});
it("order status refuses an order from another tenant", async () => {
  await expect(orderStatus("t2", "order1")).rejects.toMatchObject({ code: "chatgpt_ads_not_found" });
});
it("never re-arms a card setup from a replayed request id", async () => {
  order.kind = "setup"; order.amount_cents = 5000; m.insertError = { code: "23505" };
  await expect(createSetup("t1", "u1", "order1", { amount: 5000, enableRefill: false, allowCreators: false })).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
  expect(m.setupCreate).not.toHaveBeenCalled(); expect(walletUpdates()).toEqual([]);
});
it("reports a card the webhook already saved as applied", async () => {
  order.kind = "setup"; wallet.setup_request_id = null; wallet.payment_method_id = "pm2"; m.setup.mockResolvedValue(setupIntent());
  expect(await completeSetup("t1", "seti1")).toEqual({ applied: true });
  expect(m.updates).toEqual([]);
});
it("a pay retry for an order the webhook already settled reports it instead of refusing", async () => {
  order.status = "paid"; order.payment_intent_id = "pi1";
  expect(await payWithCard("t1", 10000, "order1", "pm1")).toEqual({ order_id: "order1", status: "paid" });
  order.status = "failed";
  expect(await payWithCard("t1", 10000, "order1", "pm1")).toEqual({ order_id: "order1", status: "failed" });
  expect(m.create).not.toHaveBeenCalled(); expect(m.retrieve).not.toHaveBeenCalled();
});
it("reports an existing payment even after the saved card changed in another tab", async () => {
  order.payment_intent_id = "pi1"; m.retrieve.mockResolvedValue({ id: "pi1", status: "succeeded" });
  expect(await payWithCard("t1", 10000, "order1", "pm_old")).toEqual({ order_id: "order1", status: "pending" });
  order.status = "paid";
  expect(await payWithCard("t1", 10000, "order1", "pm_old")).toEqual({ order_id: "order1", status: "paid" });
  expect(m.create).not.toHaveBeenCalled();
});
it("order status fails a pending order that never got a PaymentIntent after 23h, and leaves a recent one pending", async () => {
  order.payment_intent_id = null;
  expect(await orderStatus("t1", "order1")).toEqual({ order_id: "order1", status: "pending" });
  expect(m.retrieve).not.toHaveBeenCalled();
  order.created_at = new Date(Date.now() - 24 * 3600_000).toISOString();
  expect(await orderStatus("t1", "order1")).toEqual({ order_id: "order1", status: "failed" });
  expect(m.updates.filter(u => u.table === "ads_wallet_orders").map(u => u.value)).toContainEqual({ status: "failed" });
});
it("never touches the prepaid wallet for a provider-billed (customer account) campaign", async () => {
  m.owned.mockResolvedValue({ key: "customer-key", campaign: { id: "c1" }, binding: { id: "b1", funding_source: "provider" } });
  await expect(reserveCampaign("t1", "c1", 100000000)).resolves.toBeUndefined();
  expect(m.get).not.toHaveBeenCalled();
  expect(m.rpc).not.toHaveBeenCalled();
});
