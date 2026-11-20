
import { describe, it, expect, vi, beforeEach } from "vitest";

const g = vi.hoisted(() => ({ fbGet: vi.fn(), creds: vi.fn(), debug: vi.fn() }));
vi.mock("../_client", () => ({
  fbGet: (...a: unknown[]) => g.fbGet(...a),
  metaAdsCreds: (...a: unknown[]) => g.creds(...a),
}));
vi.mock("@/services/connectors/meta-ads/oauth", () => ({ debugToken: (...a: unknown[]) => g.debug(...a) }));

import { metaAccountReadTool, OBJECT_FIELDS, RESOURCES } from "../account_read";
import { _resetScopeCache } from "../_scopes";
import type { ToolContext } from "@/services/tools/types";

const ctx = { tenant_id: "t1", log: () => {} } as unknown as ToolContext;

beforeEach(() => {
  vi.clearAllMocks();
  _resetScopeCache();
  g.creds.mockResolvedValue({ ad_account_id: "act_555", access_token: "t" });
  g.debug.mockResolvedValue({ is_valid: true, scopes: ["ads_management", "business_management"] });
  g.fbGet.mockResolvedValue({ data: [] });
});

describe("meta_ads_account_read", () => {
  it("no resource asks for emails, leads or comments", () => {
    for (const [name, r] of Object.entries(RESOURCES)) {
      expect(r.fields ?? "", name).not.toMatch(/email|leads|comments|field_data/);
    }
    expect([...OBJECT_FIELDS].some((f) => /lead|comment|email|\{/.test(f))).toBe(false);
  });

  it("lists basic ad accounts without requesting restricted business fields", async () => {
    g.debug.mockResolvedValue({ is_valid: true, scopes: ["ads_read"] });
    const items = [{ id: "act_555", name: "Example ads", currency: "USD" }];
    g.fbGet.mockImplementation(async (_tenant: string, _edge: string, params: { fields: string }) => {
      if (params.fields.includes("business")) {
        throw new Error("Requires business_management permission to access the field.");
      }
      return { data: items, paging: { next: "next-page" } };
    });

    await expect(metaAccountReadTool.execute(ctx, { resource: "ad_accounts", limit: 10 }))
      .resolves.toEqual({ resource: "ad_accounts", items, truncated: true });
    expect(g.fbGet).toHaveBeenCalledWith("t1", "me/adaccounts", {
      fields: "id,name,account_status,currency,timezone_name", limit: 10,
    });
    expect(g.debug).not.toHaveBeenCalled();
  });

  it("a business resource reads its fixed edge with the business id", async () => {
    await metaAccountReadTool.execute(ctx, { resource: "owned_ad_accounts", business_id: "1234567" });
    expect(g.fbGet.mock.calls[0][1]).toBe("1234567/owned_ad_accounts");
  });

  it("a business id that is not a Meta id is refused, so it never becomes a path", async () => {
    await expect(metaAccountReadTool.execute(ctx, { resource: "clients", business_id: "1234567/leads" })).rejects.toMatchObject({ code: "meta_ads_invalid_read" });
    expect(g.fbGet).not.toHaveBeenCalled();
  });

  it("business edges need business_management", async () => {
    g.debug.mockResolvedValueOnce({ is_valid: true, scopes: ["ads_management"] });
    await expect(metaAccountReadTool.execute(ctx, { resource: "invoices", business_id: "1234567" })).rejects.toMatchObject({ code: "meta_ads_scope_missing" });
    expect(g.fbGet).not.toHaveBeenCalled();
  });

  it("a missing business_management says Meta's review is pending, never reconnect", async () => {
    g.debug.mockResolvedValueOnce({ is_valid: true, scopes: ["ads_management"] });
    const err = await metaAccountReadTool.execute(ctx, { resource: "businesses" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "meta_ads_scope_missing" });
    const msg = (err as Error).message;
    expect(msg).not.toMatch(/reconnect meta ads|allow it/i);
    expect(msg).toMatch(/nothing to do on your side/);
    expect(msg).toMatch(/Campaign-level reads still work/);
    _resetScopeCache();
    g.debug.mockResolvedValueOnce({ is_valid: true, scopes: ["pages_show_list"] });
    const noAds = await metaAccountReadTool.execute(ctx, { resource: "businesses" }).catch((e: unknown) => e);
    expect((noAds as Error).message).not.toMatch(/Campaign-level reads still work/);
  });

  it("an object read keeps only flat allowlisted fields", async () => {
    g.fbGet.mockResolvedValueOnce({ id: "777", name: "Form" });
    await metaAccountReadTool.execute(ctx, { resource: "object", id: "777777", fields: ["name", "leads{field_data}", "status"] });
    expect(g.fbGet.mock.calls[0][2]).toEqual({ fields: "name,status" });
    await expect(metaAccountReadTool.execute(ctx, { resource: "object", id: "777777", fields: ["leads"] })).rejects.toMatchObject({ code: "meta_ads_invalid_read" });
  });

  it("the account's own edges read the connected ad account", async () => {
    await metaAccountReadTool.execute(ctx, { resource: "account_subscribed_apps" });
    expect(g.fbGet.mock.calls[0][1]).toBe("act_555/subscribed_apps");
  });

  it("targeting search looks up places across location types", async () => {
    await metaAccountReadTool.execute(ctx, { resource: "targeting_search", search_type: "adgeolocation", q: "Austin" });
    expect(g.fbGet.mock.calls[0]).toEqual(["t1", "search", expect.objectContaining({ type: "adgeolocation", q: "Austin" })]);
  });
});
