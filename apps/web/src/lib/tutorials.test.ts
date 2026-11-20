import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TUTORIALS,
  TUTORIAL_GROUPS,
  formatDuration,
  isPlayable,
  tutorialAssetUrl,
  tutorialsByGroup,
  type Tutorial,
} from "./tutorials";

describe("tutorials list", () => {
  it("numbers tutorials 1..n with unique slugs", () => {
    const n = TUTORIALS.length;
    expect(n).toBeGreaterThan(0);
    expect(new Set(TUTORIALS.map((t) => t.slug)).size).toBe(n);
    expect(TUTORIALS.map((t) => t.number).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it("puts every tutorial in a known group, and every group has at least one", () => {
    const ids = new Set<string>(TUTORIAL_GROUPS.map((g) => g.id));
    for (const t of TUTORIALS) expect(ids.has(t.group), t.slug).toBe(true);
    const grouped = tutorialsByGroup();
    expect(grouped.map((g) => g.id)).toEqual(TUTORIAL_GROUPS.map((g) => g.id));
    expect(grouped.reduce((n, g) => n + g.items.length, 0)).toBe(TUTORIALS.length);
  });

  it("uses valid tiers and keeps titles and descriptions short, filled and free of em dashes", () => {
    for (const t of TUTORIALS) {
      expect(["Free", "Starter", "Growth", "Pro"]).toContain(t.tier);
      expect(t.title).not.toMatch(/—/);
      expect(t.description.trim().length, t.slug).toBeGreaterThan(20);
      expect(t.description.length, t.slug).toBeLessThanOrEqual(220);
      expect(t.description).not.toMatch(/—/);
    }
  });

  it("a ready row needs a resolvable video; coming-soon rows never play", () => {
    for (const t of TUTORIALS) {
      if (t.status === "ready") expect(isPlayable(t), t.slug).toBe(true);
      else expect(isPlayable(t)).toBe(false);
    }
    const ready: Tutorial = { ...TUTORIALS[0], status: "ready", videoUrl: "https://cdn.example.com/a.mp4" };
    expect(isPlayable(ready)).toBe(true);
    expect(isPlayable({ ...ready, videoUrl: undefined })).toBe(false);
  });

  it("gives every card a short poster title, a mascot pose that exists, and a screen crop only once the video is ready", () => {
    const pub = join(__dirname, "../../public");
    for (const t of TUTORIALS) {
      const p = t.poster;
      expect(p.title.trim().length, t.slug).toBeGreaterThan(0);
      expect(p.title.length, t.slug).toBeLessThanOrEqual(26);
      expect(p.title).not.toMatch(/—/);
      expect(existsSync(join(pub, `mascots/poses/zavi-${p.pose}.webp`)), `${t.slug} pose`).toBe(true);
      if (t.status === "ready") {
        expect(p.screen, t.slug).toBeTruthy();
        expect(existsSync(join(pub, p.screen!)), `${t.slug} screen`).toBe(true);
      } else {
        expect(p.screen, t.slug).toBeUndefined();
      }
    }
  });

  it("keeps absolute asset URLs and formats durations", () => {
    expect(tutorialAssetUrl("https://cdn.example.com/x.mp4")).toBe("https://cdn.example.com/x.mp4");
    expect(tutorialAssetUrl(undefined)).toBeUndefined();
    expect(formatDuration(95)).toBe("1:35");
    expect(formatDuration(undefined)).toBeNull();
  });
});
