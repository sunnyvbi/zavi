
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../generic-dispatcher.ts"),
  "utf-8",
);

describe("generic-dispatcher — tool_use/tool_result pairing contract", () => {
  it("pushes resultBlocks as a user-role message after the for-loop ends", () => {
    expect(src).toMatch(
      /messages\.push\(\{\s*role:\s*"user",\s*content:\s*resultBlocks\s*\}\)/,
    );
  });

  it("the user-role push lands BEFORE the soft-nudge check", () => {
    const pushIdx = src.search(
      /messages\.push\(\{\s*role:\s*"user",\s*content:\s*resultBlocks\s*\}\)/,
    );
    const nudgeIdx = src.indexOf("dispatcher soft nudge");
    expect(pushIdx).toBeGreaterThan(0);
    expect(nudgeIdx).toBeGreaterThan(0);
    expect(
      pushIdx,
      "user-role tool_result push must appear in source BEFORE the soft-nudge text — otherwise the nudge silently no-ops",
    ).toBeLessThan(nudgeIdx);
  });

  it("the for-loop accumulates resultBlocks for every tool_use block", () => {
    expect(src).toMatch(/for \(const block of toolUseBs\)/);
    expect(src).toMatch(/resultBlocks\.push\(resultBlock\)/);
  });

  it("the iter loop continues only while stop_reason is tool_use", () => {
    expect(src).toMatch(/if \(resp\.stop_reason !== "tool_use"\) \{/);
    expect(src).toMatch(/maxTokensContinuations < MAX_TOKEN_CONTINUATIONS/);
    expect(src).toMatch(/^\s*break;\s*$/m);
  });
});
