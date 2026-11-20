vi.mock("@/services/logging/logEvent",()=>({logEvent:m.log}));
vi.mock("@/services/logging/alert",()=>({alert:m.alert}));
vi.mock("@/services/ads-wallet/providers", () => ({ settleBoundCampaign: m.settle }));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ settle: vi.fn(), refill: vi.fn(), entitled: vi.fn(), log: vi.fn(), alert: vi.fn(), wallets: [{ tenant_id: "t1" }] as Array<{ tenant_id: string }>, campaigns: [] as Array<{ campaign_binding_id: string }> }));
vi.mock("../../client", () => ({ inngest: { createFunction: (_config: unknown, _trigger: unknown, handler: unknown) => handler } }));
vi.mock("@/services/ads-wallet/wallet", () => ({ refillWallet: m.refill, ensureRefillEntitlement: m.entitled }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: (table: string) => {
  const q: any = { select: () => q, order: () => q, range: async (start: number, end: number) => ({ data: table === "ads_wallets" ? m.wallets.slice(start, end + 1) : m.campaigns.slice(start, end + 1), error: null }), eq: () => q };
  return q;
} }) }));
import { adsWalletBatchFn, chatgptAdsWalletFn } from "../chatgpt-ads-wallet";

const INNGEST_STEP_LIMIT = 1000;
type Sent = { id: string; name: string; data: { tenant_ids: string[] } };
function stepper() {
  const ids = new Set<string>();
  const counter = { steps: 0, sent: [] as Sent[] };
  const take = (id: string) => { if (ids.has(id)) throw new Error(`duplicate step ${id}`); ids.add(id); counter.steps++; };
  const step = {
    run: async (id: string, callback: () => unknown) => { take(id); return callback(); },
    sendEvent: async (id: string, payload: Sent | Sent[]) => { take(id); counter.sent.push(...(Array.isArray(payload) ? payload : [payload])); },
  };
  return { step, counter };
}
async function tick() {
  const clock = stepper();
  const out = await (chatgptAdsWalletFn as unknown as (ctx: unknown) => Promise<unknown>)({ step: clock.step });
  const batchSteps: number[] = [];
  const errors: unknown[] = [];
  const results: unknown[] = [];
  for (const event of clock.counter.sent) {
    const b = stepper();
    try { results.push(await (adsWalletBatchFn as unknown as (ctx: unknown) => Promise<unknown>)({ event, step: b.step })); }
    catch (e) { errors.push(e); }
    batchSteps.push(b.counter.steps);
  }
  return { out, clockSteps: clock.counter.steps, sent: clock.counter.sent, batchSteps, errors, results };
}
const run = async () => { const t = await tick(); if (t.errors.length) throw t.errors[0]; return t.results[0]; };
beforeEach(() => { vi.resetAllMocks(); m.wallets = [{ tenant_id: "t1" }]; m.campaigns = [{ campaign_binding_id: "c1" }, { campaign_binding_id: "c2" }]; m.entitled.mockResolvedValue(true); m.log.mockResolvedValue(undefined); m.alert.mockResolvedValue(undefined); vi.stubEnv("CHATGPT_ADS_FUNDING_ENABLED", "false"); });
afterEach(() => { vi.unstubAllEnvs(); });
it("keeps settlement running while new funding is disabled", async () => {
  expect(await run()).toEqual({ wallets: 1, failed_wallets: [] });
  expect(m.settle).toHaveBeenCalledWith("t1", "c1");
  expect(m.settle).toHaveBeenCalledWith("t1", "c2");
});
it("checks every funded campaign even if one reporting request fails", async () => {
  m.settle.mockRejectedValueOnce(new Error("Reporting failed"));
  await expect(run()).rejects.toThrow("1 ads wallets need reconciliation");
  expect(m.settle).toHaveBeenCalledWith("t1", "c2");
  expect(m.refill).toHaveBeenCalledWith("t1");
});
it("keeps refilling a wallet whose ended campaign can no longer be read", async () => {
  m.settle.mockImplementation(async (_t: string, id: string) => { if (id === "c1") throw new Error("Campaign removed from LinkedIn"); });
  for (let t = 0; t < 3; t++) await expect(run()).rejects.toThrow("1 ads wallets need reconciliation");
  expect(m.refill).toHaveBeenCalledTimes(3);
  expect(m.settle).toHaveBeenCalledWith("t1", "c2");
});
it("settles after a downgrade but never starts a refill", async () => {
  m.entitled.mockResolvedValue(false);
  await run(); expect(m.settle).toHaveBeenCalledTimes(2); expect(m.refill).not.toHaveBeenCalled();
});
it("still settles and pauses when the entitlement check throws", async () => {
  m.entitled.mockRejectedValue(new Error("subscription read failed"));
  await expect(run()).rejects.toThrow("1 ads wallets need reconciliation");
  expect(m.settle).toHaveBeenCalledTimes(2); expect(m.refill).not.toHaveBeenCalled();
});
it("settles reservations beyond the first database page", async () => {
  m.campaigns = Array.from({ length: 501 }, (_, i) => ({ campaign_binding_id: `binding-${i}` }));
  expect(await run()).toEqual({ wallets: 1, failed_wallets: [] });
  expect(m.settle).toHaveBeenCalledTimes(501);
  expect(m.settle).toHaveBeenLastCalledWith("t1", "binding-500");
  expect(m.refill).toHaveBeenCalledWith("t1");
});
it("settles, refills and alerts for every one of 2,000 workspaces while each run stays under a fixed step budget", async () => {
  m.wallets = Array.from({ length: 2000 }, (_, i) => ({ tenant_id: `t-${String(i).padStart(4, "0")}` }));
  m.campaigns = [{ campaign_binding_id: "c1" }];
  m.settle.mockImplementation(async (t: string) => { if (t === "t-1999") throw Object.assign(new Error("x"), { code: "linkedin_unavailable" }); });
  const t = await tick();
  expect(t.clockSteps).toBeLessThanOrEqual(5);
  expect(t.batchSteps.length).toBeGreaterThan(0);
  expect(Math.max(...t.batchSteps)).toBeLessThanOrEqual(3 * 25 + 1);
  expect(Math.max(t.clockSteps, ...t.batchSteps)).toBeLessThan(INNGEST_STEP_LIMIT);
  expect(new Set(t.sent.flatMap(e => e.data.tenant_ids)).size).toBe(2000);
  expect(new Set(t.sent.map(e => e.id)).size).toBe(t.sent.length);
  expect(m.settle).toHaveBeenCalledTimes(2000);
  expect(m.refill).toHaveBeenCalledTimes(2000);
  expect(m.refill).toHaveBeenCalledWith("t-1999");
  expect(t.errors).toHaveLength(1);
  expect(m.alert).toHaveBeenCalledTimes(1);
  expect(m.alert.mock.calls[0][0].msg).toContain("t-1999");
});
it("names the failing campaign and error code in the staff alert, never in the workspace's own log row", async () => {
  m.settle.mockImplementation(async (_t: string, id: string) => { if (id === "c2") throw Object.assign(new Error("LinkedIn said no"), { code: "linkedin_rate_limited" }); });
  m.refill.mockRejectedValue(Object.assign(new Error("Ads wallet storage is unavailable"), { code: undefined }));
  await expect(run()).rejects.toThrow("1 ads wallets need reconciliation");
  expect(m.refill).toHaveBeenCalledWith("t1");
  expect(m.alert).toHaveBeenCalledTimes(1);
  const staff = m.alert.mock.calls[0][0];
  expect(staff.tenant_id ?? null).toBeNull();
  expect(staff.msg).toContain("t1");
  expect(staff.msg).toContain("campaign c2");
  expect(staff.msg).toContain("linkedin_rate_limited");
  expect(staff.msg).toContain("Ads wallet storage is unavailable");
  expect(staff.msg).not.toContain("campaign c1");
  const tenantRows = m.log.mock.calls.map(([row]) => row).filter(row => row.tenant_id === "t1");
  expect(tenantRows).toHaveLength(1);
  expect(JSON.stringify(tenantRows)).not.toContain("c2");
  expect(JSON.stringify(tenantRows)).not.toContain("linkedin_rate_limited");
});
