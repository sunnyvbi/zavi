// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SourceIcon } from "../SourceIcon";

const REDRAWN = ["seo", "geo", "email_marketing"];

const chip = (c: Channel, size: "md" | "sm" = "md") =>
  render(<SourceIcon channel={c} size={size} />).container.firstElementChild as HTMLElement;

const all = CHANNELS as readonly Channel[];

describe("the channel row mark", () => {
  afterEach(cleanup);

  it("draws SEO, GEO and Email as an inline brand glyph on a white bordered chip", () => {
    const wrong = all
      .filter((c) => REDRAWN.includes(c.slug))
      .filter((c) => {
        const el = chip(c);
        cleanup();
        return !(
          el.dataset.channelGlyph === c.slug &&
          el.className.includes("bg-white") &&
          el.className.includes("border-[#d9d9d9]") &&
          el.className.includes("h-9") &&
          el.querySelector("svg") !== null &&
          el.querySelector("svg.lucide") === null &&
          el.querySelector("img") === null
        );
      });
    expect(wrong.map((c) => c.slug)).toEqual([]);
    expect(all.filter((c) => REDRAWN.includes(c.slug)).length).toBe(REDRAWN.length);
  });

  it("gives the three redrawn channels three different drawings", () => {
    const art = all.filter((c) => REDRAWN.includes(c.slug)).map((c) => {
      const html = chip(c).innerHTML;
      cleanup();
      return html;
    });
    expect(new Set(art).size).toBe(REDRAWN.length);
  });

  it("leaves every other channel on its existing mark", () => {
    const moved = all
      .filter((c) => !REDRAWN.includes(c.slug))
      .filter((c) => {
        const el = chip(c);
        cleanup();
        return el.dataset.channelGlyph !== undefined || !el.className.includes("h-9");
      });
    expect(moved.map((c) => c.slug)).toEqual([]);
  });

  it("keeps the small mention chip on its 20px mark", () => {
    for (const c of all) {
      const el = chip(c, "sm");
      expect(el.dataset.channelGlyph, c.slug).toBeUndefined();
      expect(el.className, c.slug).toContain("h-5");
      cleanup();
    }
  });
});
