
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dispatcherSrc = readFileSync(
  join(__dirname, "../generic-dispatcher.ts"),
  "utf-8",
);

describe("generic-dispatcher — assistant-turn heartbeat (SDK path)", () => {
  it("emits a whitelisted progress event for every content-bearing assistant turn", () => {
    expect(dispatcherSrc).toMatch(/blocks\.length > 0/);
    expect(dispatcherSrc).toMatch(
      /await ctx\.emitProgress\("tool_use_completed",\s*\{\s*tool_name:\s*"assistant_turn"/,
    );
  });

  it("uses a whitelisted progress stage (`tool_use_completed`) so the migration 0066 trigger updates last_progress_at", () => {
    const heartbeatBlock = dispatcherSrc.match(
      /if \(blocks\.length > 0\) \{[\s\S]{0,400}?await ctx\.emitProgress\("(\w+)"/,
    );
    expect(heartbeatBlock).not.toBeNull();
    const stage = heartbeatBlock?.[1] ?? "";
    expect(["tool_use_completed", "tool_use_errored", "iter_cap_summarize", "progress"])
      .toContain(stage);
  });

  it("places the heartbeat AFTER the mid-stream budget-abort `continue` so an aborted turn doesn't double-emit", () => {
    const assistantBranch = dispatcherSrc.match(
      /if \(message\.type === "assistant"\) \{[\s\S]+?\} else if \(message\.type === "user"\)/,
    );
    expect(assistantBranch).not.toBeNull();
    const body = assistantBranch?.[0] ?? "";
    const continueIdx = body.indexOf("// Skip this over-budget turn's content");
    const heartbeatIdx = body.indexOf("tool_name: \"assistant_turn\"");
    expect(continueIdx).toBeGreaterThan(-1);
    expect(heartbeatIdx).toBeGreaterThan(continueIdx);
  });
});
