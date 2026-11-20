import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("runDispatch stale-SDK-session auto-recovery", () => {
  const src = readFileSync(join(__dirname, "../runner.ts"), "utf-8");

  it("catches the resume-not-found error on the chat path", () => {
    expect(src).toMatch(/No conversation found with session/);
  });

  it("clears the stale sdk_session_id on agent_threads before retrying", () => {
    expect(src).toMatch(/agent_threads/);
    expect(src).toMatch(/sdk_session_id:\s*null/);
  });

  it("retries the chat turn (runChat called more than once in runDispatch)", () => {
    const runDispatch = src.slice(src.indexOf("export async function runDispatch"));
    const block = runDispatch.slice(0, runDispatch.indexOf("\n}\n"));
    const calls = block.match(/runChat\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
