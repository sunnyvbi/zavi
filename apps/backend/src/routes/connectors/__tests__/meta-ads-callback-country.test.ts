import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  autoSet: vi.fn(),
  persist: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: m.rpc }),
  serverClientFromBearer: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => {}) }));
vi.mock("@/services/connectors/meta-ads/oauth", () => ({
  metaOAuthStartUrl: vi.fn(),
  exchangeCode: vi.fn(async () => ({ access_token: "short" })),
  exchangeForLongLivedToken: vi.fn(async () => ({ access_token: "long", expires_in: 5_000_000 })),
  listAdAccounts: vi.fn(async () => [{ id: "act_1", name: "A" }]),
  verifyAccountReadable: vi.fn(async () => {}),
}));
vi.mock("@/services/connectors/meta-ads/expiry", () => ({
  resolveTokenExpiry: vi.fn(async () => new Date(Date.now() + 86_400_000)),
  persistMetaAdsExpiry: m.persist,
}));
vi.mock("@/services/connectors/meta-ads/signed-request", () => ({ verifySignedRequest: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/connectors/core/token", () => ({
  handleConnectorAccountSwap: vi.fn(async () => {}),
  priorConnectorTeamId: vi.fn(async () => null),
}));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn() }));
vi.mock("@/services/company/country-inference", () => ({ autoSetCompanyCountryInBackground: m.autoSet }));
vi.mock("@/services/tools/meta-ads/write/_library-ad-capability", () => ({ resolveMetaAdCapability: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ forgetMetaAdsCreds: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_scopes", () => ({ forgetMetaScopes: vi.fn() }));
vi.mock("@/services/growth/ad-account-watch", () => ({ noteMetaReadiness: vi.fn(async () => "ready") }));

import { metaAdsCallback } from "../meta-ads";

function res() {
  const r = { statusCode: 200, body: "" as unknown, status(c: number) { this.statusCode = c; return this; }, send(b: unknown) { this.body = b; return this; } };
  return r;
}

beforeEach(() => {
  m.rpc.mockReset();
  m.autoSet.mockReset();
  m.persist.mockReset();
  m.rpc.mockImplementation(async (name: string) =>
    name === "consume_oauth_state" ? { data: [{ tenant_id: "t1", user_id: "u1" }], error: null } : { data: null, error: null },
  );
});

describe("metaAdsCallback: company country", () => {
  it("runs even when the expiry pin fails (partial success)", async () => {
    m.persist.mockResolvedValue(false);
    const r = res();
    await metaAdsCallback({ query: { code: "c", state: "s" } } as never, r as never);
    expect(r.statusCode).toBe(500);
    expect(m.autoSet).toHaveBeenCalledWith("t1");
  });

  it("runs on a full success too", async () => {
    m.persist.mockResolvedValue(true);
    await metaAdsCallback({ query: { code: "c", state: "s" } } as never, res() as never);
    expect(m.autoSet).toHaveBeenCalledWith("t1");
  });

  it("does not run when the connection was not saved", async () => {
    m.rpc.mockImplementation(async (name: string) =>
      name === "consume_oauth_state"
        ? { data: [{ tenant_id: "t1", user_id: "u1" }], error: null }
        : { data: null, error: { message: "boom" } },
    );
    await metaAdsCallback({ query: { code: "c", state: "s" } } as never, res() as never);
    expect(m.autoSet).not.toHaveBeenCalled();
  });
});
