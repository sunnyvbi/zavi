import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  forceRefreshConnectorMock: vi.fn(),
  getConnectorTokenMock: vi.fn(),
  getSecretMock: vi.fn(),
}));

vi.mock("@/services/connectors/core/token", () => ({
  forceRefreshConnector: mocks.forceRefreshConnectorMock,
  getConnectorToken: mocks.getConnectorTokenMock,
}));

vi.mock("@/services/secrets/vault", () => ({
  getSecret: mocks.getSecretMock,
}));

const { forceRefreshConnectorMock, getConnectorTokenMock, getSecretMock } = mocks;

import { callJiraTool } from "../jira";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("jiraFetch 401 retry", () => {
  const ctx = { tenant_id: "t1", run_id: "r1" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    forceRefreshConnectorMock.mockReset();
    getConnectorTokenMock.mockReset();
    getSecretMock.mockReset();
    let credCalls = 0;
    getConnectorTokenMock.mockImplementation(async () => {
      credCalls += 1;
      return credCalls === 1 ? "stale-token" : "fresh-token";
    });
    getSecretMock.mockResolvedValue("cloud-id-abc");
    forceRefreshConnectorMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("200 first try: no refresh, no retry", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ issues: [] }));
    const r = await callJiraTool(ctx, "search", { jql: "is:open" });
    expect(r.is_error).toBe(false);
    expect(forceRefreshConnectorMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("401 → force-refresh → 200 retry uses fresh token", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ issues: ["X-1"] }));
    const r = await callJiraTool(ctx, "search", { jql: "is:open" });
    expect(r.is_error).toBe(false);
    expect(forceRefreshConnectorMock).toHaveBeenCalledTimes(1);
    expect(forceRefreshConnectorMock).toHaveBeenCalledWith("t1", "jira");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchSpy.mock.calls[1][1]?.headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer fresh-token");
  });

  it("401 → force-refresh → 401 retry: throws jira_auth_expired", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    const r = await callJiraTool(ctx, "search", { jql: "is:open" });
    expect(r.is_error).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.error).toBe("jira_auth_expired");
    expect(parsed.message).toContain("forced refresh");
  });

  it("401 → forceRefresh throws → jira_auth_expired with refresh-fail message", async () => {
    forceRefreshConnectorMock.mockRejectedValueOnce(new Error("invalid_grant"));
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 401 }));
    const r = await callJiraTool(ctx, "search", { jql: "is:open" });
    expect(r.is_error).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.error).toBe("jira_auth_expired");
    expect(parsed.message).toContain("token refresh failed");
    expect(parsed.message).toContain("invalid_grant");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("401 → force-refresh → 500 retry: throws jira_http_error", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("internal server error", { status: 500 }));
    const r = await callJiraTool(ctx, "search", { jql: "is:open" });
    expect(r.is_error).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.error).toBe("jira_http_error");
  });

  it("Authorization header in retry stays fresh even if init.headers tries to override", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await callJiraTool(ctx, "search", { jql: "is:open" });
    const retryHeaders = fetchSpy.mock.calls[1][1]?.headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer fresh-token");
    expect(retryHeaders.Authorization).not.toBe("Bearer stale-token");
  });
});
