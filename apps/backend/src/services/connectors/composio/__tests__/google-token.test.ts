import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ composioProxy: vi.fn(), resolveOwnedComposioAccount: vi.fn() }));
vi.mock("../api", () => ({ composioProxy: mocks.composioProxy }));
vi.mock("../account", () => ({ resolveOwnedComposioAccount: mocks.resolveOwnedComposioAccount }));

import { getTenantGoogleAuth, composioProxyFetch } from "../google-token";

const ACCOUNT = { tenant_id: "t1", toolkit: "googledrive", connected_account_id: "ca_1", auth_config_id: "ac_1" } as never;

beforeEach(() => {
  mocks.composioProxy.mockReset();
  mocks.resolveOwnedComposioAccount.mockReset();
});

describe("getTenantGoogleAuth (Composio Drive rail)", () => {
  it("resolves the REQUESTING tenant's owned googledrive account; none → null", async () => {
    mocks.resolveOwnedComposioAccount.mockResolvedValue(null);
    expect(await getTenantGoogleAuth("t1")).toBeNull();
    expect(mocks.resolveOwnedComposioAccount).toHaveBeenCalledWith("t1", "googledrive");
  });

  it("never carries a token: requests go through the proxy for that account", async () => {
    mocks.resolveOwnedComposioAccount.mockResolvedValue(ACCOUNT);
    mocks.composioProxy.mockResolvedValue({ ok: true, status: 200, json: { id: "f1", name: "Plan" } });
    const auth = await getTenantGoogleAuth("t1");
    expect(auth?.access_token).toBe("");
    const res = await auth!.fetchFn("https://www.googleapis.com/drive/v3/files/f1", { headers: { authorization: "Bearer " } });
    expect(mocks.composioProxy).toHaveBeenCalledWith({ account: ACCOUNT, method: "GET", endpoint: "https://www.googleapis.com/drive/v3/files/f1" });
    expect(await res.json()).toEqual({ id: "f1", name: "Plan" });
  });
});

describe("composioProxyFetch", () => {
  it("a text export (proxy data is a string) reads back as that text", async () => {
    mocks.composioProxy.mockResolvedValue({ ok: true, status: 200, json: "# Plan\n\nBody" });
    const res = await composioProxyFetch(ACCOUNT)("https://www.googleapis.com/drive/v3/files/f1/export?mimeType=text%2Fplain");
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("# Plan\n\nBody");
  });

  it("keeps Google's status, so a 401 still reads as auth_stale and a 404 as no access", async () => {
    mocks.composioProxy.mockResolvedValue({ ok: false, status: 401, json: {} });
    expect((await composioProxyFetch(ACCOUNT)("https://www.googleapis.com/x")).status).toBe(401);
    mocks.composioProxy.mockResolvedValue({ ok: false, status: 404, json: {} });
    expect((await composioProxyFetch(ACCOUNT)("https://www.googleapis.com/x")).status).toBe(404);
  });

  it("a refused or failed proxy call (status 0) is a 502, never a stale-token 401", async () => {
    mocks.composioProxy.mockResolvedValue({ ok: false, status: 0, json: { error: "composio_transport_error" } });
    const res = await composioProxyFetch(ACCOUNT)("https://www.googleapis.com/x");
    expect(res.status).toBe(502);
  });
});
