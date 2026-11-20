import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatBubble } from "./ChatBubble";

const url = "http://localhost:3011/api/public/workspace-files/b92dcbf1-bac9-457a-af81-0bbe5984339b/cd9ec0c2-1c87-483f-9930-4a18bc701015/hero.jpeg";
const sent = `put it in the hero\n\nUse this photo on the site:\nhero.jpeg: ${url}`;

describe("ChatBubble photo chips", () => {
  for (const variant of ["bubble", "flat"] as const) {
    it(`shows a sent photo as a chip and keeps only the typed words as text (${variant})`, () => {
      const html = renderToStaticMarkup(<ChatBubble role="user" text={sent} variant={variant} />);
      expect(html).toContain('aria-label="Attached photo"');
      expect(html).toContain(`src="${url}"`);
      expect(html).toContain('alt="hero.jpeg"');
      expect(html).not.toContain(">hero.jpeg<");
      expect(html).not.toContain("Image attachment");
      expect(html).toContain("h-[132px]");
      expect(html).toContain("put it in the hero");
      expect(html).not.toContain("Use this photo on the site");
      expect(html.split(url)).toHaveLength(2);
    });
  }

  it("draws no empty text plate for a photo-only message", () => {
    const html = renderToStaticMarkup(<ChatBubble role="user" text={`Use this photo on the site:\nhero.jpeg: ${url}`} />);
    expect(html).toContain('aria-label="Attached photo"');
    expect(html).not.toContain("bg-[#f0f0f0]");
  });
});
