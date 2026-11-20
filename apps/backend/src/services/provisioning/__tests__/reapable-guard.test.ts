import { describe, it, expect } from "vitest";

import {
  isResourceReapable,
  isThrowawayTenantSlug,
  protectedRepoFullNames,
  THROWAWAY_TENANT_PREFIXES,
} from "../reapable-guard";

describe("isThrowawayTenantSlug", () => {
  it("matches every throwaway prefix (case-insensitive)", () => {
    for (const p of THROWAWAY_TENANT_PREFIXES) {
      expect(isThrowawayTenantSlug(`${p}something`)).toBe(true);
      expect(isThrowawayTenantSlug(`${p.toUpperCase()}SOMETHING`)).toBe(true);
    }
  });

  it("does NOT match a real customer slug", () => {
    expect(isThrowawayTenantSlug("upcar-ai")).toBe(false);
    expect(isThrowawayTenantSlug("upcar-private")).toBe(false);
    expect(isThrowawayTenantSlug("apna-tutor-dogfood")).toBe(false);
    expect(isThrowawayTenantSlug(null)).toBe(false);
    expect(isThrowawayTenantSlug(undefined)).toBe(false);
    expect(isThrowawayTenantSlug("")).toBe(false);
  });
});

describe("isResourceReapable — the protected-set guard", () => {
  it("does NOT reap a provisioned customer repo on a live, non-throwaway tenant", () => {
    const v = isResourceReapable({
      tenantId: "73db45ff-457e-4541-bc8f-bdb625390204",
      tenantAlive: true,
      tenantSlug: "upcar-ai",
      status: "ready",
    });
    expect(v.reapable).toBe(false);
    expect(v.reason).toBe("protected_live_customer");
  });

  it("reaps a repo on a live THROWAWAY (bv3 benchmark) tenant", () => {
    const v = isResourceReapable({
      tenantId: "human-1",
      tenantAlive: true,
      tenantSlug: "bv3-grade-shop",
      status: "ready",
    });
    expect(v.reapable).toBe(true);
    expect(v.reason).toBe("throwaway_tenant");
  });

  it("reaps an ORPHANED repo with no tenant_id", () => {
    const v = isResourceReapable({
      tenantId: null,
      tenantAlive: false,
      tenantSlug: null,
      status: "ready",
    });
    expect(v.reapable).toBe(true);
    expect(v.reason).toBe("orphaned_no_tenant");
  });

  it("reaps a repo whose tenant was hard-deleted", () => {
    const v = isResourceReapable({
      tenantId: "gone-tenant",
      tenantAlive: false,
      tenantSlug: null,
      status: "ready",
    });
    expect(v.reapable).toBe(true);
    expect(v.reason).toBe("tenant_deleted");
  });

  it("reaps a row explicitly marked for teardown even on a live real tenant", () => {
    const v = isResourceReapable({
      tenantId: "real",
      tenantAlive: true,
      tenantSlug: "upcar-ai",
      status: "teardown",
    });
    expect(v.reapable).toBe(true);
    expect(v.reason).toBe("explicit_deprovisioning");
  });

  it("is deny-by-default: a live real tenant with an unknown status is protected", () => {
    const v = isResourceReapable({
      tenantId: "real",
      tenantAlive: true,
      tenantSlug: "some-real-company",
      status: "weird-unrecognized-status",
    });
    expect(v.reapable).toBe(false);
    expect(v.reason).toBe("protected_live_customer");
  });

  it("a real tenant's repo is protected regardless of name shape", () => {
    const v = isResourceReapable({
      tenantId: "real",
      tenantAlive: true,
      tenantSlug: "upcar-ai",
      status: "ready",
    });
    expect(v.reapable).toBe(false);
    expect(v.reason).toBe("protected_live_customer");
  });
});

describe("protectedRepoFullNames — the set a cleanup path must skip", () => {
  it("protects the live customer repo and not the throwaway/orphan ones", () => {
    const live = new Map<string, string | null>([
      ["73db45ff", "upcar-ai"],
      ["human-1", "bv3-grade-shop"],
    ]);
    const rows = [
      {
        tenant_id: "73db45ff",
        status: "ready",
        external_ref: { github_full_name: "Praxis-build/upcarai-6ec4d609" },
      },
      {
        tenant_id: "human-1",
        status: "ready",
        external_ref: { github_full_name: "Praxis-build/bv3-shop-aaaa1111" },
      },
      {
        tenant_id: "gone",
        status: "ready",
        external_ref: { github_full_name: "Praxis-build/gtb-orphan-bbbb2222" },
      },
    ];
    const result = protectedRepoFullNames(rows, live);
    expect(result.has("Praxis-build/upcarai-6ec4d609")).toBe(true);
    expect(result.has("Praxis-build/bv3-shop-aaaa1111")).toBe(false);
    expect(result.has("Praxis-build/gtb-orphan-bbbb2222")).toBe(false);
    expect(result.size).toBe(1);
  });
});
