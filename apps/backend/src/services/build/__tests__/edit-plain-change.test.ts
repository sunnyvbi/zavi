import { describe, it, expect } from "vitest";
import { NEUTRAL_EDIT_LINE, plainEditLine } from "../edit-plain-change";
import { hasInternalJargon } from "@/services/agents/internal-jargon";

const m = (path: string, action = "modify") => ({ path, action });

describe("plainEditLine", () => {
  it.each([
    [[m("src/app/page.tsx")], "Updated your home page"],
    [[m("app/(marketing)/pricing/page.tsx")], "Updated your pricing page"],
    [[m("src/pages/index.tsx")], "Updated your home page"],
    [[m("src/pages/AboutUs.tsx")], "Updated your about us page"],
    [[m("pages/blog/index.jsx")], "Updated your blog page"],
    [[m("index.html")], "Updated your home page"],
    [[m("public/contact.html")], "Updated your contact page"],
    [[m("src/index.css")], "Updated your site's look"],
    [[m("tailwind.config.ts")], "Updated your site's look"],
    [[m("public/hero.webp", "create")], "Updated your site's pictures"],
    [[m("src/components/SiteHeader.tsx")], "Updated your header"],
    [[m("src/components/PricingTable.jsx")], "Updated your pricing section"],
    [[m("supabase/migrations/002_orders.sql", "create")], "Updated how your site works behind the scenes"],
    [[m("src/app/careers/page.tsx", "create")], "Added a new careers page"],
    [[m("src/pages/Old.tsx", "delete")], "Removed your old page"],
  ])("%j -> %s", (files, expected) => {
    expect(plainEditLine(files)).toBe(expected);
  });

  it("joins several parts and lists added before updated", () => {
    expect(
      plainEditLine([m("src/components/Footer.tsx"), m("src/app/careers/page.tsx", "create"), m("src/styles/theme.css"), m("src/index.css")]),
    ).toBe("Added a new careers page and updated your footer and your site's look");
  });

  it("caps the list at three parts and says there is more", () => {
    expect(
      plainEditLine([m("src/app/page.tsx"), m("src/app/menu/page.tsx"), m("src/components/Footer.tsx"), m("src/index.css"), m("public/a.png")]),
    ).toBe("Updated your home page, your menu page and your footer, and more");
  });

  it("a page created and edited in one change reads as updated", () => {
    expect(plainEditLine([m("pages/menu.tsx", "create"), m("src/app/menu/page.tsx")])).toBe("Updated your menu page");
  });

  it.each([
    [[]],
    [null],
    [undefined],
    [[m("src/App.tsx"), m("src/lib/format.ts"), m("package.json")]],
    [[m("src/app/[slug]/page.tsx")]],
    [[m("pages/_app.tsx"), m("pages/_document.tsx")]],
    [[{ path: 42 }, { path: "" }, null as never, {}]],
  ])("nothing nameable (%j) gives the neutral line", (files) => {
    expect(plainEditLine(files as never)).toBe(NEUTRAL_EDIT_LINE);
  });

  it("never echoes a file name, a hook, a sandbox or a build repo", () => {
    const hostile = [
      m("Praxis-build/yoga/src/pages/useCart.tsx"),
      m("src/pages/sandbox.tsx"),
      m("src/pages/git push.tsx"),
      m("src/pages/repo_hint.tsx"),
      m("src/pages/0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d01.tsx"),
      m("src/pages/a.b.tsx"),
      m("src/app/x/page.tsx"),
    ];
    for (const f of hostile) {
      const line = plainEditLine([f]);
      expect(hasInternalJargon(line), line).toBe(false);
      expect(line, line).not.toMatch(/\.tsx|src\/|Praxis-build|repo_hint|0f1c1a5e|git push/i);
    }
    expect(plainEditLine([m("src/pages/sandbox.tsx")])).toBe(NEUTRAL_EDIT_LINE);
  });
});
