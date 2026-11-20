import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCKERFILE = readFileSync(
  join(__dirname, "../../../../docker/main/Dockerfile"),
  "utf8",
);
const BUILD_LOGO_SVG = readFileSync(join(__dirname, "../build-logo-svg.ts"), "utf8");

const runtimeStage = DOCKERFILE.slice(DOCKERFILE.lastIndexOf("AS runtime"));

describe("logo_spec font availability (2026-07-17 tofu regression)", () => {
  it("runtime image installs font packages", () => {
    expect(runtimeStage).toMatch(/fonts-dejavu-core/);
    expect(runtimeStage).toMatch(/fonts-noto-core/);
  });

  it("runtime image installs Devanagari coverage (non-Latin glyphs were tofu too)", () => {
    expect(runtimeStage).toMatch(/fonts-lohit-deva/);
  });

  it("installs ONLY font packages that actually exist in bookworm main", () => {
    const VERIFIED_IN_BOOKWORM_MAIN = new Set([
      "fontconfig",
      "fonts-dejavu-core",
      "fonts-liberation2",
      "fonts-noto-core",
      "fonts-lohit-deva",
    ]);
    const installed = [...runtimeStage.matchAll(/(?:^|\s)(fonts?-[a-z0-9.-]+|fontconfig)(?=\s|\\)/gm)]
      .map((m) => m[1]);
    expect(installed.length).toBeGreaterThan(0);
    for (const pkg of installed) {
      expect(
        VERIFIED_IN_BOOKWORM_MAIN.has(pkg),
        `Dockerfile installs "${pkg}", which is not in the verified-to-exist list. Look it up in the real bookworm index before adding it — an invented name like "fonts-noto-devanagari" passes every string assertion and fails the image build.`,
      ).toBe(true);
    }
  });

  it("runtime image installs fontconfig EXPLICITLY", () => {
    expect(runtimeStage).toMatch(/(^|\s)fontconfig(\s|\\)/);
  });

  it("every PRIMARY family in FONT_STACK is installed in the runtime image", () => {
    const stackBlock = BUILD_LOGO_SVG.slice(
      BUILD_LOGO_SVG.indexOf("const FONT_STACK"),
      BUILD_LOGO_SVG.indexOf("};", BUILD_LOGO_SVG.indexOf("const FONT_STACK")),
    );
    const primaries = [...stackBlock.matchAll(/:\s*\n?\s*"'([^']+)'/g)].map((m) => m[1]);
    expect(primaries.length).toBeGreaterThanOrEqual(3);

    const PROVIDED_BY: Record<string, RegExp> = {
      "DejaVu Sans": /fonts-dejavu-core/,
      "DejaVu Sans Mono": /fonts-dejavu-core/,
      "DejaVu Serif": /fonts-dejavu(-core)?/,
      "Liberation Sans": /fonts-liberation2/,
      "Liberation Serif": /fonts-liberation2/,
      "Liberation Mono": /fonts-liberation2/,
      "Noto Sans": /fonts-noto-core/,
      "Noto Serif": /fonts-noto-core/,
      "Noto Sans Mono": /fonts-noto-core/,
    };
    for (const fam of primaries) {
      const pkg = PROVIDED_BY[fam];
      expect(
        pkg,
        `FONT_STACK names "${fam}" first, but this test does not know which package provides it. Either install it in the runtime stage and map it here, or do not name it first — an unresolvable primary family is how the tofu bug happened.`,
      ).toBeDefined();
      expect(runtimeStage, `FONT_STACK primary "${fam}" is not installed in the runtime image`).toMatch(pkg);
    }
  });

  it("FONT_STACK does not lead with a family the image cannot provide", () => {
    const stackBlock = BUILD_LOGO_SVG.slice(
      BUILD_LOGO_SVG.indexOf("const FONT_STACK"),
      BUILD_LOGO_SVG.indexOf("};", BUILD_LOGO_SVG.indexOf("const FONT_STACK")),
    );
    expect(stackBlock).not.toMatch(/:\s*\n?\s*"(Helvetica|Georgia|'Courier New')/);
  });
});
