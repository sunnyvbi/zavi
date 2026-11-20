import { describe, it, expect, vi } from "vitest";
import { type KernelSqlPolicy, isVerifiedSiteRepoRun, siteProtectedPathHits, withoutSiteMigrationHits, payloadSiteId, verifySiteRepoRun } from "../site-build-target";
import { DEFAULT_PROTECTED_GLOBS, findProtectedPathHits } from "@/services/agents/pipeline-policy";
import type { SiteRow } from "../contract";

const T = "6fcb0904-4e2b-41dc-aa92-83810a902d2d";
const SITE = "4e697436-edc6-4e18-9d92-17adccbf898f";
const REPO = "Zavi-Latest-Build/dog-grooming-693dfbdb-4e6974";

function site(over: Partial<SiteRow> = {}): SiteRow {
  return { id: SITE, tenant_id: T, github_full_name: REPO, status: "building", hostname: "h", label: "l" } as unknown as SiteRow & typeof over;
}

describe("isVerifiedSiteRepoRun", () => {
  const payload = { stage: "build", site_id: SITE };
  it("true only when this tenant's site owns the repo and is the payload's site", async () => {
    const load = vi.fn(async () => site());
    expect(await isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: REPO, payload }, load)).toBe(true);
    expect(load).toHaveBeenCalledWith(T, REPO);
  });
  it("false without a site_id (an old-flow or customer run)", async () => {
    const load = vi.fn(async () => site());
    expect(await isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: REPO, payload: { stage: "build" } }, load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
  it("false when the repo belongs to another site, another tenant, or no site", async () => {
    expect(await isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: REPO, payload }, async () => ({ ...site(), id: "11111111-1111-4111-8111-111111111111" }))).toBe(false);
    expect(await isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: REPO, payload }, async () => ({ ...site(), tenant_id: "other" }))).toBe(false);
    expect(await isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: REPO, payload }, async () => null)).toBe(false);
    expect(await isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: "Zavi-Latest-Build/other", payload }, async () => site())).toBe(false);
  });
  it("false for a dead site and on a read error (fail closed)", async () => {
    for (const status of ["failed", "fell_back_old", "deleting", "deleted"] as const) {
      expect(await isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: REPO, payload }, async () => ({ ...site(), status }))).toBe(false);
    }
    expect(await isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: REPO, payload }, async () => { throw new Error("db down"); })).toBe(false);
  });
  it("SQL may only be authored where it can run: false for a POOLED site and a BUILT kernel site; true for static, legacy dedicated and a GRADUATED kernel", async () => {
    const K = "55555555-5555-4555-8555-555555555555";
    const policy = vi.fn(async () => false);
    const run = (over: Partial<SiteRow>, p: KernelSqlPolicy = policy) => isVerifiedSiteRepoRun({ tenant_id: T, repo_full_name: REPO, payload }, async () => ({ ...site(), ...over }), p);
    expect(await run({ backend_mode: "pooled", shard_id: "33333333-3333-4333-8333-333333333333" })).toBe(false);
    expect(await run({ backend_mode: "static", shard_id: "33333333-3333-4333-8333-333333333333" })).toBe(false);
    expect(await run({ backend_mode: "dedicated", kernel_shard_id: K })).toBe(false);
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T }));
    expect(await run({ backend_mode: "dedicated", kernel_shard_id: K }, async () => true)).toBe(true);
    expect(await run({ backend_mode: "static" })).toBe(true);
    expect(await run({ backend_mode: "dedicated" })).toBe(true);
    expect(await run({ backend_mode: "dedicated", kernel_shard_id: K }, async () => { throw new Error("db down"); })).toBe(false);
  });
  it("payloadSiteId ignores non-uuid values", () => {
    expect(payloadSiteId({ site_id: "x" })).toBeNull();
    expect(payloadSiteId({ site_id: SITE.toUpperCase() })).toBe(SITE);
  });
});

describe("siteProtectedPathHits", () => {
  const globs = [...DEFAULT_PROTECTED_GLOBS, "**/*.sql"];
  it("the default policy holds a site migration (today's refusal)", () => {
    expect(findProtectedPathHits(["supabase/migrations/001_bookings.sql"], [...DEFAULT_PROTECTED_GLOBS])).toHaveLength(1);
  });
  it("lifts only the migrations glob for top-level files; every other glob still applies", () => {
    expect(siteProtectedPathHits([{ path: "supabase/migrations/001_bookings.sql" }, { path: "src/pages/Book.tsx" }], [...DEFAULT_PROTECTED_GLOBS])).toEqual([]);
    expect(siteProtectedPathHits([{ path: "supabase/migrations/001_bookings.sql" }], globs)).toEqual([
      { path: "supabase/migrations/001_bookings.sql", glob: "**/*.sql" },
    ]);
    expect(siteProtectedPathHits([{ path: ".env.local" }, { path: "src/billing/x.ts" }], [...DEFAULT_PROTECTED_GLOBS]).map((h) => h.path)).toEqual([".env.local", "src/billing/x.ts"]);
  });
  it("a nested path under supabase/migrations stays a hit", () => {
    expect(siteProtectedPathHits([{ path: "supabase/migrations/a/001.sql" }], [...DEFAULT_PROTECTED_GLOBS])).toEqual([
      { path: "supabase/migrations/a/001.sql", glob: "supabase/migrations/**" },
    ]);
  });
  it("withoutSiteMigrationHits drops only top-level migration stamps", () => {
    expect(
      withoutSiteMigrationHits([
        { path: "supabase/migrations/001.sql", glob: "supabase/migrations/**" },
        { path: "supabase/migrations/a/001.sql", glob: "supabase/migrations/**" },
        { path: ".env", glob: "**/.env*" },
      ]),
    ).toEqual([
      { path: "supabase/migrations/a/001.sql", glob: "supabase/migrations/**" },
      { path: ".env", glob: "**/.env*" },
    ]);
  });
});

describe("siteProtectedPathHits — actions", () => {
  it("a deleted top-level migration is a hit; created and modified ones are not", () => {
    expect(
      siteProtectedPathHits(
        [
          { path: "supabase/migrations/001_a.sql", action: "create" },
          { path: "supabase/migrations/002_b.sql", action: "modify" },
          { path: "supabase/migrations/003_c.sql", action: "delete" },
        ],
        [...DEFAULT_PROTECTED_GLOBS],
      ),
    ).toEqual([{ path: "supabase/migrations/003_c.sql", glob: "supabase/migrations/**" }]);
  });
  it("a non-SQL file under supabase/migrations is a hit", () => {
    expect(siteProtectedPathHits([{ path: "supabase/migrations/x.sh", action: "create" }], [...DEFAULT_PROTECTED_GLOBS])).toHaveLength(1);
  });
});

describe("verifySiteRepoRun names why the exemption did or did not apply", () => {
  const payload = { stage: "build", site_id: SITE };
  const v = (load: Parameters<typeof verifySiteRepoRun>[1], p: unknown = payload, repo: string = REPO) =>
    verifySiteRepoRun({ tenant_id: T, repo_full_name: repo, payload: p }, load);

  it("ok, and each refusal reason", async () => {
    expect(await v(async () => site())).toEqual({ ok: true });
    expect(await v(async () => site(), {})).toEqual({ ok: false, reason: "no_site_id" });
    expect(await v(async () => site(), payload, "")).toEqual({ ok: false, reason: "no_repo" });
    expect(await v(async () => null)).toEqual({ ok: false, reason: "no_site" });
    expect(await v(async () => ({ ...site(), id: "11111111-1111-4111-8111-111111111111" }))).toEqual({ ok: false, reason: "other_site" });
    expect(await v(async () => ({ ...site(), github_full_name: "Zavi-Latest-Build/other" }))).toEqual({ ok: false, reason: "repo_mismatch" });
    expect(await v(async () => ({ ...site(), status: "failed" }))).toEqual({ ok: false, reason: "not_buildable", status: "failed" });
  });

  it("a transient read error is retried once before failing closed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return site();
    });
    expect(await v(flaky)).toEqual({ ok: true });
    expect(flaky).toHaveBeenCalledTimes(2);
    const down = vi.fn(async (): Promise<SiteRow | null> => {
      throw new Error("db down");
    });
    expect(await v(down)).toEqual({ ok: false, reason: "read_error" });
    expect(down).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
