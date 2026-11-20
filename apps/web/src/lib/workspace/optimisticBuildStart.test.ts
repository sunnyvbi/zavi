// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOptimisticBuildStart,
  hasOptimisticBuildStart,
  markOptimisticBuildStart,
} from "./optimisticBuildStart";

afterEach(() => {
  clearOptimisticBuildStart();
  vi.restoreAllMocks();
});

describe("optimistic build start", () => {
  it("is visible synchronously and survives the workspace navigation boundary", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    markOptimisticBuildStart();

    expect(hasOptimisticBuildStart()).toBe(true);
    expect(window.sessionStorage.getItem("zavi.buildStartingAt")).toBe("1000");
  });

  it("clears when the backend confirms or rejects the build", () => {
    markOptimisticBuildStart();
    clearOptimisticBuildStart();

    expect(hasOptimisticBuildStart()).toBe(false);
    expect(window.sessionStorage.getItem("zavi.buildStartingAt")).toBeNull();
  });

  it("expires a stranded signal instead of showing a stale loader forever", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(121_001);
    markOptimisticBuildStart();

    expect(hasOptimisticBuildStart()).toBe(false);
  });
});
