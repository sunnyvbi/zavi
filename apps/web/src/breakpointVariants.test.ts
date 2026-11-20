import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const config = readFileSync(resolve(__dirname, "../tailwind.config.ts"), "utf8");

describe("responsive variants", () => {
  it("this config declares a max-width screen, which disables Tailwind's arbitrary min-[]/max-[] variants", () => {
    expect(config).toMatch(/screens:\s*\{[^}]*max:/);
  });

  it("so no source file may use one: it silently compiles to nothing", () => {
    let hits = "";
    try {
      hits = execSync(
        "grep -rnE '(min|max)-\\[[0-9]+px\\]:' src --include='*.tsx' --include='*.ts' --exclude='*.test.*'",
        { cwd: resolve(__dirname, ".."), encoding: "utf8" },
      );
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      if (err.status !== 1) throw e;
      hits = err.stdout ?? "";
    }
    expect(hits.trim()).toBe("");
  });
});
