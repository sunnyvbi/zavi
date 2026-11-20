import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appPageInfo, pageInfo } from "./pages";

const middleware = readFileSync(join(__dirname, "..", "publicPaths.ts"), "utf8").replace(
  /\/\/.*$/gm,
  "",
);

function listed(name: string): string[] {
  const start = middleware.indexOf(name);
  const end = middleware.indexOf("]", start);
  return [...middleware.slice(start, end).matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
}

const NOT_PAGES = new Set(["/auth/", "/r-Hg5x3K/", "/connectors/finish"]);

describe("pageInfo covers every public page", () => {
  it("has a page type for every public path and prefix in middleware", () => {
    const paths = [...listed("const PUBLIC_PATHS"), ...listed("const PUBLIC_PREFIXES")];
    expect(paths.length).toBeGreaterThan(20);
    for (const p of paths) {
      if (NOT_PAGES.has(p)) continue;
      const sample = p !== "/" && p.endsWith("/") ? `${p}sample` : p;
      expect(pageInfo(sample), p).not.toBeNull();
    }
  });

  it("groups the pages the manager asked about", () => {
    expect(pageInfo("/")).toEqual({ type: "home", group: "marketing" });
    expect(pageInfo("/startups")?.type).toBe("startups");
    expect(pageInfo("/tools")?.type).toBe("tools");
    expect(pageInfo("/channels/seo")).toEqual({ type: "channel", group: "marketing" });
    expect(pageInfo("/use-cases/marketplaces")?.type).toBe("use_case");
    expect(pageInfo("/start")?.group).toBe("onboarding");
    expect(pageInfo("/login")?.group).toBe("onboarding");
    expect(pageInfo("/creators/apply")?.group).toBe("onboarding");
    expect(pageInfo("/live/upcar")?.group).toBe("share");
    expect(pageInfo("/shopify/app-home")).toEqual({ type: "shopify_app_home", group: "app" });
    expect(pageInfo("/shopify/pricing")).toEqual({ type: "shopify_pricing", group: "marketing" });
  });

  it("ignores a trailing slash", () => {
    expect(pageInfo("/pricing/")?.type).toBe("pricing");
  });

  it("does not track the signed-in app", () => {
    for (const p of ["/workspace", "/workspace/legacy", "/account", "/creator", "/memory/abc", "/humans"]) {
      expect(pageInfo(p), p).toBeNull();
    }
  });

  it("names the signed-in app's pages for PostHog page views only", () => {
    expect(appPageInfo("/workspace")).toEqual({ type: "workspace", group: "app" });
    expect(appPageInfo("/workspace/runs/abc")?.type).toBe("workspace_runs");
    expect(appPageInfo("/workspace/email-cards/x/y")?.type).toBe("workspace_email_cards");
    expect(appPageInfo("/workspace/3f2b0c9e-0000-0000-0000-000000000000")?.type).toBe("workspace_thread");
    expect(appPageInfo("/pricing")).toBeNull();
    expect(pageInfo("/onboarding/past-work")).toEqual({ type: "onboarding_past_work", group: "onboarding" });
  });
});
