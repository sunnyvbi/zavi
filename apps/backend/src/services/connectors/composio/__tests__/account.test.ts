import { describe, it, expect, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({ row: null as null | { team_id: string; composio_auth_config_id?: string | null }, verify: vi.fn(), get: vi.fn(), resolve: vi.fn(), eqs: [] as unknown[][] }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => {
    const q: any = { select: () => q, eq: (...a: unknown[]) => { m.eqs.push(a); return q; }, maybeSingle: async () => ({ data: m.row }) };
    return q;
  } }),
}));
vi.mock("../api", () => ({ composioVerifyActive: m.verify, composioGetAccount: m.get }));
vi.mock("../catalog", () => ({ lookupAuthConfigId: m.resolve, ensureAuthConfigForConnect: () => { throw new Error("read path must never create"); } }));
import { composioConnectionStoppedError, honestComposioToolError, resolveOwnedComposioAccount } from "../account";
import { ExpectedToolError, connectorErrorFromContent } from "@/services/tools/types";
import { classifyAdReadError } from "@/services/connectors/core/read-error-kind";

beforeEach(() => { m.row = null; m.verify.mockReset(); m.get.mockReset(); m.resolve.mockReset().mockResolvedValue("ac_square"); m.eqs = []; });

describe("resolveOwnedComposioAccount (cross-tenant guard)", () => {
  it("reads connector_metadata BY tenant and verifies list-scoped with user_id = that tenant", async () => {
    m.row = { team_id: "ca_9" }; m.verify.mockResolvedValue(true);
    expect(await resolveOwnedComposioAccount("TENANT_A", "square")).toEqual({ tenant_id: "TENANT_A", toolkit: "square", connected_account_id: "ca_9", auth_config_id: "ac_square" });
    expect(m.eqs).toContainEqual(["tenant_id", "TENANT_A"]);
    expect(m.eqs).toContainEqual(["slug", "composio.square"]);
    expect(m.verify).toHaveBeenCalledWith({ user_id: "TENANT_A", auth_config_id: "ac_square", connected_account_id: "ca_9" });
  });
  it("returns null when Composio does not list the account for this tenant (another tenant's id)", async () => {
    m.row = { team_id: "ca_of_tenant_b" }; m.verify.mockResolvedValue(false);
    expect(await resolveOwnedComposioAccount("TENANT_A", "square")).toBeNull();
  });
  it("verifies against the auth config STORED with the connection, not whichever config is enabled today", async () => {
    m.row = { team_id: "ca_9", composio_auth_config_id: "ac_at_connect" }; m.verify.mockResolvedValue(true);
    await resolveOwnedComposioAccount("TENANT_A", "square");
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.verify).toHaveBeenCalledWith({ user_id: "TENANT_A", auth_config_id: "ac_at_connect", connected_account_id: "ca_9" });
  });
  it("returns null when not connected", async () => {
    expect(await resolveOwnedComposioAccount("TENANT_A", "square")).toBeNull();
    expect(m.verify).not.toHaveBeenCalled();
  });
  it("a native-rail toolkit's composio row is ignored (spec 14): null, no DB read, no verify", async () => {
    m.row = { team_id: "ca_9" }; m.verify.mockResolvedValue(true);
    expect(await resolveOwnedComposioAccount("TENANT_A", "linear")).toBeNull();
    expect(m.eqs).toEqual([]);
    expect(m.verify).not.toHaveBeenCalled();
  });
});

describe("composioConnectionStoppedError (a Composio account that stopped working)", () => {
  const expired = { status: "EXPIRED", status_reason: 'Access revoked; Details: {"message": "Bad Request", "error": 400}', updated_at: "2026-10-15T15:07:09Z", user_id: "TENANT_A" };
  it("an EXPIRED account: neutral words with the date, never who revoked it, never the raw Composio JSON", async () => {
    m.row = { team_id: "ca_r" }; m.get.mockResolvedValue(expired);
    const e = await composioConnectionStoppedError("TENANT_A", "reddit_ads", "Reddit Ads");
    expect(m.get).toHaveBeenCalledWith("ca_r");
    expect(e?.code).toBe("reddit_ads_connection_stopped");
    expect(e?.meta?.founder_reason).toBe("Reddit Ads connection stopped working on Oct 15");
    expect(e?.message).toBe("Reddit Ads connection stopped working on Oct 15. Reconnect it.");
    expect(e?.message).not.toMatch(/revoked|Bad Request|\{/);
    expect(classifyAdReadError(e)).toBe("auth");
  });
  it("the agent's error envelope names the connector for a Reconnect card", async () => {
    m.row = { team_id: "ca_r" }; m.get.mockResolvedValue(expired);
    const e = await composioConnectionStoppedError("TENANT_A", "reddit_ads", "Reddit Ads");
    expect(connectorErrorFromContent(JSON.stringify({ error: e?.code, message: e?.message, meta: e?.meta })))
      .toEqual({ code: "reddit_ads_connection_stopped", connector_slug: "reddit_ads", connector_mode: "reconnect" });
    const p = await composioConnectionStoppedError("TENANT_A", "pinterest", "Pinterest");
    expect(p?.meta?.connector_slug).toBe("composio.pinterest");
  });
  it("the GET fails: null, so the caller keeps its generic login error", async () => {
    m.row = { team_id: "ca_r" }; m.get.mockRejectedValue(new Error("composio get account HTTP 500"));
    expect(await composioConnectionStoppedError("TENANT_A", "reddit_ads", "Reddit Ads")).toBeNull();
  });
  it("still ACTIVE, no row, or another user's account: null", async () => {
    m.row = { team_id: "ca_r" }; m.get.mockResolvedValue({ ...expired, status: "ACTIVE" });
    expect(await composioConnectionStoppedError("TENANT_A", "reddit_ads", "Reddit Ads")).toBeNull();
    m.get.mockResolvedValue({ ...expired, user_id: "TENANT_B" });
    expect(await composioConnectionStoppedError("TENANT_A", "reddit_ads", "Reddit Ads")).toBeNull();
    m.row = null; m.get.mockReset();
    expect(await composioConnectionStoppedError("TENANT_A", "reddit_ads", "Reddit Ads")).toBeNull();
    expect(m.get).not.toHaveBeenCalled();
  });
  it("another non-ACTIVE status gets the same neutral words; no date when Composio has none", async () => {
    m.row = { team_id: "ca_t" }; m.get.mockResolvedValue({ status: "INACTIVE", status_reason: null, updated_at: null, user_id: null });
    const e = await composioConnectionStoppedError("TENANT_A", "tiktok_ads", "TikTok Ads");
    expect(e?.code).toBe("tiktok_ads_connection_stopped");
    expect(e?.message).toBe("TikTok Ads connection stopped working. Reconnect it.");
  });
});

describe("honestComposioToolError (agent tool seam)", () => {
  const notConnected = () => new ExpectedToolError("reddit_ads_not_connected", "Reddit Ads is not connected for this workspace.");
  it("set up, login EXPIRED: the honest code replaces not_connected", async () => {
    m.row = { team_id: "ca_r" }; m.get.mockResolvedValue({ status: "EXPIRED", status_reason: "Access revoked", updated_at: "2026-10-15T15:07:09Z", user_id: "TENANT_A" });
    const e = (await honestComposioToolError("TENANT_A", "reddit_ads", "Reddit Ads", notConnected())) as ExpectedToolError;
    expect(e.code).toBe("reddit_ads_connection_stopped");
    expect(e.message).toBe("Reddit Ads connection stopped working on Oct 15. Reconnect it.");
  });
  it("set up, status unreadable or another user's: connection_unverified, no Reconnect card mode", async () => {
    m.row = { team_id: "ca_r" }; m.get.mockRejectedValue(new Error("HTTP 503"));
    const e = (await honestComposioToolError("TENANT_A", "reddit_ads", "Reddit Ads", notConnected())) as ExpectedToolError;
    expect(e.code).toBe("reddit_ads_connection_unverified");
    expect(e.meta?.connector_mode).toBeUndefined();
    m.get.mockResolvedValue({ status: "EXPIRED", status_reason: null, updated_at: null, user_id: "TENANT_B" });
    expect(((await honestComposioToolError("TENANT_A", "reddit_ads", "Reddit Ads", notConnected())) as ExpectedToolError).code).toBe("reddit_ads_connection_unverified");
  });
  it("set up and ACTIVE: the tool's own error stands (it is about something else)", async () => {
    m.row = { team_id: "ca_r" }; m.get.mockResolvedValue({ status: "ACTIVE", status_reason: null, updated_at: null, user_id: "TENANT_A" });
    const orig = notConnected();
    expect(await honestComposioToolError("TENANT_A", "reddit_ads", "Reddit Ads", orig)).toBe(orig);
  });
  it("never set up (no row): not_connected stays", async () => {
    const orig = notConnected();
    expect(await honestComposioToolError("TENANT_A", "reddit_ads", "Reddit Ads", orig)).toBe(orig);
    expect(m.get).not.toHaveBeenCalled();
  });
  it("another error, or another toolkit's not_connected, is returned untouched with no lookup", async () => {
    const other = new ExpectedToolError("reddit_ads_rate_limited", "busy");
    expect(await honestComposioToolError("TENANT_A", "reddit_ads", "Reddit Ads", other)).toBe(other);
    const tiktok = new ExpectedToolError("tiktok_ads_not_connected", "x");
    expect(await honestComposioToolError("TENANT_A", "reddit_ads", "Reddit Ads", tiktok)).toBe(tiktok);
    const plain = new Error("boom");
    expect(await honestComposioToolError("TENANT_A", "reddit_ads", "Reddit Ads", plain)).toBe(plain);
    expect(m.get).not.toHaveBeenCalled();
  });
});
