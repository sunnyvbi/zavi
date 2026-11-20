
import { describe, it, expect } from "vitest";
import {
  COLUMN_MIN_WIDTH_PX,
  COMPACT_VIEWPORT_MAX_PX,
  columnsRowMinWidth,
  effectiveCollapse,
  type ColumnId,
} from "./columnLayout";

const GEOMETRY = { gapPx: 6, rowPaddingPx: 12 };
const RAIL_PX = 48;
const PHONE_PX = 390;

const row = (ids: ColumnId[], collapsed: Partial<Record<ColumnId, boolean>>) =>
  columnsRowMinWidth(
    ids.map((id) => ({ id, collapsed: collapsed[id] ?? false, railPx: RAIL_PX })),
    GEOMETRY,
  );

describe("effectiveCollapse", () => {
  it("collapses every side panel on a compact viewport, whatever is stored", () => {
    expect(
      effectiveCollapse({
        compact: true,
        context: false,
        channels: false,
        analytics: false,
      }),
    ).toEqual({ context: true, channels: true, analytics: true });
  });

  it("is a pass-through above the breakpoint, so a phone visit cannot reshape the desktop", () => {
    const stored = { context: false, channels: true, analytics: false };
    expect(effectiveCollapse({ compact: false, ...stored })).toEqual(stored);
  });

  it("keeps context open when a compact surface opened it through its own hatch", () => {
    expect(
      effectiveCollapse({
        compact: true,
        context: false,
        channels: false,
        analytics: false,
        contextEscapeOpen: true,
      }).context,
    ).toBe(false);
  });

  it("still honours a stored hidden context even when the hatch is open", () => {
    expect(
      effectiveCollapse({
        compact: true,
        context: true,
        channels: false,
        analytics: false,
        contextEscapeOpen: true,
      }).context,
    ).toBe(true);
  });

  it("collapses context on a compact surface that has no hatch at all", () => {
    expect(
      effectiveCollapse({
        compact: true,
        context: false,
        channels: false,
        analytics: false,
      }).context,
    ).toBe(true);
  });

  it("never leaves chat as the collapsed one - it is not in the state at all", () => {
    const state = effectiveCollapse({
      compact: true,
      context: false,
      channels: false,
      analytics: false,
    });
    expect(Object.keys(state).sort()).toEqual([
      "analytics",
      "channels",
      "context",
    ]);
  });
});

describe("columnsRowMinWidth", () => {
  it("the FRESH phone default overflows 390 - this is the reported bug", () => {
    const before = row(["context", "chat", "analytics"], { context: true });
    expect(before).toBe(RAIL_PX + COLUMN_MIN_WIDTH_PX.chat + COLUMN_MIN_WIDTH_PX.analytics + 6 * 2 + 12);
    expect(before).toBe(712);
    expect(before).toBeGreaterThan(PHONE_PX);
  });

  it("all four expanded is far worse, which is what a stored desktop layout gives a phone", () => {
    expect(row(["context", "chat", "analytics", "channels"], {})).toBe(1210);
  });

  it("one rail plus chat fits a 390px phone - this is the fix", () => {
    const after = row(["context", "chat"], { context: true });
    expect(after).toBe(RAIL_PX + COLUMN_MIN_WIDTH_PX.chat + 6 + 12);
    expect(after).toBe(386);
    expect(after).toBeLessThanOrEqual(PHONE_PX);
  });

  it("does not add a gap that is not there when only one column is visible", () => {
    expect(row(["chat"], {})).toBe(COLUMN_MIN_WIDTH_PX.chat + 12);
  });

  it("the breakpoint sits one pixel under Tailwind's sm, matching the build surface", () => {
    expect(COMPACT_VIEWPORT_MAX_PX).toBe(639);
  });

  it("the Tailwind `compact:` screen is the same pixel as COMPACT_VIEWPORT_MAX_PX", async () => {
    const config = (await import("../../../../tailwind.config")).default;
    const screens = config.theme?.extend?.screens as
      | { compact?: { max?: string } }
      | undefined;
    expect(screens?.compact?.max).toBe(`${COMPACT_VIEWPORT_MAX_PX}px`);
  });
});
