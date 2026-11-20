import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  persist: vi.fn(),
  cap: vi.fn(),
  note: vi.fn(),
  forgetCreds: vi.fn(),
  order: [] as string[],
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
vi.mock("@/services/company/country-inference", () => ({ autoSetCompanyCountryInBackground: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_library-ad-capability", () => ({ resolveMetaAdCapability: m.cap }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ forgetMetaAdsCreds: m.forgetCreds }));
vi.mock("@/services/tools/meta-ads/_scopes", () => ({ forgetMetaScopes: vi.fn() }));
vi.mock("@/services/growth/ad-account-watch", () => ({ noteMetaReadiness: m.note }));

import { metaAdsCallback, metaAdsFinalize, recheckMetaReadinessAfterConnect } from "../meta-ads";

function res() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    send(b: unknown) { m.order.push("respond"); this.body = b; return this; },
    json(b: unknown) { m.order.push("respond"); this.body = b; return this; },
  };
}

beforeEach(() => {
  m.rpc.mockReset();
  m.persist.mockReset().mockResolvedValue(true);
  m.cap.mockReset();
  m.note.mockReset().mockImplementation(async () => { m.order.push("note"); return "ready"; });
  m.order.length = 0;
  m.forgetCreds.mockReset().mockImplementation(() => { m.order.push("forget"); });
});

describe("Meta connect: Page readiness re-check", () => {
  it("callback: clears the marker when the Page is now reachable, before answering", async () => {
    m.rpc.mockImplementation(async (name: string) =>
      name === "consume_oauth_state" ? { data: [{ tenant_id: "t1", user_id: "u1" }], error: null } : { data: null, error: null },
    );
    m.cap.mockImplementation(async () => { m.order.push("cap"); return { ok: true }; });
    await metaAdsCallback({ query: { code: "c", state: "s" } } as never, res() as never);
    expect(m.note).toHaveBeenCalledWith("t1", null);
    expect(m.forgetCreds).toHaveBeenCalledWith("t1");
    expect(m.order).toEqual(["forget", "cap", "note", "respond"]);
  });

  it("finalize: raises the marker at once when Page access is still missing", async () => {
    m.rpc.mockImplementation(async (name: string) =>
      name === "consume_meta_ads_pending"
        ? { data: [{ tenant_id: "t2", long_token: "long", account_ids: ["act_9"] }], error: null }
        : { data: null, error: null },
    );
    m.cap.mockResolvedValue({ ok: false, reason_code: "no_page", reason: "x" });
    const r = res();
    await metaAdsFinalize({ body: { pending_id: "11111111-1111-4111-8111-111111111111", ad_account_id: "act_9" } } as never, r as never);
    expect(m.note).toHaveBeenCalledWith("t2", "no_page");
    expect(m.forgetCreds).toHaveBeenCalledWith("t2");
    expect((r.body as { ok?: boolean }).ok).toBe(true);
  });

  it("a failing re-check never fails the connect", async () => {
    m.rpc.mockImplementation(async (name: string) =>
      name === "consume_oauth_state" ? { data: [{ tenant_id: "t1", user_id: "u1" }], error: null } : { data: null, error: null },
    );
    m.cap.mockRejectedValue(new Error("graph down"));
    const r = res();
    await metaAdsCallback({ query: { code: "c", state: "s" } } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(m.note).not.toHaveBeenCalled();
  });

  it("gives up after the timeout instead of holding the connect", async () => {
    m.cap.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await recheckMetaReadinessAfterConnect("t1", 20);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
