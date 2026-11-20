import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_TOOLS_PREFS,
  hiddenToolsHint,
  parsePreviewToolsPrefs,
  previewShortcutFor,
  shortcutLabel,
} from "./previewTools";

describe("parsePreviewToolsPrefs", () => {
  it("falls back to docked with shortcuts on for missing, broken or foreign values", () => {
    expect(parsePreviewToolsPrefs(null)).toEqual(DEFAULT_PREVIEW_TOOLS_PREFS);
    expect(parsePreviewToolsPrefs("{not json")).toEqual(DEFAULT_PREVIEW_TOOLS_PREFS);
    expect(parsePreviewToolsPrefs("null")).toEqual(DEFAULT_PREVIEW_TOOLS_PREFS);
    expect(parsePreviewToolsPrefs(JSON.stringify({ placement: "floating", shortcuts: "yes" }))).toEqual(
      DEFAULT_PREVIEW_TOOLS_PREFS,
    );
  });

  it("keeps a saved choice", () => {
    expect(parsePreviewToolsPrefs(JSON.stringify({ placement: "hidden", shortcuts: false }))).toEqual({
      placement: "hidden",
      shortcuts: false,
    });
    expect(parsePreviewToolsPrefs(JSON.stringify({ placement: "minimized" }))).toEqual({
      placement: "minimized",
      shortcuts: true,
    });
  });
});

describe("previewShortcutFor", () => {
  it("maps the bare letters to their tools, either case", () => {
    expect(previewShortcutFor({ key: "e" })).toBe("edit");
    expect(previewShortcutFor({ key: "E" })).toBe("edit");
    expect(previewShortcutFor({ key: "t" })).toBe("text");
    expect(previewShortcutFor({ key: "a" })).toBe("annotate");
    expect(previewShortcutFor({ key: "c" })).toBeNull();
  });

  it("maps ⌘. and Ctrl+. to show/hide tools", () => {
    expect(previewShortcutFor({ key: ".", metaKey: true })).toBe("toggleTools");
    expect(previewShortcutFor({ key: ".", ctrlKey: true })).toBe("toggleTools");
  });

  it("ignores copy/paste, shifted or alt letters, a bare dot, other keys and key repeat", () => {
    expect(previewShortcutFor({ key: "c", metaKey: true })).toBeNull();
    expect(previewShortcutFor({ key: "a", ctrlKey: true })).toBeNull();
    expect(previewShortcutFor({ key: "E", shiftKey: true })).toBeNull();
    expect(previewShortcutFor({ key: "e", altKey: true })).toBeNull();
    expect(previewShortcutFor({ key: ".", metaKey: true, shiftKey: true })).toBeNull();
    expect(previewShortcutFor({ key: "." })).toBeNull();
    expect(previewShortcutFor({ key: "x" })).toBeNull();
    expect(previewShortcutFor({ key: "e", repeat: true })).toBeNull();
  });
});

describe("labels", () => {
  it("shows Ctrl instead of ⌘ off a Mac", () => {
    expect(shortcutLabel(true, "⌘ .")).toBe("⌘ .");
    expect(shortcutLabel(false, "⌘ .")).toBe("Ctrl .");
    expect(shortcutLabel(false, "E")).toBe("E");
  });

  it("tells the person how to get hidden tools back", () => {
    expect(hiddenToolsHint(true, true)).toContain("⌘ .");
    expect(hiddenToolsHint(true, false)).toContain("Ctrl .");
    expect(hiddenToolsHint(false, true)).not.toMatch(/⌘|Ctrl/);
    expect(hiddenToolsHint(false, true)).toContain("eye button");
  });
});
