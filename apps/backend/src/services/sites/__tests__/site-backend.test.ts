import { describe, it, expect, vi } from "vitest";
import {
  SiteBackendUnresolved,
  payloadSiteBackend,
  payloadSiteId,
  requireSiteBackend,
  resolvePayloadSiteBackend,
  resolveSiteBackend,
  resolveSiteBackendForRepo,
  siteBackendKindOf,
} from "../site-backend";
import type { SiteRow } from "../contract";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "11111111-1111-4111-8111-111111111111";
const SITE = "aaaaaaaa-0000-4000-8000-000000000001";

function row(patch: Partial<SiteRow>): SiteRow {
  return { id: SITE, tenant_id: T, backend_mode: "pooled", kernel_shard_id: null, ...patch } as SiteRow;
}
function depsFor(r: SiteRow | null | Error) {
  const get = vi.fn(async () => {
    if (r instanceof Error) throw r;
    return r;
  });
  return { get, deps: { store: () => ({ get, getByRepo: get }) } };
}

describe("resolveSiteBackendForRepo (a run that reached a site repo without naming the site)", () => {
  it("stamps the owning site and its backend; a plain repo is null", async () => {
    await expect(resolveSiteBackendForRepo(T, "praxis-build/alpha", depsFor(row({ backend_mode: "static" })).deps)).resolves.toEqual({
      site_id: SITE,
      site_backend: "pooled",
    });
    await expect(resolveSiteBackendForRepo(T, "acme/app", depsFor(null).deps)).resolves.toBeNull();
    await expect(resolveSiteBackendForRepo(T, "acme/app", depsFor(row({ tenant_id: OTHER })).deps)).resolves.toBeNull();
  });

  it("a failed read or an unknown mode is SiteBackendUnresolved, never 'not a site'", async () => {
    await expect(resolveSiteBackendForRepo(T, "x/y", depsFor(new Error("db down")).deps)).rejects.toBeInstanceOf(SiteBackendUnresolved);
    await expect(resolveSiteBackendForRepo(T, "x/y", depsFor(row({ backend_mode: undefined })).deps)).rejects.toBeInstanceOf(SiteBackendUnresolved);
  });
});

describe("siteBackendKindOf", () => {
  it("maps the sites row to the build backend", () => {
    expect(siteBackendKindOf(row({ backend_mode: "static" }))).toBe("pooled");
    expect(siteBackendKindOf(row({ backend_mode: "pooled" }))).toBe("pooled");
    expect(siteBackendKindOf(row({ backend_mode: "dedicated" }))).toBe("dedicated");
    expect(siteBackendKindOf(row({ backend_mode: "dedicated", kernel_shard_id: "k1" }))).toBe("pooled");
  });

  it("never guesses: no row or an unknown mode is null", () => {
    expect(siteBackendKindOf(null)).toBeNull();
    expect(siteBackendKindOf(row({ backend_mode: undefined }))).toBeNull();
    expect(siteBackendKindOf(row({ backend_mode: "weird" as never }))).toBeNull();
  });
});

describe("payload helpers", () => {
  it("reads the site id and the stamped backend", () => {
    expect(payloadSiteId({ site_id: ` ${SITE} ` })).toBe(SITE);
    expect(payloadSiteId({ site_id: "" })).toBeNull();
    expect(payloadSiteId({ site_id: 7 })).toBeNull();
    expect(payloadSiteId(null)).toBeNull();
    expect(payloadSiteBackend({ site_backend: "pooled" })).toBe("pooled");
    expect(payloadSiteBackend({ site_backend: "static" })).toBeNull();
  });

  it("requireSiteBackend: null for a non-site payload, the kind for a resolved one, a typed error otherwise", () => {
    expect(requireSiteBackend({ stage: "build" })).toBeNull();
    expect(requireSiteBackend({ site_id: SITE, site_backend: "dedicated" })).toBe("dedicated");
    expect(() => requireSiteBackend({ site_id: SITE, refine_mode: true })).toThrow(SiteBackendUnresolved);
  });
});

describe("resolveSiteBackend", () => {
  it("reads the row tenant-scoped", async () => {
    const { get, deps } = depsFor(row({ backend_mode: "static" }));
    await expect(resolveSiteBackend(T, SITE, deps)).resolves.toBe("pooled");
    expect(get).toHaveBeenCalledWith(T, SITE);
  });

  it("a dedicated site stays dedicated", async () => {
    await expect(resolveSiteBackend(T, SITE, depsFor(row({ backend_mode: "dedicated" })).deps)).resolves.toBe("dedicated");
  });

  it("no row, another tenant's row, an unknown mode or a read error is a retryable SiteBackendUnresolved", async () => {
    for (const r of [null, row({ tenant_id: OTHER }), row({ backend_mode: undefined }), new Error("db down")]) {
      const p = resolveSiteBackend(T, SITE, depsFor(r).deps);
      await expect(p).rejects.toBeInstanceOf(SiteBackendUnresolved);
      await expect(resolveSiteBackend(T, SITE, depsFor(r).deps)).rejects.toMatchObject({ retryable: true, code: "site_backend_unresolved", site_id: SITE });
    }
  });

  it("resolvePayloadSiteBackend: null without a site, the row's backend with one (ignoring a stale stamp)", async () => {
    const { get, deps } = depsFor(row({ backend_mode: "pooled", shard_id: "sh1" }));
    await expect(resolvePayloadSiteBackend(T, { stage: "build" }, deps)).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
    await expect(resolvePayloadSiteBackend(T, { site_id: SITE, site_backend: "dedicated" }, deps)).resolves.toBe("pooled");
  });
});
