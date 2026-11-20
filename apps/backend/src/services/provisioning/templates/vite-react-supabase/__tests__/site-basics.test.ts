import { describe, it, expect } from "vitest";
import { TEMPLATE_FILES as VITE, TEMPLATE_FILE_PATHS as VITE_PATHS } from "../template-files.generated";
import { TEMPLATE_FILES as NEXT, TEMPLATE_FILE_PATHS as NEXT_PATHS } from "../../nextjs-supabase-tailwind/template-files.generated";
import { readSiteMeta, seedMetaProblems, STARTER_SITE_DESCRIPTION, STARTER_SITE_TITLE } from "@/services/sites/site-content-check";
import { STARTER_APP_DESCRIPTION, STARTER_APP_TITLE } from "@/services/provisioning/acceptance-gate";
import { buildStarterFiles } from "../../starters";
import { STARTER_CATEGORIES } from "@/services/provisioning/starter-picker";
import { createViteStarterProvider } from "..";

const CLIP_RULE = /html,\s*body\s*\{[^}]*overflow-x:\s*clip;[^}]*\}/;

describe("vite starter: the basics a visitor sees", () => {
  it("wires an SVG favicon that ships in public/", () => {
    expect(VITE_PATHS).toContain("public/favicon.svg");
    expect(VITE["public/favicon.svg"]).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(VITE["index.html"]).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  });

  it("keeps a starter title and description the site check recognises as unfinished", () => {
    const meta = readSiteMeta(VITE["index.html"]);
    expect(meta.title).toBe(STARTER_SITE_TITLE);
    expect(meta.description).toBe(STARTER_SITE_DESCRIPTION);
    expect(seedMetaProblems(VITE["index.html"])).toHaveLength(2);
  });

  it("routes unknown paths to a styled not-found page with a link home", () => {
    expect(VITE["src/App.tsx"]).toContain('<Route path="*" element={<NotFound />} />');
    expect(VITE["src/App.tsx"]).not.toContain("Page not found.</p>");
    const page = VITE["src/pages/NotFound.tsx"];
    expect(page).toContain('data-zavi="not-found"');
    expect(page).toContain('<Link to="/"');
    expect(page).toMatch(/className="[^"]*text-3xl/);
  });

  it("base CSS stops page-level sideways scroll and keeps media inside the screen", () => {
    const css = VITE["src/index.css"];
    expect(css).toMatch(CLIP_RULE);
    expect(css).toMatch(/img,\s*video,\s*iframe,\s*canvas\s*\{\s*max-width:\s*100%;\s*\}/);
  });

  it("the smoke script can check the width at 390px when the gate asks", () => {
    const smoke = VITE["scripts/smoke.mjs"];
    expect(smoke).toContain('checkOverflow: env.SMOKE_CHECK_OVERFLOW === "1"');
    expect(smoke).toContain("export const MOBILE_WIDTH = 390;");
    expect(smoke).toContain("el.scrollWidth");
  });

  it("the provider still hands out the new files with the lockfile", () => {
    const starter = createViteStarterProvider(VITE).starterFiles();
    expect(starter.files["package-lock.json"]).toBeTruthy();
    expect(starter.files["public/favicon.svg"]).toBe(VITE["public/favicon.svg"]);
    expect(starter.files["src/pages/NotFound.tsx"]).toBe(VITE["src/pages/NotFound.tsx"]);
  });
});

describe("next starter: the basics a visitor sees", () => {
  it("ships app/icon.svg, which Next serves as the favicon", () => {
    expect(NEXT_PATHS).toContain("app/icon.svg");
    expect(NEXT["app/icon.svg"]).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  });

  it("ships a styled not-found page with a link home", () => {
    const page = NEXT["app/not-found.tsx"];
    expect(page).toContain('import Link from "next/link";');
    expect(page).toContain('href="/"');
    expect(page).toMatch(/className="[^"]*text-3xl/);
  });

  it("base CSS stops page-level sideways scroll", () => {
    expect(NEXT["app/globals.css"]).toMatch(CLIP_RULE);
  });

  it("the layout's starter title and description are the ones the live check rejects", () => {
    expect(NEXT["app/layout.tsx"]).toContain(`title: "${STARTER_APP_TITLE}"`);
    expect(NEXT["app/layout.tsx"]).toContain(`description: "${STARTER_APP_DESCRIPTION}"`);
  });

  it("every category starter carries the favicon, the not-found page and the width rule", () => {
    for (const category of STARTER_CATEGORIES) {
      const files = buildStarterFiles(category, { visitorSafe: true });
      expect(files["app/icon.svg"], category).toBe(NEXT["app/icon.svg"]);
      expect(files["app/not-found.tsx"], category).toBe(NEXT["app/not-found.tsx"]);
      expect(files["app/globals.css"], category).toMatch(CLIP_RULE);
    }
  });
});
