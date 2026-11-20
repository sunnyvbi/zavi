import { fetchLivePricingClient } from "@/lib/marketing/pricing";
import { apiUrl, newIdempotencyKey } from "@/lib/api";
import { fixtureFor } from "./fixtures";
import type { AppHomeFixture, ShopifyAppHome, ShopifyAppHomeLoadResult, ShopifyConnectionConfirmation } from "./types";

export const ZAVI_APP_URL = "https://www.zaviagent.com";

export function fixtureFromSearch(search: string): AppHomeFixture | null {
  if (process.env.NODE_ENV === "production") return null;
  const value = new URLSearchParams(search).get("fixture");
  if (value === "free" || value === "paid" || value === "setup") return value;
  return process.env.NODE_ENV === "test" ? "paid" : null;
}

declare global {
  interface Window {
    shopify?: { idToken: () => Promise<string> };
  }
}

async function appBridgeToken(): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (!window.shopify?.idToken && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!window.shopify?.idToken) throw new Error("Shopify App Bridge is not available. Open Zavi from Shopify admin.");
  return window.shopify.idToken();
}

async function authenticatedShopifyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await appBridgeToken();
    const response = await fetch(apiUrl(path), {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers, Authorization: `Bearer ${token}` },
    });
    if (response.status !== 401 || attempt === 1) return response;
  }
  throw new Error("Shopify session retry failed.");
}

async function apiMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? body.error.message : fallback;
  } catch {
    return fallback;
  }
}

async function apiError(response: Response, fallback: string): Promise<{ code: string | null; message: string }> {
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } };
    return {
      code: typeof body.error?.code === "string" ? body.error.code : null,
      message: typeof body.error?.message === "string" ? body.error.message : fallback,
    };
  } catch {
    return { code: null, message: fallback };
  }
}

export async function startShopifyConnection(): Promise<void> {
  const response = await authenticatedShopifyFetch("/api/shopify/app-home/install", { method: "POST" });
  if (!response.ok) throw new Error(await apiMessage(response, "Could not prepare this Shopify connection."));
  const body = await response.json() as { connect_url?: unknown };
  if (typeof body.connect_url !== "string") throw new Error("Shopify did not return a Zavi connection page.");
  window.open(body.connect_url, "_top");
}

export async function confirmShopifyConnection(confirmation: string): Promise<void> {
  if (!confirmation) throw new Error("This Shopify confirmation is missing. Start setup again.");
  const response = await authenticatedShopifyFetch("/api/shopify/app-home/install/confirm", {
    method: "POST",
    body: JSON.stringify({ confirmation }),
  });
  if (!response.ok) throw new Error(await apiMessage(response, "Could not confirm this Shopify connection."));
}

export async function previewShopifyConnection(confirmation: string): Promise<ShopifyConnectionConfirmation> {
  if (!confirmation) throw new Error("This Shopify confirmation is missing. Start setup again.");
  const response = await authenticatedShopifyFetch("/api/shopify/app-home/install/confirmation", {
    method: "POST",
    body: JSON.stringify({ confirmation }),
  });
  if (!response.ok) throw new Error(await apiMessage(response, "Could not verify this Shopify connection."));
  return response.json() as Promise<ShopifyConnectionConfirmation>;
}

export async function loadAppHome(fixture: AppHomeFixture | null): Promise<ShopifyAppHomeLoadResult> {
  if (fixture === "setup") return { kind: "setup" };
  if (fixture) {
    const base = fixtureFor(fixture);
    const pricing = await fetchLivePricingClient();
    return {
      kind: "ready",
      data: {
        ...base,
        pricing,
        billing: { ...base.billing, daily_allowance: pricing.freeDailyCredits, daily_remaining: pricing.freeDailyCredits },
      },
    };
  }
  const response = await authenticatedShopifyFetch("/api/shopify/app-home", { cache: "no-store" });
  if (!response.ok) {
    const error = await apiError(response, "Could not load your Zavi workspace.");
    if (error.code === "shop_not_connected") return { kind: "setup" };
    if (error.code === "user_not_linked") return { kind: "link" };
    throw new Error(error.message);
  }
  const data = await response.json() as ShopifyAppHome;
  return { kind: "ready", data };
}

export type ApprovalDecision = "approve" | "reject";

export async function decideAppHomeApproval(id: string, decision: ApprovalDecision): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await authenticatedShopifyFetch(`/api/shopify/app-home/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
  return response.ok ? { ok: true } : { ok: false, message: await apiMessage(response, "Could not update this approval.") };
}

export async function startShopifyBilling(tier: "starter" | "growth" | "pro", term: "monthly" | "annual"): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await authenticatedShopifyFetch("/api/shopify/app-home/billing", {
    method: "POST",
    headers: { "Idempotency-Key": newIdempotencyKey() },
    body: JSON.stringify({ tier, term }),
  });
  if (!response.ok) return { ok: false, message: await apiMessage(response, "Could not start Shopify billing.") };
  const body = await response.json() as { confirmation_url?: unknown };
  if (typeof body.confirmation_url !== "string") return { ok: false, message: "Shopify did not return a billing confirmation page." };
  window.open(body.confirmation_url, "_top");
  return { ok: true };
}
