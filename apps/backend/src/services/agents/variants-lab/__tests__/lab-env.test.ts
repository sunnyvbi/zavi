import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { applyProdAppKeys, normalizePemValue, parseEnvKeys, PROD_APP_KEYS, supabaseProjectRef } from "../lab-env";

describe("parseEnvKeys", () => {
  it("reads only the asked keys, strips quotes and export", () => {
    const text = [
      "# comment",
      "SUPABASE_URL=https://wmycgyjsenvgtczlupoe.supabase.co",
      'export SUPABASE_SERVICE_ROLE_KEY="abc.def"',
      "QA_TEST_PASSWORD=secret",
      "SUPABASE_ANON_KEY=anon",
    ].join("\n");
    expect(parseEnvKeys(text, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])).toEqual({
      SUPABASE_URL: "https://wmycgyjsenvgtczlupoe.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "abc.def",
    });
  });
});

describe("parseEnvKeys — anon key", () => {
  it("takes SUPABASE_ANON_KEY when asked, nothing else", () => {
    const text = "SUPABASE_ANON_KEY=anon-prod\nQA_TEST_PASSWORD=secret";
    expect(parseEnvKeys(text, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"])).toEqual({
      SUPABASE_ANON_KEY: "anon-prod",
    });
  });
});

describe("supabaseProjectRef", () => {
  it("returns the project ref of a supabase url", () => {
    expect(supabaseProjectRef("https://wmycgyjsenvgtczlupoe.supabase.co")).toBe("wmycgyjsenvgtczlupoe");
    expect(supabaseProjectRef("https://dgzgwclslzzzrjopbobp.supabase.co/")).toBe("dgzgwclslzzzrjopbobp");
  });
  it("rejects look-alikes and non-supabase hosts", () => {
    expect(supabaseProjectRef("https://wmycgyjsenvgtczlupoe.supabase.co.evil.com")).toBeNull();
    expect(supabaseProjectRef("http://wmycgyjsenvgtczlupoe.supabase.co")).toBeNull();
    expect(supabaseProjectRef("http://localhost:54321")).toBeNull();
    expect(supabaseProjectRef("not a url")).toBeNull();
  });
});

const PEM_BODY = "MIIEowIBAAKCAQEAabc\nDEFghi123\n";
describe("parseEnvKeys — GitHub App private key shapes", () => {
  it("a double-quoted multi-line PEM keeps its real newlines", () => {
    const text = [
      "GITHUB_APP_ID=12345",
      'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
      "MIIEowIBAAKCAQEAabc",
      "DEFghi123",
      '-----END RSA PRIVATE KEY-----"',
      "GITHUB_APP_SLUG=zavi-app",
    ].join("\n");
    const kv = parseEnvKeys(text, PROD_APP_KEYS);
    expect(kv.GITHUB_APP_ID).toBe("12345");
    expect(kv.GITHUB_APP_SLUG).toBe("zavi-app");
    expect(kv.GITHUB_APP_PRIVATE_KEY).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\nDEFghi123\n-----END RSA PRIVATE KEY-----",
    );
  });

  it("a double-quoted single line with \\n escapes expands them (same as the backend's dotenv)", () => {
    const text = 'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAabc\\nDEFghi123\\n-----END RSA PRIVATE KEY-----"';
    expect(parseEnvKeys(text, ["GITHUB_APP_PRIVATE_KEY"]).GITHUB_APP_PRIVATE_KEY).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\n" + PEM_BODY + "-----END RSA PRIVATE KEY-----",
    );
  });

  it("an unquoted \\n-escaped line stays literal (the GitHub client normalizes it)", () => {
    const text = "GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY-----";
    expect(parseEnvKeys(text, ["GITHUB_APP_PRIVATE_KEY"]).GITHUB_APP_PRIVATE_KEY).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY-----",
    );
  });

  it("a missing or empty key is absent", () => {
    expect(parseEnvKeys("GITHUB_APP_ID=\nOTHER=1", ["GITHUB_APP_ID", "GITHUB_APP_SLUG"])).toEqual({});
  });
});

describe("applyProdAppKeys", () => {
  it("overrides with prod values and names the keys still on staging; never returns values", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_APP_ID: "staging-id",
      COMPOSIO_API_KEY: "staging-composio",
      UNRELATED: "x",
    };
    const r = applyProdAppKeys(env, { GITHUB_APP_ID: "prod-id", GOOGLE_ADS_CLIENT_ID: "prod-g" });
    expect(env.GITHUB_APP_ID).toBe("prod-id");
    expect(env.GOOGLE_ADS_CLIENT_ID).toBe("prod-g");
    expect(env.COMPOSIO_API_KEY).toBe("staging-composio");
    expect(env.UNRELATED).toBe("x");
    expect(r.from_prod.sort()).toEqual(["GITHUB_APP_ID", "GOOGLE_ADS_CLIENT_ID"]);
    expect(r.still_staging).toEqual(["COMPOSIO_API_KEY"]);
    expect(JSON.stringify(r)).not.toMatch(/staging-|prod-/);
  });

  it("the allowlist covers the keys named in the root cause", () => {
    for (const k of [
      "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY",
      "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN",
      "COMPOSIO_API_KEY", "COMPOSIO_MCP_SERVER_ID", "COMPOSIO_AUTH_CONFIGS", "PRAXIS_VAULT_KEY",
    ]) expect(PROD_APP_KEYS).toContain(k);
    expect(PROD_APP_KEYS.some((k) => k.startsWith("SUPABASE_") || /SIGNING|WEBHOOK/.test(k))).toBe(false);
  });
});

describe("normalizePemValue — a key pasted on one line with spaces for line breaks", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const lines = privateKey.trim().split("\n");
  const mangled = lines.join(" ");

  it("the fixture really is the broken shape", () => {
    expect(mangled).not.toContain("\n");
    expect(mangled.split(" ").length - 1).toBeGreaterThan(20);
    expect(() => crypto.createPrivateKey(mangled)).toThrow();
  });

  it("re-wraps it into a key Node can load, identical to the original", () => {
    const fixed = normalizePemValue(mangled);
    const k = crypto.createPrivateKey(fixed);
    expect(k.export({ type: "pkcs1", format: "pem" })).toBe(privateKey);
    for (const l of fixed.trim().split("\n").slice(1, -1)) expect(l.length).toBeLessThanOrEqual(64);
  });

  it("also fixes \\n-escaped and leaves a correct key loadable", () => {
    const escaped = lines.join("\\n");
    expect(() => crypto.createPrivateKey(normalizePemValue(escaped))).not.toThrow();
    expect(crypto.createPrivateKey(normalizePemValue(privateKey)).export({ type: "pkcs1", format: "pem" })).toBe(privateKey);
  });

  it("applyProdAppKeys normalizes the GitHub App key from prodqa.env", () => {
    const env: Record<string, string | undefined> = {};
    const text = `GITHUB_APP_PRIVATE_KEY=${mangled}`;
    applyProdAppKeys(env, parseEnvKeys(text, PROD_APP_KEYS));
    expect(() => crypto.createPrivateKey(env.GITHUB_APP_PRIVATE_KEY!)).not.toThrow();
  });

  it("a non-PEM value is unchanged", () => {
    expect(normalizePemValue("abc def")).toBe("abc def");
  });
});
