import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refreshTokenMock = vi.fn();
const rpcMock = vi.fn();
const getSecretMock = vi.fn();

vi.mock("../registry", () => ({
  getConnector: (slug: string) =>
    slug === "jira"
      ? { refreshToken: refreshTokenMock }
      : slug === "slack"
        ? {  }
        : null,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: rpcMock }),
}));

vi.mock("@/services/secrets/vault", () => ({
  getSecret: getSecretMock,
}));

async function loadToken() {
  vi.resetModules();
  return await import("../token");
}

describe("forceRefreshConnector", () => {
  beforeEach(() => {
    refreshTokenMock.mockReset();
    rpcMock.mockReset();
    getSecretMock.mockReset();
    refreshTokenMock.mockResolvedValue({
      secrets: { access_token: "fresh", refresh_token: "fresh-r" },
      expiresInSec: 3600,
    });
    rpcMock.mockResolvedValue({ error: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-op for connector without refreshToken (long-lived)", async () => {
    const { forceRefreshConnector } = await loadToken();
    await forceRefreshConnector("t1", "slack");
    expect(refreshTokenMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("no-op for unknown connector", async () => {
    const { forceRefreshConnector } = await loadToken();
    await forceRefreshConnector("t1", "nonexistent");
    expect(refreshTokenMock).not.toHaveBeenCalled();
  });

  it("calls connector.refreshToken once + persists via RPC", async () => {
    const { forceRefreshConnector } = await loadToken();
    await forceRefreshConnector("t1", "jira");
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const rpcArg = rpcMock.mock.calls[0];
    expect(rpcArg[0]).toBe("refresh_connector_secrets");
    expect(rpcArg[1].p_tenant_id).toBe("t1");
    expect(rpcArg[1].p_slug).toBe("jira");
  });

  it("single-flight collapse: two concurrent force-refreshes → one upstream call", async () => {
    const { forceRefreshConnector } = await loadToken();
    let resolve!: (v: unknown) => void;
    refreshTokenMock.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p1 = forceRefreshConnector("t1", "jira");
    const p2 = forceRefreshConnector("t1", "jira");
    await new Promise((r) => setTimeout(r, 0));
    resolve({ secrets: { access_token: "fresh" }, expiresInSec: 3600 });
    await Promise.all([p1, p2]);
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
  });

  it("propagates refresh errors", async () => {
    const { forceRefreshConnector } = await loadToken();
    refreshTokenMock.mockRejectedValueOnce(new Error("invalid_grant"));
    await expect(forceRefreshConnector("t1", "jira")).rejects.toThrow(
      /invalid_grant/,
    );
  });

  it("propagates RPC persist errors", async () => {
    const { forceRefreshConnector } = await loadToken();
    rpcMock.mockResolvedValueOnce({ error: { message: "vault write failed" } });
    await expect(forceRefreshConnector("t1", "jira")).rejects.toThrow(
      /vault write failed/,
    );
  });
});
