import { describe, expect, it, vi } from "vitest";
import {
  claimShopifyInstall,
  loadShopifyInstall,
  SHOPIFY_CLAIM_FAILED,
  SHOPIFY_INSTALL_FAILED,
  SHOPIFY_INSTALL_MISSING,
} from "./startShopifyInstall";

function reply(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

describe("loadShopifyInstall", () => {
  it("loads the already-authorized store without starting another OAuth flow", async () => {
    const fetcher = vi.fn(async () => reply(200, { shop: "acme.myshopify.com", connected: false }));
    expect(await loadShopifyInstall("t.ok", fetcher)).toEqual({ kind: "ready", shop: "acme.myshopify.com" });
    expect(fetcher).toHaveBeenCalledWith("/api/connectors/shopify/install/status?token=t.ok");
  });

  it("carries the connected workspace for a staff link on a store that is already connected", async () => {
    expect(await loadShopifyInstall("t.link", async () => reply(200, {
      shop: "acme.myshopify.com",
      connected: false,
      link_tenant_id: "tenant-1",
    }))).toEqual({ kind: "ready", shop: "acme.myshopify.com", linkTenantId: "tenant-1" });
  });

  it("requires a manual Zavi login when there is no Zavi session", async () => {
    expect(await loadShopifyInstall("t.ok", async () => reply(401, {}))).toEqual({ kind: "login" });
  });

  it("sends a completed retry back to the embedded Shopify app", async () => {
    expect(await loadShopifyInstall("t.ok", async () => reply(200, {
      shop: "acme.myshopify.com",
      connected: true,
      redirect_url: "https://admin.shopify.com/store/acme/apps/client-id",
    }))).toEqual({
      kind: "connected",
      url: "https://admin.shopify.com/store/acme/apps/client-id",
    });
  });

  it("keeps the workspace fallback while an older backend is still deployed", async () => {
    expect(await loadShopifyInstall("t.ok", async () => reply(200, { shop: "acme.myshopify.com", connected: true }))).toEqual({
      kind: "connected",
      url: "/workspace?tab=brain&shopify=connected#integration",
    });
  });

  it("explains missing, expired and network-failed installs", async () => {
    expect(await loadShopifyInstall("", vi.fn())).toEqual({ kind: "error", message: SHOPIFY_INSTALL_MISSING });
    expect(await loadShopifyInstall("t.old", async () => reply(410, { error: { message: "Restart from Shopify." } }))).toEqual({ kind: "error", message: "Restart from Shopify." });
    expect(await loadShopifyInstall("t", async () => { throw new Error("offline"); })).toEqual({ kind: "error", message: SHOPIFY_INSTALL_FAILED });
  });
});

describe("claimShopifyInstall", () => {
  it("claims only after the merchant clicks Connect", async () => {
    const fetcher = vi.fn(async () => reply(200, { redirect_url: "https://admin.shopify.com/store/acme/apps/client-id" }));
    expect(await claimShopifyInstall("t.ok", fetcher)).toEqual({ kind: "connected", url: "https://admin.shopify.com/store/acme/apps/client-id" });
    expect(fetcher).toHaveBeenCalledWith("/api/connectors/shopify/install/claim", {
      method: "POST",
      body: JSON.stringify({ token: "t.ok" }),
    });
  });

  it("surfaces a refresh-expiry instruction and network failure", async () => {
    expect(await claimShopifyInstall("t", async () => reply(409, { error: { message: "Approve again." } }))).toEqual({ kind: "error", message: "Approve again." });
    expect(await claimShopifyInstall("t", async () => { throw new Error("offline"); })).toEqual({ kind: "error", message: SHOPIFY_CLAIM_FAILED });
  });
});
