
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

vi.mock("@/services/secrets/vault", () => ({
  getSecret: vi.fn(async (_t: string, key: string) =>
    key === "meta_ads.access_token" ? "tok-123" : "act_999",
  ),
}));

const sendSpy = vi.fn(async (_evt: { id: string; name: string; data: unknown }) => ({ ids: [] as string[] }));
vi.mock("@/../workers/client", () => ({
  inngest: { send: (evt: { id: string; name: string; data: unknown }) => sendSpy(evt) },
}));

import { fbGet, fbPost } from "../_client";

const TENANT = "11111111-1111-1111-1111-111111111111";

function graphResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

function metaError(code: number, subcode?: number) {
  return JSON.stringify({
    error: {
      message: "Error validating access token",
      type: "OAuthException",
      code,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
    },
  });
}

async function captureError(fn: () => Promise<unknown>): Promise<ExpectedToolError> {
  try {
    await fn();
  } catch (e) {
    return e as ExpectedToolError;
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  sendSpy.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fbGet — token-expiry classification", () => {
  it("maps code 190 (access token expired) to meta_ads_token_expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(400, metaError(190))));
    const err = await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(err.code).toBe("meta_ads_token_expired");
    expect(err.message).toMatch(/reconnect/i);
  });

  it("maps code 102 (session expired) to meta_ads_token_expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(400, metaError(102))));
    const err = await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(err.code).toBe("meta_ads_token_expired");
  });

  it.each([458, 459, 460, 463, 464, 467])(
    "maps auth subcode %i to meta_ads_token_expired",
    async (subcode) => {
      vi.stubGlobal("fetch", vi.fn(async () => graphResponse(400, metaError(100, subcode))));
      const err = await captureError(() => fbGet(TENANT, "act_999/insights", {}));
      expect(err.code).toBe("meta_ads_token_expired");
    },
  );

  it("fires the token_invalid nudge with a stable per-tenant-per-day id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(400, metaError(190))));
    await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const evt = sendSpy.mock.calls[0][0];
    expect(evt.name).toBe("meta_ads.token_invalid");
    expect(evt.data).toEqual({ tenant_id: TENANT });
    expect(evt.id).toBe(
      `meta_ads.token_invalid:${TENANT}:${new Date().toISOString().slice(0, 10)}`,
    );
  });
});

describe("fbGet — permission classification", () => {
  it.each([10, 200, 250, 299])("maps code %i to meta_ads_permission_revoked", async (code) => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(403, metaError(code))));
    const err = await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(err.code).toBe("meta_ads_permission_revoked");
  });

  it("does NOT fire the token_invalid nudge for a permission error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(403, metaError(10))));
    await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("fbGet — must NOT over-trigger (a false 'reconnect' is worse than the bug)", () => {
  it("leaves a generic 500 as meta_ads_query_failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(500, metaError(1))));
    const err = await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(err.code).toBe("meta_ads_query_failed");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("leaves an HTML (non-JSON) body as meta_ads_query_failed, never a parse throw", async () => {
    const html = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(502, html)));
    const err = await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("meta_ads_query_failed");
  });

  it("leaves an empty body as meta_ads_query_failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(504, "")));
    const err = await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(err.code).toBe("meta_ads_query_failed");
  });

  it("does not treat subcode 492 (no Page role) as expiry — reconnecting won't fix it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(400, metaError(100, 492))));
    const err = await captureError(() => fbGet(TENANT, "act_999/insights", {}));
    expect(err.code).toBe("meta_ads_query_failed");
  });
});

describe("fbPost — the write path classifies auth failures identically", () => {
  it("maps code 190 to meta_ads_token_expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(400, metaError(190))));
    const err = await captureError(() => fbPost(TENANT, "act_999/adsets", { status: "PAUSED" }));
    expect(err.code).toBe("meta_ads_token_expired");
  });

  it("maps code 10 to meta_ads_permission_revoked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(403, metaError(10))));
    const err = await captureError(() => fbPost(TENANT, "act_999/adsets", { status: "PAUSED" }));
    expect(err.code).toBe("meta_ads_permission_revoked");
  });

  it("preserves meta_ads_write_failed for a non-auth failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(400, metaError(100))));
    const err = await captureError(() => fbPost(TENANT, "act_999/adsets", { status: "PAUSED" }));
    expect(err.code).toBe("meta_ads_write_failed");
  });
});

describe("fbGet — a generic failure carries its status and Graph code", () => {
  it("an HTML 503 page: http_status only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(503, "<html>Service Unavailable</html>")));
    const err = await captureError(() => fbGet(TENANT, "act_999/campaigns", {}));
    expect(err.code).toBe("meta_ads_query_failed");
    expect(err.meta).toEqual({ http_status: 503 });
  });

  it("a throttled 400: Graph code, subcode and is_transient", async () => {
    const body = JSON.stringify({ error: { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true } });
    vi.stubGlobal("fetch", vi.fn(async () => graphResponse(400, body)));
    const err = await captureError(() => fbGet(TENANT, "act_999/campaigns", {}));
    expect(err.meta).toEqual({ http_status: 400, graph_code: 17, graph_subcode: 2446079, is_transient: true });
  });
});
