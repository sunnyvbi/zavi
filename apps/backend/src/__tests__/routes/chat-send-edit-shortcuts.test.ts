import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../routes/agents/chat-send.ts"), "utf8");

function gateAfter(marker: string): string {
  const start = SRC.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const open = SRC.indexOf("if (", start);
  return SRC.slice(open, SRC.indexOf(") {", open));
}

describe("chat-send — an edited message never takes a shortcut that skips the edit", () => {
  it.each([
    ["qa confirm", "qa deterministic confirm fast path"],
    ["approve/reject", "// Gate: skip the approval fast-path"],
    ["PR follow-up", "// Engineer PR follow-up routing (DEL-318, S4)."],
    ["acknowledgment", "// Pure-acknowledgment no-op gate"],
    ["fan-out proposal", "// Multi-task fan-out PROPOSE path"],
    ["barge-in", "// MID-RUN BARGE-IN (Slice 6)"],
  ])("%s gate excludes edits", (_name, marker) => {
    expect(gateAfter(marker)).toContain("!body.edit_of_message_id");
  });

  it("a greeting or setup-FAQ reply to an edit still replaces the original", () => {
    const start = SRC.indexOf("const reply =\n        (slug === CGO");
    const block = SRC.slice(start, SRC.indexOf("res.status(200).json(reply);", start));
    expect(block).toMatch(/body\.edit_of_message_id \? null : await tryResolveConflict/);
    expect(block).toMatch(/supersedeEditedMessage\(serviceClient\(\), \{/);
    expect(block).toMatch(/new_message_id: reply\.user_message_id/);
  });
});
