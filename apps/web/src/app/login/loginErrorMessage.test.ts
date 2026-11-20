import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("the sign-in page never shows a machine error to a person", () => {
  it("routes every catch through humanAuthMessage, not a raw .message", () => {
    expect(SOURCE).not.toMatch(/setError\(\((?:e\d) as Error\)\.message\)/);
    expect(SOURCE).toMatch(/setError\(humanAuthMessage\(/);
  });

  it("falls back instead of returning an unrecognised raw string", () => {
    const fn = SOURCE.slice(SOURCE.indexOf("function friendlyAuthError"));
    const body = fn.slice(0, fn.indexOf("\nfunction "));
    expect(body).toContain("return humanAuthMessage(raw);");
    expect(body).not.toMatch(/\n\s*return raw;/);
  });
});
