import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ rpc: vi.fn(), upserts: [] as unknown[] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (x: string) => x,
  tenantRpc: (...a: unknown[]) => db.rpc(...a),
  tenantClient: () => ({
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (k: string, v: unknown) => ((f[k] = v), q),
        maybeSingle: async () => (table === "autopilot_goals" ? { data: { id: f.id, status: "active" }, error: null } : { data: null, error: null }),
        upsert: async (row: unknown) => (db.upserts.push(row), { error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("./adapter", async (o) => ({ ...(await o<typeof import("./adapter")>()), ownedAccount: async () => ({ account: { tenant_id: "tenant" }, details: { currency: "USD" } }) }));
vi.mock("@/services/channels/lock", () => ({ assertSpendWritesOn: async () => undefined }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => "owner" }));
const wake = vi.hoisted(() => vi.fn());
vi.mock("./monitor", () => ({ wakeRedditChange: wake }));
vi.mock("../../../../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: vi.fn() }));
vi.mock("@/services/growth/unattended-policy", () => ({ authorizeUnattended: vi.fn() }));
vi.mock("@/services/decisions/ad-budget", () => ({ reserveAdSpend: vi.fn(), commitAdSpend: vi.fn(), dropAdSpendHold: vi.fn(), rebaseAdSpendForObject: vi.fn(), releaseAdSpendForObject: vi.fn(async () => true), noCommittedAdSpendHold: vi.fn(async () => true) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/decisions/ad-changes", () => ({ recordZaviAdChange: vi.fn() }));
vi.mock("./operations", async (o) => ({ ...(await o<typeof import("./operations")>()), operationStore: () => ({ list: async () => [] }) }));
import { executeRedditAction } from "./execute";

const grant = { ad_account_id: "account", name: "Authority", rationale: "Grant", daily_limit_usd: 50, campaign_lifetime_limit_usd: 500, objectives: ["CLICKS"], geolocations: ["US"], expires_at: "2099-01-01T00:00:00.000Z", goal_id: "11111111-1111-4111-8111-111111111111" };
const run = (id: string) => executeRedditAction({ id, tenant_id: "tenant", decision_class: "reddit_ads.authorize_account", body: grant, approved_by: "founder", approved_by_source: null, exec_source: "channel_actions" });

beforeEach(() => {
  wake.mockReset();
  db.rpc.mockReset();
  db.upserts = [];
});

describe("authorize_account writes only through the atomic grant RPC", () => {
  it("saved: ok, through save_reddit_ad_authority with this card and account; never a direct upsert", async () => {
    db.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    expect(await run("new_card")).toMatchObject({ ok: true });
    expect(db.rpc).toHaveBeenCalledWith("tenant", "save_reddit_ad_authority", expect.objectContaining({ p_ad_account_id: "account", p_action_id: "new_card", p_limits: expect.objectContaining({ daily_limit_usd: 50 }) }));
    expect(db.upserts).toEqual([]);
    expect(wake).toHaveBeenCalledWith("tenant", "new_card:authorized", [expect.any(String)], { quiet_ok: true });
  });

  it("superseded (an older card approved after a newer one): refused, typed", async () => {
    db.rpc.mockResolvedValue({ data: { ok: false, code: "superseded" }, error: null });
    expect(await run("old_card")).toMatchObject({ ok: false, code: "reddit_ads_authority_superseded" });
  });

  it("an RPC error or an unmatched card: refused, nothing claimed as saved", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await run("c")).toMatchObject({ ok: false, code: "reddit_ads_authority_unreadable" });
    db.rpc.mockResolvedValue({ data: { ok: false, code: "card_not_found" }, error: null });
    expect(await run("c")).toMatchObject({ ok: false, code: "reddit_ads_authority_unreadable" });
  });
});
