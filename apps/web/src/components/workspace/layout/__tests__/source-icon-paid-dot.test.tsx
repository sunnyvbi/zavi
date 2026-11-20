// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SourceIcon } from "../SourceIcon";

const channel = (slug: string): Channel => {
  const c = CHANNELS.find((x) => x.slug === slug);
  if (!c) throw new Error(`no such channel: ${slug}`);
  return c as Channel;
};

function hasDot(slug: string, size: "md" | "sm" = "md"): boolean {
  const { container } = render(<SourceIcon channel={channel(slug)} size={size} />);
  return container.querySelector("[data-paid-dot]") !== null;
}

function markup(slug: string): string {
  const { container } = render(<SourceIcon channel={channel(slug)} />);
  return container.innerHTML;
}

describe("the channel mark carries no status dot", () => {
  afterEach(cleanup);

  it("draws no dot on any channel, paid or organic, at either size", () => {
    for (const c of CHANNELS) {
      expect(hasDot(c.slug, "md"), c.slug).toBe(false);
      expect(hasDot(c.slug, "sm"), c.slug).toBe(false);
    }
  });

  it.each([
    ["youtube_ads", "youtube_organic"],
    ["linkedin_ads", "linkedin_organic"],
    ["reddit_ads", "reddit_organic"],
    ["tiktok_ads", "tiktok_organic"],
  ])("renders %s and %s identically, since the dot no longer separates them", (paid, organic) => {
    expect(hasDot(paid)).toBe(false);
    expect(hasDot(organic)).toBe(false);
  });

  it("draws no ring on any chip — the logos carry their own colour", () => {
    for (const c of CHANNELS) {
      expect(markup(c.slug), c.slug).not.toContain("ring-rule");
    }
  });
});
