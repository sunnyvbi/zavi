
import { describe, it, expect, expectTypeOf } from "vitest";
import {
  E2B_VITE_TEMPLATE_ALIAS,
  SITE_IDLE_PAUSE_DAYS,
  SITE_MANIFEST_PATH,
  SITE_MIGRATIONS_DIR,
  SITE_REPO_DIR,
  SITE_WAKE_PATH,
  SMOKE_SCRIPT_PATH,
  STARTER_SQL_PATH,
  SiteCredentialsMissing,
  VITE_DEV_PORT,
  VITE_STARTER_ID,
  siteKv,
  siteVaultKey,
  type SiteProviderKind,
  type SiteProviderState,
  type SiteStarterProvider,
  type SiteStatus,
  type StarterFiles,
} from "../contract";

describe("sites contract", () => {
  it("pins the stable constants", () => {
    expect(SITE_IDLE_PAUSE_DAYS).toBe(30);
    expect(SITE_WAKE_PATH).toBe("/api/public/sites/wake");
    expect(VITE_STARTER_ID).toBe("vite-react-supabase");
    expect(E2B_VITE_TEMPLATE_ALIAS).toBe("zavi-vite-starter");
    expect(VITE_DEV_PORT).toBe(5173);
    expect(SITE_REPO_DIR).toBe("/home/user/repo");
    expect(STARTER_SQL_PATH).toBe("supabase/starter.sql");
    expect(SITE_MIGRATIONS_DIR).toBe("supabase/migrations");
    expect(SITE_MANIFEST_PATH).toBe("zavi-site.json");
    expect(SMOKE_SCRIPT_PATH).toBe("scripts/smoke.mjs");
  });

  it("pins the Vault key shapes", () => {
    expect(siteVaultKey.serviceRole("s1")).toBe("site.s1.sb_service_role");
    expect(siteVaultKey.anon("s1")).toBe("site.s1.sb_anon");
    expect(siteVaultKey.dbPassword("s1")).toBe("site.s1.sb_db_password");
  });

  it("pins the Worker KV key shapes", () => {
    expect(siteKv.host("a.zaviagent.com")).toBe("host:a.zaviagent.com");
    expect(siteKv.lastSeen("a.zaviagent.com")).toBe("lastseen:a.zaviagent.com");
    expect(siteKv.paused("a.zaviagent.com")).toBe("paused:a.zaviagent.com");
  });

  it("SiteCredentialsMissing names every missing key", () => {
    const e = new SiteCredentialsMissing(["SUPABASE_MGMT_TOKEN", "SUPABASE_ORG_ID"]);
    expect(e).toBeInstanceOf(Error);
    expect(e.missing).toEqual(["SUPABASE_MGMT_TOKEN", "SUPABASE_ORG_ID"]);
    expect(e.message).toBe("site credentials missing: SUPABASE_MGMT_TOKEN, SUPABASE_ORG_ID");
  });

  it("pins the union types", () => {
    expectTypeOf<SiteStatus>().toEqualTypeOf<
      | "provisioning" | "building" | "publishing" | "live"
      | "paused" | "waking" | "failed" | "fell_back_old" | "deleting" | "deleted"
    >();
    expectTypeOf<SiteProviderKind>().toEqualTypeOf<
      "github_repo" | "supabase_project" | "cloudflare_host" | "r2_prefix" | "pooled_backend"
    >();
    expectTypeOf<SiteProviderState>().toEqualTypeOf<
      "claimed" | "created" | "cleanup_pending" | "delete_scheduled" | "delete_issuing" | "deleted"
    >();
  });

  it("pins the starter seam shape", () => {
    expectTypeOf<StarterFiles>().toEqualTypeOf<{
      files: Record<string, string>;
      starter_sql?: string;
      manifest_json: string;
    }>();
    expectTypeOf<SiteStarterProvider["starterFiles"]>().returns.toEqualTypeOf<StarterFiles>();
  });
});
