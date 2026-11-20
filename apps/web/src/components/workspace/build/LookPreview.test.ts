// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TILE_SECTIONS, lookPreviewDoc } from "./LookPreview";
import type { SiteDesignPreview } from "@/lib/workspace/useSiteDesign";

const THEME = ":root{--background:255 255 255;--primary:180 60 90;--accent:255 220 230;--muted:250 240 240}";
const PREVIEW: SiteDesignPreview = {
  name: "Petal & Crumb",
  eyebrow: "Celebration cakes",
  headline: "Cakes worth the occasion",
  subtitle: "Made to order in small batches.",
  primary_action: "Order a cake",
  sections: [
    { title: "Gallery", body: "Recent cakes", kind: "Gallery", variant: "masonry" },
    { title: "Flavours", body: "This season", kind: "Features", variant: "split" },
    { title: "Reviews", body: "What people say", kind: "Testimonials" },
    { title: "Order", body: "Order yours", kind: "CTA" },
  ],
};

describe("a look's sample page", () => {
  it.each(["split", "centered", "editorial", "bold", "minimal"] as const)("shows a glimpse (the hero and %s's first sections), never a photo or a stand-in label", (layout) => {
    const doc = new DOMParser().parseFromString(lookPreviewDoc(THEME, PREVIEW, layout), "text/html");
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(doc.body.textContent).not.toMatch(/image area|photo|placeholder/i);
    expect(doc.querySelectorAll("section.sec")).toHaveLength(TILE_SECTIONS);
    expect(TILE_SECTIONS).toBeLessThanOrEqual(2);
  });
});
