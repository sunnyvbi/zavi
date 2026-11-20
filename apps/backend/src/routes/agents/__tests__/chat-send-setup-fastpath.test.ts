import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const code = readFileSync(join(__dirname, "..", "chat-send.ts"), "utf8")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
  .join("\n");
const at = code.indexOf("trySetupFaq(");

describe("chat-send setup fast path", () => {
  it("runs before the billable chat turn is created", () => {
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(code.indexOf("send_agent_chat_turn"));
    expect(at).toBeLessThan(code.indexOf("enqueue_or_steer_chat_turn"));
  });
  it("FAILS CLOSED: an error answers 503 and returns; it is never swallowed into the billable path", () => {
    const block = code.slice(code.lastIndexOf("try {", at), at + 900);
    expect(block).toMatch(/catch \(e\)/);
    expect(block).toMatch(/res\.status\(503\)/);
    expect(block).toMatch(/return;/);
    expect(code).not.toMatch(/trySetupFaq\([\s\S]{0,200}\)\s*\.catch\(/);
  });
  it("a conflict-chip tap is resolved first, inside the same fail-closed try", () => {
    const c = code.indexOf("tryResolveConflict(");
    expect(c).toBeGreaterThan(-1);
    expect(c).toBeLessThan(at);
    const tryAt = code.lastIndexOf("try {", at);
    expect(tryAt).toBeLessThan(c);
    expect(code.slice(c, at)).not.toMatch(/catch \(/);
  });
});
