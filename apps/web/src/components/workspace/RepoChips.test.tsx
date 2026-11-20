
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepoChips } from "./SettingsTab";

const NAMES = [
  "rravi149/OraiCar",
  "rravi149/OraiCarAndroid",
  "rravi149/upcar",
  "rravi149/upcar-private",
  "rravi149/apna-tutor",
  "rravi149/praxis",
];
const IDS = [1, 2, 3, 4, 5, 6];
const noop = () => {};

function render(props: Partial<React.ComponentProps<typeof RepoChips>>) {
  return renderToStaticMarkup(
    <RepoChips
      names={NAMES}
      ids={IDS}
      onSetDefault={noop}
      {...props}
    />,
  );
}

describe("RepoChips reachability", () => {
  it("scoped: marks unreachable repos and shows the legend", () => {
    const html = render({ selectedIds: [3], readOnly: true });
    expect(html).toContain("= not reachable");
    expect(html).toContain("line-through");
    expect(html).toContain("🚫");
    expect(html).toContain("not reachable (limited by repo access)");
  });

  it("scoped: reachable repo sorts before the unreachable ones", () => {
    const html = render({ selectedIds: [3], readOnly: true });
    const reachableAt = html.indexOf(">upcar<");
    const firstStruck = html.indexOf("line-through");
    expect(reachableAt).toBeGreaterThan(-1);
    expect(reachableAt).toBeLessThan(firstStruck);
  });

  it("unscoped (selectedIds null): no dimming, no legend", () => {
    const html = render({ selectedIds: null, readOnly: true });
    expect(html).not.toContain("= not reachable");
    expect(html).not.toContain("line-through");
    expect(html).not.toContain("🚫");
  });

  it("no aligned ids: falls back to all-reachable even when scoped", () => {
    const html = render({ ids: [1, 2], selectedIds: [1], readOnly: true });
    expect(html).not.toContain("line-through");
    expect(html).not.toContain("🚫");
  });

  it("scoped to nothing: every repo is marked unreachable", () => {
    const html = render({ selectedIds: [], readOnly: true });
    const marks = html.match(/🚫/g) || [];
    expect(marks.length).toBe(6);
  });
});
