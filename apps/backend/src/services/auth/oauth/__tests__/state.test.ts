import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.OAUTH_STATE_SECRET = "test-secret-key-for-consent-state";
});

describe("consent-state signing", () => {
  async function mod() {
    return import("../state");
  }

  const base = {
    client_id: "c1",
    redirect_uri: "https://claude.ai/cb",
    code_challenge: "abc",
    state: "xyz",
    scopes: ["read", "run", "offline_access"],
    resource: "https://api.zaviagent.com/mcp",
  };

  it("round-trips a valid signed state and assigns a jti", async () => {
    const { signConsentState, verifyConsentState } = await mod();
    const token = signConsentState(base);
    const out = verifyConsentState(token);
    expect(out).not.toBeNull();
    expect(out!.client_id).toBe("c1");
    expect(out!.redirect_uri).toBe("https://claude.ai/cb");
    expect(typeof out!.jti).toBe("string");
    expect(out!.jti.length).toBeGreaterThan(10);
  });

  it("rejects a tampered payload", async () => {
    const { signConsentState, verifyConsentState } = await mod();
    const token = signConsentState(base);
    const [body, sig] = token.split(".");
    const tampered =
      Buffer.from(JSON.stringify({ ...base, client_id: "evil", jti: "x", iat: 1 }), "utf8").toString("base64url") +
      "." +
      sig;
    expect(verifyConsentState(tampered)).toBeNull();
    expect(verifyConsentState(`${body}.${sig}`)).not.toBeNull();
  });

  it("rejects an expired state (iat older than TTL)", async () => {
    const { verifyConsentState } = await mod();
    const { createHmac } = await import("node:crypto");
    const stale = { ...base, jti: "j1", iat: Math.floor(Date.now() / 1000) - 10_000 };
    const body = Buffer.from(JSON.stringify(stale), "utf8").toString("base64url");
    const sig = createHmac("sha256", process.env.OAUTH_STATE_SECRET!).update(body).digest().toString("base64url");
    expect(verifyConsentState(`${body}.${sig}`)).toBeNull();
  });

  it("rejects malformed input", async () => {
    const { verifyConsentState } = await mod();
    expect(verifyConsentState("not-a-token")).toBeNull();
    expect(verifyConsentState("")).toBeNull();
  });
});
