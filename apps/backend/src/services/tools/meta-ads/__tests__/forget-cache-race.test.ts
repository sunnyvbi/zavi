
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getSecret: vi.fn(), debugToken: vi.fn() }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: h.getSecret }));
vi.mock("@/services/connectors/meta-ads/oauth", () => ({ debugToken: h.debugToken }));

import { forgetMetaAdsCreds, metaAdsCreds } from "../_client";
import { _resetScopeCache, assertMetaScopes, forgetMetaScopes } from "../_scopes";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  h.getSecret.mockReset();
  h.debugToken.mockReset();
  _resetScopeCache();
});

describe("Meta cache fill vs forget", () => {
  it("creds: fill starts, forget, fill resolves: the old token is returned but not cached", async () => {
    const tok = deferred<string>();
    h.getSecret.mockImplementation(async (_t: string, key: string) => (key === "meta_ads.access_token" ? tok.promise : "act_1"));
    const inflight = metaAdsCreds("t-race");
    forgetMetaAdsCreds("t-race");
    tok.resolve("old-token");
    expect((await inflight).access_token).toBe("old-token");
    h.getSecret.mockImplementation(async (_t: string, key: string) => (key === "meta_ads.access_token" ? "new-token" : "act_1"));
    expect((await metaAdsCreds("t-race")).access_token).toBe("new-token");
    h.getSecret.mockImplementation(async () => "changed");
    expect((await metaAdsCreds("t-race")).access_token).toBe("new-token");
  });

  it("scopes: grants read before a forget are not written back after it", async () => {
    forgetMetaAdsCreds("t-s");
    h.getSecret.mockImplementation(async (_t: string, key: string) => (key === "meta_ads.access_token" ? "tok" : "act_1"));
    const grants = deferred<{ scopes: string[] }>();
    h.debugToken.mockReturnValueOnce(grants.promise);
    const inflight = assertMetaScopes("t-s", ["pages_read_engagement"], "Reading Page posts");
    await Promise.resolve();
    await Promise.resolve();
    forgetMetaScopes("t-s");
    grants.resolve({ scopes: [] });
    await expect(inflight).rejects.toMatchObject({ code: "meta_ads_scope_missing" });
    h.debugToken.mockResolvedValue({ scopes: ["pages_read_engagement"] });
    await expect(assertMetaScopes("t-s", ["pages_read_engagement"], "Reading Page posts")).resolves.toBeUndefined();
    expect(h.debugToken).toHaveBeenCalledTimes(2);
  });
});
