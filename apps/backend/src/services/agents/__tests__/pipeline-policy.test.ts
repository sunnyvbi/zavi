
import { describe, it, expect } from "vitest";
import {
  parseAppPipelinePolicy,
  resolveProtectedGlobs,
  matchProtectedGlob,
  findProtectedPathHits,
  coerceProtectedPathHits,
  normalizeRepoPath,
  CORE_PROTECTED_GLOBS,
  DEFAULT_PROTECTED_GLOBS,
  DEFAULT_APP_PIPELINE_POLICY,
} from "@/services/agents/pipeline-policy";

describe("matchProtectedGlob — the dumb glob matcher (Q5)", () => {
  const globs = [...DEFAULT_PROTECTED_GLOBS];

  it("matches env files anywhere (**/.env*)", () => {
    expect(matchProtectedGlob(".env", globs)).toBe("**/.env*");
    expect(matchProtectedGlob(".env.local", globs)).toBe("**/.env*");
    expect(matchProtectedGlob("apps/backend/.env", globs)).toBe("**/.env*");
    expect(matchProtectedGlob("apps/web/.env.production", globs)).toBe("**/.env*");
  });

  it("matches migrations (supabase/migrations/**)", () => {
    expect(matchProtectedGlob("supabase/migrations/20260101_x.sql", globs)).toBe(
      "supabase/migrations/**",
    );
  });

  it("matches auth / billing / webhooks / middleware / secrets DIRS as segments", () => {
    expect(matchProtectedGlob("src/services/auth/session.ts", globs)).toBe("**/auth/**");
    expect(matchProtectedGlob("src/lib/billing/charge.ts", globs)).toBe("**/billing/**");
    expect(matchProtectedGlob("api/webhooks/stripe.ts", globs)).toBe("**/webhooks/**");
    expect(matchProtectedGlob("src/middleware/index.ts", globs)).toBe("**/middleware/**");
    expect(matchProtectedGlob("config/secrets/keys.json", globs)).toBe("**/secrets/**");
    expect(matchProtectedGlob("auth/login.ts", globs)).toBe("**/auth/**");
  });

  it("does NOT false-positive on names that merely CONTAIN a protected word", () => {
    expect(matchProtectedGlob("src/authenticate.ts", globs)).toBeNull();
    expect(matchProtectedGlob("src/oauth/client.ts", globs)).toBeNull();
    expect(matchProtectedGlob("src/middleware.ts", globs)).toBeNull();
    expect(matchProtectedGlob("src/components/Header.tsx", globs)).toBeNull();
    expect(matchProtectedGlob("README.md", globs)).toBeNull();
    expect(matchProtectedGlob("src/billingHistory.ts", globs)).toBeNull();
  });

  it("normalizes leading ./ and / before matching", () => {
    expect(normalizeRepoPath("./apps/backend/.env")).toBe("apps/backend/.env");
    expect(normalizeRepoPath("/supabase/migrations/x.sql")).toBe("supabase/migrations/x.sql");
    expect(matchProtectedGlob("./.env", globs)).toBe("**/.env*");
  });
});

describe("resolveProtectedGlobs — additive + fail-closed core", () => {
  it("default policy resolves to the DEFAULT set (⊇ CORE)", () => {
    const r = resolveProtectedGlobs(DEFAULT_APP_PIPELINE_POLICY);
    for (const c of CORE_PROTECTED_GLOBS) expect(r).toContain(c);
    for (const d of DEFAULT_PROTECTED_GLOBS) expect(r).toContain(d);
  });

  it("app-specific globs are ADDED (an app can only tighten)", () => {
    const r = resolveProtectedGlobs({
      protected_globs: ["**/payments/**", "src/config/**"],
      freeze: false,
      preview: "branch_preview",
    });
    expect(r).toContain("**/payments/**");
    expect(r).toContain("src/config/**");
    for (const c of CORE_PROTECTED_GLOBS) expect(r).toContain(c);
  });

  it("CORE (migrations/auth/secrets/env) can never be removed by a policy", () => {
    const r = resolveProtectedGlobs({
      protected_globs: ["docs/**"],
      freeze: false,
      preview: "branch_preview",
    });
    expect(r).toContain("supabase/migrations/**");
    expect(r).toContain("**/auth/**");
    expect(r).toContain("**/secrets/**");
    expect(r).toContain("**/.env*");
  });
});

describe("parseAppPipelinePolicy — from external_ref JSONB", () => {
  it("reads flat protected_globs / freeze / preview_policy", () => {
    const p = parseAppPipelinePolicy({
      github_full_name: "praxis-build/acme",
      default_branch: "main",
      protected_globs: ["**/payments/**", "  ", 123, "src/x/**"],
      freeze: true,
      preview_policy: "none",
    });
    expect(p.protected_globs).toEqual(["**/payments/**", "src/x/**"]);
    expect(p.freeze).toBe(true);
    expect(p.preview).toBe("none");
  });

  it("degrades every missing/malformed field to a safe default (fail-closed)", () => {
    expect(parseAppPipelinePolicy(null)).toEqual(DEFAULT_APP_PIPELINE_POLICY);
    expect(parseAppPipelinePolicy({})).toEqual(DEFAULT_APP_PIPELINE_POLICY);
    expect(parseAppPipelinePolicy({ freeze: "yes", protected_globs: "nope" })).toEqual(
      DEFAULT_APP_PIPELINE_POLICY,
    );
  });
});

describe("findProtectedPathHits + coerceProtectedPathHits", () => {
  it("finds every hit, de-dupes by path", () => {
    const hits = findProtectedPathHits(
      ["src/pages/Home.tsx", "supabase/migrations/1.sql", "supabase/migrations/1.sql", ".env"],
      [...DEFAULT_PROTECTED_GLOBS],
    );
    expect(hits.map((h) => h.path).sort()).toEqual([".env", "supabase/migrations/1.sql"]);
  });

  it("returns [] for a clean diff", () => {
    expect(
      findProtectedPathHits(["src/a.ts", "README.md"], [...DEFAULT_PROTECTED_GLOBS]),
    ).toEqual([]);
  });

  it("coerces a persisted stamp back into typed hits", () => {
    expect(
      coerceProtectedPathHits([{ path: "supabase/migrations/x.sql", glob: "supabase/migrations/**" }, "junk", { nope: 1 }]),
    ).toEqual([{ path: "supabase/migrations/x.sql", glob: "supabase/migrations/**" }]);
    expect(coerceProtectedPathHits(undefined)).toEqual([]);
  });
});
