import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../engineer-preview.ts"), "utf-8");

const proxy = src.slice(src.indexOf("export async function engineerPreviewProxy"));

describe("engineerPreviewProxy — no paintable error bodies", () => {
  it("never sends a string body on ANY error path", () => {
    const sends = proxy.match(/res\.status\([^)]*\)\.send\(/g) ?? [];
    expect(sends).toHaveLength(1);
    expect(proxy).toMatch(/res\.status\(status\)\.send\(rewritten\)/);
  });

  it("never reintroduces the literal strings the customer saw", () => {
    expect(proxy).not.toMatch(/send\(\s*["'`]preview not live/i);
    expect(proxy).not.toMatch(/send\(\s*["'`]preview token invalid/i);
    expect(proxy).not.toMatch(/send\(\s*["'`]preview origin invalid/i);
    expect(proxy).not.toMatch(/send\(\s*["'`]bad path/i);
  });

  it("never echoes a raw upstream error message into the response", () => {
    expect(proxy).not.toMatch(/send\(`preview upstream unreachable/);
  });

  it("uses 410 for an expired preview and keeps auth failures on 401/403", () => {
    expect(proxy).toMatch(/sendState\(410,\s*["']expired["']\)/);
    expect(proxy).toMatch(/sendState\(401,\s*["']token_invalid["']\)/);
    expect(proxy).toMatch(/sendState\(403,\s*["']forbidden["']\)/);
  });
});
