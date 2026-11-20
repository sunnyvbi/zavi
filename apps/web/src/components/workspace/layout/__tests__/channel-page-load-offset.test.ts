import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (dir: string, file: string) =>
  readFileSync(join(__dirname, "..", "..", dir, file), "utf8");

const drawer = read("layout", "ChannelDrawer.tsx");
const headerRow = read("layout", "ChannelHeaderRow.tsx");
const lane = read("actions", "ChannelActionsLane.tsx");

const lineWith = (source: string, needle: string): string => {
  const hits = source.split("\n").filter((l) => l.includes(needle));
  expect(hits.length, `expected exactly one line containing ${needle}`).toBe(1);
  return hits[0];
};

const SCROLLER = lineWith(drawer, "ws-scroll min-h-0 flex-1");
const BODY_PAD = lineWith(drawer, 'isPage ? cx("px-6 pb-6');
const HEADER = lineWith(headerRow, "flex w-full flex-wrap items-center gap-3");
const HEADER_SPACED = lineWith(headerRow, "spaced && ");
const SKELETON = lineWith(lane, 'role="status" aria-live="polite" aria-busy="true"');

const topMargin = /(?<![\w:-])mt-[\d.]+/;
const compactTopMargin = /compact:mt-[\d.]+/;

describe("a channel page does not move when its data lands", () => {
  it("keeps the top gutter on the scroll body, the one element present in every state", () => {
    expect(SCROLLER).toBeTruthy();
    expect(BODY_PAD).toMatch(/(?<![\w:-])pt-[\d.]+/);
    expect(BODY_PAD).toMatch(/compact:pt-[\d.]+/);
  });

  it("gives the header row no top margin, so an EMPTY row costs the same as a full one", () => {
    expect(HEADER).not.toMatch(topMargin);
    expect(HEADER).not.toMatch(compactTopMargin);
    expect(HEADER).not.toMatch(/sm:\[&:has\(>\*:not\(:empty\)\)\]:mt-/);
  });

  it("gives the loading skeleton no top margin either, so it cannot sit lower than the row it becomes", () => {
    expect(SKELETON).not.toMatch(topMargin);
    expect(SKELETON).not.toMatch(compactTopMargin);
  });

  it("puts the row's own separation BELOW it, where an empty row contributes nothing", () => {
    expect(HEADER_SPACED).toMatch(/\[&:has\(>\*:not\(:empty\)\)\]:mb-[\d.]+/);
    expect(HEADER_SPACED).not.toMatch(topMargin);
  });
});
