
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GOOGLE_ADS_VAULT_KEYS, GOOGLE_ADS_ENV_KEYS } from "../keys";

const root = join(__dirname, "..", "..", "..", "..", "..");
const clientSrc = readFileSync(join(__dirname, "..", "_client.ts"), "utf-8");
const migSrc = readFileSync(
  join(root, "..", "..", "supabase", "migrations", "0083_google_ads_oauth_plumbing.sql"),
  "utf-8",
);

const perTenant = [GOOGLE_ADS_VAULT_KEYS.refresh_token, GOOGLE_ADS_VAULT_KEYS.customer_id];

describe("Google Ads Vault-key contract", () => {
  it("_client.ts reads each per-tenant key via getSecret(GOOGLE_ADS_VAULT_KEYS.*)", () => {
    expect(clientSrc).toMatch(/getSecret\(\s*tenant_id,\s*GOOGLE_ADS_VAULT_KEYS\.refresh_token\s*\)/);
    expect(clientSrc).toMatch(/getSecret\(\s*tenant_id,\s*GOOGLE_ADS_VAULT_KEYS\.customer_id\s*\)/);
  });

  it("migration 0082 writes exactly the per-tenant keys into secrets", () => {
    for (const k of perTenant) {
      expect(migSrc).toContain(`'${k}'`);
    }
    const writtenKeys = [...migSrc.matchAll(/key\s*=\s*'(google_ads\.[a-z_]+)'|values\s*\([^)]*'(google_ads\.[a-z_]+)'/g)]
      .flatMap((m) => [m[1], m[2]])
      .filter(Boolean) as string[];
    const allowed = new Set<string>([...perTenant, GOOGLE_ADS_VAULT_KEYS.login_customer_id]);
    for (const k of writtenKeys) {
      if (k === "google_ads.access_token" || k === "google_ads.developer_token") continue;
      expect(allowed.has(k)).toBe(true);
    }
  });

  it("app-level secrets come from process.env, never getSecret (Decision A)", () => {
    expect(clientSrc).toMatch(/process\.env\[GOOGLE_ADS_ENV_KEYS\.client_id\]/);
    expect(clientSrc).toMatch(/process\.env\[GOOGLE_ADS_ENV_KEYS\.client_secret\]/);
    expect(clientSrc).toMatch(/process\.env\[GOOGLE_ADS_ENV_KEYS\.developer_token\]/);
    expect(clientSrc).not.toMatch(/getSecret\([^)]*client_secret/);
    expect(clientSrc).not.toMatch(/getSecret\([^)]*developer_token/);
  });

  it("migration 0082 does NOT STORE client_id/client_secret/developer_token per tenant", () => {
    for (const k of ["google_ads.client_id", "google_ads.client_secret", "google_ads.developer_token", "google_ads.access_token"]) {
      expect(migSrc).not.toMatch(
        new RegExp(`insert into secrets[^;]*values[^;]*'${k.replace(".", "\\.")}'`, "i"),
      );
    }
    const inserted = [...migSrc.matchAll(/insert into secrets[^;]*values\s*\([^;]*?'(google_ads\.[a-z_]+)'/gi)].map((m) => m[1]);
    const allowed = new Set<string>([...perTenant, GOOGLE_ADS_VAULT_KEYS.login_customer_id]);
    for (const k of inserted) expect(allowed.has(k)).toBe(true);
  });

  it("env key names are stable", () => {
    expect(GOOGLE_ADS_ENV_KEYS).toEqual({
      client_id: "GOOGLE_ADS_CLIENT_ID",
      client_secret: "GOOGLE_ADS_CLIENT_SECRET",
      developer_token: "GOOGLE_ADS_DEVELOPER_TOKEN",
    });
  });
});
