import { describe, expect, it } from "vitest";
import { fastBuildDesignFrom, fastSiteBuildPrompt, starterSectionNames } from "../fast-build-prompt";
import { briefForChosenLook, designDirections, fallbackDesignBrief, withCompleteLook } from "@/services/sites/design-directions";
import type { DesignBrief } from "@/services/sites/design-brief";

const IDEA = "A bakery taking pre-orders for sourdough loaves, pick up Saturday mornings on Mill Lane.";
const BRIEF: DesignBrief = withCompleteLook({ ...fallbackDesignBrief({ idea: IDEA }), facts: ["Pick up Saturday mornings"], audience: "Neighbours who want real bread" }, IDEA);

function prompt(over: Partial<Parameters<typeof fastSiteBuildPrompt>[0]> = {}) {
  return fastSiteBuildPrompt({ companyName: "Crumb & Co", targetRepo: "Praxis-build/crumb-1", idea: IDEA, backend: "pooled", designBrief: BRIEF, ...over });
}

describe("the build prompt follows the founder's chosen look", () => {
  it("names the picked look and the platform-owned theme file the founder can switch", () => {
    const dirs = designDirections(BRIEF);
    const design = fastBuildDesignFrom({ brief: BRIEF, directions: dirs, chosen_direction: dirs[2].id, theme_mode: "theme_css" })!;
    expect(design.label).toBe(dirs[2].label);
    const p = prompt({ design });
    expect(p).toContain(`${dirs[2].label}: ${dirs[2].mood}`);
    expect(p).toContain("<untrusted_design_direction>");
    expect(p).toContain("`src/theme.css`, which the platform owns");
  });

  it("lays the site out in the structure the build was given, styled in the current pick", () => {
    const dirs = designDirections(BRIEF);
    const d = fastBuildDesignFrom({ brief: BRIEF, directions: dirs, chosen_direction: dirs[1].id, build_direction: "brand", theme_mode: "theme_css" })!;
    expect(d.label).toBe(dirs[1].label);
    expect(d.layout).toBe(dirs[0].layout);
    expect(dirs[0].layout).not.toBe(dirs[1].layout);
    expect(prompt({ design: d })).toContain(`Lay the home page out ${dirs[0].layout}:`);
  });

  it("the plan in the prompt is the picked look's: its hero variant agrees with its layout line", () => {
    const planned: DesignBrief = withCompleteLook(
      {
        ...BRIEF,
        plan: {
          tone: "warm",
          primary_action: { label: "Pre-order", steps: "Pick a loaf and a pick-up time" },
          pages: [
            {
              path: "/",
              title: "Home",
              sections: [
                { name: "Hero", headline: "Real bread, Saturday mornings", component: "Hero", variant: "split", image: { subject: "sourdough loaves", role: "hero" } },
                { name: "Loaves", headline: "This week's bakes", component: "Features", variant: "cards" },
              ],
            },
          ],
        },
      },
      IDEA,
    );
    const dirs = designDirections(planned);
    for (const d of dirs) {
      const row = { brief: planned, directions: dirs, chosen_direction: d.id, theme_mode: "theme_css" as const };
      const hero = d.plan!.pages[0].sections[0].variant!;
      const p = prompt({ design: fastBuildDesignFrom(row)!, designBrief: briefForChosenLook(row) });
      expect(p).toContain(`Lay the home page out ${d.layout}:`);
      expect(p).toContain(`(Hero ${hero})`);
    }
  });

  it("points the theme starter's build at its section library, read from the starter itself", () => {
    const names = starterSectionNames();
    expect(names).toEqual(expect.arrayContaining(["Hero", "Contact", "SiteFooter"]));
    expect(names.every((n) => /^[A-Z]/.test(n))).toBe(true);
    const dirs = designDirections(BRIEF);
    const design = fastBuildDesignFrom({ brief: BRIEF, directions: dirs, chosen_direction: "brand", theme_mode: "theme_css" })!;
    expect(prompt({ design })).toContain(`it has ${names.join(", ")}`);
    expect(prompt({ design, backend: "dedicated" })).not.toContain("section library");
  });

  it("an older starter keeps its tokens in index.css; no design row falls back to the brief's own line", () => {
    const dirs = designDirections(BRIEF);
    expect(fastBuildDesignFrom({ brief: BRIEF, directions: dirs, chosen_direction: "brand", theme_mode: "index_css" })!.themeFile).toBe("src/index.css");
    expect(fastBuildDesignFrom({ brief: BRIEF, directions: dirs, chosen_direction: "brand", theme_mode: "none" })).toBeNull();
    expect(fastBuildDesignFrom(null)).toBeNull();
    expect(fastBuildDesignFrom({ brief: BRIEF, directions: dirs, chosen_direction: "gone", theme_mode: "theme_css" })!.label).toBe(dirs[0].label);
  });

  it("carries the brief's audience and stated facts, and the images rule on the first pass only", () => {
    const first = prompt({ imagesRule: "### Images and icons\nRULE" });
    expect(first).toContain("For: Neighbours who want real bread");
    expect(first).toContain("Facts to use (the founder's own; invent no others): Pick up Saturday mornings");
    expect(first).toContain("### Images and icons\nRULE");
    const fix = prompt({ imagesRule: "### Images and icons\nRULE", repairSignal: "journey book failed" });
    expect(fix).not.toContain("### Images and icons");
    expect(prompt({ imagesRule: "### Images and icons\nRULE", repairSignal: "the site never asked for its photos (add_site_images)" })).toContain("### Images and icons");
  });
});
