
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  WEBSITE_CHAT_PANE_OPTIONS,
  websiteChatPaneOptions,
  websiteChatSide,
} from "./WebsiteTab";
import { growKeyFor, paneSizeFromPointer } from "@/hooks/useResizablePane";

const source = readFileSync(join(__dirname, "WebsiteTab.tsx"), "utf8");
const panel = readFileSync(
  join(__dirname, "home", "calm", "HomeChatPanel.tsx"),
  "utf8",
);

describe("websiteChatSide", () => {
  it("docks the chat left on Build and right on the Website tab", () => {
    expect(websiteChatSide("build")).toBe("left");
    expect(websiteChatSide("website")).toBe("right");
  });

  it("hands the resize hook the matching anchor, keeping the shared clamp", () => {
    expect(websiteChatPaneOptions("build").anchor).toBe("left");
    expect(websiteChatPaneOptions("website").anchor).toBe("right");
    const { anchor: _a, defaultPx: _d, resetTo: _r, ...site } = websiteChatPaneOptions("website");
    const { defaultPx: _bd, resetTo: _br, ...base } = WEBSITE_CHAT_PANE_OPTIONS;
    expect(site).toEqual(base);
    const {
      anchor: _ba,
      defaultPx: _bdd,
      resetTo: _brr,
      min: buildMin,
      storageKey: buildStorageKey,
      containerRef: _bc,
      maxFraction: buildFraction,
      maxFn: buildCeiling,
      keyboard: buildKeyboard,
      ...buildRest
    } = websiteChatPaneOptions("build");
    expect(buildFraction).toBeUndefined();
    expect(buildCeiling).toBeTypeOf("function");
    expect(buildKeyboard).toBe(true);
    expect(buildStorageKey).toBe("zavi.buildAppChatWidth");
    expect(buildStorageKey).not.toBe(WEBSITE_CHAT_PANE_OPTIONS.storageKey);
    expect(buildMin).toBe(420);
    expect(buildMin).toBeGreaterThan(base.min);
    expect(websiteChatPaneOptions("website").keyboard).toBeUndefined();
    const { maxFraction: _mf, storageKey: _siteStorageKey, min: _siteMin, ...baseWithoutCap } = base;
    expect(buildRest).toEqual(baseWithoutCap);
  });

  it("opens the Build chat at its polished width, within the shared clamp", () => {
    const build = websiteChatPaneOptions("build");
    const site = websiteChatPaneOptions("website");
    expect(build.defaultPx).toBeGreaterThan(site.defaultPx!);
    expect(build.defaultPx).toBe(460);
    expect(build.resetTo).toBe(build.defaultPx);
    expect(site.resetTo).toBe(site.defaultPx);
    expect(build.defaultPx!).toBeLessThanOrEqual(1440 - 360);
    expect(build.defaultPx!).toBeGreaterThanOrEqual(340);
  });
});

describe("the Build anchor actually inverts the drag", () => {
  const bounds = { left: 100, right: 1100 };

  it("measures a left-docked chat from the container's LEFT edge", () => {
    expect(paneSizeFromPointer("left", bounds, 500)).toBe(400);
    expect(paneSizeFromPointer("right", bounds, 500)).toBe(600);
  });

  it("widens a left-docked chat when the pointer moves right", () => {
    const narrow = paneSizeFromPointer("left", bounds, 400);
    const wide = paneSizeFromPointer("left", bounds, 700);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("puts the grow key on the side that moves away from the pane", () => {
    expect(growKeyFor(websiteChatSide("build"))).toBe("ArrowRight");
    expect(growKeyFor(websiteChatSide("website"))).toBe("ArrowLeft");
  });
});

describe("the markup follows the same decision", () => {
  it("reserves the main column's space on the side the chat is docked to", () => {
    const main = source.slice(
      source.indexOf("{/* Main column"),
      source.indexOf("{/* Preview header"),
    );
    expect(main).toMatch(/chatOnLeft\s*\?\s*"lg:ml-\[var\(--website-chat-w\)\]"/);
    expect(main).toContain('"lg:mr-[var(--website-chat-w)]"');
  });

  it("passes the side to the panel rather than letting it guess", () => {
    expect(source).toContain("side={chatSide}");
    expect(source).toContain("useResizablePane(websiteChatPaneOptions(variant, rootRef))");
  });

  it("flips the panel's border and drag handle with the side", () => {
    expect(panel).toContain('onLeft ? "left-0 border-r" : "right-0 border-l"');
    expect(panel).toContain('onLeft ? "right-0" : "left-0"');
    expect(panel).toContain('onLeft ? "right-0 -mr-px" : "left-0 -ml-px"');
  });

  it("still defaults to the right, so Home is untouched", () => {
    expect(panel).toContain('side = "right"');
  });
});
