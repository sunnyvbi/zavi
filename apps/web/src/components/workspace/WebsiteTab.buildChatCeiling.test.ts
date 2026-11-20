// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { makeClamp } from "@/hooks/useResizablePane";
import { websiteChatPaneOptions } from "./WebsiteTab";
import { BUILD_PREVIEW_MIN_PX, PREVIEW_MIN_SCREEN_FRACTION } from "./layout/buildSplit";

const BUILD_CHAT_FLOOR_PX = 420;

const clampFor = (variant: "website" | "build") =>
  makeClamp(websiteChatPaneOptions(variant));

function screenWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
}

beforeEach(() => screenWidth(1480));

describe("the Build surface's chat ceiling", () => {
  it("never lets the preview drop below its screen fraction", () => {
    const clamp = clampFor("build");
    const row = 1410;
    const widest = clamp(99999, row);
    expect(row - widest).toBe(Math.round(1480 * PREVIEW_MIN_SCREEN_FRACTION));
  });

  it("measures that fraction against the screen, not the row it sits in", () => {
    const clamp = clampFor("build");
    const narrowRow = 1200;
    expect(narrowRow - clamp(99999, narrowRow)).toBe(
      Math.round(1480 * PREVIEW_MIN_SCREEN_FRACTION),
    );
  });

  it("falls back to the pixel floor when that fraction of a small screen is less", () => {
    screenWidth(790);
    const clamp = clampFor("build");
    const row = 790;
    expect(790 * PREVIEW_MIN_SCREEN_FRACTION).toBeLessThan(BUILD_PREVIEW_MIN_PX);
    expect(row - BUILD_PREVIEW_MIN_PX).toBeGreaterThan(BUILD_CHAT_FLOOR_PX);
    expect(row - clamp(99999, row)).toBe(BUILD_PREVIEW_MIN_PX);
  });

  it("no longer stops at 40% of the row, which was the old wall", () => {
    const clamp = clampFor("build");
    const row = 1410;
    const oldWall = Math.max(340, Math.round(row * 0.4));
    expect(clamp(99999, row)).toBeGreaterThan(oldWall);
    expect(clamp(oldWall + 1, row)).toBe(oldWall + 1);
  });

  it("still refuses to collapse the chat below its own floor", () => {
    const clamp = clampFor("build");
    expect(clamp(10, 1410)).toBe(BUILD_CHAT_FLOOR_PX);
    expect(clamp(10, 600)).toBe(BUILD_CHAT_FLOOR_PX);
  });

  it("gives the chat its floor, not a negative width, on a row too narrow for both", () => {
    const clamp = clampFor("build");
    expect(clamp(500, 300)).toBe(BUILD_CHAT_FLOOR_PX);
  });

  it("leaves the Website tab on its 40%-of-viewport cap", () => {
    const clamp = clampFor("website");
    const row = 1470;
    expect(clamp(99999, row)).toBe(Math.round(row * 0.4));
  });

  it("is idempotent, so a re-clamp on window resize never creeps", () => {
    const clamp = clampFor("build");
    const once = clamp(99999, 1410);
    expect(clamp(once, 1410)).toBe(once);
  });
});
