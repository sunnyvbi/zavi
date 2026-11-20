
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANE_WIDTH_PCT,
  clampPaneWidthPct,
  normalizeWorkspacePrefs,
} from "./userPrefs";

describe("normalizeWorkspacePrefs", () => {
  it("resolves {} (unset user, OR the server's fail-soft degrade) to chat", () => {
    expect(normalizeWorkspacePrefs({})).toEqual({
      viewMode: "chat",
      paneWidthPct: DEFAULT_PANE_WIDTH_PCT,
    });
  });

  it("resolves a missing payload to chat", () => {
    expect(normalizeWorkspacePrefs(undefined).viewMode).toBe("chat");
    expect(normalizeWorkspacePrefs(null).viewMode).toBe("chat");
  });

  it("honors a stored threaded preference", () => {
    expect(
      normalizeWorkspacePrefs({ viewMode: "threaded", paneWidthPct: 62 }),
    ).toEqual({ viewMode: "threaded", paneWidthPct: 62 });
  });

  it("falls back to chat on a junk viewMode instead of rendering nothing", () => {
    expect(
      normalizeWorkspacePrefs({
        viewMode: "split" as unknown as "chat",
      }).viewMode,
    ).toBe("chat");
  });

  it("clamps an out-of-range pane width into the server's 20..80 window", () => {
    expect(normalizeWorkspacePrefs({ paneWidthPct: 5 }).paneWidthPct).toBe(20);
    expect(normalizeWorkspacePrefs({ paneWidthPct: 500 }).paneWidthPct).toBe(80);
    expect(clampPaneWidthPct(Number.NaN)).toBe(DEFAULT_PANE_WIDTH_PCT);
  });

  it("ignores a non-numeric pane width", () => {
    expect(
      normalizeWorkspacePrefs({
        paneWidthPct: "52" as unknown as number,
      }).paneWidthPct,
    ).toBe(DEFAULT_PANE_WIDTH_PCT);
  });
});
