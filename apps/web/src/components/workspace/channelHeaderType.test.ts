import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (...parts: string[]) => readFileSync(join(__dirname, ...parts), "utf8");

const lineWith = (source: string, needle: string): string => {
  const hit = source.split("\n").filter((l) => l.includes(needle));
  expect(hit.length, `expected exactly one line containing ${needle}`).toBe(1);
  return hit[0];
};

const sizeOf = (line: string, prefix = ""): number => {
  const found = new RegExp(`(?<![\\w:-])${prefix}text-\\[(\\d+(?:\\.\\d+)?)px\\]`).exec(line);
  expect(found, `no ${prefix || "base "}text size in: ${line.trim().slice(0, 80)}`).not.toBeNull();
  return Number(found![1]);
};

const tabs = read("layout", "ChannelTabBar.tsx");
const menu = read("..", "ui", "Menu.tsx");
const redditOverview = read("agent", "reddit", "OverviewTab.tsx");

const TAB_LABEL = lineWith(tabs, "-mb-px flex h-10 items-center gap-2 border-b-2");
const WINDOW_PICKER = lineWith(menu, "inline-flex cursor-pointer list-none items-center");
const SCAN_STATUS = lineWith(redditOverview, "flex shrink-0 items-center gap-2 pl-3");

describe("the channel header keeps a type hierarchy", () => {
  it("sets the tab label as the row's loudest voice", () => {
    expect(sizeOf(TAB_LABEL)).toBe(16);
  });

  it("speaks the window picker and the scan status more quietly than the tabs", () => {
    const tab = sizeOf(TAB_LABEL);
    for (const [name, line] of [
      ["window picker", WINDOW_PICKER],
      ["scan status", SCAN_STATUS],
    ] as const) {
      expect(sizeOf(line), `${name} must not shout over the tabs`).toBeLessThan(tab);
    }
  });

  it("hands both of them back the phone-readable size on a compact viewport", () => {
    for (const [name, line] of [
      ["window picker", WINDOW_PICKER],
      ["scan status", SCAN_STATUS],
    ] as const) {
      expect(sizeOf(line, "compact:"), `${name} must stay readable on a phone`).toBe(16);
    }
  });
});
