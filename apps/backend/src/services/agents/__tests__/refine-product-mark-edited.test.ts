import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ update: vi.fn(), markChanged: vi.fn() }));
vi.mock("@/services/sites/store", () => ({ siteStore: () => ({ update: h.update }) }));
vi.mock("@/services/sites/site-preview-snapshot", () => ({ sitePreviewSnapshotStore: () => ({ markChanged: h.markChanged }) }));

import { realRefineProductDeps } from "../refine-product";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("marking a site edited after a chat change", () => {
  it("a failed preview change mark names itself and does not read as a failed last_edit_at stamp", async () => {
    h.update.mockResolvedValue(undefined);
    h.markChanged.mockRejectedValue(new Error("site_mark_preview_changed failed: Could not find the function"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(realRefineProductDeps.markSiteEdited!("t1", "s1")).resolves.toBeUndefined();
    expect(h.update).toHaveBeenCalledWith("t1", "s1", { last_edit_at: expect.any(String) });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[refine-product] preview change mark failed for site=s1"));
  });

  it("a snapshot store that throws before it returns a promise is caught the same way", async () => {
    h.update.mockResolvedValue(undefined);
    h.markChanged.mockImplementation(() => {
      throw new Error("no service client");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(realRefineProductDeps.markSiteEdited!("t1", "s1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("preview change mark failed for site=s1: no service client"));
  });

  it("a failed last_edit_at write still surfaces to the caller", async () => {
    h.update.mockRejectedValue(new Error("db down"));
    await expect(realRefineProductDeps.markSiteEdited!("t1", "s1")).rejects.toThrow("db down");
    expect(h.markChanged).not.toHaveBeenCalled();
  });
});
