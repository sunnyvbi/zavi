import { describe, expect, it } from "vitest";

import { historyRowBindsToBuild } from "./historyOpen";

const OPERATOR = "operator";
const BUILD_CHAT = "22222222-2222-4222-8222-222222222222";
const OTHER_CHAT = "33333333-3333-4333-8333-333333333333";

const ctx = (over: Partial<Parameters<typeof historyRowBindsToBuild>[0]> = {}) => ({
  rowSlug: OPERATOR,
  rowThreadId: BUILD_CHAT,
  operatorSlug: OPERATOR,
  activeTabKind: "build",
  hasBuildTab: true,
  buildThreadId: BUILD_CHAT,
  buildChatFollowsThread: true,
  ...over,
});

describe("a chat row clicked from Build", () => {
  it("binds the build's own conversation into the build tab", () => {
    expect(historyRowBindsToBuild(ctx())).toBe(true);
  });

  it("sends any other Zavi conversation to its own surface, away from the preview", () => {
    expect(historyRowBindsToBuild(ctx({ rowThreadId: OTHER_CHAT }))).toBe(false);
  });

  it("binds nothing while the build has no conversation of its own yet", () => {
    expect(historyRowBindsToBuild(ctx({ buildThreadId: undefined }))).toBe(false);
    expect(historyRowBindsToBuild(ctx({ buildThreadId: null }))).toBe(false);
  });

  it("does NOT bind while the BUILDER is showing", () => {
    expect(historyRowBindsToBuild(ctx({ buildChatFollowsThread: false }))).toBe(false);
  });

  it("does not bind when there is no build tab to bind to", () => {
    expect(historyRowBindsToBuild(ctx({ hasBuildTab: false }))).toBe(false);
  });

  it("leaves another agent's row alone even on Build", () => {
    expect(historyRowBindsToBuild(ctx({ rowSlug: "engineer" }))).toBe(false);
  });

  it("never binds from a surface that is not Build", () => {
    for (const kind of ["agent", "home", "analytics", undefined]) {
      expect(historyRowBindsToBuild(ctx({ activeTabKind: kind }))).toBe(false);
    }
  });

  it("needs every condition, not a majority of them", () => {
    const conditions = [
      { rowSlug: "engineer" },
      { rowThreadId: OTHER_CHAT },
      { activeTabKind: "home" },
      { hasBuildTab: false },
      { buildThreadId: undefined },
      { buildChatFollowsThread: false },
    ];
    for (const one of conditions) {
      expect(historyRowBindsToBuild(ctx(one))).toBe(false);
    }
    expect(historyRowBindsToBuild(ctx())).toBe(true);
  });
});
