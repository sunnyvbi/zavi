
import { describe, expect, it } from "vitest";
import {
  BUILD_CHAT_DEFAULT_PX,
  BUILD_CHAT_MIN_PX,
  BUILD_PREVIEW_MIN_PX,
  BUILD_SPLIT_MIN_PX,
  PREVIEW_MIN_SCREEN_FRACTION,
  buildChatCeiling,
  clampBuildChatWidth,
} from "./buildSplit";

const GAP = 6;
const PADDING = 12;

const SMALL_SCREEN = 600;

const wideRow = (rowWidth: number, chatLeft = 60, screenWidth = SMALL_SCREEN) =>
  buildChatCeiling({
    rowRight: chatLeft + rowWidth,
    chatLeft,
    gapPx: GAP,
    rowPaddingPx: PADDING,
    screenWidth,
  });

describe("constants", () => {
  it("opens at a width at or above the floor", () => {
    expect(BUILD_CHAT_DEFAULT_PX).toBeGreaterThanOrEqual(BUILD_CHAT_MIN_PX);
  });

  it("leaves both panes above their floor at the split breakpoint", () => {
    expect(BUILD_CHAT_MIN_PX + BUILD_PREVIEW_MIN_PX).toBeLessThan(
      BUILD_SPLIT_MIN_PX,
    );
  });
});

describe("buildChatCeiling", () => {
  it("reserves the preview floor, the gap, and the trailing padding", () => {
    expect(wideRow(1100)).toBe(1100 - GAP - PADDING / 2 - BUILD_PREVIEW_MIN_PX);
  });

  it("keeps the preview floor as the ceiling while the screen fraction is smaller", () => {
    expect(wideRow(4000)).toBe(4000 - GAP - PADDING / 2 - BUILD_PREVIEW_MIN_PX);
  });

  it("hands the preview its screen fraction once that beats the pixel floor", () => {
    const screenWidth = 1470;
    const reserved = screenWidth * PREVIEW_MIN_SCREEN_FRACTION;
    expect(reserved).toBeGreaterThan(BUILD_PREVIEW_MIN_PX);
    expect(wideRow(4000, 60, screenWidth)).toBe(
      4000 - GAP - PADDING / 2 - reserved,
    );
  });

  it("reads that fraction off the screen, never off the row", () => {
    const screenWidth = 1470;
    const wide = wideRow(4000, 60, screenWidth);
    const narrow = wideRow(2000, 60, screenWidth);
    expect(wide - narrow).toBe(2000);
  });

  it("lets the divider push the preview down to its floor and no further", () => {
    const rowWidth = 2400;
    const ceiling = wideRow(rowWidth);
    expect(rowWidth - GAP - PADDING / 2 - ceiling).toBe(BUILD_PREVIEW_MIN_PX);
    expect(clampBuildChatWidth(rowWidth, ceiling)).toBe(ceiling);
  });

  it("never drops below the chat floor on a very narrow row", () => {
    expect(wideRow(300)).toBe(BUILD_CHAT_MIN_PX);
  });

  it("shrinks as the context column to the chat's left expands", () => {
    const rowRight = 1200;
    const withRail = buildChatCeiling({
      rowRight,
      chatLeft: 60,
      gapPx: GAP,
      rowPaddingPx: PADDING,
      screenWidth: SMALL_SCREEN,
    });
    const withExpandedNav = buildChatCeiling({
      rowRight,
      chatLeft: 300,
      gapPx: GAP,
      rowPaddingPx: PADDING,
      screenWidth: SMALL_SCREEN,
    });
    expect(withExpandedNav).toBeLessThan(withRail);
    expect(withExpandedNav).toBe(withRail - 240);
  });
});

describe("clampBuildChatWidth", () => {
  it("passes an in-range width through, rounded", () => {
    expect(clampBuildChatWidth(512.4, 700)).toBe(512);
  });

  it("clamps to the ceiling", () => {
    expect(clampBuildChatWidth(900, 700)).toBe(700);
  });

  it("clamps to the floor", () => {
    expect(clampBuildChatWidth(10, 700)).toBe(BUILD_CHAT_MIN_PX);
  });

  it("lets the floor win when the ceiling falls below it", () => {
    expect(clampBuildChatWidth(400, 100)).toBe(BUILD_CHAT_MIN_PX);
    expect(clampBuildChatWidth(10, 100)).toBe(BUILD_CHAT_MIN_PX);
  });

  it("treats an unmeasured row as no ceiling at all", () => {
    expect(clampBuildChatWidth(600, Number.POSITIVE_INFINITY)).toBe(600);
  });

  it("is idempotent", () => {
    const once = clampBuildChatWidth(1200, 640);
    expect(clampBuildChatWidth(once, 640)).toBe(once);
  });
});
