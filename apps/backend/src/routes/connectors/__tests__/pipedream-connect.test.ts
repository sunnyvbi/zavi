import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rpc: vi.fn(),
  appExists: vi.fn(),
  createConnectToken: vi.fn(),
  verifyAccountOwned: vi.fn(),
  resolveConnectedAccount: vi.fn(),
  deleteConnectedAccount: vi.fn(),
  listApps: vi.fn(),
  buildPipedreamMcpUrl: vi.fn(),
  syncActiveTenant: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: mocks.syncActiveTenant }));
vi.mock("@/services/connectors/pipedream/api", () => ({
  appExists: mocks.appExists,
  createConnectToken: mocks.createConnectToken,
  verifyAccountOwned: mocks.verifyAccountOwned,
  resolveConnectedAccount: mocks.resolveConnectedAccount,
  deleteConnectedAccount: mocks.deleteConnectedAccount,
  listApps: mocks.listApps,
  buildPipedreamMcpUrl: mocks.buildPipedreamMcpUrl,
}));

import { pipedreamApps, pipedreamConnectStart, pipedreamReturn, pipedreamDisconnect } from "../pipedream";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    redirectedTo?: string;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
    redirect: (c: number, url: string) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    redirect(c: number, url: string) {
      this.statusCode = c;
      this.redirectedTo = url;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BACKEND_PUBLIC_URL = "https://api.zavi.test";
  process.env.WEB_ORIGIN = "https://zavi.test";
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tenant-1", user_id: "user-1" });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.appExists.mockResolvedValue(true);
  mocks.verifyAccountOwned.mockResolvedValue(true);
  mocks.resolveConnectedAccount.mockResolvedValue({
    status: "ok",
    account: { id: "apn_latest", app_slug: "stripe" },
  });
  mocks.buildPipedreamMcpUrl.mockReturnValue("https://remote.mcp.pipedream.net/v3");
  mocks.syncActiveTenant.mockResolvedValue(undefined);
  mocks.createConnectToken.mockResolvedValue({
    connect_token: "ctok_123",
    connect_link_url: "https://pipedream.com/_static/connect.html?token=ctok_123&connectLink=true",
    expires_at: null,
  });
});

describe("pipedreamConnectStart", () => {
  it("answers 410 provider_switched and never touches Pipedream or mints state", async () => {
    for (const app of ["stripe", "gmail", "posthog"]) {
      const res = mockRes();
      await pipedreamConnectStart({ params: { app } } as never, res as never);
      expect(res.statusCode).toBe(410);
      expect((res.body as { error: { code: string } }).error.code).toBe("provider_switched");
    }
    expect(mocks.appExists).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createConnectToken).not.toHaveBeenCalled();
  });

  it("returns early when auth fails", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();

    await pipedreamConnectStart({ params: { app: "stripe" } } as never, res as never);

    expect(mocks.appExists).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createConnectToken).not.toHaveBeenCalled();
  });
});

describe("every Pipedream route is closed (410)", () => {
  const untouched = () => {
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    for (const f of [mocks.listApps, mocks.verifyAccountOwned, mocks.resolveConnectedAccount, mocks.deleteConnectedAccount, mocks.createConnectToken, mocks.appExists]) {
      expect(f).not.toHaveBeenCalled();
    }
  };
  it("GET /apps", async () => {
    const res = mockRes();
    await pipedreamApps({ query: { q: "twilio" } } as never, res as never);
    expect(res.statusCode).toBe(410);
    expect((res.body as { error: { code: string } }).error.code).toBe("provider_switched");
    untouched();
  });
  it("GET /:app/return (even with a valid-looking state)", async () => {
    const res = mockRes();
    await pipedreamReturn({ params: { app: "stripe" }, query: { state: "s", account_id: "apn_1" }, headers: {} } as never, res as never);
    expect(res.statusCode).toBe(410);
    untouched();
  });
  it("POST /:app/disconnect", async () => {
    const res = mockRes();
    await pipedreamDisconnect({ params: { app: "stripe" }, body: {} } as never, res as never);
    expect(res.statusCode).toBe(410);
    untouched();
  });
});
