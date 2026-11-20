import { beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache, findJwk, JWKS_TTL_MS } from "../jwt";

const URL_ = "https://abcdefghijklmnopqrst.supabase.co/auth/v1/.well-known/jwks.json";
beforeEach(() => clearJwksCache());

describe("JWKS cache", () => {
  it("a removed key stops verifying after the TTL even when the JWKS endpoint is failing", async () => {
    let up = true;
    const f = (async () => (up ? new Response(JSON.stringify({ keys: [{ kid: "old", kty: "EC", crv: "P-256" }] })) : new Response("down", { status: 503 }))) as unknown as typeof fetch;
    expect(await findJwk(URL_, "old", 0, f)).not.toBeNull();
    up = false;
    expect(await findJwk(URL_, "old", JWKS_TTL_MS - 1, f)).not.toBeNull();
    expect(await findJwk(URL_, "old", JWKS_TTL_MS + 1, f)).toBeNull();
    const thrower = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await findJwk(URL_, "old", JWKS_TTL_MS + 2, thrower)).toBeNull();
  });
});
