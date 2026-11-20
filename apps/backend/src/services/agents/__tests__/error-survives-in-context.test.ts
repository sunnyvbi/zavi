import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../generic-dispatcher.ts"),
  "utf-8",
);

describe("generic-dispatcher — errors survive in the live model context", () => {
  it("legacy is_error branch keeps the FULL error content in the tool_result", () => {
    expect(src).toMatch(
      /is_error:\s*true,\s*\n\s*content:\s*result\.content,/,
    );
  });

  it("the legacy error path documents the don't-scrub invariant", () => {
    expect(src).toMatch(/keep errors in the live model context, do NOT scrub/);
    expect(src).toMatch(/keep the wrong stuff in context/);
  });

  it("the SDK error path documents the same invariant", () => {
    expect(src).toMatch(/retained in the model's working\b[\s\S]{0,40}context by the SDK itself/);
  });

  it("error tool_result flows through resultBlocks into the next user turn", () => {
    expect(src).toMatch(/resultBlocks\.push\(resultBlock\)/);
    expect(src).toMatch(
      /messages\.push\(\{\s*role:\s*"user",\s*content:\s*resultBlocks\s*\}\)/,
    );
  });

  it("does NOT widen the C14 meta whitelist (errors go to messages, not meta)", () => {
    expect(src).toMatch(
      /emitProgress\("tool_use_errored",\s*\{\s*tool_name:[^}]*ms:[^}]*code,[^}]*iter\s*\}\)/,
    );
  });
});
