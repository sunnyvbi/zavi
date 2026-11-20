
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { initialWebsiteMode, remembersWebsiteMode } from "./WebsiteTab";

const source = readFileSync(join(__dirname, "WebsiteTab.tsx"), "utf8");

describe("initialWebsiteMode", () => {
  it("opens Build on the preview whatever the URL or the stored choice say", () => {
    expect(initialWebsiteMode("build", "dashboard", "dashboard")).toBe("preview");
    expect(initialWebsiteMode("build", "dashboard", null)).toBe("preview");
    expect(initialWebsiteMode("build", null, "dashboard")).toBe("preview");
    expect(initialWebsiteMode("build", null, null)).toBe("preview");
  });

  it("lets a shared ?view= link win on the Website tab", () => {
    expect(initialWebsiteMode("website", "dashboard", null)).toBe("dashboard");
    expect(initialWebsiteMode("website", "preview", "dashboard")).toBe("preview");
  });

  it("falls back to the stored choice, then the preview", () => {
    expect(initialWebsiteMode("website", null, "dashboard")).toBe("dashboard");
    expect(initialWebsiteMode("website", null, null)).toBe("preview");
    expect(initialWebsiteMode("website", "garbage", "nonsense")).toBe("preview");
  });
});

describe("remembersWebsiteMode", () => {
  it("is false for Build and true for the Website tab", () => {
    expect(remembersWebsiteMode("build")).toBe(false);
    expect(remembersWebsiteMode("website")).toBe(true);
  });

  it("gates the localStorage write, so Build cannot poison the shared key", () => {
    const persist = source.slice(
      source.indexOf("// Build never writes the choice"),
      source.indexOf("}, [mode, variant]);"),
    );
    expect(persist).toContain("if (remembersWebsiteMode(variant))");
    expect(persist).toContain("window.localStorage.setItem(WEBSITE_MODE_KEY, mode)");
    const guardAt = persist.indexOf("if (remembersWebsiteMode(variant))");
    expect(persist.indexOf("setItem")).toBeGreaterThan(guardAt);
  });
});
