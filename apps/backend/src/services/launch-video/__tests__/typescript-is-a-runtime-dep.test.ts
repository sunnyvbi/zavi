import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("typescript is a production dependency of the backend", () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "../../../../package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  it("is declared under dependencies", () => {
    expect(pkg.dependencies?.typescript).toBeTruthy();
  });

  it("is NOT also declared under devDependencies, which would make npm omit it in production", () => {
    expect(pkg.devDependencies?.typescript).toBeUndefined();
  });

  it("is actually imported at module scope by the film gate", () => {
    const src = readFileSync(join(__dirname, "../authored-film.ts"), "utf8");
    expect(src).toMatch(/^import ts from "typescript";$/m);
  });
});
