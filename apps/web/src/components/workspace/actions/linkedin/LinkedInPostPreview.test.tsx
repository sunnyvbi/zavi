import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionCardFacts } from "../ActionCardFacts";
import { LinkedInPostPreview } from "./LinkedInPostPreview";

const radiusOf = (html: string, tag: string, marker: string) => {
  const open = html.split("<").find((chunk) => chunk.startsWith(tag + " ") && chunk.includes(marker)) ?? "";
  return /class="[^"]*?(rounded-[a-z0-9]+)[ "]/.exec(open)?.[1];
};

describe("LinkedInPostPreview corner radius", () => {
  it("matches the What it is panel and the open-post overlay", () => {
    const html = renderToStaticMarkup(<><ActionCardFacts description="Create the campaign." /><LinkedInPostPreview name="Zavi Labs" text="Post text" textReal href="https://www.linkedin.com/feed/update/urn:li:share:1/" /></>);
    const panel = radiusOf(html, "dl", "border-rule");
    expect(panel).toBe("rounded-2xl");
    expect(radiusOf(html, "article", "LinkedIn post preview")).toBe(panel);
    expect(radiusOf(html, "a", "Open this post on LinkedIn")).toBe(panel);
  });
});
