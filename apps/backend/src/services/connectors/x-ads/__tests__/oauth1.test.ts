import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { oauth1Header, rfc3986 } from "../oauth1";

const consumer = { key: "ck", secret: "cs" };

describe("rfc3986", () => {
  it("encodes !'()* and space as %20 — encodeURIComponent alone is NOT enough", () => {
    expect(rfc3986("a b!'()*")).toBe("a%20b%21%27%28%29%2A");
  });
});

describe("oauth1Header", () => {
  it("carries ONLY oauth_* params in the header, never the query params", () => {
    const h = oauth1Header(consumer, "GET", "https://ads-api.x.com/12/accounts", { count: "200" });
    expect(h.startsWith("OAuth ")).toBe(true);
    expect(h).not.toContain("count=");
    for (const k of ["oauth_consumer_key", "oauth_nonce", "oauth_signature", "oauth_signature_method", "oauth_timestamp", "oauth_version"]) {
      expect(h).toContain(`${k}="`);
    }
    expect(h).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(h).not.toContain("oauth_token=");
  });
  it("includes oauth_token when a user token is supplied, and oauthExtra (callback/verifier)", () => {
    const h = oauth1Header(consumer, "POST", "https://api.x.com/oauth/access_token", {}, { key: "tk", secret: "ts" }, { oauth_verifier: "v1" });
    expect(h).toContain('oauth_token="tk"');
    expect(h).toContain('oauth_verifier="v1"');
  });
  it("signs the QUERY params too (a signature over a different set than sent = 401)", () => {
    const url = "https://ads-api.x.com/12/accounts";
    const h = oauth1Header(consumer, "GET", url, { count: "200" });
    const get = (k: string) => decodeURIComponent(h.match(new RegExp(`${k}="([^"]*)"`))![1]);
    const params: Record<string, string> = {
      count: "200",
      oauth_consumer_key: "ck",
      oauth_nonce: get("oauth_nonce"),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: get("oauth_timestamp"),
      oauth_version: "1.0",
    };
    const norm = Object.keys(params).sort().map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`).join("&");
    const base = `GET&${rfc3986(url)}&${rfc3986(norm)}`;
    const expected = createHmac("sha1", `${rfc3986("cs")}&`).update(base).digest("base64");
    expect(get("oauth_signature")).toBe(expected);
    delete params.count;
    const norm2 = Object.keys(params).sort().map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`).join("&");
    const wrong = createHmac("sha1", `${rfc3986("cs")}&`).update(`GET&${rfc3986(url)}&${rfc3986(norm2)}`).digest("base64");
    expect(get("oauth_signature")).not.toBe(wrong);
  });
  it("uses a fresh cryptographic nonce per call", () => {
    const a = oauth1Header(consumer, "GET", "https://x/a"), b = oauth1Header(consumer, "GET", "https://x/a");
    expect(a.match(/oauth_nonce="([^"]*)"/)![1]).not.toBe(b.match(/oauth_nonce="([^"]*)"/)![1]);
  });
});
