import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../api-key", () => ({ getComposioApiKey: () => "k" }));
vi.mock("@/services/mcp/streamable-guards", () => ({ assertStreamableUrlAllowed: vi.fn() }));
import {
  authConfigSupportsBearerImport,
  composioGetAuthConfig,
  composioImportBearerToken,
  composioLink,
  composioPatchBearerToken,
  composioVerifyOwned,
} from "../api";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ redirect_url: "https://x.example/auth", connected_account_id: "ca_1" }), { status: 200 }));
});

describe("composioLink", () => {
  it("omits connection_data when the toolkit needs none", async () => {
    await composioLink({ user_id: "T1", auth_config_id: "ac_n", callback_url: "https://api.example/return" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://backend.composio.dev/api/v3/connected_accounts/link");
    expect(JSON.parse(init.body)).toEqual({ user_id: "T1", auth_config_id: "ac_n", callback_url: "https://api.example/return" });
  });
  it("creates the account directly with the store so no hosted form asks for it", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "ca_2", connectionData: { val: { redirectUrl: "https://backend.composio.dev/api/v3/s/abc" } } }), { status: 200 }));
    const r = await composioLink({ user_id: "T1", auth_config_id: "ac_s", callback_url: "https://api.example/return", connection_data: { subdomain: "zavi-test-store" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://backend.composio.dev/api/v3/connected_accounts");
    expect(JSON.parse(init.body)).toEqual({
      auth_config: { id: "ac_s" },
      connection: { user_id: "T1", callback_url: "https://api.example/return", data: { subdomain: "zavi-test-store" } },
    });
    expect(r).toEqual({ redirect_url: "https://backend.composio.dev/api/v3/s/abc", connected_account_id: "ca_2" });
  });
  it("reads a flat redirect_url from the create response too", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ redirect_url: "https://backend.composio.dev/api/v3/s/flat", connected_account_id: "ca_3" }), { status: 200 }));
    const r = await composioLink({ user_id: "T1", auth_config_id: "ac_s", callback_url: "https://api.example/return", connection_data: { subdomain: "s" } });
    expect(r).toEqual({ redirect_url: "https://backend.composio.dev/api/v3/s/flat", connected_account_id: "ca_3" });
  });
  it("fails loudly when the create response has no redirect", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "ca_4" }), { status: 200 }));
    await expect(composioLink({ user_id: "T1", auth_config_id: "ac_s", callback_url: "https://api.example/return", connection_data: { subdomain: "s" } })).rejects.toThrow(/missing redirect_url/);
  });
});

describe("Composio bearer credentials", () => {
  it("imports an existing Shopify access token as immediately ACTIVE", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "ca_imported" }), { status: 201 }));
    const result = await composioImportBearerToken({
      user_id: "T1",
      auth_config_id: "ac_shop",
      access_token: "access-secret",
      connection_data: { subdomain: "zavi-test-store" },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://backend.composio.dev/api/v3.1/connected_accounts");
    expect(JSON.parse(init.body)).toEqual({
      auth_config: { id: "ac_shop" },
      connection: {
        user_id: "T1",
        state: {
          authScheme: "BEARER_TOKEN",
          val: {
            status: "ACTIVE",
            token: "access-secret",
            subdomain: "zavi-test-store",
          },
        },
      },
    });
    expect(result).toEqual({ connected_account_id: "ca_imported" });
  });

  it("PATCHes only the rotated token so the stored Shopify subdomain survives", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, id: "ca_imported", status: "ACTIVE" }), { status: 200 }));
    await composioPatchBearerToken({ connected_account_id: "ca_imported", access_token: "access-rotated" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://backend.composio.dev/api/v3.1/connected_accounts/ca_imported");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      connection: { state: { authScheme: "BEARER_TOKEN", val: { token: "access-rotated" } } },
    });
  });

  it("proves ownership without requiring the account to already be ACTIVE", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "ca_imported", status: "EXPIRED" }] }), { status: 200 }));
    await expect(composioVerifyOwned({
      user_id: "T1",
      auth_config_id: "ac_shop",
      connected_account_id: "ca_imported",
    })).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("statuses=");
  });
});

describe("composioGetAuthConfig", () => {
  it("accepts only an enabled custom BEARER_TOKEN config for imported Shopify credentials", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ id: "ac_s", is_composio_managed: false, auth_scheme: "BEARER_TOKEN", status: "ENABLED" }), { status: 200 }));
    const custom = await composioGetAuthConfig("ac_s");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/api/v3/auth_configs/ac_s");
    expect(custom).toEqual({ id: "ac_s", is_composio_managed: false, auth_scheme: "BEARER_TOKEN", status: "ENABLED" });
    expect(authConfigSupportsBearerImport(custom)).toBe(true);
    expect(authConfigSupportsBearerImport({ ...custom, is_composio_managed: true })).toBe(false);
    expect(authConfigSupportsBearerImport({ ...custom, auth_scheme: "OAUTH2" })).toBe(false);
    expect(authConfigSupportsBearerImport({ ...custom, status: "DISABLED" })).toBe(false);
    fetchMock.mockImplementationOnce(async () => new Response("", { status: 404 }));
    await expect(composioGetAuthConfig("ac_missing")).rejects.toThrow("composio auth config HTTP 404");
  });
});
