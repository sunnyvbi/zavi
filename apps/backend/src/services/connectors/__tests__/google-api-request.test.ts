import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ composioProxy: vi.fn() }));
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: mocks.composioProxy }));

import { googleApiRequest, googleApiErrorText } from "../google-api-request";

const ACCOUNT = { tenant_id: "t", toolkit: "google_analytics", connected_account_id: "ca", auth_config_id: "ac" } as never;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("googleApiRequest", () => {
  it("native: fetches with Bearer and JSON body, returns the parsed envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ rows: [1] }) });
    vi.stubGlobal("fetch", fetchMock);

    const r = await googleApiRequest(
      { kind: "native", access_token: "ya29.x" },
      { method: "POST", url: "https://analyticsdata.googleapis.com/x", body: { a: 1 } },
    );

    expect(r).toEqual({ ok: true, status: 200, json: { rows: [1] } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://analyticsdata.googleapis.com/x");
    expect(init.headers.Authorization).toBe("Bearer ya29.x");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(mocks.composioProxy).not.toHaveBeenCalled();
  });

  it("composio: delegates to composioProxy with the account and endpoint", async () => {
    mocks.composioProxy.mockResolvedValue({ ok: true, status: 200, json: { siteEntry: [] } });

    const r = await googleApiRequest(
      { kind: "composio", account: ACCOUNT },
      { method: "GET", url: "https://www.googleapis.com/webmasters/v3/sites" },
    );

    expect(r).toEqual({ ok: true, status: 200, json: { siteEntry: [] } });
    expect(mocks.composioProxy).toHaveBeenCalledWith({
      account: ACCOUNT,
      method: "GET",
      endpoint: "https://www.googleapis.com/webmasters/v3/sites",
    });
  });

  it("composio: a stalled proxy call rejects with TimeoutError at the caller's budget", async () => {
    vi.useFakeTimers();
    mocks.composioProxy.mockReturnValue(new Promise(() => {}));

    const p = googleApiRequest(
      { kind: "composio", account: ACCOUNT },
      { method: "GET", url: "https://www.googleapis.com/webmasters/v3/sites", timeoutMs: 5_000 },
    );
    const settled = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    const err = await settled;
    expect(err.name).toBe("TimeoutError");
  });

  it("googleApiErrorText stringifies the error envelope, capped", () => {
    expect(googleApiErrorText({ ok: false, status: 401, json: { error: { message: "bad" } } })).toContain("bad");
  });
});
