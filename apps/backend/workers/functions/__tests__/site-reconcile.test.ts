import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/sites/store", () => ({ siteStore: vi.fn() }));

import {
  enqueueSitePointerRepairs,
  handleSiteReconcile,
  requestSiteVerify,
  SITE_RECONCILE_EVENT,
  SITE_VERIFY_DELAY_MS,
  SITE_RECONCILE_SETTLE_MS,
  sitePointerSweepAllowed,
  type SiteReconcileDeps,
} from "../site-reconcile";
import type { SiteRow } from "@/services/sites/contract";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = Date.parse("2026-10-01T10:30:00Z");

describe("enqueueSitePointerRepairs (inside the hourly site cron)", () => {
  it("sends one deduped-per-hour site/reconcile event per drifted site, settled rows only", async () => {
    const driftBatch = vi.fn(async () => [{ tenant_id: TENANT, site_id: SITE }]);
    const send = vi.fn(async () => undefined);
    const r = await enqueueSitePointerRepairs({ ledger: { driftBatch }, send, now: () => NOW, configured: () => true });
    expect(r).toEqual({ enqueued: 1 });
    expect(driftBatch).toHaveBeenCalledWith(new Date(NOW - SITE_RECONCILE_SETTLE_MS).toISOString(), 200);
    expect(send).toHaveBeenCalledWith([
      { id: `site-reconcile:${SITE}:${Math.floor(NOW / 3_600_000)}`, name: SITE_RECONCILE_EVENT, data: { tenant_id: TENANT, site_id: SITE } },
    ]);
  });

  it("sends nothing when nothing drifted, and is inert without static hosting", async () => {
    const send = vi.fn(async () => undefined);
    expect(await enqueueSitePointerRepairs({ ledger: { driftBatch: async () => [] }, send, now: () => NOW, configured: () => true })).toEqual({ enqueued: 0 });
    const driftBatch = vi.fn(async () => []);
    expect(await enqueueSitePointerRepairs({ ledger: { driftBatch }, send, now: () => NOW, configured: () => false })).toEqual({
      enqueued: 0,
      skipped: "no_static_hosting",
    });
    expect(driftBatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sitePointerSweepAllowed", () => {
  it("only a deployed backend with static hosting may sweep (a local stack sharing the DB never certifies its own KV)", async () => {
    const { FULL_ENV } = await import("@/services/hosting/__tests__/static-fakes");
    expect(sitePointerSweepAllowed({ ...FULL_ENV, NODE_ENV: "production" })).toBe(true);
    expect(sitePointerSweepAllowed({ ...FULL_ENV, NODE_ENV: "development" })).toBe(false);
    expect(sitePointerSweepAllowed({ ...FULL_ENV })).toBe(false);
    expect(sitePointerSweepAllowed({ NODE_ENV: "production" })).toBe(false);
  });
});

describe("handleSiteReconcile", () => {
  const row = (github_full_name: string | null) => ({ id: SITE, tenant_id: TENANT, github_full_name }) as unknown as SiteRow;
  const deps = (site: SiteRow | null): SiteReconcileDeps => ({
    store: { get: vi.fn(async () => site) },
    reconcile: vi.fn(async () => ({ outcome: "repaired" as const, site })),
    org: () => "Praxis-build",
  });

  it("reconciles a site of this environment as a sweep (mismatch = drift)", async () => {
    const d = deps(row("praxis-build/shop"));
    expect(await handleSiteReconcile({ tenant_id: TENANT, site_id: SITE }, d)).toEqual({ outcome: "repaired" });
    expect(d.reconcile).toHaveBeenCalledWith({ tenant_id: TENANT, site_id: SITE, source: "sweep" });
  });

  it("never touches another environment's site (shared database), a missing site, or a bad payload", async () => {
    const other = deps(row("zavi-dev-org/shop"));
    expect(await handleSiteReconcile({ tenant_id: TENANT, site_id: SITE }, other)).toEqual({ skipped: "other_env" });
    expect(other.reconcile).not.toHaveBeenCalled();
    const gone = deps(null);
    expect(await handleSiteReconcile({ tenant_id: TENANT, site_id: SITE }, gone)).toEqual({ skipped: "gone" });
    const bad = deps(row(null));
    expect(await handleSiteReconcile({ site_id: SITE }, bad)).toEqual({ skipped: "bad_request" });
    expect(bad.reconcile).not.toHaveBeenCalled();
  });
});

describe("requestSiteVerify (a pooled writer asks the serialized reconciler to confirm)", () => {
  it("one delayed site/reconcile per (site, version), source verify; the handler reconciles with source verify", async () => {
    const send = vi.fn(async () => undefined);
    await requestSiteVerify({ tenant_id: TENANT, site_id: SITE, version: 7 }, send, () => NOW);
    expect(send).toHaveBeenCalledWith([
      { id: `site-verify:${SITE}:7`, name: SITE_RECONCILE_EVENT, data: { tenant_id: TENANT, site_id: SITE, source: "verify" }, ts: NOW + SITE_VERIFY_DELAY_MS },
    ]);
    const reconcile = vi.fn(async () => ({ outcome: "in_sync" as const, site: null }));
    const deps: SiteReconcileDeps = {
      store: { get: async () => ({ id: SITE, tenant_id: TENANT, github_full_name: null } as unknown as SiteRow) },
      reconcile,
      org: () => "zavi",
    };
    await handleSiteReconcile({ tenant_id: TENANT, site_id: SITE, source: "verify" }, deps);
    expect(reconcile).toHaveBeenLastCalledWith({ tenant_id: TENANT, site_id: SITE, source: "verify" });
    await handleSiteReconcile({ tenant_id: TENANT, site_id: SITE, source: "anything-else" }, deps);
    expect(reconcile).toHaveBeenLastCalledWith({ tenant_id: TENANT, site_id: SITE, source: "sweep" });
  });
});
