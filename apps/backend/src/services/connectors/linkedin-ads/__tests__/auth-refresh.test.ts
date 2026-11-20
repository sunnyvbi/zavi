import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ token: "stale", refreshes: 0, refreshFails: false as boolean, fetch: vi.fn() }));

vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: async () => store.token,
  forceRefreshConnector: async () => {
    store.refreshes += 1;
    if (store.refreshFails) {
      const { OAuthTokenError } = await import("@/services/connectors/core/oauth2-authcode");
      throw new OAuthTokenError("linkedin_ads token error: invalid_grant", 400, "invalid_grant");
    }
    store.token = "fresh";
  },
  markConnectorTokenRevoked: async () => undefined,
}));

vi.mock("@/services/ads-wallet/bindings", () => ({ verifyAccountBinding: async () => undefined }));
vi.mock("@/services/tenant-client", () => ({ platformSecretRpc: async () => ({ data: null, error: null }) }));

import { listLinkedInAdAccounts, listLinkedInCampaigns } from "../client";
import { resolveLinkedinAccount } from "@/services/ads-wallet/adapters/linkedin-account";
import { pauseLinkedInCampaign } from "../write";
import { ExpectedToolError } from "@/services/tools/types";
import { classifyAdReadError, isRetryableAdReadKind } from "@/services/connectors/core/read-error-kind";

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;
const bearer = () => store.fetch.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>).map((h) => h.Authorization);
const answer = (byToken: Record<string, Response>) =>
  store.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    return byToken[auth.replace("Bearer ", "")] ?? json(500, {});
  });

beforeEach(() => {
  store.token = "stale";
  store.refreshes = 0;
  store.refreshFails = false;
  store.fetch.mockReset();
  vi.stubGlobal("fetch", store.fetch);
});

describe("a LinkedIn Ads 401 on a token that has not reached its recorded expiry", () => {
  it("spends the stored refresh token once and retries, so the founder is never asked to reconnect", async () => {
    answer({ stale: json(401, {}), fresh: json(200, { elements: [{ id: 7, name: "Couple App", currency: "USD", status: "ACTIVE" }] }) });
    const accounts = await listLinkedInAdAccounts("t1");
    expect(accounts).toEqual([{ id: "7", name: "Couple App", currency: "USD", status: "ACTIVE" }]);
    expect(store.refreshes).toBe(1);
    expect(bearer()).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("says reconnect only when LinkedIn refuses the refresh token too", async () => {
    store.refreshFails = true;
    answer({ stale: json(401, {}) });
    await expect(listLinkedInCampaigns("t1", "7")).rejects.toMatchObject({ code: "linkedin_ads_token_revoked", message: "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu." });
    expect(store.refreshes).toBe(1);
    expect(store.fetch).toHaveBeenCalledTimes(1);
  });

  it("a fresh token LinkedIn still refuses is reported as revoked after one retry, never a loop", async () => {
    answer({ stale: json(401, {}), fresh: json(401, {}) });
    await expect(listLinkedInAdAccounts("t1")).rejects.toMatchObject({ code: "linkedin_ads_token_revoked" });
    expect(store.refreshes).toBe(1);
    expect(store.fetch).toHaveBeenCalledTimes(2);
  });

  it("a 403 is a permission problem, not an expired token: no refresh is spent", async () => {
    answer({ stale: json(403, {}) });
    await expect(listLinkedInAdAccounts("t1")).rejects.toMatchObject({ code: "linkedin_ads_forbidden" });
    expect(store.refreshes).toBe(0);
  });

  it("a 403 read reaches the founder in plain words naming the fix, with no scope names, no status code and no Refresh advice", async () => {
    answer({ stale: json(403, { message: "Not enough permissions to access: adAccounts.FINDER-search r_ads_reporting" }) });
    const err = await listLinkedInAdAccounts("t1").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    const e = err as ExpectedToolError;
    expect(e.code).toBe("linkedin_ads_forbidden");
    expect(e.message).toBe(
      "LinkedIn did not let Zavi read this ad account. Your LinkedIn user needs a role on it: ask an account admin in LinkedIn Campaign Manager to give you one, or reconnect LinkedIn Ads with a LinkedIn user who already has one.",
    );
    expect(e.message).not.toMatch(/r_ads|rw_ads|403|scope|HTTP|Refresh|in a minute/i);
    expect(classifyAdReadError(e)).toBe("auth");
    expect(store.refreshes).toBe(0);
  });

  it("a 429 or 5xx read stays a try-again-later error, never the role message", async () => {
    for (const status of [429, 500, 503]) {
      store.fetch.mockReset();
      answer({ stale: json(status, {}) });
      const e = (await listLinkedInAdAccounts("t1").then(() => null, (x: unknown) => x)) as ExpectedToolError;
      expect(e.code).toBe("linkedin_ads_http_error");
      expect(e.message).not.toMatch(/role|Campaign Manager/);
      expect(isRetryableAdReadKind(classifyAdReadError(e))).toBe(true);
    }
  });

  it("a 403 write says which role to ask for, with no scope names or status code", async () => {
    answer({ stale: json(403, {}) });
    const e = (await pauseLinkedInCampaign("t1", "7", "99").then(() => null, (x: unknown) => x)) as ExpectedToolError;
    expect(e.code).toBe("linkedin_ads_forbidden");
    expect(e.message).toContain("Ask an account admin in LinkedIn Campaign Manager to give your LinkedIn user a Campaign Manager or Account Manager role");
    expect(e.message).not.toMatch(/r_ads|rw_ads|403|scope|HTTP|Refresh/i);
    expect(store.refreshes).toBe(0);
  });

  it("a pause refused with 401 is retried once on the refreshed token", async () => {
    answer({ stale: json(401, {}), fresh: json(204, {}) });
    await pauseLinkedInCampaign("t1", "7", "99");
    expect(store.refreshes).toBe(1);
    expect(bearer()).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("the shared wallet's account read recovers too, and hands back the refreshed token for the calls after it", async () => {
    answer({ stale: json(401, {}), fresh: json(200, { id: 42, name: "Couple App", currency: "USD", status: "ACTIVE" }) });
    const binding = {
      id: "b", tenant_id: "t1", account_id: "acc", platform: "linkedin", provider_account_id: "42", currency: "USD", verified_at: "now",
      credential_source: "tenant_connector", credential_ref: "linkedin_ads.access_token", credential_tenant_id: "t1", funding_source: "provider", legacy_key: null,
    } as unknown as Parameters<typeof resolveLinkedinAccount>[1];
    const out = await resolveLinkedinAccount("t1", binding);
    expect(out.token).toBe("fresh");
    expect(out.account.id).toBe("42");
    expect(store.refreshes).toBe(1);
    expect(store.fetch).toHaveBeenCalledTimes(2);
  });
});
