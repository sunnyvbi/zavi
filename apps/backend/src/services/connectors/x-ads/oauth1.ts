
import { createHmac, randomBytes } from "node:crypto";

export type Consumer = { key: string; secret: string };
export type UserToken = { key: string; secret: string };

export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauth1Header(
  consumer: Consumer,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  params: Record<string, string> = {},
  token?: UserToken,
  oauthExtra: Record<string, string> = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: randomBytes(24).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(token ? { oauth_token: token.key } : {}),
    ...oauthExtra,
  };
  const all = { ...params, ...oauth };
  const normalized = Object.keys(all)
    .map((k) => [rfc3986(k), rfc3986(all[k])] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method}&${rfc3986(url)}&${rfc3986(normalized)}`;
  const key = `${rfc3986(consumer.secret)}&${rfc3986(token?.secret ?? "")}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k])}"`)
    .join(", ")}`;
}

const LIMIT = 16 * 1024;

async function formPost(
  consumer: Consumer,
  url: string,
  oauthExtra: Record<string, string>,
  token?: UserToken,
): Promise<URLSearchParams> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: oauth1Header(consumer, "POST", url, {}, token, oauthExtra) },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status !== 200) throw new Error(`X OAuth request failed (HTTP ${resp.status})`);
  const text = await resp.text();
  if (text.length > LIMIT) throw new Error("X OAuth response exceeded size limit");
  const values = new URLSearchParams(text);
  for (const k of ["oauth_token", "oauth_token_secret"]) {
    const v = values.getAll(k);
    if (v.length !== 1 || !v[0] || /[\s\x00-\x1f\x7f]/.test(v[0])) throw new Error("X OAuth: malformed token response");
  }
  return values;
}

export async function requestToken(consumer: Consumer, requestTokenUrl: string, callback: string): Promise<UserToken> {
  const u = new URL(callback);
  if (u.protocol !== "https:" || u.search || u.hash) {
    throw new Error("X OAuth: callback must be an exact registered HTTPS URL without query or fragment");
  }
  const v = await formPost(consumer, requestTokenUrl, { oauth_callback: u.href });
  if (v.get("oauth_callback_confirmed") !== "true") throw new Error("X OAuth: callback was not confirmed");
  return { key: v.get("oauth_token")!, secret: v.get("oauth_token_secret")! };
}

export async function accessToken(
  consumer: Consumer,
  accessTokenUrl: string,
  request: UserToken,
  verifier: string,
): Promise<{ token: UserToken; userId: string; screenName: string }> {
  if (!verifier || /[\s\x00-\x1f\x7f]/.test(verifier)) throw new Error("X OAuth: malformed verifier");
  const v = await formPost(consumer, accessTokenUrl, { oauth_verifier: verifier }, request);
  return {
    token: { key: v.get("oauth_token")!, secret: v.get("oauth_token_secret")! },
    userId: v.get("user_id") ?? "",
    screenName: v.get("screen_name") ?? "",
  };
}
