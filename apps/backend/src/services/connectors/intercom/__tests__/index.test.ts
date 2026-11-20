
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { intercomConnector } from "@/services/connectors/intercom";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.INTERCOM_CLIENT_ID = "cid_123";
  process.env.INTERCOM_CLIENT_SECRET = "csec_456";
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("intercomConnector.authorizeUrl", () => {
  it("builds the Intercom OAuth URL with client_id, state, redirect_uri", () => {
    const url = new URL(
      intercomConnector.authorizeUrl("st8", "https://api.zaviagent.com/api/connectors/intercom/callback"),
    );
    expect(url.origin + url.pathname).toBe("https://app.intercom.com/oauth");
    expect(url.searchParams.get("client_id")).toBe("cid_123");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.zaviagent.com/api/connectors/intercom/callback",
    );
  });

  it("throws (inert) when INTERCOM_CLIENT_ID is not provisioned", () => {
    delete process.env.INTERCOM_CLIENT_ID;
    expect(() => intercomConnector.authorizeUrl("s", "r")).toThrow(/INTERCOM_CLIENT_ID/);
  });
});

describe("intercomConnector.exchangeCode", () => {
  it("exchanges code → long-lived token (no expiresInSec) + resolves workspace", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/auth/eagle/token")) {
        return { ok: true, json: async () => ({ access_token: "tok_live", token: "tok_live" }) } as Response;
      }
      if (String(url).endsWith("/me")) {
        return { ok: true, json: async () => ({ app: { id_code: "app_abc", name: "Acme Support" } }) } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const res = await intercomConnector.exchangeCode("code_xyz", "https://x/callback");
    expect(res.secrets["intercom.access_token"]).toBe("tok_live");
    expect(res.expiresInSec).toBeUndefined();
    expect(res.metadata.team_id).toBe("app_abc");
    expect(res.metadata.team_name).toBe("Acme Support");
    expect(calls.some((u) => u.includes("/auth/eagle/token"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/me"))).toBe(true);
  });

  it("throws when the token response has no access_token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      ({ ok: true, json: async () => ({ error: "invalid_grant" }) } as Response),
    ));
    await expect(intercomConnector.exchangeCode("bad", "r")).rejects.toThrow(/access_token/);
  });
});
