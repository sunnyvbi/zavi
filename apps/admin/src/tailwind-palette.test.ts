import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import defaultColors from "tailwindcss/colors";
import resolveConfig from "tailwindcss/resolveConfig";
import { describe, expect, it } from "vitest";
import config from "../tailwind.config";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const theme = resolveConfig(config).theme as unknown as {
  colors: Record<string, unknown>;
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("admin tailwind palette", () => {
  it("never shrinks a built-in palette scale via theme.extend.colors", () => {
    const extended = (config.theme?.extend?.colors ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(extended)) {
      const builtin = (defaultColors as Record<string, unknown>)[name];
      if (!builtin || typeof builtin !== "object") continue;
      const resolved = theme.colors[name];
      expect(typeof resolved, `colors.${name} must stay a scale`).toBe("object");
      for (const [shade, hex] of Object.entries(builtin as Record<string, string>)) {
        expect((resolved as Record<string, unknown>)[shade], `colors.${name}-${shade}`).toBe(hex);
      }
    }
  });

  it("every <color>-<shade> class used in src resolves to a theme color", () => {
    const used = new Set<string>();
    const re =
      /\b(?:bg|text|border(?:-[trblxyse]{1,2})?|ring|ring-offset|from|via|to|fill|stroke|outline|divide|decoration|accent|caret|placeholder|shadow)-([a-z]+)-(50|[1-9]00|950)\b/g;
    const NOT_COLORS = new Set(["opacity"]);
    for (const file of sourceFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(re)) {
        if (!NOT_COLORS.has(m[1])) used.add(`${m[1]}-${m[2]}`);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((key) => {
      const [color, shade] = key.split("-");
      const scale = theme.colors[color];
      const value = scale && typeof scale === "object" ? (scale as Record<string, unknown>)[shade] : undefined;
      return typeof value !== "string" || value.length === 0;
    });
    expect(missing).toEqual([]);
  });

  it("generates CSS for the primary button classes and the bare brand accent", async () => {
    const result = await postcss([
      tailwindcss({
        ...config,
        content: [{ raw: '<button class="bg-sky-700 hover:bg-sky-800 text-sky bg-sky/10">' }],
      }),
    ]).process("@tailwind utilities;", { from: undefined });
    expect(result.css).toContain(".bg-sky-700");
    expect(result.css).toContain(".hover\\:bg-sky-800:hover");
    expect(result.css).toMatch(/\.text-sky\s*\{[^}]*rgb\(14 165 233/);
    expect(result.css).toContain(".bg-sky\\/10");
  });
});
