
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../PipedreamApps.tsx"), "utf8");

describe("catalog fetch failure is distinguishable from an empty catalog", () => {
  it("tracks the failure separately from `loaded`", () => {
    expect(SRC).toMatch(/const \[fetchFailed, setFetchFailed\] = useState\(false\)/);
  });

  it("sets the flag on BOTH failure paths (bad response and thrown fetch)", () => {
    const hits = SRC.match(/setFetchFailed\(true\)/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it("clears the flag when a new query or retry starts, so it cannot stick", () => {
    expect(SRC).toMatch(/setFetchFailed\(false\)/);
  });

  it("renders an explanation instead of returning null", () => {
    expect(SRC).toMatch(/App directory unavailable/);
    expect(SRC).toMatch(/not a sign that these\s*\n?\s*apps are unsupported/);
  });

  it("offers a retry that re-runs the fetch without clearing the user's query", () => {
    expect(SRC).toMatch(/onRetry/);
    expect(SRC).toMatch(/setRetryNonce\(\(v\) => v \+ 1\)/);
    expect(SRC).toMatch(/\}, \[q, retryNonce\]\)/);
  });

  it("still renders nothing when the fetch SUCCEEDED and returned no rows", () => {
    expect(SRC).toMatch(/if \(!loaded \|\| tileCount === 0\) return null;/);
    expect(SRC.indexOf("fetchFailed && tileCount === 0")).toBeLessThan(
      SRC.indexOf("if (!loaded || tileCount === 0) return null;"),
    );
  });

  it("a later page failing does not blank an already-populated grid", () => {
    expect(SRC).toMatch(/if \(resultsRef\.current\.length === 0\) \{\s*\n\s*setLoaded\(false\);\s*\n\s*setFetchFailed\(true\);/);
  });
});
