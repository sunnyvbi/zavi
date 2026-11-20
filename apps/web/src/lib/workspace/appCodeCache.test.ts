import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  cachedFileBytes,
  clearAppCodeCache,
  readCachedFile,
  writeCachedFile,
} from "./appCodeCache";

const text = (bytes: number, fill = "x") => ({ status: "text" as const, content: fill.repeat(bytes / 2) });

afterEach(() => clearAppCodeCache());

describe("app code file cache byte budget", () => {
  it("keeps total cached text under the budget by evicting the least recently used file", () => {
    const third = Math.floor(MAX_FILE_BYTES / 3 / 2) * 2 + 2;
    writeCachedFile("a", text(third, "a"));
    writeCachedFile("b", text(third, "b"));
    expect(readCachedFile("a")?.status).toBe("text");
    writeCachedFile("c", text(third, "c"));
    expect(cachedFileBytes()).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(readCachedFile("b")).toBeNull();
    expect(readCachedFile("a")).not.toBeNull();
    expect(readCachedFile("c")).not.toBeNull();
    expect(cachedFileBytes()).toBe(third * 2);
  });

  it("never caches a single file bigger than the whole budget, and keeps what was there", () => {
    writeCachedFile("small", text(1000));
    writeCachedFile("huge", text(MAX_FILE_BYTES + 2));
    expect(readCachedFile("huge")).toBeNull();
    expect(readCachedFile("small")).not.toBeNull();
    expect(cachedFileBytes()).toBe(1000);
  });

  it("counts a rewritten sha once, not twice", () => {
    writeCachedFile("a", text(1000));
    writeCachedFile("a", text(3000));
    expect(cachedFileBytes()).toBe(3000);
    clearAppCodeCache();
    expect(cachedFileBytes()).toBe(0);
  });

  it("still caps the number of files", () => {
    for (let i = 0; i < 305; i += 1) writeCachedFile(`s${i}`, { status: "binary" });
    expect(readCachedFile("s0")).toBeNull();
    expect(readCachedFile("s4")).toBeNull();
    expect(readCachedFile("s5")).not.toBeNull();
  });
});
