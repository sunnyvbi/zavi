import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppInitialTile, appInitial } from "./AppInitialTile";

const TILE = /class="[^"]*bg-\[#0e0f11\][^"]*"/;

describe("AppInitialTile", () => {
  it("shows the app's first letter, upper-cased, on the same black tile at both sizes", () => {
    const sm = renderToStaticMarkup(<AppInitialTile name="mohit" />);
    const lg = renderToStaticMarkup(<AppInitialTile name="mohit" size="lg" />);
    for (const html of [sm, lg]) {
      expect(html).toContain(">M<");
      expect(html).toMatch(TILE);
      expect(html).toContain("text-white");
      expect(html).not.toMatch(/gradient|#4f46e5|#0e9f6e/);
    }
    expect(sm).toContain("h-5 w-5 rounded-md");
    expect(lg).toContain("h-16 w-16 rounded-2xl");
  });

  it("renders an empty tile, not a crash, for a missing name", () => {
    expect(appInitial(null)).toBe("");
    expect(appInitial("  ")).toBe("");
    expect(renderToStaticMarkup(<AppInitialTile name={undefined} />)).toMatch(TILE);
  });

  it("is the one tile both the Build header and Settings use", () => {
    const dir = join(__dirname, "..");
    const tab = readFileSync(join(dir, "WebsiteTab.tsx"), "utf8");
    const console_ = readFileSync(join(dir, "website", "WebsiteConsole.tsx"), "utf8");
    expect(tab).toContain("<AppInitialTile name={appName} />");
    expect(console_).toContain('<AppInitialTile name={app.name} size="lg" />');
    expect(console_).not.toMatch(/bg-gradient-to-br|<Sparkles/);
  });
});
