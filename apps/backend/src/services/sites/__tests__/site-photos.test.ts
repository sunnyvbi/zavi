import { describe, expect, it, vi } from "vitest";
import { PHOTOS_MISSING_REASON, readSitePhotos, recordSitePhotos, sitePhotosView } from "../site-photos";
import { recordBuildPhotos, recordsPhotos } from "../site-photos-record";

const now = () => new Date("2026-10-08T00:00:00Z");

describe("the site's photo outcome", () => {
  it("records through one SQL statement on the tenant's own site (the claim is kept in SQL, never read-then-replaced)", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    expect(await recordSitePhotos({ tenant_id: "t1", site_id: "s1", check: { kind: "ok", count: 3 } }, { rpc, now })).toBe("recorded");
    expect(rpc).toHaveBeenCalledWith({ p_tenant_id: "t1", p_site_id: "s1", p_photos: { status: "added", count: 3, checked_at: "2026-10-08T00:00:00.000Z" } });
  });

  it("writes nothing for an unreadable marker; a site with no root run or an error is failed", async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }));
    expect(await recordSitePhotos({ tenant_id: "t1", site_id: "s1", check: { kind: "unknown" } }, { rpc })).toBe("skipped");
    expect(rpc).not.toHaveBeenCalled();
    expect(await recordSitePhotos({ tenant_id: "t1", site_id: "s1", check: { kind: "none_landed" } }, { rpc })).toBe("failed");
    expect(await recordSitePhotos({ tenant_id: "t1", site_id: "s1", check: { kind: "none_landed" } }, { rpc: async () => ({ data: null, error: { message: "x" } }) })).toBe("failed");
  });

  it("the founder sees only missing photos, with Retry free until the site's free retry is used", () => {
    expect(sitePhotosView({ status: "added", count: 2 })).toBeNull();
    expect(sitePhotosView(null)).toBeNull();
    expect(sitePhotosView({ status: "missing", reason: "none_landed" })).toEqual({ status: "missing", reason: PHOTOS_MISSING_REASON, retry: "free" });
    expect(sitePhotosView({ status: "missing", free_retry_run_id: "cr_9" })?.retry).toBe("paid");
  });

  it("a read error (a database without the column yet) is no field, never an error", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "column does not exist" } }) }) }) }) }) };
    expect(await readSitePhotos(broken, "t1", "r1")).toBeNull();
  });
});

describe("the post-run record", () => {
  const first = { fast_single_pass: true, stage: "build", site_id: "s1", idea: "A bakery" };
  it("runs for a first build pass and a photo retry, never for other edits or a no-photos ask", () => {
    const noPhotos = (idea: string) => /no photos/.test(idea);
    expect(recordsPhotos(first, noPhotos)).toBe(true);
    expect(recordsPhotos({ refine_mode: true, photo_retry: true, site_id: "s1" }, noPhotos)).toBe(true);
    expect(recordsPhotos({ refine_mode: true, site_id: "s1" }, noPhotos)).toBe(false);
    expect(recordsPhotos({ ...first, idea: "A bakery, no photos please" }, noPhotos)).toBe(false);
  });

  it("reads the marker from the sandbox and records what it says", async () => {
    const record = vi.fn(async () => "recorded" as const);
    await recordBuildPhotos(
      { tenant_id: "t1", payload: first, sandbox_id: "sb", repoRoot: "/home/user/repo" },
      { exec: async () => ({ exit_code: 0, stdout: "__none__" }), record, noPhotosAsked: () => false },
    );
    expect(record).toHaveBeenCalledWith({ tenant_id: "t1", site_id: "s1", check: { kind: "never_called" } });
  });
});
