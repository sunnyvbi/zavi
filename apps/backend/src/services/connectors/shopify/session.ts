import { jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { normalizeShopDomain, shopifyClientId, shopifyClientSecret } from "./hmac";
import { shopifyScopes, type ShopifyTokenGrant } from "./oauth";

const TOKEN_TIMEOUT_MS = 15_000;

export class ShopifySessionError extends Error {
  constructor(readonly code: "missing_token" | "invalid_token" | "stale_token" | "reauthorization_required" | "provider_unreachable" | "bad_exchange") {
    super(code);
    this.name = "ShopifySessionError";
  }
}

export type ShopifyIdTokenSession = {
  token: string;
  shop: string;
  shopify_user_id: string;
  payload: JWTPayload;
};

const onlineGrantSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(""),
  expires_in: z.number().int().positive(),
  associated_user_scope: z.string().default(""),
  associated_user: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    first_name: z.string().default(""),
    last_name: z.string().default(""),
    email: z.string().email(),
    account_owner: z.boolean(),
    collaborator: z.boolean().default(false),
    email_verified: z.boolean(),
  }),
});

const offlineGrantSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  scope: z.string().default(""),
  expires_in: z.number().int().positive(),
  refresh_token_expires_in: z.number().int().positive(),
});

export type ShopifyOnlineGrant = z.infer<typeof onlineGrantSchema> & {
  scopes: string[];
  user_scopes: string[];
};

function bearer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

function shopFromUrlClaim(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    return normalizeShopDomain(new URL(raw).hostname);
  } catch {
    return null;
  }
}

export async function verifyShopifyIdToken(authorization: unknown): Promise<ShopifyIdTokenSession> {
  const token = bearer(authorization);
  if (!token) throw new ShopifySessionError("missing_token");
  const clientId = shopifyClientId();
  const secret = shopifyClientSecret();
  if (!clientId || !secret) throw new ShopifySessionError("invalid_token");

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      audience: clientId,
      clockTolerance: 5,
    }));
  } catch (error) {
    const providerCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const code = providerCode === "ERR_JWT_EXPIRED" || (error instanceof Error && /expir|not active|nbf|\bexp\b.*claim/i.test(error.message))
      ? "stale_token"
      : "invalid_token";
    throw new ShopifySessionError(code);
  }

  const dest = shopFromUrlClaim(payload.dest);
  const issuer = shopFromUrlClaim(payload.iss);
  const sub = typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : null;
  if (!dest || !issuer || dest !== issuer || !sub) throw new ShopifySessionError("invalid_token");
  return { token, shop: dest, shopify_user_id: sub, payload };
}

async function exchangeShopifySessionToken(
  session: ShopifyIdTokenSession,
  requestedTokenType: "online-access-token" | "offline-access-token",
): Promise<unknown> {
  const clientId = shopifyClientId();
  const clientSecret = shopifyClientSecret();
  if (!clientId || !clientSecret) throw new ShopifySessionError("bad_exchange");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: session.token,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: `urn:shopify:params:oauth:token-type:${requestedTokenType}`,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (requestedTokenType === "offline-access-token") body.set("expiring", "1");
  let response: Response;
  try {
    response = await fetch(`https://${session.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new ShopifySessionError("provider_unreachable");
  }
  if (!response.ok) {
    throw new ShopifySessionError(response.status === 400 || response.status === 401 ? "reauthorization_required" : "bad_exchange");
  }
  try {
    return await response.json();
  } catch {
    throw new ShopifySessionError("bad_exchange");
  }
}

export async function exchangeShopifyOnlineToken(session: ShopifyIdTokenSession): Promise<ShopifyOnlineGrant> {
  const json = await exchangeShopifySessionToken(session, "online-access-token");
  const parsed = onlineGrantSchema.safeParse(json);
  if (!parsed.success || parsed.data.associated_user.id !== session.shopify_user_id) {
    throw new ShopifySessionError("bad_exchange");
  }
  const split = (value: string) => value.split(",").map((scope) => scope.trim()).filter(Boolean);
  return {
    ...parsed.data,
    scopes: split(parsed.data.scope),
    user_scopes: split(parsed.data.associated_user_scope),
  };
}

function scopeSatisfied(requested: string, granted: ReadonlySet<string>): boolean {
  return granted.has(requested) || (requested.startsWith("read_") && granted.has(`write_${requested.slice("read_".length)}`));
}

export async function exchangeShopifyOfflineToken(
  session: ShopifyIdTokenSession,
  now: number = Date.now(),
): Promise<ShopifyTokenGrant> {
  const json = await exchangeShopifySessionToken(session, "offline-access-token");
  const parsed = offlineGrantSchema.safeParse(json);
  if (!parsed.success) throw new ShopifySessionError("bad_exchange");
  const scopes = parsed.data.scope.split(",").map((scope) => scope.trim()).filter(Boolean);
  const granted = new Set(scopes);
  if (shopifyScopes().some((scope) => !scopeSatisfied(scope, granted))) {
    throw new ShopifySessionError("reauthorization_required");
  }
  return {
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token,
    scopes,
    access_token_expires_at: new Date(now + parsed.data.expires_in * 1000),
    refresh_token_expires_at: new Date(now + parsed.data.refresh_token_expires_in * 1000),
  };
}
