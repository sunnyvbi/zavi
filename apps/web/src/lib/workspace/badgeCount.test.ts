
import { describe, it, expect } from "vitest";
import { capBadgeCount, exactCountLabel } from "./badgeCount";

describe("capBadgeCount", () => {
  it("renders the exact number at or below the cap of 99", () => {
    expect(capBadgeCount(0)).toBe("0");
    expect(capBadgeCount(1)).toBe("1");
    expect(capBadgeCount(9)).toBe("9");
    expect(capBadgeCount(10)).toBe("10");
    expect(capBadgeCount(55)).toBe("55");
    expect(capBadgeCount(99)).toBe("99");
  });
  it("compresses to \"99+\" above the default cap of 99", () => {
    expect(capBadgeCount(100)).toBe("99+");
    expect(capBadgeCount(101)).toBe("99+");
    expect(capBadgeCount(555)).toBe("99+");
  });
  it("honors a custom cap", () => {
    expect(capBadgeCount(6, 6)).toBe("6");
    expect(capBadgeCount(7, 6)).toBe("6+");
  });
});

describe("exactCountLabel", () => {
  it("pluralizes correctly and never caps (full N for a11y/tooltip)", () => {
    expect(exactCountLabel(1)).toBe("1 pending approval");
    expect(exactCountLabel(0)).toBe("0 pending approvals");
    expect(exactCountLabel(2)).toBe("2 pending approvals");
    expect(exactCountLabel(55)).toBe("55 pending approvals");
  });
  it("supports the sidebar's unread noun", () => {
    expect(exactCountLabel(1, "unread chat")).toBe("1 unread chat");
    expect(exactCountLabel(13, "unread chat")).toBe("13 unread chats");
  });
});

