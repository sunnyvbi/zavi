// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AtSign } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import {
  DETAIL_TILE_MIN_PX,
  PER_ROW_MAX_COLS,
  ROW_GAP_PX,
  SummaryRow,
  TILE_MIN_PX,
  columnTemplate,
  tileBasis,
  type PerRow,
} from "./SummaryRow";
import { COLUMN_MIN_WIDTH_PX } from "../layout/columnLayout";

afterEach(cleanup);

function m(key: string, value: number): ChannelMetric {
  return {
    key,
    value,
    unit: "count",
    window_kind: "7d",
    day: "2026-09-17",
    grounded: true,
    prev_value: null,
    prev_day: null,
  };
}

const REDDIT_ORGANIC = [
  m("brand_mentions", 0),
  m("reply_opportunities", 0),
  m("relevant_posts", 0),
  m("relevant_comments", 0),
  m("subreddits_saved", 0),
];

type Layout = { count: number; tile: number; rowWidth: number };

function layOut(template: string, containerPx: number): Layout {
  const parsed =
    /^repeat\(auto-fill, minmax\(max\((\d+(?:\.\d+)?)px, calc\(\(100% - (\d+(?:\.\d+)?)px\) \/ (\d+)\)\), 1fr\)\)$/.exec(
      template,
    );
  if (!parsed) throw new Error(`not an auto-fill track list: ${template}`);
  const [, floorRaw, reservedRaw, maxColsRaw] = parsed;
  const floorPx = Number(floorRaw);
  const maxCols = Number(maxColsRaw);
  expect(Number(reservedRaw)).toBe(ROW_GAP_PX * (maxCols - 1));

  const share = (containerPx - ROW_GAP_PX * (maxCols - 1)) / maxCols;
  const trackMin = Math.max(floorPx, share);
  const count = Math.max(
    1,
    Math.floor((containerPx + ROW_GAP_PX) / (trackMin + ROW_GAP_PX)),
  );
  const tile = (containerPx - ROW_GAP_PX * (count - 1)) / count;
  return { count, tile, rowWidth: tile * count + ROW_GAP_PX * (count - 1) };
}

function basisOf(testId = "summary-row"): string {
  const row = screen.getByTestId(testId);
  expect(row.className).not.toMatch(/\b(sm|md|lg|xl|2xl):grid-cols-/);
  expect(row.className).toContain("flex-wrap");
  expect(row.className).toContain("[&>*]:grow");
  const basis = row.style.getPropertyValue("--metric-tile-basis");
  expect(basis, "the row must size its tiles from its own width").not.toBe("");
  return basis;
}

function flexRows(basis: string, containerPx: number, tiles: number): number[][] {
  const parsed = /^max\((\d+)px, calc\(\(100% - (\d+)px\) \/ (\d+)\)\)$/.exec(basis);
  if (!parsed) throw new Error(`not a fluid tile basis: ${basis}`);
  const [, floorRaw, reservedRaw, maxColsRaw] = parsed;
  const floor = Number(floorRaw);
  const maxCols = Number(maxColsRaw);
  expect(Number(reservedRaw)).toBe(ROW_GAP_PX * (maxCols - 1));
  const base = Math.max(floor, (containerPx - Number(reservedRaw)) / maxCols);
  const count = Math.min(maxCols, Math.max(1, Math.floor((containerPx + ROW_GAP_PX) / (base + ROW_GAP_PX))));
  const rows: number[][] = [];
  for (let remaining = tiles; remaining > 0; remaining -= count) {
    const items = Math.min(remaining, count);
    const width = (containerPx - ROW_GAP_PX * (items - 1)) / items;
    rows.push(Array(items).fill(width));
  }
  return rows;
}

const PANE_FLOOR = COLUMN_MIN_WIDTH_PX.analytics;

const DESKTOP_PANE_MIN = 750;

const TILE_PADDING_X = 32;

const WITH_ICONS = Object.fromEntries(
  REDDIT_ORGANIC.map((m) => [m.key, { icon: AtSign }]),
);

describe("a metric row is sized by its pane, not by the viewport", () => {
  it("never squeezes a tile below the label floor, at any pane width", () => {
    for (const perRow of Object.keys(PER_ROW_MAX_COLS).map(Number) as PerRow[]) {
      const template = columnTemplate(PER_ROW_MAX_COLS[perRow], TILE_MIN_PX);
      for (let width = 240; width <= 1440; width += 1) {
        const { count, tile, rowWidth } = layOut(template, width);
        expect(count, `perRow ${perRow} at ${width}px`).toBeLessThanOrEqual(
          PER_ROW_MAX_COLS[perRow],
        );
        expect(rowWidth, `perRow ${perRow} at ${width}px overflows`).toBeLessThanOrEqual(
          width + 0.001,
        );
        if (count > 1) {
          expect(tile, `perRow ${perRow} at ${width}px`).toBeGreaterThanOrEqual(
            TILE_MIN_PX,
          );
        }
      }
    }
  });

  it("gives the five Reddit tiles a readable width in a pane at its own floor", () => {
    render(<SummaryRow metrics={REDDIT_ORGANIC} perRow={5} />);
    const rows = flexRows(basisOf(), PANE_FLOOR, REDDIT_ORGANIC.length);
    expect(rows[0]).toHaveLength(2);
    expect(rows.flat().every((width) => width >= TILE_MIN_PX)).toBe(true);
    expect(rows[2][0]).toBe(PANE_FLOOR);
  });

  it("wraps rather than shrinks in the 430px pane the four-column shell hands them", () => {
    render(<SummaryRow metrics={REDDIT_ORGANIC} perRow={5} />);
    const rows = flexRows(basisOf(), 430, REDDIT_ORGANIC.length);
    expect(rows[0].length).toBeLessThan(5);
    expect(rows.flat().every((width) => width >= TILE_MIN_PX)).toBe(true);
    expect(rows[1][0]).toBe(209);
  });

  it("opens all five across on one row at every desktop pane width", () => {
    render(<SummaryRow metrics={REDDIT_ORGANIC} perRow={5} />);
    const basis = basisOf();
    for (let width = DESKTOP_PANE_MIN; width <= 1440; width += 1) {
      expect(flexRows(basis, width, REDDIT_ORGANIC.length)[0].length, `${width}px must be one row`).toBe(5);
    }
    expect(flexRows(basis, 880, REDDIT_ORGANIC.length)[0][0]).toBeCloseTo(166.4, 1);
  });

  it("holds the same floor for the wider spend cards", () => {
    const spend = [m("spend", 1200), m("cpa", 54.5), m("pacing", 82)];
    render(<SummaryRow metrics={spend} variant="spend" />);
    const basis = basisOf();
    for (const width of [PANE_FLOOR, 430, 560, 880]) {
      const rows = flexRows(basis, width, spend.length);
      expect(rows[0].length, `spend at ${width}px`).toBeLessThanOrEqual(3);
      if (rows[0].length > 1) expect(rows[0][0]).toBeGreaterThanOrEqual(DETAIL_TILE_MIN_PX);
    }
  });

  it("fills the last row when three cards cannot fit together beside chat", () => {
    render(<SummaryRow metrics={REDDIT_ORGANIC.slice(0, 3)} perRow={3} />);
    const rows = flexRows(basisOf(), 333, 3);
    expect(rows.map((row) => row.length)).toEqual([2, 1]);
    expect(rows[1][0]).toBe(333);
  });

  it("keeps a tile's own chrome out of the way when the tile itself is tiny", () => {
    render(<SummaryRow metrics={REDDIT_ORGANIC} perRow={5} />);
    const tile = screen.getByTestId("summary-row").firstElementChild as HTMLElement;
    expect(tile.className).toContain("[container-type:inline-size]");
    expect(
      screen.getByTestId("summary-row").querySelectorAll("span.break-normal").length,
    ).toBe(REDDIT_ORGANIC.length);
    expect(screen.getByTestId("summary-row").querySelectorAll("span.break-words")).toHaveLength(0);
  });

  it("never hides a tile's icon at a width the layout can actually produce", () => {
    render(<SummaryRow metrics={REDDIT_ORGANIC} perRow={5} display={WITH_ICONS} />);
    const icon = screen.getByTestId("summary-row").querySelector("svg")!;
    const hide = /\[@container\(max-width:(\d+)px\)\]:hidden/.exec(icon.getAttribute("class") ?? "");
    expect(hide, "the icon must declare when it gives up its space").not.toBeNull();

    const basis = basisOf();
    let narrowest = Infinity;
    for (let width = 240; width <= 1440; width += 1) {
      narrowest = Math.min(narrowest, ...flexRows(basis, width, REDDIT_ORGANIC.length).flat());
    }
    expect(narrowest - TILE_PADDING_X).toBeGreaterThan(Number(hide![1]));
  });

  it("uses the same fluid basis for the row and its exported sizing helper", () => {
    render(<SummaryRow metrics={REDDIT_ORGANIC} perRow={5} />);
    expect(basisOf()).toBe(tileBasis(5, TILE_MIN_PX));
  });
});
