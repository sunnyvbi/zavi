import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refreshTokenMock = vi.fn();
const rpcMock = vi.fn();
const updateMock = vi.fn();
const getSecretMock = vi.fn();
let expiresAt: string | null = null;

vi.mock("../registry", () => ({
  getConnector: (slug: string) => (slug === "jira" ? { refreshToken: refreshTokenMock } : null),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: rpcMock,
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { token_expires_at: expiresAt }, error: null }),
        update: updateMock,
      };
      return chain;
    },
  }),
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: getSecretMock }));

async function loadToken() {
  vi.resetModules();
  return await import("../token");
}

describe("getConnectorToken in the variants-lab process", () => {
  beforeEach(() => {
    process.env.PRAXIS_VARIANTS_LAB = "1";
    refreshTokenMock.mockReset();
    rpcMock.mockReset();
    updateMock.mockReset();
    getSecretMock.mockReset();
    getSecretMock.mockResolvedValue("stored-access-token");
  });
  afterEach(() => {
    delete process.env.PRAXIS_VARIANTS_LAB;
  });

  it("a Jira-like token about to expire: refuses, no refresh call, no write", async () => {
    expiresAt = new Date(Date.now() + 60_000).toISOString();
    const { getConnectorToken } = await loadToken();
    await expect(getConnectorToken("t1", "jira", "jira.access_token")).rejects.toThrow(
      "variants lab: jira token needs a refresh; skipped so prod credentials aren't rotated",
    );
    expect(refreshTokenMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a forced refresh (after a 401) is refused the same way", async () => {
    const { forceRefreshConnector } = await loadToken();
    await expect(forceRefreshConnector("t1", "jira")).rejects.toThrow(/variants lab: jira token needs a refresh/);
    expect(refreshTokenMock).not.toHaveBeenCalled();
  });

  it("a still-valid token passes and is returned", async () => {
    expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const { getConnectorToken } = await loadToken();
    await expect(getConnectorToken("t1", "jira", "jira.access_token")).resolves.toBe("stored-access-token");
    expect(refreshTokenMock).not.toHaveBeenCalled();
  });

  it("outside the lab process the refresh still runs (normal behaviour unchanged)", async () => {
    delete process.env.PRAXIS_VARIANTS_LAB;
    expiresAt = new Date(Date.now() + 60_000).toISOString();
    refreshTokenMock.mockResolvedValue({ secrets: { "jira.access_token": "fresh" }, expiresInSec: 3600 });
    rpcMock.mockResolvedValue({ error: null });
    const { getConnectorToken } = await loadToken();
    await getConnectorToken("t1", "jira", "jira.access_token");
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
  });
});

describe("connector-specific refresh paths refuse in the lab process", () => {
  beforeEach(() => {
    process.env.PRAXIS_VARIANTS_LAB = "1";
  });
  afterEach(() => {
    delete process.env.PRAXIS_VARIANTS_LAB;
  });

  it("jira refreshToken throws before any token request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { jiraConnector } = await import("@/services/connectors/jira");
    await expect(jiraConnector.refreshToken!("t1")).rejects.toThrow(/variants lab: jira/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
