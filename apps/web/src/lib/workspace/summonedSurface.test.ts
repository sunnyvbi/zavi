
import { describe, it, expect } from "vitest";
import { readSummonedSurface } from "./summonedSurface";

const good = {
  summoned_surface: {
    key: "builds",
    dashboard_slug: "engineer",
    label: "Your builds",
  },
};

describe("readSummonedSurface", () => {
  it("parses a well-formed key", () => {
    expect(readSummonedSurface(good)).toEqual({
      key: "builds",
      dashboardSlug: "engineer",
      label: "Your builds",
    });
  });

  it("accepts a kebab slug on both fields", () => {
    const r = readSummonedSurface({
      summoned_surface: {
        key: "ads-manager",
        dashboard_slug: "performance-marketer",
        label: "Ads",
      },
    });
    expect(r?.key).toBe("ads-manager");
    expect(r?.dashboardSlug).toBe("performance-marketer");
  });

  it("caps a runaway label before it reaches the DOM", () => {
    const r = readSummonedSurface({
      summoned_surface: { ...good.summoned_surface, label: "x".repeat(500) },
    });
    expect(r?.label.length).toBe(60);
  });

  it("trims whitespace and rejects a blank label", () => {
    expect(
      readSummonedSurface({
        summoned_surface: { ...good.summoned_surface, label: "  Your builds  " },
      })?.label,
    ).toBe("Your builds");
    expect(
      readSummonedSurface({
        summoned_surface: { ...good.summoned_surface, label: "   " },
      }),
    ).toBeNull();
  });

  const rejects: Array<[string, unknown]> = [
    ["null meta", null],
    ["undefined meta", undefined],
    ["a string meta", "summoned_surface"],
    ["meta with no key", { envelope: { kind: "report" } }],
    ["an array payload", { summoned_surface: ["builds"] }],
    ["a string payload", { summoned_surface: "builds" }],
    ["a missing key", { summoned_surface: { dashboard_slug: "engineer", label: "x" } }],
    ["a non-string key", { summoned_surface: { key: 7, dashboard_slug: "engineer", label: "x" } }],
    ["an UPPERCASE key", { summoned_surface: { key: "Builds", dashboard_slug: "engineer", label: "x" } }],
    ["a path-ish key", { summoned_surface: { key: "../../etc", dashboard_slug: "engineer", label: "x" } }],
    ["a path-ish dashboard slug", { summoned_surface: { key: "builds", dashboard_slug: "a/b", label: "x" } }],
    ["a missing label", { summoned_surface: { key: "builds", dashboard_slug: "engineer" } }],
  ];
  for (const [name, meta] of rejects) {
    it(`returns null for ${name}`, () => {
      expect(readSummonedSurface(meta)).toBeNull();
    });
  }
});
