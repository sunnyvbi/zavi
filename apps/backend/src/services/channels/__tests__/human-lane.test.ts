
import { describe, it, expect } from "vitest";
import { CHANNELS, channelForBriefKind, HUMAN_DISCIPLINES, type Channel } from "@zavi/shared";

describe("human lane — human brief_kind → channel", () => {
  it("routes a creative brief to ugc, NOT to the channel it was authored in", () => {
    expect(channelForBriefKind("creative")?.slug).toBe("ugc");
  });

  it("returns undefined for an unknown kind rather than guessing a tile", () => {
    expect(channelForBriefKind("engineering")).toBeUndefined();
    expect(channelForBriefKind("")).toBeUndefined();
  });

  it("ignores a channel whose lane is declared but CLOSED", () => {
    const closed = (CHANNELS as readonly Channel[]).filter((c) => c.human?.available === false);
    for (const c of closed) {
      expect(channelForBriefKind(c.human!.brief_kind)?.slug).not.toBe(c.slug);
    }
  });

  it("declares only real human disciplines on the open lane", () => {
    const ugc = (CHANNELS as readonly Channel[]).find((c) => c.slug === "ugc");
    expect(ugc?.human?.available).toBe(true);
    for (const d of ugc?.human?.disciplines ?? []) {
      expect(HUMAN_DISCIPLINES as readonly string[]).toContain(d);
    }
  });

  it("leaves exactly one open claimant for the creative kind", () => {
    const open = (CHANNELS as readonly Channel[]).filter(
      (c) => c.human?.available === true && c.human.brief_kind === "creative",
    );
    expect(open.map((c) => c.slug)).toEqual(["ugc"]);
  });
});
