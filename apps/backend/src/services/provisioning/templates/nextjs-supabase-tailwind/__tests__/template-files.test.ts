import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectTemplateFiles, collectVariantFiles, renderModule } from "../generate-template-files";
import { TEMPLATE_FILES, TEMPLATE_FILE_PATHS } from "../template-files.generated";

const HERE = __dirname;
const GENERATED = join(HERE, "..", "template-files.generated.ts");

describe("template-files.generated (drift guard)", () => {
  it("the committed generated module matches the on-disk ./files (re-run the generator if this fails)", () => {
    const expected = renderModule(collectTemplateFiles(), collectVariantFiles());
    const actual = readFileSync(GENERATED, "utf-8");
    expect(actual).toBe(expected);
  });

  it("embeds the full working-app file set (real app, not a stub)", () => {
    expect(TEMPLATE_FILE_PATHS).toContain("package.json");
    expect(TEMPLATE_FILE_PATHS).toContain("app/page.tsx");
    expect(TEMPLATE_FILE_PATHS).toContain("app/layout.tsx");
    expect(TEMPLATE_FILE_PATHS).toContain("app/globals.css");
    expect(TEMPLATE_FILE_PATHS).toContain("lib/supabase.ts");
    expect(TEMPLATE_FILE_PATHS).toContain("tailwind.config.ts");
    expect(TEMPLATE_FILE_PATHS).toContain("postcss.config.mjs");
    expect(TEMPLATE_FILE_PATHS).toContain("next.config.mjs");
    expect(TEMPLATE_FILE_PATHS).toContain("tsconfig.json");
  });

  it("package.json has render-compatible build + start scripts", () => {
    const pkg = JSON.parse(TEMPLATE_FILES["package.json"]);
    expect(pkg.scripts.build).toContain("next build");
    expect(pkg.scripts.start).toContain("next start");
    expect(pkg.dependencies.next).toBeDefined();
    expect(pkg.dependencies["@supabase/supabase-js"]).toBeDefined();
  });

  it("serves local images directly so a cold Render service cannot break the first paint", () => {
    const nextConfig = TEMPLATE_FILES["next.config.mjs"];
    expect(nextConfig).toContain("images:");
    expect(nextConfig).toContain("unoptimized: true");
  });

  it("ships a package-lock.json that satisfies package.json — `npm ci` needs both", () => {
    const pkg = JSON.parse(TEMPLATE_FILES["package.json"]);
    const lock = JSON.parse(TEMPLATE_FILES["package-lock.json"]);
    const root = lock.packages[""];
    const rootSpecs = { ...root.dependencies, ...root.devDependencies };
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(rootSpecs[name], `${name} missing from lock root`).toBe(spec);
      expect(lock.packages[`node_modules/${name}`], `${name} unresolved in lock`).toBeDefined();
    }
  });

  it("ships NO secrets — .env.example has empty values only", () => {
    const env = TEMPLATE_FILES[".env.example"];
    for (const line of env.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      expect(trimmed).toMatch(/^[A-Z0-9_]+=$/);
    }
  });

  it("freezes the maps (immutable at runtime)", () => {
    expect(Object.isFrozen(TEMPLATE_FILES)).toBe(true);
    expect(Object.isFrozen(TEMPLATE_FILE_PATHS)).toBe(true);
  });
});
