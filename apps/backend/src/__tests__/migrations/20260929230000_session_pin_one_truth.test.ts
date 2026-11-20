import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const NAME = "20260929230000_session_pin_one_truth.sql";
const sql = readFileSync(join(DIR, NAME), "utf8");
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

describe(NAME, () => {
  const body = code(sql);

  it("resolves the session pin first, then the claim, then the profile", () => {
    const pin = body.indexOf("from public.session_tenants");
    const claim = body.indexOf("'active_tenant_id'");
    const profile = body.indexOf("from public.profiles");
    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(claim);
    expect(claim).toBeLessThan(profile);
    expect(body).toMatch(/st\.session_id = v_session\s+and st\.user_id = v_user/);
  });

  it("returns only a tenant the caller belongs to", () => {
    expect(body).toMatch(/not exists \(select 1 from public\.tenant_users tu\s+where tu\.user_id = v_user and tu\.tenant_id = v_tenant\)/);
  });

  it("is a stable security definer whose search_path pins pg_temp last", () => {
    expect(body).toMatch(/stable\s+security definer\s+set search_path = pg_catalog, pg_temp/);
  });

  it("rewrites the restrictive policies to one evaluation per statement", () => {
    expect(body).toContain("tenant_id = (select public.app_active_tenant())");
    expect(body).toContain("from pg_policies");
    expect(body).toContain("as restrictive for select");
  });
});

describe("no later migration reads the raw tenant claim in a policy", () => {
  const later = readdirSync(DIR).filter((f) => f.endsWith(".sql") && f > NAME);

  it.each(later.length ? later : ["(none yet)"])("%s", (f) => {
    if (f === "(none yet)") return;
    const body = code(readFileSync(join(DIR, f), "utf8"));
    const policies = body.match(/create\s+policy[\s\S]*?;/gi) ?? [];
    for (const p of policies) {
      expect(p, `${f}: use (select public.app_active_tenant()) instead of the raw claim`).not.toMatch(/active_tenant_id/);
    }
  });
});
