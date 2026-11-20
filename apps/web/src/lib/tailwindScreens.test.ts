import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config";

const SRC = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("tailwind screens", () => {
  const screens = (config.theme?.extend?.screens ?? {}) as Record<string, unknown>;
  const hasObjectScreen = Object.values(screens).some((v) => typeof v === "object");

  it("defines every max-* variant the app uses, because an object screen turns Tailwind's built-in max-* variants off", () => {
    expect(hasObjectScreen).toBe(true);
    const used = new Map<string, string>();
    for (const file of sourceFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(/(?<![\w-])(max-(?:sm|md|lg|xl|2xl)):[\w[\]\-/.]+/g)) {
        if (!used.has(m[1])) used.set(m[1], file.slice(SRC.length + 1));
      }
    }
    expect(used.has("max-lg")).toBe(true);
    const missing = [...used].filter(([variant]) => !(variant in screens));
    expect(missing).toEqual([]);
  });

  it("max-lg stops exactly where lg starts, so max-lg:hidden and lg:flex never both apply", () => {
    expect(screens["max-lg"]).toEqual({ max: "1023px" });
  });
});
