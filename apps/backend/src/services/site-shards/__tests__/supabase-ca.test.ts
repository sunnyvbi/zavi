import { describe, it, expect } from "vitest";
import { X509Certificate } from "node:crypto";
import { SUPABASE_ROOT_CA_2021, supabasePgConfig } from "../supabase-ca";

describe("supabasePgConfig", () => {
  it("verifies TLS against the Supabase root CA", () => {
    const c = supabasePgConfig("postgresql://u.ref:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require");
    expect(c.ssl).toEqual({ ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true });
  });
  it("drops sslmode from the URL so it cannot override the explicit ssl option", () => {
    const c = supabasePgConfig("postgresql://u.ref:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require");
    expect(c.connectionString).not.toMatch(/sslmode/);
    expect(c.connectionString).toContain("aws-0-us-west-1.pooler.supabase.com:6543/postgres");
  });
  it("embeds a valid, unexpired Supabase Root 2021 CA", () => {
    const x = new X509Certificate(SUPABASE_ROOT_CA_2021);
    expect(x.subject).toContain("Supabase Root 2021 CA");
    expect(new Date(x.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
