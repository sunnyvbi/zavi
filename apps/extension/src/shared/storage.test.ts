import { describe, expect, it, vi } from "vitest";
import { createChromeStorageAdapter, type StorageArea } from "./storage";

function fakeArea(initial: Record<string, unknown> = {}): StorageArea & {
  dump: () => Record<string, unknown>;
} {
  const bag: Record<string, unknown> = { ...initial };
  return {
    dump: () => ({ ...bag }),
    async get(keys) {
      if (keys === null) return { ...bag };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in bag) out[k] = bag[k];
      return out;
    },
    async set(items) {
      Object.assign(bag, items);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete bag[k];
    },
  };
}

describe("createChromeStorageAdapter", () => {
  it("round-trips a value", async () => {
    const area = fakeArea();
    const s = createChromeStorageAdapter(area);
    await s.setItem("zavi-ext-auth", '{"access_token":"tok"}');
    expect(await s.getItem("zavi-ext-auth")).toBe('{"access_token":"tok"}');
    expect(area.dump()["zavi-ext-auth"]).toBe('{"access_token":"tok"}');
  });

  it("returns null for a missing key", async () => {
    const s = createChromeStorageAdapter(fakeArea());
    expect(await s.getItem("nope")).toBeNull();
  });

  it("removes a value", async () => {
    const area = fakeArea({ k: "v" });
    const s = createChromeStorageAdapter(area);
    await s.removeItem("k");
    expect(await s.getItem("k")).toBeNull();
    expect("k" in area.dump()).toBe(false);
  });

  it("returns null (not the raw value) when the stored value is not a string", async () => {
    const s = createChromeStorageAdapter(fakeArea({ k: { not: "a string" } }));
    expect(await s.getItem("k")).toBeNull();
  });

  it("degrades a READ failure to 'no session' instead of throwing", async () => {
    const area = fakeArea();
    area.get = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const s = createChromeStorageAdapter(area);
    await expect(s.getItem("k")).resolves.toBeNull();
  });

  it("propagates a WRITE failure — a session we cannot persist must not look saved", async () => {
    const area = fakeArea();
    area.set = vi.fn().mockRejectedValue(new Error("quota exceeded"));
    const s = createChromeStorageAdapter(area);
    await expect(s.setItem("k", "v")).rejects.toThrow("quota exceeded");
  });

  it("only reads the key it was asked for", async () => {
    const area = fakeArea({ a: "1", b: "2" });
    const spy = vi.spyOn(area, "get");
    const s = createChromeStorageAdapter(area);
    await s.getItem("a");
    expect(spy).toHaveBeenCalledWith("a");
  });
});
