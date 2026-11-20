import { z } from "zod";
import { shopifyClientId, shopifyClientSecret } from "./hmac";

const DEFAULT_SCOPES = ["read_products", "write_products", "read_orders", "read_discounts", "write_discounts"] as const;
const TOKEN_TIMEOUT_MS = 15_000;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  scope: z.string().default(""),
  expires_in: z.number().int().positive(),
  refresh_token_expires_in: z.number().int().positive(),
});

export type ShopifyTokenGrant = {
  access_token: string;
  refresh_token: string;
  scopes: string[];
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
};

export class ShopifyOAuthError extends Error {
  constructor(readonly code: "not_configured" | "provider_unreachable" | "token_rejected" | "bad_token_response" | "missing_scope") {
    super(code);
    this.name = "ShopifyOAuthError";
  }
}

export function shopifyScopes(): string[] {
  const configured = (process.env.SHOPIFY_SCOPES ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return [...new Set(configured.length ? configured : DEFAULT_SCOPES)];
}

export function shopifyCallbackUrl(): string {
  const base = process.env.BACKEND_PUBLIC_URL?.trim();
  if (!base) throw new ShopifyOAuthError("not_configured");
  return `${base.replace(/\/$/, "")}/api/connectors/shopify/callback`;
}

export function shopifyAuthorizeUrl(shop: string, state: string): string {
  const clientId = shopifyClientId();
  if (!clientId) throw new ShopifyOAuthError("not_configured");
  const query = new URLSearchParams({
    client_id: clientId,
    scope: shopifyScopes().join(","),
    redirect_uri: shopifyCallbackUrl(),
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${query.toString()}`;
}

function scopeSatisfied(requested: string, granted: ReadonlySet<string>): boolean {
  if (granted.has(requested)) return true;
  return requested.startsWith("read_") && granted.has(`write_${requested.slice("read_".length)}`);
}

function grantFromResponse(raw: unknown, now: number): ShopifyTokenGrant {
  const parsed = tokenSchema.safeParse(raw);
  if (!parsed.success) throw new ShopifyOAuthError("bad_token_response");
  const scopes = parsed.data.scope.split(",").map((scope) => scope.trim()).filter(Boolean);
  const granted = new Set(scopes);
  if (shopifyScopes().some((scope) => !scopeSatisfied(scope, granted))) {
    throw new ShopifyOAuthError("missing_scope");
  }
  return {
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token,
    scopes,
    access_token_expires_at: new Date(now + parsed.data.expires_in * 1000),
    refresh_token_expires_at: new Date(now + parsed.data.refresh_token_expires_in * 1000),
  };
}

async function tokenRequest(shop: string, body: URLSearchParams, now: number = Date.now()): Promise<ShopifyTokenGrant> {
  let response: Response;
  try {
    response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new ShopifyOAuthError("provider_unreachable");
  }
  if (!response.ok) throw new ShopifyOAuthError("token_rejected");
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ShopifyOAuthError("bad_token_response");
  }
  return grantFromResponse(json, now);
}

function clientCredentials(): { client_id: string; client_secret: string } {
  const client_id = shopifyClientId();
  const client_secret = shopifyClientSecret();
  if (!client_id || !client_secret) throw new ShopifyOAuthError("not_configured");
  return { client_id, client_secret };
}

export function exchangeShopifyCode(shop: string, code: string, now: number = Date.now()): Promise<ShopifyTokenGrant> {
  const credentials = clientCredentials();
  return tokenRequest(shop, new URLSearchParams({ ...credentials, code, expiring: "1" }), now);
}

export function refreshShopifyGrant(shop: string, refreshToken: string, now: number = Date.now()): Promise<ShopifyTokenGrant> {
  const credentials = clientCredentials();
  return tokenRequest(shop, new URLSearchParams({
    ...credentials,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }), now);
}
