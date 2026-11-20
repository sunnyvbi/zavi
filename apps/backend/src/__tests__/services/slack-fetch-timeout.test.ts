import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(
  resolve(__dirname, "../../services/tools/slack/_client.ts"),
  "utf8",
);

describe("GAP 36 — Slack fetches have a timeout", () => {
  it("every fetch( call passes an AbortSignal.timeout", () => {
    const fetchCalls = src.match(/await fetch\(|resp = await fetch\(/g) ?? [];
    expect(fetchCalls.length).toBeGreaterThanOrEqual(3);
    const signals = src.match(/AbortSignal\.timeout\(/g) ?? [];
    expect(signals.length).toBeGreaterThanOrEqual(fetchCalls.length);
  });
  it("defines bounded API + download timeouts", () => {
    expect(src).toMatch(/SLACK_API_TIMEOUT_MS\s*=\s*\d+/);
    expect(src).toMatch(/SLACK_DOWNLOAD_TIMEOUT_MS\s*=\s*\d+/);
  });
  it("surfaces an API timeout as a clean slack_timeout tool error, not a raw throw", () => {
    expect(src).toMatch(/TimeoutError/);
    expect(src).toContain('"slack_timeout"');
  });
});
