import { describe, it, expect } from "vitest";
import { creditMonthWindow, paidWindowToday } from "../period";

describe("creditMonthWindow — paid credits reset on the billing date", () => {
  it("a Sep 22 subscriber resets Oct 22, not Oct 1", () => {
    expect(creditMonthWindow("2026-10-22T08:00:00Z", "2026-09-25")).toEqual({
      start: "2026-09-22",
      end: "2026-10-22",
    });
  });

  it("the billing day itself starts the new window", () => {
    expect(creditMonthWindow("2026-10-22T08:00:00Z", "2026-10-22")).toEqual({
      start: "2026-10-22",
      end: "2026-11-22",
    });
  });

  it("a six-month term still resets monthly on its day", () => {
    expect(creditMonthWindow("2027-03-15T00:00:00Z", "2026-11-02")).toEqual({
      start: "2026-10-15",
      end: "2026-11-15",
    });
  });

  it("clamps an anchor on the 31st to month end, like Postgres and Stripe", () => {
    expect(creditMonthWindow("2026-01-31T00:00:00Z", "2026-03-01")).toEqual({
      start: "2026-02-28",
      end: "2026-03-31",
    });
  });

  it("no anchor → the calendar month", () => {
    expect(creditMonthWindow(null, "2026-09-22")).toEqual({ start: "2026-09-01", end: "2026-10-01" });
  });
});

describe("paidWindowToday — the paid window turns over at the billing MOMENT", () => {
  it("before the moment on the billing day, it is still the previous day", () => {
    expect(paidWindowToday("2026-10-22T18:00:00Z", new Date("2026-10-22T09:00:00Z"))).toBe("2026-10-21");
  });

  it("once the moment passes, it is the billing day", () => {
    expect(paidWindowToday("2026-10-22T18:00:00Z", new Date("2026-10-22T18:00:01Z"))).toBe("2026-10-22");
  });

  it("a midnight anchor and no anchor both read the plain UTC date", () => {
    const now = new Date("2026-10-22T09:00:00Z");
    expect(paidWindowToday("2026-10-22T00:00:00Z", now)).toBe("2026-10-22");
    expect(paidWindowToday(null, now)).toBe("2026-10-22");
  });
});
