import crypto from "node:crypto";

const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$/;
const INSTALL_KEY_LABEL = "zavi-shopify-install";
const APP_CONFIRM_KEY_LABEL = "zavi-shopify-app-confirm";
const APP_LINK_KEY_LABEL = "zavi-shopify-app-link";
const APP_LINK_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const INSTALL_TOKEN_TTL_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ShopifyInstallRef = {
  installation_id: string;
  generation: number;
  viewer_email_fingerprint?: string;
  return_to_app?: true;
  shopify_user_id?: string;
};

export type ShopifyAppHomeConfirmation = {
  ref: ShopifyInstallRef & { return_to_app: true; shopify_user_id: string };
  tenant_id: string;
  user_id: string;
};

export type ShopifyAppLinkRef = {
  shop: string;
  shopify_user_id: string;
};

export type ShopifyAppLinkConfirmation = ShopifyAppLinkRef & {
  tenant_id: string;
  user_id: string;
};

export function shopifyClientId(): string {
  return (process.env.SHOPIFY_CLIENT_ID ?? "").trim();
}

export function shopifyClientSecret(): string {
  return (process.env.SHOPIFY_CLIENT_SECRET ?? "").trim();
}

export function shopifyEnabled(): boolean {
  return shopifyClientId().length > 0 && shopifyClientSecret().length > 0;
}

export function normalizeShopDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return SHOP_RE.test(v) ? v : null;
}

export function shopSubdomain(shop: string): string {
  return shop.replace(/\.myshopify\.com$/, "");
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function queryValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(",");
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function escapeQueryKey(s: string): string {
  return s.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D");
}

function escapeQueryValue(s: string): string {
  return s.replace(/%/g, "%25").replace(/&/g, "%26");
}

export function shopifyQueryMessage(query: Record<string, unknown>): string {
  return Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${escapeQueryKey(k)}=${escapeQueryValue(queryValue(query[k]))}`)
    .join("&");
}

export function verifyShopifyQueryHmac(query: Record<string, unknown>, secret: string = shopifyClientSecret()): boolean {
  if (!secret) return false;
  const provided = query.hmac;
  if (typeof provided !== "string" || !/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = crypto.createHmac("sha256", secret).update(shopifyQueryMessage(query)).digest("hex");
  return safeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided.toLowerCase(), "utf8"));
}

export function verifyShopifyWebhookHmac(rawBody: Buffer, headerBase64: unknown, secret: string = shopifyClientSecret()): boolean {
  if (!secret || !Buffer.isBuffer(rawBody)) return false;
  if (typeof headerBase64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(headerBase64)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(headerBase64, "base64");
  return safeEqual(expected, provided);
}

function installKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(`${INSTALL_KEY_LABEL}:${secret}`).digest();
}

function installSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", installKey(secret)).update(payload).digest("base64url");
}

function appConfirmationSignature(payload: string, secret: string): string {
  const key = crypto.createHash("sha256").update(`${APP_CONFIRM_KEY_LABEL}:${secret}`).digest();
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function viewerEmailFingerprint(email: string, secret: string): string {
  return crypto.createHmac("sha256", installKey(secret)).update(`viewer:${email.trim().toLowerCase()}`).digest("base64url");
}

function signedInstallToken(
  installation_id: string,
  generation: number,
  options: { viewer_email_fingerprint?: string; return_to_app?: boolean; shopify_user_id?: string },
  secret: string,
): string {
  if (!secret || !UUID_RE.test(installation_id) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Cannot sign an invalid Shopify installation reference.");
  }
  const exp = Date.now() + INSTALL_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({
    id: installation_id,
    gen: generation,
    exp,
    ...(options.viewer_email_fingerprint ? { vh: options.viewer_email_fingerprint } : {}),
    ...(options.return_to_app ? { rt: "app" } : {}),
    ...(options.shopify_user_id ? { su: options.shopify_user_id } : {}),
  }), "utf8").toString("base64url");
  return `${payload}.${installSignature(payload, secret)}`;
}

export function signInstallToken(
  installation_id: string,
  generation: number,
  secret: string = shopifyClientSecret(),
): string {
  return signedInstallToken(installation_id, generation, {}, secret);
}

export function signAppHomeInstallToken(
  installation_id: string,
  generation: number,
  shopify_user_id: string,
  secret: string = shopifyClientSecret(),
): string {
  if (!/^[0-9]{1,64}$/.test(shopify_user_id)) throw new Error("Cannot bind a Shopify installation to an invalid staff user.");
  return signedInstallToken(installation_id, generation, { return_to_app: true, shopify_user_id }, secret);
}

export function signShopifyAppHomeConfirmation(
  ref: ShopifyInstallRef,
  tenant_id: string,
  user_id: string,
  secret: string = shopifyClientSecret(),
): string {
  if (!secret || !ref.return_to_app || !ref.shopify_user_id || !UUID_RE.test(ref.installation_id) ||
      !Number.isSafeInteger(ref.generation) || ref.generation < 1 || !UUID_RE.test(tenant_id) || !UUID_RE.test(user_id)) {
    throw new Error("Cannot sign an invalid Shopify App Home confirmation.");
  }
  const payload = Buffer.from(JSON.stringify({
    kind: "app_confirm",
    id: ref.installation_id,
    gen: ref.generation,
    su: ref.shopify_user_id,
    tid: tenant_id,
    uid: user_id,
    exp: Date.now() + 10 * 60 * 1000,
  }), "utf8").toString("base64url");
  return `${payload}.${appConfirmationSignature(payload, secret)}`;
}

export function verifyShopifyAppHomeConfirmation(
  token: unknown,
  secret: string = shopifyClientSecret(),
): ShopifyAppHomeConfirmation | null {
  if (!secret || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = appConfirmationSignature(payload, secret);
  if (!safeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"))) return null;
  let parsed: { kind?: unknown; id?: unknown; gen?: unknown; su?: unknown; tid?: unknown; uid?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.kind !== "app_confirm" || typeof parsed.id !== "string" || !UUID_RE.test(parsed.id)) return null;
  if (typeof parsed.gen !== "number" || !Number.isSafeInteger(parsed.gen) || parsed.gen < 1) return null;
  if (typeof parsed.su !== "string" || !/^[0-9]{1,64}$/.test(parsed.su)) return null;
  if (typeof parsed.tid !== "string" || !UUID_RE.test(parsed.tid) || typeof parsed.uid !== "string" || !UUID_RE.test(parsed.uid)) return null;
  if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
  return {
    ref: { installation_id: parsed.id, generation: parsed.gen, return_to_app: true, shopify_user_id: parsed.su },
    tenant_id: parsed.tid,
    user_id: parsed.uid,
  };
}

function appLinkSignature(payload: string, secret: string): string {
  const key = crypto.createHash("sha256").update(`${APP_LINK_KEY_LABEL}:${secret}`).digest();
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function signAppLinkPayload(body: Record<string, unknown>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${payload}.${appLinkSignature(payload, secret)}`;
}

function verifyAppLinkPayload(token: unknown, kind: string, secret: string): Record<string, unknown> | null {
  if (!secret || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const expected = appLinkSignature(payload, secret);
  if (!safeEqual(Buffer.from(expected, "utf8"), Buffer.from(token.slice(dot + 1), "utf8"))) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.kind !== kind || typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
  if (typeof parsed.shop !== "string" || !SHOP_RE.test(parsed.shop)) return null;
  if (typeof parsed.su !== "string" || !/^[0-9]{1,64}$/.test(parsed.su)) return null;
  return parsed;
}

export function signShopifyAppLinkToken(
  shop: string,
  shopify_user_id: string,
  secret: string = shopifyClientSecret(),
): string {
  if (!secret || !SHOP_RE.test(shop) || !/^[0-9]{1,64}$/.test(shopify_user_id)) {
    throw new Error("Cannot sign an invalid Shopify staff link.");
  }
  return signAppLinkPayload({ kind: "app_link", shop, su: shopify_user_id, exp: Date.now() + INSTALL_TOKEN_TTL_MS }, secret);
}

export function verifyShopifyAppLinkToken(
  token: unknown,
  secret: string = shopifyClientSecret(),
): ShopifyAppLinkRef | null {
  const parsed = verifyAppLinkPayload(token, "app_link", secret);
  return parsed ? { shop: parsed.shop as string, shopify_user_id: parsed.su as string } : null;
}

export function signShopifyAppLinkConfirmation(
  ref: ShopifyAppLinkRef,
  tenant_id: string,
  user_id: string,
  secret: string = shopifyClientSecret(),
): string {
  if (!secret || !SHOP_RE.test(ref.shop) || !/^[0-9]{1,64}$/.test(ref.shopify_user_id) || !UUID_RE.test(tenant_id) || !UUID_RE.test(user_id)) {
    throw new Error("Cannot sign an invalid Shopify staff link confirmation.");
  }
  return signAppLinkPayload({
    kind: "app_link_confirm",
    shop: ref.shop,
    su: ref.shopify_user_id,
    tid: tenant_id,
    uid: user_id,
    exp: Date.now() + APP_LINK_CONFIRMATION_TTL_MS,
  }, secret);
}

export function verifyShopifyAppLinkConfirmation(
  token: unknown,
  secret: string = shopifyClientSecret(),
): ShopifyAppLinkConfirmation | null {
  const parsed = verifyAppLinkPayload(token, "app_link_confirm", secret);
  if (!parsed) return null;
  if (typeof parsed.tid !== "string" || !UUID_RE.test(parsed.tid) || typeof parsed.uid !== "string" || !UUID_RE.test(parsed.uid)) return null;
  return { shop: parsed.shop as string, shopify_user_id: parsed.su as string, tenant_id: parsed.tid, user_id: parsed.uid };
}

export function signInstallTokenForViewer(
  installation_id: string,
  generation: number,
  email: string,
  secret: string = shopifyClientSecret(),
): string {
  if (!email.trim()) throw new Error("Cannot bind a Shopify installation to an empty email.");
  return signedInstallToken(installation_id, generation, { viewer_email_fingerprint: viewerEmailFingerprint(email, secret) }, secret);
}

export function verifyInstallToken(token: unknown, secret: string = shopifyClientSecret()): ShopifyInstallRef | null {
  if (!secret || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = installSignature(payload, secret);
  if (!safeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig, "utf8"))) return null;
  let parsed: { id?: unknown; gen?: unknown; exp?: unknown; vh?: unknown; rt?: unknown; su?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { id?: unknown; gen?: unknown; exp?: unknown; vh?: unknown; rt?: unknown; su?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.id !== "string" || !UUID_RE.test(parsed.id)) return null;
  if (typeof parsed.gen !== "number" || !Number.isSafeInteger(parsed.gen) || parsed.gen < 1) return null;
  if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
  if (parsed.vh !== undefined && (typeof parsed.vh !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.vh))) return null;
  if (parsed.rt !== undefined && parsed.rt !== "app") return null;
  if (parsed.su !== undefined && (typeof parsed.su !== "string" || !/^[0-9]{1,64}$/.test(parsed.su))) return null;
  if (parsed.rt === "app" && parsed.su === undefined) return null;
  if (parsed.su !== undefined && parsed.rt !== "app") return null;
  return {
    installation_id: parsed.id,
    generation: parsed.gen,
    ...(parsed.vh ? { viewer_email_fingerprint: parsed.vh } : {}),
    ...(parsed.rt === "app" ? { return_to_app: true as const } : {}),
    ...(typeof parsed.su === "string" ? { shopify_user_id: parsed.su } : {}),
  };
}

export function installTokenMatchesViewerEmail(
  ref: ShopifyInstallRef,
  email: string | null | undefined,
  secret: string = shopifyClientSecret(),
): boolean {
  if (!ref.viewer_email_fingerprint || !email || !secret) return false;
  const actual = viewerEmailFingerprint(email, secret);
  return safeEqual(Buffer.from(ref.viewer_email_fingerprint, "utf8"), Buffer.from(actual, "utf8"));
}
