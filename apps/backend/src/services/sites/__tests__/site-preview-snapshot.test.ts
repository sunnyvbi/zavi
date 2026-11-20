import { describe, expect, it, vi } from "vitest";
import {
  createSitePreviewSnapshotStore,
  isSitePreviewSnapshotPath,
  latestChange,
  newSitePreviewSnapshotPath,
  snapshotIsFresh,
  type SitePreviewSnapshotRow,
} from "../site-preview-snapshot";

const T = "11111111-1111-4111-8111-111111111111";
const S = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const JPEG = Buffer.from("jpeg").toString("base64");

function bucket() {
  const uploaded: string[] = [];
  const removed: string[][] = [];
  return {
    uploaded,
    removed,
    store: {
      upload: vi.fn(async (path: string) => {
        uploaded.push(path);
        return { error: null };
      }),
      remove: vi.fn(async (paths: string[]) => {
        removed.push(paths);
        return { error: null };
      }),
      list: vi.fn(async () => ({ data: [], error: null })),
    },
  };
}

const encode = async () => ({ body: Buffer.from("x"), width: 1280, height: 800 });

describe("snapshotIsFresh", () => {
  it("is never fresh while unpublished editor edits exist, however new the snapshot", () => {
    expect(snapshotIsFresh({ taken_at: "2026-10-13T12:00:00Z", changed_at: null, pending_edits: true })).toBe(false);
  });
  it("is stale when the site changed at or after the snapshot", () => {
    expect(snapshotIsFresh({ taken_at: "2026-10-13T12:00:00Z", changed_at: "2026-10-13T12:00:00Z", pending_edits: false })).toBe(false);
    expect(snapshotIsFresh({ taken_at: "2026-10-13T12:00:00Z", changed_at: "2026-10-13T12:00:01Z", pending_edits: false })).toBe(false);
  });
  it("is fresh when taken after the last change, or when the site never changed", () => {
    expect(snapshotIsFresh({ taken_at: "2026-10-13T12:00:01Z", changed_at: "2026-10-13T12:00:00Z", pending_edits: false })).toBe(true);
    expect(snapshotIsFresh({ taken_at: "2026-10-13T12:00:01Z", changed_at: null, pending_edits: false })).toBe(true);
  });
  it("treats an unreadable time as stale", () => {
    expect(snapshotIsFresh({ taken_at: "nope", changed_at: null, pending_edits: false })).toBe(false);
    expect(snapshotIsFresh({ taken_at: "2026-10-13T12:00:01Z", changed_at: "nope", pending_edits: false })).toBe(false);
  });
});

describe("latestChange", () => {
  it("takes the later of the preview mark and the edit stamp, so a lost mark is backed by last_edit_at", () => {
    expect(latestChange({ preview_changed_at: "2026-10-13T10:00:00Z", last_edit_at: "2026-10-13T11:00:00Z" })).toBe("2026-10-13T11:00:00Z");
    expect(latestChange({ preview_changed_at: "2026-10-13T12:00:00Z", last_edit_at: "2026-10-13T11:00:00Z" })).toBe("2026-10-13T12:00:00Z");
    expect(latestChange({ preview_changed_at: null, last_edit_at: null })).toBeNull();
  });
});

describe("snapshot paths", () => {
  it("only names this tenant's site and device", () => {
    const p = newSitePreviewSnapshotPath(T, S, "desktop", "0123456789ab")!;
    expect(p).toBe(`${T}/${S}/site-preview-desktop-0123456789ab.jpg`);
    expect(isSitePreviewSnapshotPath(T, S, p, "desktop")).toBe(true);
    expect(isSitePreviewSnapshotPath(T, S, p, "mobile")).toBe(false);
    expect(isSitePreviewSnapshotPath(OTHER_T, S, p)).toBe(false);
    expect(isSitePreviewSnapshotPath(T, S, `${T}/${S}/site-thumb-0123456789ab.jpg`)).toBe(false);
    expect(newSitePreviewSnapshotPath(T, S, "tablet" as never)).toBeNull();
  });
});

describe("createSitePreviewSnapshotStore.save", () => {
  it("points at the new snapshot and deletes the one it replaced", async () => {
    const b = bucket();
    const prev = newSitePreviewSnapshotPath(T, S, "desktop", "aaaaaaaaaaaa")!;
    const setPointer = vi.fn(async () => ({ outcome: "set" as const, replaced: prev }));
    const store = createSitePreviewSnapshotStore({ bucket: () => b.store, encode, setPointer });
    expect(await store.save({ tenant_id: T, site_id: S, device: "desktop", jpeg_b64: JPEG, taken_at: new Date("2026-10-13T12:00:00Z") })).toBe(true);
    expect(setPointer).toHaveBeenCalledWith(expect.objectContaining({ device: "desktop", width: 1280, height: 800, path: b.uploaded[0] }));
    expect(b.removed).toEqual([[prev]]);
  });

  it("deletes its own upload when a newer snapshot already won", async () => {
    const b = bucket();
    const store = createSitePreviewSnapshotStore({ bucket: () => b.store, encode, setPointer: async () => ({ outcome: "stale", replaced: null }) });
    expect(await store.save({ tenant_id: T, site_id: S, device: "mobile", jpeg_b64: JPEG, taken_at: new Date() })).toBe(false);
    expect(b.removed).toEqual([[b.uploaded[0]]]);
  });

  it("never deletes a replaced path that is not this site's same-device snapshot", async () => {
    const b = bucket();
    const foreign = newSitePreviewSnapshotPath(OTHER_T, S, "desktop", "aaaaaaaaaaaa")!;
    const otherDevice = newSitePreviewSnapshotPath(T, S, "mobile", "aaaaaaaaaaaa")!;
    for (const replaced of [foreign, otherDevice]) {
      const store = createSitePreviewSnapshotStore({ bucket: () => b.store, encode, setPointer: async () => ({ outcome: "set", replaced }) });
      await store.save({ tenant_id: T, site_id: S, device: "desktop", jpeg_b64: JPEG, taken_at: new Date() });
    }
    expect(b.removed).toEqual([]);
  });

  it("keeps the upload when the pointer outcome is unknown, and writes nothing for oversized input", async () => {
    const b = bucket();
    const store = createSitePreviewSnapshotStore({ bucket: () => b.store, encode, setPointer: async () => Promise.reject(new Error("timeout")) });
    expect(await store.save({ tenant_id: T, site_id: S, device: "desktop", jpeg_b64: JPEG, taken_at: new Date() })).toBe(false);
    expect(b.removed).toEqual([]);
    expect(await store.save({ tenant_id: T, site_id: S, device: "desktop", jpeg_b64: "a".repeat(600_001), taken_at: new Date() })).toBe(false);
    expect(b.uploaded).toHaveLength(1);
  });
});

describe("createSitePreviewSnapshotStore.fresh", () => {
  const row = (over: Partial<SitePreviewSnapshotRow>): SitePreviewSnapshotRow => ({
    device: "desktop",
    path: newSitePreviewSnapshotPath(T, S, "desktop", "aaaaaaaaaaaa")!,
    taken_at: "2026-10-13T12:00:00Z",
    width: 1280,
    height: 800,
    ...over,
  });

  it("returns only snapshots newer than the last change, and none while editor edits are pending", async () => {
    const rows = [row({}), row({ device: "mobile", path: newSitePreviewSnapshotPath(T, S, "mobile", "bbbbbbbbbbbb")!, taken_at: "2026-10-13T10:00:00Z" })];
    const base = { readRows: async () => rows, readChangedAt: async () => "2026-10-13T11:00:00Z" };
    const clean = createSitePreviewSnapshotStore({ ...base, hasPendingEdits: async () => false });
    expect((await clean.fresh(T, S)).map((r) => r.device)).toEqual(["desktop"]);
    const edited = createSitePreviewSnapshotStore({ ...base, hasPendingEdits: async () => true });
    expect(await edited.fresh(T, S)).toEqual([]);
  });

  it("drops a row whose path is not this tenant's site, even when fresh", async () => {
    const store = createSitePreviewSnapshotStore({
      readRows: async () => [row({ path: newSitePreviewSnapshotPath(OTHER_T, S, "desktop", "aaaaaaaaaaaa")! })],
      readChangedAt: async () => null,
      hasPendingEdits: async () => false,
    });
    expect(await store.fresh(T, S)).toEqual([]);
  });

  it("fails loud when the change mark cannot be read, rather than showing a maybe-stale image", async () => {
    const store = createSitePreviewSnapshotStore({
      readRows: async () => [row({})],
      readChangedAt: async () => Promise.reject(new Error("db down")),
      hasPendingEdits: async () => false,
    });
    await expect(store.fresh(T, S)).rejects.toThrow(/db down/);
  });
});

describe("createSitePreviewSnapshotStore.markChanged", () => {
  it("stamps the server clock and refuses malformed ids", async () => {
    const markChanged = vi.fn(async () => true);
    const store = createSitePreviewSnapshotStore({ markChanged, now: () => Date.parse("2026-10-13T12:00:00Z") });
    expect(await store.markChanged(T, S)).toBe(true);
    expect(markChanged).toHaveBeenCalledWith(T, S, new Date("2026-10-13T12:00:00Z"));
    expect(await store.markChanged("x", S)).toBe(false);
    expect(markChanged).toHaveBeenCalledTimes(1);
  });
});
