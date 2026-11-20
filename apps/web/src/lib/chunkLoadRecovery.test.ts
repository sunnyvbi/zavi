import { describe, expect, it } from "vitest";
import {
  isNextChunkLoadFailure,
  shouldReloadForChunkFailure,
} from "./chunkLoadRecovery";

describe("chunkLoadRecovery", () => {
  it("detects the Next chunk 404 shape from production", () => {
    expect(
      isNextChunkLoadFailure(
        "ChunkLoadError: Loading chunk 5221 failed.\n(error: https://www.zaviagent.com/_next/static/chunks/app/workspace/page-619fc3581a3052ea.js)",
      ),
    ).toBe(true);
  });

  it("detects chunk failures carried by Error objects", () => {
    const err = new Error("Loading chunk 5221 failed.");
    err.name = "ChunkLoadError";
    expect(isNextChunkLoadFailure(err)).toBe(true);
  });

  it("detects failed script/link resources under Next static chunks", () => {
    expect(
      isNextChunkLoadFailure({
        src: "https://www.zaviagent.com/_next/static/chunks/app/workspace/page.js",
      }),
    ).toBe(true);
  });

  it("ignores ordinary app errors", () => {
    expect(isNextChunkLoadFailure(new Error("Cannot read properties of null"))).toBe(false);
  });

  it("guards reloads with a minimum interval", () => {
    expect(shouldReloadForChunkFailure(100_000, null, 30_000)).toBe(true);
    expect(shouldReloadForChunkFailure(100_000, "not-a-number", 30_000)).toBe(true);
    expect(shouldReloadForChunkFailure(100_000, "90000", 30_000)).toBe(false);
    expect(shouldReloadForChunkFailure(100_000, "60000", 30_000)).toBe(true);
  });
});
