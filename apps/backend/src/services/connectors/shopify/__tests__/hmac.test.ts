import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  INSTALL_TOKEN_TTL_MS,
  installTokenMatchesViewerEmail,
  normalizeShopDomain,
  shopSubdomain,
  signAppHomeInstallToken,
  shopifyQueryMessage,
  signInstallToken,
  signInstallTokenForViewer,
  signShopifyAppHomeConfirmation,
  signShopifyAppLinkConfirmation,
  signShopifyAppLinkToken,
  verifyInstallToken,
  verifyShopifyAppHomeConfirmation,
  verifyShopifyAppLinkConfirmation,
  verifyShopifyAppLinkToken,
  verifyShopifyQueryHmac,
  verifyShopifyWebhookHmac,
} from "../hmac";

const SECRET = "shpss_test_secret";

function signQuery(q: Record<string, string>): Record<string, string> {
  const hmac = crypto.createHmac("sha256", SECRET).update(shopifyQueryMessage(q)).digest("hex");
  return { ...q, hmac };
}

beforeEach(() => {
  vi.stubEnv("SHOPIFY_CLIENT_ID", "client-id");
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("normalizeShopDomain", () => {
  it("accepts a myshopify domain, with or without a scheme", () => {
    expect(normalizeShopDomain("Acme-Store.myshopify.com")).toBe("acme-store.myshopify.com");
    expect(normalizeShopDomain("https://acme.myshopify.com/admin")).toBe("acme.myshopify.com");
  });
  it("rejects anything else", () => {
    for (const v of ["acme", "acme.myshopify.com.evil.com", "evil.com", "", 12, null, "-acme.myshopify.com"]) {
      expect(normalizeShopDomain(v)).toBeNull();
    }
  });
  it("strips the suffix for the Composio subdomain", () => {
    expect(shopSubdomain("acme.myshopify.com")).toBe("acme");
  });
});

describe("verifyShopifyQueryHmac", () => {
  const base = { shop: "acme.myshopify.com", timestamp: "1700000000", host: "YWRtaW4", embedded: "1" };
  it("accepts a query Shopify signed", () => {
    expect(verifyShopifyQueryHmac(signQuery(base))).toBe(true);
  });
  it("rejects a changed shop, a missing hmac and a wrong secret", () => {
    const signed = signQuery(base);
    expect(verifyShopifyQueryHmac({ ...signed, shop: "other.myshopify.com" })).toBe(false);
    expect(verifyShopifyQueryHmac(base)).toBe(false);
    expect(verifyShopifyQueryHmac(signed, "another")).toBe(false);
    expect(verifyShopifyQueryHmac(signed, "")).toBe(false);
  });
  it("escapes & % = in keys and values the way Shopify does", () => {
    expect(shopifyQueryMessage({ "a=b": "x&y%", hmac: "zz", b: "1" })).toBe("a%3Db=x%26y%25&b=1");
  });
  it("ignores a legacy signature param", () => {
    expect(verifyShopifyQueryHmac({ ...signQuery(base), signature: "old" })).toBe(true);
  });
});

describe("verifyShopifyWebhookHmac", () => {
  const body = Buffer.from(JSON.stringify({ shop_domain: "acme.myshopify.com" }));
  const good = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  it("accepts the base64 digest Shopify sends", () => {
    expect(verifyShopifyWebhookHmac(body, good)).toBe(true);
  });
  it("rejects a wrong digest, a missing header, a changed body and a non-buffer body", () => {
    expect(verifyShopifyWebhookHmac(body, good.slice(0, -2) + "AA")).toBe(false);
    expect(verifyShopifyWebhookHmac(body, "")).toBe(false);
    expect(verifyShopifyWebhookHmac(body, undefined)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, `${good}\n`)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, "not-base64")).toBe(false);
    expect(verifyShopifyWebhookHmac(body, good.replace(/=$/, ""))).toBe(false);
    expect(verifyShopifyWebhookHmac(Buffer.from("{}"), good)).toBe(false);
    expect(verifyShopifyWebhookHmac("not a buffer" as unknown as Buffer, good)).toBe(false);
  });
});

describe("install token", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  it("round-trips a durable opaque installation reference", () => {
    const t = signInstallToken(id, 7);
    expect(verifyInstallToken(t)).toEqual({ installation_id: id, generation: 7 });
  });
  it("marks an App Home handoff without exposing a Shopify staff email", () => {
    const t = signAppHomeInstallToken(id, 7, "42");
    expect(verifyInstallToken(t)).toEqual({ installation_id: id, generation: 7, return_to_app: true, shopify_user_id: "42" });
    expect(t).not.toContain("owner");
  });
  it("refuses to mint an App Home handoff without a valid Shopify staff id", () => {
    expect(() => signAppHomeInstallToken(id, 7, "staff@example.com")).toThrow(/invalid staff user/);
  });
  it("round-trips a workspace choice that still requires the App Bridge staff id", () => {
    const ref = verifyInstallToken(signAppHomeInstallToken(id, 7, "42"))!;
    const token = signShopifyAppHomeConfirmation(
      ref,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(verifyShopifyAppHomeConfirmation(token)).toEqual({
      ref: { installation_id: id, generation: 7, return_to_app: true, shopify_user_id: "42" },
      tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(verifyShopifyAppHomeConfirmation(`${token}x`)).toBeNull();
  });
  it("round-trips a staff link for a connected store and keeps it apart from every install token", () => {
    const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const user = "11111111-1111-4111-8111-111111111111";
    const link = signShopifyAppLinkToken("zavi-test-store.myshopify.com", "42");
    const ref = verifyShopifyAppLinkToken(link)!;
    expect(ref).toEqual({ shop: "zavi-test-store.myshopify.com", shopify_user_id: "42" });
    const confirmation = signShopifyAppLinkConfirmation(ref, tenant, user);
    expect(verifyShopifyAppLinkConfirmation(confirmation)).toEqual({ ...ref, tenant_id: tenant, user_id: user });

    expect(verifyShopifyAppLinkConfirmation(link)).toBeNull();
    expect(verifyShopifyAppLinkToken(confirmation)).toBeNull();
    expect(verifyInstallToken(link)).toBeNull();
    expect(verifyShopifyAppHomeConfirmation(confirmation)).toBeNull();
    expect(verifyShopifyAppLinkToken(signAppHomeInstallToken(id, 7, "42"))).toBeNull();
    expect(verifyShopifyAppLinkToken(`${link}x`)).toBeNull();
    expect(verifyShopifyAppLinkToken(link, "other-secret")).toBeNull();
    expect(() => signShopifyAppLinkToken("evil.example.com", "42")).toThrow(/invalid Shopify staff link/);
    expect(() => signShopifyAppLinkToken("zavi-test-store.myshopify.com", "staff@example.com")).toThrow(/invalid Shopify staff link/);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(verifyShopifyAppLinkConfirmation(confirmation)).toBeNull();
    expect(verifyShopifyAppLinkToken(link)).toEqual(ref);
    vi.setSystemTime(Date.now() + INSTALL_TOKEN_TTL_MS);
    expect(verifyShopifyAppLinkToken(link)).toBeNull();
    vi.useRealTimers();
  });
  it("binds a managed install to a keyed fingerprint of the verified viewer email", () => {
    const t = signInstallTokenForViewer(id, 7, "Owner@Store.com");
    const ref = verifyInstallToken(t);
    expect(ref).toMatchObject({ installation_id: id, generation: 7 });
    expect(ref?.viewer_email_fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t).not.toContain("Owner");
    expect(installTokenMatchesViewerEmail(ref!, "owner@store.com")).toBe(true);
    expect(installTokenMatchesViewerEmail(ref!, "other@store.com")).toBe(false);
  });
  it("rejects a tampered payload, a wrong secret and junk", () => {
    const t = signInstallToken(id, 7);
    const [payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ id, gen: 8, exp: Date.now() + 1000 })).toString("base64url");
    expect(verifyInstallToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyInstallToken(t, "other-secret")).toBeNull();
    expect(verifyInstallToken(payload)).toBeNull();
    expect(verifyInstallToken("")).toBeNull();
    expect(verifyInstallToken(42)).toBeNull();
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");
    expect(verifyInstallToken(t)).toBeNull();
  });
  it.each([
    ["managed install", () => signInstallToken(id, 7), { installation_id: id, generation: 7 }],
    ["App Home handoff", () => signAppHomeInstallToken(id, 7, "42"), { installation_id: id, generation: 7, return_to_app: true, shopify_user_id: "42" }],
  ] as const)("expires an unclaimed %s link after its window", (_name, sign, expected) => {
    vi.useFakeTimers();
    try {
      const t = sign();
      vi.advanceTimersByTime(INSTALL_TOKEN_TTL_MS - 1000);
      expect(verifyInstallToken(t)).toEqual(expected);
      vi.advanceTimersByTime(2000);
      expect(verifyInstallToken(t)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
